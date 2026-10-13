/**
 * Importa los datos reales de Roll It (recetas, insumos, conteo de inventario
 * y ventas de SmartMenu) a la base del panel.
 *
 * Uso: IMPORT_DIR=<carpeta> pnpm import:real [--wipe-demo]
 *
 * La carpeta trae `insumos.csv`, `recetas.csv`, `inventario-inicial.csv`,
 * `smartmenu-alias-platos.csv` y `ventas-<slug>.jsonl` (en la raíz o en
 * `import/`), generados por el preprocesado de los .xls de SmartMenu. Los
 * datos del cliente no viven en el repo (es público): por eso llegan por env.
 *
 * Es idempotente: catálogos por upsert, ventas por (sucursal, externalId),
 * conteo inicial una sola vez por fecha y el descuento de inventario con la
 * marca `inventoryApplied`. Correrlo dos veces deja la base igual.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose, { Types } from "mongoose";
import { env } from "../config/env";
import { Branch } from "../models/branch.model";
import { Ingredient, IngredientUnit } from "../models/ingredient.model";
import { InventoryMovement } from "../models/inventoryMovement.model";
import { Product } from "../models/product.model";
import { PurchaseInvoice } from "../models/purchaseInvoice.model";
import { Recipe } from "../models/recipe.model";
import { Sale } from "../models/sale.model";
import { StockLevel } from "../models/stockLevel.model";
import { Waiter } from "../models/waiter.model";
import { convertQuantity, normalizeUnit } from "../services/recipeImport.service";
import {
  applyMovement,
  computeStatus,
  effectiveThresholds,
  StockStatus,
} from "../services/stock.service";
import { applySaleInventory, loadRecipes } from "../services/sync.service";
import { normalizeName } from "../utils/normalize";
import { ecuadorDateKey, ecuadorParts } from "../utils/time";

const BATCH = 1000;
const INVENTORY_CONCURRENCY = 8;
// El conteo físico es el cierre de agosto 2026: se fecha al último minuto del mes.
const INITIAL_DATE = new Date("2026-08-31T23:59:00-05:00");
// Desde aquí las ventas descuentan stock; antes del conteo no tiene sentido descontar.
const INVENTORY_CUTOFF = new Date("2026-09-01T00:00:00-05:00");
const SEPT_END = new Date("2026-10-01T00:00:00-05:00");
const SEPT_DAYS = 30;
const RECIPE_NOTE = "Importada de recetas.csv";
const RESALE_NOTE = "Reventa 1:1 (importador)";
const DEMO_RECIPE_NOTE = "Receta de demostración";

const BRANCHES = [
  { name: "Villa Club", slug: "villa-club", csv: "VILLA CLUB" },
  { name: "Marbol", slug: "marbol", csv: "MARBOL" },
  { name: "Cuenca", slug: "cuenca", csv: "CUENCA" },
];

// Lo que crea seed-demo.ts. Se copia aquí porque importar ese archivo ejecutaría el seed.
const DEMO_BRANCHES_TO_DELETE = ["sucursal-2", "sucursal-3"];
const DEMO_PRODUCTS = [
  "Maki Acevichado",
  "California Roll",
  "Roll Tempura de Langostino",
  "Philadelphia Roll",
  "Roll Parrillero",
  "Spicy Tuna Roll",
  "Dragon Roll",
  "Roll Vegetariano",
  "Burrito de Pollo",
  "Burrito de Salmón",
  "Burrito de Carne",
  "Burrito de Langostino",
  "Poke Bowl de Salmón",
  "Poke Bowl de Pollo",
  "Gyozas",
  "Edamame",
  "Wantán de Langostino",
  "Limonada",
  "Té Helado",
  "Coca Cola",
  "Mochi",
  "Cheesecake de Maracuyá",
];
const DEMO_INGREDIENTS = [
  "Salmón",
  "Langostino",
  "Atún",
  "Arroz para sushi",
  "Alga nori",
  "Queso crema",
  "Aguacate",
  "Pepino",
  "Tortilla de harina",
  "Pollo",
  "Panko",
  "Salsa de soya",
  "Limón",
  "Carne de res",
  "Frijoles",
  "Cebolla paiteña",
  "Edamame",
  "Masa para gyozas",
  "Azúcar",
  "Coca Cola 350 ml",
  "Mochi",
];
const DEMO_WAITERS_VILLA_CLUB = [
  "Andrea Castillo",
  "Kevin Mora",
  "Valeria Paredes",
  "Jonathan Vera",
  "Daniela Salazar",
];

// Categorías de SmartMenu donde hay reventa (botella que entra y sale igual).
const RESALE_CATEGORIES = ["bebidas soft", "cervezas", "bebidas especiales"];

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const round = (value: number, decimals: number) =>
  Math.round(value * 10 ** decimals) / 10 ** decimals;

// ---------- Lectura de archivos ----------

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else current += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      cells.push(current.trim());
      current = "";
    } else current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function readCsv(file: string): Record<string, string>[] {
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  });
}

function findFile(dir: string, name: string): string | null {
  for (const candidate of [path.join(dir, name), path.join(dir, "import", name)]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function requireFile(dir: string, name: string): string {
  const file = findFile(dir, name);
  if (!file) throw new Error(`No encontré ${name} en IMPORT_DIR`);
  return file;
}

function num(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

interface TicketItem {
  name: string;
  rawName: string;
  code: string;
  category: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
}
interface Ticket {
  externalId: string;
  date: string;
  items: TicketItem[];
  totalCents: number;
  channel: string;
}

function readJsonl(file: string): Ticket[] {
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Ticket);
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

// ---------- a. Limpieza del demo ----------

async function wipeDemo(
  realProductKeys: Set<string>,
  realIngredientUnits: Map<string, IngredientUnit | null>,
) {
  const report: string[] = [];

  const demoSales = await Sale.find({ source: "demo" }).select("_id").lean<any[]>();
  const demoInvoices = await PurchaseInvoice.find({ invoiceNumber: /^DEMO-/ })
    .select("_id")
    .lean<any[]>();
  const refIds = [...demoSales, ...demoInvoices].map((d) => d._id);
  const movs = await InventoryMovement.deleteMany({
    $or: [{ note: { $regex: "\\[demo\\]" } }, { refId: { $in: refIds } }],
  });
  const sales = await Sale.deleteMany({ source: "demo" });
  await PurchaseInvoice.deleteMany({ invoiceNumber: /^DEMO-/ });
  report.push(`${sales.deletedCount} ventas demo, ${movs.deletedCount} movimientos demo`);

  // Sucursales inventadas por el seed: se van con todo lo que cuelga de ellas.
  const extra = await Branch.find({ slug: { $in: DEMO_BRANCHES_TO_DELETE } })
    .select("_id slug")
    .lean<any[]>();
  if (extra.length) {
    const ids = extra.map((b) => b._id);
    await Promise.all([
      Sale.deleteMany({ branch: { $in: ids } }),
      InventoryMovement.deleteMany({ branch: { $in: ids } }),
      StockLevel.deleteMany({ branch: { $in: ids } }),
      Waiter.deleteMany({ branch: { $in: ids } }),
      PurchaseInvoice.deleteMany({ branch: { $in: ids } }),
    ]);
    await Branch.deleteMany({ _id: { $in: ids } });
    report.push(`sucursales ${extra.map((b) => b.slug).join(", ")} borradas`);
  }

  // Villa Club se reutiliza; solo se van sus meseros inventados.
  const villa = await Branch.findOne({ slug: "villa-club" }).select("_id").lean<any>();
  if (villa) {
    const w = await Waiter.deleteMany({
      branch: villa._id,
      normalizedName: { $in: DEMO_WAITERS_VILLA_CLUB.map(normalizeName) },
    });
    if (w.deletedCount) report.push(`${w.deletedCount} meseros demo de Villa Club`);
  }

  // Platos demo que no existen en el recetario real ni en ventas reales. Si una venta real ya
  // apunta al plato (p. ej. "EDAMAME"), borrarlo lo recrearía en cada corrida con otro _id.
  // Se borran primero las recetas demo: así un plato real no conserva una receta inventada.
  const demoRecipes = await Recipe.deleteMany({ notes: DEMO_RECIPE_NOTE });
  const demoProducts = await Product.find({
    normalizedName: { $in: DEMO_PRODUCTS.map(normalizeName) },
  })
    .select("_id normalizedName")
    .lean<any[]>();
  const usedProducts = new Set(
    (
      await Sale.distinct("items.product", {
        "items.product": { $in: demoProducts.map((p) => p._id) },
      })
    ).map(String),
  );
  const dropProducts = demoProducts.filter(
    (p) => !realProductKeys.has(p.normalizedName) && !usedProducts.has(String(p._id)),
  );
  if (dropProducts.length) {
    const ids = dropProducts.map((p) => p._id);
    await Recipe.deleteMany({ product: { $in: ids } });
    await Product.deleteMany({ _id: { $in: ids } });
  }
  // Los que se quedan pierden el código inventado "RI-xxx" y su precio de demo.
  await Product.updateMany(
    { _id: { $in: demoProducts.map((p) => p._id) }, smartmenuCode: /^RI-/ },
    { $set: { smartmenuCode: "", priceCents: 0 } },
  );
  report.push(
    `${dropProducts.length} platos demo borrados, ${demoRecipes.deletedCount} recetas demo`,
  );

  // Insumos demo que no están en insumos.csv ni tienen movimientos o recetas reales: fuera.
  const demoIngredients = await Ingredient.find({
    normalizedName: { $in: DEMO_INGREDIENTS.map(normalizeName) },
  })
    .select("_id normalizedName unit")
    .lean<any[]>();
  const dropIngredients = [];
  for (const ing of demoIngredients) {
    if (realIngredientUnits.has(ing.normalizedName)) continue;
    const inUse =
      (await InventoryMovement.exists({ ingredient: ing._id })) ||
      (await Recipe.exists({ "items.ingredient": ing._id }));
    if (!inUse) dropIngredients.push(ing);
  }
  if (dropIngredients.length) {
    const ids = dropIngredients.map((i) => i._id);
    await StockLevel.deleteMany({ ingredient: { $in: ids } });
    await Ingredient.deleteMany({ _id: { $in: ids } });
  }
  // Un insumo demo que también es real conserva umbrales calculados con ventas inventadas (y en
  // kg si el real va en g). Solo se vacían cuando esta corrida borró ventas demo: en una segunda
  // corrida ya son los sugeridos por el importador o los que ajustó el dueño.
  const keptIngredientIds = demoIngredients
    .filter((i) => realIngredientUnits.has(i.normalizedName))
    .map((i) => i._id);
  if (sales.deletedCount && keptIngredientIds.length) {
    await StockLevel.updateMany(
      { ingredient: { $in: keptIngredientIds } },
      { $set: { minStock: null, maxStock: null } },
    );
    await Ingredient.updateMany(
      { _id: { $in: keptIngredientIds } },
      { $set: { defaultMinStock: 0, defaultMaxStock: 0 } },
    );
  }
  // El seed marca la última sincronización con su venta inventada más reciente (hoy).
  if (sales.deletedCount && villa) {
    await Branch.updateOne({ _id: villa._id }, { $set: { lastSyncAt: null } });
  }
  report.push(`${dropIngredients.length} insumos demo borrados`);

  // Sin los movimientos demo, la caché de stock quedó desfasada: se recalcula desde el libro.
  if (villa) await recomputeStock([villa._id]);
  return report;
}

async function recomputeStock(branchIds: Types.ObjectId[]) {
  const sums = await InventoryMovement.aggregate([
    { $match: { branch: { $in: branchIds } } },
    { $group: { _id: { b: "$branch", i: "$ingredient" }, q: { $sum: "$quantity" } } },
  ]);
  const byKey = new Map(sums.map((s) => [`${s._id.b}:${s._id.i}`, s.q as number]));
  const levels = await StockLevel.find({ branch: { $in: branchIds } })
    .select("_id branch ingredient")
    .lean<any[]>();
  const ops = levels.map((l) => ({
    updateOne: {
      filter: { _id: l._id },
      update: { $set: { quantity: round(byKey.get(`${l.branch}:${l.ingredient}`) ?? 0, 4) } },
    },
  }));
  for (let i = 0; i < ops.length; i += BATCH) await StockLevel.bulkWrite(ops.slice(i, i + BATCH));
}

// ---------- Main ----------

async function main() {
  const dir = process.env.IMPORT_DIR?.trim();
  // IMPORT_DIR es un parámetro del script, no configuración de la app: por eso no está en env.ts.
  if (!dir) throw new Error("Falta IMPORT_DIR (carpeta con los CSV y los .jsonl)");
  const wipe = process.argv.includes("--wipe-demo");

  const insumosRows = readCsv(requireFile(dir, "insumos.csv"));
  const recetasRows = readCsv(requireFile(dir, "recetas.csv"));
  const inventarioRows = readCsv(requireFile(dir, "inventario-inicial.csv"));
  const aliasRows = readCsv(requireFile(dir, "smartmenu-alias-platos.csv"));
  const ticketsBySlug = new Map<string, Ticket[]>();
  for (const b of BRANCHES) {
    const file = findFile(dir, `ventas-${b.slug}.jsonl`);
    if (file) ticketsBySlug.set(b.slug, readJsonl(file));
  }

  console.log("Conectando a MongoDB...");
  await mongoose.connect(env.DB_URI);

  const realProductKeys = new Set(recetasRows.map((r) => normalizeName(r.Plato)).filter(Boolean));
  const realIngredientKeys = new Set(
    insumosRows.map((r) => normalizeName(r.Ingrediente)).filter(Boolean),
  );

  if (wipe) {
    console.log("Limpiando datos demo...");
    const realIngredientUnits = new Map(
      insumosRows.map((r) => [normalizeName(r.Ingrediente), normalizeUnit(r.Unidad)]),
    );
    for (const line of await wipeDemo(realProductKeys, realIngredientUnits)) {
      console.log(`  ${line}`);
    }
  }

  // ---------- b. Sucursales ----------
  const branches = new Map<string, any>();
  for (const b of BRANCHES) {
    // $setOnInsert: si alguien ya cargó la URL de SmartMenu desde Ajustes, no se pisa.
    const doc = await Branch.findOneAndUpdate(
      { slug: b.slug },
      { $setOnInsert: { name: b.name, slug: b.slug, smartmenuUrl: "", isActive: true } },
      { upsert: true, new: true },
    ).lean<any>();
    branches.set(b.slug, doc);
  }
  const branchByCsv = new Map(BRANCHES.map((b) => [normalizeName(b.csv), branches.get(b.slug)]));

  // ---------- c. Insumos ----------
  const existingIngredients = await Ingredient.find({
    normalizedName: { $in: [...realIngredientKeys] },
  }).lean<any[]>();
  const existingIngByKey = new Map(existingIngredients.map((i) => [i.normalizedName, i]));
  const ingredientOps: any[] = [];
  const badUnits: string[] = [];
  for (const row of insumosRows) {
    const key = normalizeName(row.Ingrediente);
    const unit = normalizeUnit(row.Unidad);
    if (!key) continue;
    if (!unit) {
      badUnits.push(`${row.Ingrediente} (${row.Unidad})`);
      continue;
    }
    const cost = num(row.CostoUnitario);
    const min = num(row.Minimo);
    const max = num(row.Maximo);
    const aliases = (row.Alias ?? "")
      .split("|")
      .map((a) => a.trim())
      .filter(Boolean);
    const previous = existingIngByKey.get(key);
    const set: Record<string, unknown> = { name: row.Ingrediente.trim(), unit };
    // El costo viene en USD por unidad del insumo y puede tener decimales finos (0.011224 $/g).
    if (cost !== null) set.costPerUnitCents = round(cost * 100, 6);
    if (min !== null) set.defaultMinStock = min;
    if (max !== null) set.defaultMaxStock = max;
    // Un umbral guardado en otra unidad (el demo usaba kg) sería 1000 veces menor: se reinicia.
    if (previous && previous.unit !== unit) {
      if (min === null) set.defaultMinStock = 0;
      if (max === null) set.defaultMaxStock = 0;
    }
    const setOnInsert: Record<string, unknown> = { isActive: true };
    if (cost === null) setOnInsert.costPerUnitCents = 0;
    if (min === null && !(previous && previous.unit !== unit)) setOnInsert.defaultMinStock = 0;
    if (max === null && !(previous && previous.unit !== unit)) setOnInsert.defaultMaxStock = 0;
    ingredientOps.push({
      updateOne: {
        filter: { normalizedName: key },
        update: {
          $set: set,
          $setOnInsert: setOnInsert,
          $addToSet: { aliases: { $each: aliases } },
        },
        upsert: true,
      },
    });
  }
  if (ingredientOps.length) await Ingredient.bulkWrite(ingredientOps);
  const allIngredients = await Ingredient.find().lean<any[]>();
  const ingredientByKey = new Map<string, any>();
  for (const ing of allIngredients) {
    for (const alias of ing.aliases ?? []) {
      const k = normalizeName(alias);
      if (k && !ingredientByKey.has(k)) ingredientByKey.set(k, ing);
    }
  }
  // El nombre propio gana sobre un alias ajeno.
  for (const ing of allIngredients) ingredientByKey.set(ing.normalizedName, ing);

  // ---------- d. Platos y recetas ----------
  // Código de SmartMenu por plato: solo si el plato tiene un único código y ese código no se usa
  // en otro plato. SmartMenu reutiliza códigos (MEDIO ACEVICHADO aparece con ROLL005 y ROLL006).
  const codesByPlato = new Map<string, Set<string>>();
  const platosByCode = new Map<string, Set<string>>();
  for (const row of aliasRows) {
    const plato = normalizeName(row.Plato);
    for (const code of (row.CodigoProducto ?? "")
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean)) {
      if (!codesByPlato.has(plato)) codesByPlato.set(plato, new Set());
      codesByPlato.get(plato)!.add(code);
      if (!platosByCode.has(code)) platosByCode.set(code, new Set());
      platosByCode.get(code)!.add(plato);
    }
  }
  // Las ventas también cuentan: un código que aparece con dos platos distintos no sirve de llave.
  for (const tickets of ticketsBySlug.values()) {
    for (const t of tickets) {
      for (const item of t.items) {
        const code = item.code?.trim();
        if (!code) continue;
        if (!platosByCode.has(code)) platosByCode.set(code, new Set());
        platosByCode.get(code)!.add(normalizeName(item.name));
      }
    }
  }
  const isSafeCode = (code: string) => (platosByCode.get(code)?.size ?? 0) === 1;
  const uniqueCodeFor = (plato: string): string => {
    const codes = [...(codesByPlato.get(plato) ?? [])];
    return codes.length === 1 && isSafeCode(codes[0]) ? codes[0] : "";
  };

  const recipeSpecs = new Map<
    string,
    { name: string; category: string; rows: typeof recetasRows }
  >();
  for (const row of recetasRows) {
    const key = normalizeName(row.Plato);
    if (!key) continue;
    if (!recipeSpecs.has(key)) {
      recipeSpecs.set(key, { name: row.Plato.trim(), category: row.Categoria.trim(), rows: [] });
    }
    recipeSpecs.get(key)!.rows.push(row);
  }

  const recipeWarnings: string[] = [];
  const productOps: any[] = [];
  for (const [key, spec] of recipeSpecs) {
    const code = uniqueCodeFor(key);
    const set: Record<string, unknown> = { category: spec.category || "General", isActive: true };
    if (code) set.smartmenuCode = code;
    productOps.push({
      updateOne: {
        filter: { normalizedName: key },
        update: {
          $set: set,
          $setOnInsert: { name: spec.name, ...(code ? {} : { smartmenuCode: "" }), priceCents: 0 },
        },
        upsert: true,
      },
    });
  }
  if (productOps.length) await Product.bulkWrite(productOps);
  // Un código ambiguo que haya quedado de antes cruzaría ventas con el plato equivocado.
  await Product.updateMany(
    {
      normalizedName: { $in: [...recipeSpecs.keys()] },
      smartmenuCode: { $nin: ["", ...[...platosByCode.keys()].filter(isSafeCode)] },
    },
    { $set: { smartmenuCode: "" } },
  );

  const recipeProducts = await Product.find({ normalizedName: { $in: [...recipeSpecs.keys()] } })
    .select("_id normalizedName")
    .lean<any[]>();
  const productIdByKey = new Map(recipeProducts.map((p) => [p.normalizedName, p._id]));
  const recipeOps: any[] = [];
  for (const [key, spec] of recipeSpecs) {
    const items = new Map<string, number>();
    for (const row of spec.rows) {
      const ing = ingredientByKey.get(normalizeName(row.Ingrediente));
      const quantity = num(row.Cantidad);
      if (!ing || quantity === null || quantity <= 0) {
        recipeWarnings.push(`${spec.name}: ${row.Ingrediente} ${row.Cantidad} ${row.Unidad}`);
        continue;
      }
      const fileUnit = normalizeUnit(row.Unidad) ?? (ing.unit as IngredientUnit);
      const converted = convertQuantity(quantity, fileUnit, ing.unit);
      if (converted === null) {
        recipeWarnings.push(`${spec.name}: ${row.Ingrediente} en ${row.Unidad} vs ${ing.unit}`);
        continue;
      }
      const id = String(ing._id);
      items.set(id, (items.get(id) ?? 0) + converted);
    }
    // La receta del archivo reemplaza completa a la anterior del plato.
    recipeOps.push({
      updateOne: {
        filter: { product: productIdByKey.get(key) },
        update: {
          $set: {
            items: [...items].map(([ingredient, quantity]) => ({
              ingredient,
              quantity: round(quantity, 4),
            })),
            notes: RECIPE_NOTE,
          },
        },
        upsert: true,
      },
    });
  }
  if (recipeOps.length) await Recipe.bulkWrite(recipeOps);

  // ---------- e. Ventas ----------
  const allProducts = await Product.find().lean<any[]>();
  const byName = new Map<string, any>(allProducts.map((p) => [p.normalizedName, p]));
  const byCode = new Map<string, any>();
  for (const p of allProducts) {
    if (p.smartmenuCode && isSafeCode(p.smartmenuCode)) byCode.set(p.smartmenuCode, p);
  }
  // Precio de menú (con IVA) de la venta más reciente: sirve de referencia en el catálogo.
  const lastPrice = new Map<string, { date: string; cents: number }>();
  const createdProducts: string[] = [];

  async function resolveProduct(item: TicketItem): Promise<any> {
    const code = item.code?.trim() ?? "";
    const safe = code && isSafeCode(code);
    if (safe && byCode.has(code)) return byCode.get(code);
    const key = normalizeName(item.name);
    let product = byName.get(key);
    if (!product) {
      product = await Product.findOneAndUpdate(
        { normalizedName: key },
        {
          $setOnInsert: {
            name: item.name.trim(),
            normalizedName: key,
            smartmenuCode: safe ? code : "",
            category: item.category || "General",
            priceCents: 0,
            isActive: true,
          },
        },
        { upsert: true, new: true },
      ).lean<any>();
      byName.set(key, product);
      createdProducts.push(product.name);
    }
    // Se aprende el código para que la sincronización diaria cruce por código y no por nombre.
    if (safe && !product.smartmenuCode) {
      await Product.updateOne({ _id: product._id }, { $set: { smartmenuCode: code } });
      product.smartmenuCode = code;
    }
    if (safe) byCode.set(code, product);
    return product;
  }

  const ticketStats: { slug: string; count: number; first: Date | null; last: Date | null }[] = [];
  for (const b of BRANCHES) {
    const tickets = ticketsBySlug.get(b.slug);
    const branch = branches.get(b.slug);
    if (!tickets?.length) {
      ticketStats.push({ slug: b.slug, count: 0, first: null, last: null });
      continue;
    }
    let first: Date | null = null;
    let last: Date | null = null;
    let ops: any[] = [];
    for (const t of tickets) {
      const date = new Date(t.date);
      if (Number.isNaN(date.getTime()) || !t.externalId) continue;
      const items = [];
      for (const item of t.items) {
        const quantity = Number(item.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0) continue;
        const product = await resolveProduct(item);
        const totalCents = Math.round(Number(item.totalCents) || 0);
        items.push({
          product: product._id,
          productName: product.name,
          smartmenuCode: item.code ?? "",
          quantity,
          unitPriceCents: Math.round(Number(item.unitPriceCents) || 0),
          totalCents,
        });
        const pk = String(product._id);
        if (totalCents > 0 && (!lastPrice.has(pk) || lastPrice.get(pk)!.date < t.date)) {
          lastPrice.set(pk, { date: t.date, cents: Math.round(totalCents / quantity) });
        }
      }
      if (!items.length) continue;
      if (!first || date < first) first = date;
      if (!last || date > last) last = date;
      const { weekday, hour } = ecuadorParts(date);
      const subtotalCents = items.reduce((sum, i) => sum + i.totalCents, 0);
      ops.push({
        updateOne: {
          filter: { branch: branch._id, externalId: t.externalId },
          update: {
            $set: {
              // El reporte de SmartMenu no trae mesero: queda vacío hasta que llegue por la sincronización.
              waiter: null,
              waiterName: "",
              date,
              weekday,
              hour,
              items,
              subtotalCents,
              totalCents: Math.round(Number(t.totalCents) || subtotalCents),
              guests: 0,
              table: "",
              status: "paid",
              source: "smartmenu",
            },
            // Lo anterior al conteo de agosto es histórico: cuenta como aplicado y no genera
            // movimientos, así ni este script ni el sincronizador lo descuentan del stock actual.
            $setOnInsert: { inventoryApplied: date < INVENTORY_CUTOFF },
          },
          upsert: true,
        },
      });
      if (ops.length >= BATCH) {
        await Sale.bulkWrite(ops, { ordered: false });
        ops = [];
      }
    }
    if (ops.length) await Sale.bulkWrite(ops, { ordered: false });
    ticketStats.push({ slug: b.slug, count: tickets.length, first, last });
  }

  // Precio de referencia solo para platos que no lo tienen: no se pisa lo que cargó el dueño.
  const priceOps = [...lastPrice].map(([id, p]) => ({
    updateOne: { filter: { _id: id, priceCents: 0 }, update: { $set: { priceCents: p.cents } } },
  }));
  for (let i = 0; i < priceOps.length; i += BATCH) {
    await Product.bulkWrite(priceOps.slice(i, i + BATCH));
  }

  // ---------- d'. Reventa 1:1 (gaseosas, aguas, cervezas) ----------
  const unitIngredients = new Map<string, any>();
  for (const [k, ing] of ingredientByKey) if (ing.unit === "unidad") unitIngredients.set(k, ing);
  const recipesNow = await Recipe.find().select("product notes items").lean<any[]>();
  const recipeByProduct = new Map(recipesNow.map((r) => [String(r.product), r]));
  const resaleMatches: string[] = [];
  const resaleOps: any[] = [];
  for (const product of byName.values()) {
    if (!RESALE_CATEGORIES.includes(normalizeName(product.category ?? ""))) continue;
    const existing = recipeByProduct.get(String(product._id));
    // Una receta cargada a mano manda sobre el cruce automático.
    if (existing && existing.notes !== RESALE_NOTE) continue;
    const n = product.normalizedName as string;
    // SmartMenu dice "retornable/desechable" y el inventario "vidrio/descartable".
    const base = n
      .replace(/\bcocacola\b/g, "coca cola")
      .replace(/\bretornable\b/g, "vidrio")
      .replace(/\bdesechable\b/g, "descartable");
    // El inventario a veces dice "Cerveza corona" y a veces solo "Club verde".
    const candidates = [
      n,
      base,
      `${base} descartable`,
      `cerveza ${base}`,
      base.replace(/^cerveza /, ""),
    ];
    const ing = candidates.map((c) => unitIngredients.get(c)).find(Boolean);
    if (!ing) continue;
    resaleMatches.push(`${product.name} → ${ing.name}`);
    resaleOps.push({
      updateOne: {
        filter: { product: product._id },
        update: { $set: { items: [{ ingredient: ing._id, quantity: 1 }], notes: RESALE_NOTE } },
        upsert: true,
      },
    });
  }
  if (resaleOps.length) await Recipe.bulkWrite(resaleOps);

  // ---------- f. Inventario inicial (conteo de cierre de agosto 2026) ----------
  const notLoaded: string[] = [];
  let initialCreated = 0;
  let initialSkipped = 0;
  for (const row of inventarioRows) {
    const branch = branchByCsv.get(normalizeName(row.Sucursal));
    const ing = ingredientByKey.get(normalizeName(row.Ingrediente));
    const quantity = num(row.Cantidad);
    const label = `${row.Sucursal} · ${row.Ingrediente} ${row.Cantidad} ${row.Unidad}`;
    if (!branch || !ing || quantity === null) {
      notLoaded.push(`${label} (sucursal, insumo o cantidad no reconocidos)`);
      continue;
    }
    const fileUnit = normalizeUnit(row.Unidad);
    const converted = fileUnit ? convertQuantity(quantity, fileUnit, ing.unit) : null;
    if (converted === null) {
      notLoaded.push(`${label} (el insumo se mide en ${ing.unit})`);
      continue;
    }
    // La fila existe aunque el conteo sea 0: así el panel lo muestra como agotado y no lo esconde.
    await StockLevel.updateOne(
      { branch: branch._id, ingredient: ing._id },
      { $setOnInsert: { quantity: 0, minStock: null, maxStock: null } },
      { upsert: true },
    );
    if (converted === 0) continue;
    const already = await InventoryMovement.exists({
      branch: branch._id,
      ingredient: ing._id,
      type: "initial",
      date: INITIAL_DATE,
    });
    if (already) {
      initialSkipped++;
      continue;
    }
    await applyMovement({
      branch: branch._id,
      ingredient: ing._id,
      type: "initial",
      quantity: round(converted, 4),
      note: "Conteo de cierre agosto 2026 (importador)",
      date: INITIAL_DATE,
    });
    initialCreated++;
  }

  // ---------- g. Descuento de inventario desde septiembre 2026 ----------
  const branchIds = [...branches.values()].map((b) => b._id);
  const pending = await Sale.find({
    branch: { $in: branchIds },
    source: "smartmenu",
    status: "paid",
    inventoryApplied: false,
    date: { $gte: INVENTORY_CUTOFF },
  })
    .select("_id branch externalId date status inventoryApplied items")
    .lean<any[]>();
  const recipes = await loadRecipes(pending.flatMap((s) => s.items.map((i: any) => i.product)));
  let applied = 0;
  // Ventas distintas en paralelo: el $inc de applyMovement es atómico y la marca evita dobles.
  await pool(pending, INVENTORY_CONCURRENCY, async (sale) => {
    if (await applySaleInventory(sale, recipes)) applied++;
  });

  // ---------- h. Umbrales sugeridos ----------
  // Sugeridos, no medidos: mínimo = 3 días y máximo = 12 días del consumo promedio de
  // septiembre 2026. Solo se llenan si están vacíos, para no pisar lo que ajuste el dueño.
  const usage = await InventoryMovement.aggregate([
    {
      $match: {
        branch: { $in: branchIds },
        type: "sale",
        date: { $gte: INVENTORY_CUTOFF, $lt: SEPT_END },
      },
    },
    { $group: { _id: { b: "$branch", i: "$ingredient" }, used: { $sum: "$quantity" } } },
  ]);
  const ingById = new Map(allIngredients.map((i) => [String(i._id), i]));
  // Enteros: nadie cuenta 0,37 botellas ni 412,6 g en la bodega.
  const nice = (value: number) => Math.max(1, Math.round(value));
  let thresholds = 0;
  for (const u of usage) {
    const ing = ingById.get(String(u._id.i));
    const daily = -u.used / SEPT_DAYS;
    if (!ing || daily <= 0) continue;
    const filter = { branch: u._id.b, ingredient: u._id.i };
    const a = await StockLevel.updateOne(
      { ...filter, minStock: null },
      { $set: { minStock: nice(daily * 3) } },
    );
    const b = await StockLevel.updateOne(
      { ...filter, maxStock: null },
      { $set: { maxStock: nice(daily * 12) } },
    );
    if (a.modifiedCount || b.modifiedCount) thresholds++;
  }

  // ---------- i. Última venta por sucursal ----------
  for (const s of ticketStats) {
    // $max: si el sincronizador ya marcó algo más nuevo, no se retrocede.
    if (s.last) await Branch.updateOne({ slug: s.slug }, { $max: { lastSyncAt: s.last } });
  }

  // ---------- j. Resumen ----------
  const [productCount, ingredientCount, recipeDocs] = await Promise.all([
    Product.countDocuments(),
    Ingredient.countDocuments(),
    Recipe.find({ "items.0": { $exists: true } })
      .select("product")
      .lean<any[]>(),
  ]);
  const withRecipe = new Set(recipeDocs.map((r) => String(r.product)));

  const septSales = await Sale.aggregate([
    {
      $match: {
        branch: { $in: branchIds },
        status: "paid",
        date: { $gte: INVENTORY_CUTOFF, $lt: SEPT_END },
      },
    },
    { $group: { _id: "$branch", cents: { $sum: "$totalCents" }, tickets: { $sum: 1 } } },
  ]);
  const septByBranch = new Map(septSales.map((s) => [String(s._id), s]));

  const soldNoRecipe = await Sale.aggregate([
    { $match: { branch: { $in: branchIds }, status: "paid", date: { $gte: INVENTORY_CUTOFF } } },
    { $unwind: "$items" },
    { $match: { "items.product": { $nin: [...withRecipe].map((id) => new Types.ObjectId(id)) } } },
    { $group: { _id: "$items.productName", units: { $sum: "$items.quantity" } } },
    { $sort: { units: -1 } },
    { $limit: 10 },
  ]);

  const levels = await StockLevel.find({ branch: { $in: branchIds } }).lean<any[]>();
  const statusByBranch = new Map<string, Record<StockStatus, number>>();
  const negatives: { branch: string; name: string; quantity: number; unit: string }[] = [];
  for (const level of levels) {
    const ing = ingById.get(String(level.ingredient));
    if (!ing) continue;
    const { minStock, maxStock } = effectiveThresholds(level, ing);
    const status = computeStatus(level.quantity, minStock, maxStock);
    const key = String(level.branch);
    if (!statusByBranch.has(key)) statusByBranch.set(key, { out: 0, low: 0, ok: 0, over: 0 });
    statusByBranch.get(key)![status]++;
    if (level.quantity < 0) {
      const branch = [...branches.values()].find((b) => String(b._id) === key);
      negatives.push({
        branch: branch?.name ?? key,
        name: ing.name,
        quantity: level.quantity,
        unit: ing.unit,
      });
    }
  }

  console.log("\nResumen de la importación real");
  console.log(`  Sucursales: ${[...branches.values()].map((b) => b.name).join(", ")}`);
  console.log(
    `  Platos: ${productCount} (${withRecipe.size} con receta, ${productCount - withRecipe.size} sin receta; ${createdProducts.length} creados desde ventas en esta corrida)`,
  );
  console.log(`  Insumos: ${ingredientCount} · Recetas con ítems: ${withRecipe.size}`);
  if (badUnits.length) console.log(`  Insumos con unidad no reconocida: ${badUnits.join(", ")}`);
  if (recipeWarnings.length)
    console.log(`  Filas de receta omitidas: ${recipeWarnings.join("; ")}`);
  console.log(`  Reventa 1:1: ${resaleMatches.length} bebidas → ${resaleMatches.join("; ")}`);
  for (const s of ticketStats) {
    const name = branches.get(s.slug).name;
    const range = s.first
      ? `${ecuadorDateKey(s.first)} a ${ecuadorDateKey(s.last!)}`
      : "sin archivo de ventas";
    console.log(`  Tickets ${name}: ${s.count} (${range})`);
  }
  for (const b of branches.values()) {
    const s = septByBranch.get(String(b._id));
    console.log(
      `  Venta septiembre 2026 ${b.name}: ${money(s?.cents ?? 0)} en ${s?.tickets ?? 0} tickets`,
    );
  }
  console.log(
    `  Inventario inicial: ${initialCreated} movimientos nuevos, ${initialSkipped} ya existían`,
  );
  console.log(`  Ventas descontadas del inventario en esta corrida: ${applied}`);
  console.log(`  Umbrales sugeridos llenados: ${thresholds}`);
  console.log(`  Filas de inventario no cargadas (${notLoaded.length}):`);
  for (const line of notLoaded) console.log(`    - ${line}`);
  console.log("  Top 10 platos vendidos sin receta desde 2026-09-01 (unidades):");
  for (const p of soldNoRecipe) console.log(`    - ${p._id}: ${p.units}`);
  for (const b of branches.values()) {
    const c = statusByBranch.get(String(b._id)) ?? { out: 0, low: 0, ok: 0, over: 0 };
    console.log(
      `  Stock hoy ${b.name}: ${c.out} agotados, ${c.low} por acabarse, ${c.ok} óptimos, ${c.over} sobrestock`,
    );
  }
  if (negatives.length) {
    console.log(`  Insumos en negativo (${negatives.length}), los 15 más negativos:`);
    for (const n of negatives.sort((a, b) => a.quantity - b.quantity).slice(0, 15)) {
      console.log(`    - ${n.branch} · ${n.name}: ${round(n.quantity, 2)} ${n.unit}`);
    }
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("✖ Falló la importación real:", error?.message ?? error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
