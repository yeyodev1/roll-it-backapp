/**
 * Importa lo que traen los cierres de mes de los locales (carpeta del Drive
 * CIERRE MES LOCALES): el día a día de cada mesera y las compras pagadas con
 * caja chica.
 *
 * Uso: IMPORT_DIR=<carpeta> pnpm import:drive
 *
 * La carpeta trae `meseros-cierre.jsonl` y `compras-cierre.jsonl` (en la raíz
 * o en `import/`), generados por `import/prep_drive.py` a partir de los .xlsx.
 * Los datos del cliente no viven en el repo (es público): por eso llegan por env.
 * Correr antes `pnpm import:real`: crea las sucursales, los insumos y el conteo
 * inicial que decide qué compras mueven stock.
 *
 * Es idempotente: meseras por (sucursal, nombre), días por (mesera, fecha),
 * compras por (sucursal, externalId) y el stock de cada compra se suma una sola
 * vez. Correrlo dos veces deja la base igual.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose, { Types } from "mongoose";
import { env } from "../config/env";
import { Branch } from "../models/branch.model";
import { Ingredient } from "../models/ingredient.model";
import { InventoryMovement } from "../models/inventoryMovement.model";
import { PurchaseInvoice } from "../models/purchaseInvoice.model";
import { Waiter } from "../models/waiter.model";
import { WaiterDay } from "../models/waiterDay.model";
import { convertQuantity, normalizeUnit } from "../services/recipeImport.service";
import { applyMovement } from "../services/stock.service";
import { normalizeName } from "../utils/normalize";
import { ecuadorDateKey, parseEcuadorDate } from "../utils/time";

// Mismo conteo que usa import-real.ts si una sucursal todavía no tiene movimiento "initial".
const FALLBACK_COUNT_DATE = new Date("2026-08-31T23:59:00-05:00");
const BRANCH_NAMES: Record<string, string> = {
  "villa-club": "Villa Club",
  marbol: "Marbol",
  cuenca: "Cuenca",
};

interface WaiterDayRow {
  branch: string;
  waiter: string;
  date: string;
  tables: number;
  upsell: Record<string, number>;
  upsellUnits: number;
  source: string;
}

interface PurchaseRow {
  branch: string;
  externalId: string;
  date: string;
  supplier: string;
  rawName: string;
  ingredient: string;
  quantity: number;
  unit: string;
  totalCents: number;
  source: string;
}

function findFile(dir: string, name: string): string | null {
  for (const candidate of [path.join(dir, name), path.join(dir, "import", name)]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function readJsonl<T>(file: string | null): T[] {
  if (!file) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

function toDate(key: string): Date {
  const date = parseEcuadorDate(key);
  if (!date) throw new Error(`Fecha inválida en el cierre: ${key}`);
  return date;
}

const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];
// "2026-07-03" → "julio 2026" / "3 de julio de 2026", sin pasar por la zona horaria.
const monthLabel = (key: string) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
const dayLabel = (key: string) =>
  `${Number(key.slice(8, 10))} de ${MONTHS[Number(key.slice(5, 7)) - 1]} de ${key.slice(0, 4)}`;

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  const dir = process.env.IMPORT_DIR?.trim();
  // IMPORT_DIR es un parámetro del script, no configuración de la app: por eso no está en env.ts.
  if (!dir)
    throw new Error("Falta IMPORT_DIR (carpeta con meseros-cierre.jsonl y compras-cierre.jsonl)");
  const daysFile = findFile(dir, "meseros-cierre.jsonl");
  const purchasesFile = findFile(dir, "compras-cierre.jsonl");
  if (!daysFile && !purchasesFile) {
    throw new Error(
      "No encontré meseros-cierre.jsonl ni compras-cierre.jsonl: corre prep_drive.py",
    );
  }
  const dayRows = readJsonl<WaiterDayRow>(daysFile);
  const purchaseRows = readJsonl<PurchaseRow>(purchasesFile);

  console.log("Conectando a MongoDB...");
  await mongoose.connect(env.DB_URI);

  // ---------- Sucursales ----------
  const slugs = [...new Set([...dayRows, ...purchaseRows].map((r) => r.branch))];
  const branches = new Map<string, any>();
  for (const slug of slugs) {
    const doc = await Branch.findOneAndUpdate(
      { slug },
      {
        $setOnInsert: { name: BRANCH_NAMES[slug] ?? slug, slug, smartmenuUrl: "", isActive: true },
      },
      { upsert: true, new: true },
    ).lean<any>();
    branches.set(slug, doc);
  }

  // ---------- Meseras ----------
  const waiterIds = new Map<string, Types.ObjectId>();
  for (const row of dayRows) {
    const k = `${row.branch}:${normalizeName(row.waiter)}`;
    if (waiterIds.has(k)) continue;
    const branch = branches.get(row.branch);
    const doc = await Waiter.findOneAndUpdate(
      { branch: branch._id, normalizedName: normalizeName(row.waiter) },
      { $setOnInsert: { name: row.waiter.trim(), isActive: true } },
      { upsert: true, new: true },
    ).lean<any>();
    waiterIds.set(k, doc._id);
  }

  const dayOps = dayRows.map((row) => ({
    updateOne: {
      filter: {
        waiter: waiterIds.get(`${row.branch}:${normalizeName(row.waiter)}`),
        date: toDate(row.date),
      },
      update: {
        $set: {
          branch: branches.get(row.branch)._id,
          tables: row.tables,
          upsell: row.upsell,
          upsellUnits: row.upsellUnits,
          source: row.source,
        },
        // El cierre no trae venta en $ por mesera: si algún día llega por otra vía, no se pisa.
        $setOnInsert: { salesCents: null },
      },
      upsert: true,
    },
  }));
  const dayResult = dayOps.length ? await WaiterDay.bulkWrite(dayOps) : null;

  // ---------- Compras de caja chica ----------
  const ingredients = await Ingredient.find()
    .select("_id name normalizedName unit aliases")
    .lean<any[]>();
  const ingredientByKey = new Map<string, any>();
  for (const ing of ingredients) {
    for (const alias of ing.aliases ?? []) {
      const k = normalizeName(alias);
      if (k && !ingredientByKey.has(k)) ingredientByKey.set(k, ing);
    }
  }
  for (const ing of ingredients) ingredientByKey.set(ing.normalizedName, ing);

  // El stock arranca en el conteo físico de cada sucursal: una compra anterior ya está dentro de ese conteo.
  const counts = await InventoryMovement.aggregate([
    { $match: { type: "initial" } },
    { $group: { _id: "$branch", date: { $min: "$date" } } },
  ]);
  const countDate = new Map<string, Date>(counts.map((c) => [String(c._id), c.date as Date]));

  const existing = new Set(
    (
      await PurchaseInvoice.find({ externalId: { $in: purchaseRows.map((r) => r.externalId) } })
        .select("externalId")
        .lean<any[]>()
    ).map((d) => d.externalId),
  );

  let created = 0;
  let updated = 0;
  let historical = 0;
  let movementsApplied = 0;
  let linked = 0;
  const unmatchedHints = new Set<string>();
  const totals = new Map<string, { count: number; cents: number }>();

  for (const row of purchaseRows) {
    const branch = branches.get(row.branch);
    const date = toDate(row.date);
    const counted = countDate.get(String(branch._id)) ?? FALLBACK_COUNT_DATE;
    const movesStock = date > counted;

    const ing = row.ingredient ? ingredientByKey.get(normalizeName(row.ingredient)) : null;
    if (row.ingredient && !ing) unmatchedHints.add(row.ingredient);
    if (ing) linked++;
    const fileUnit = normalizeUnit(row.unit) ?? ing?.unit ?? null;
    const quantity =
      ing && row.quantity > 0 && fileUnit
        ? (convertQuantity(row.quantity, fileUnit, ing.unit) ?? 0)
        : 0;

    const month = monthLabel(row.date);
    const note =
      movesStock && quantity > 0
        ? `Compra del cierre de caja chica de ${month}.`
        : movesStock
          ? `Compra del cierre de caja chica de ${month}. El cierre no anota cantidades: no suma stock.`
          : `Compra histórica del cierre de caja chica de ${month}: es anterior al conteo inicial del ${dayLabel(ecuadorDateKey(counted))}, así que no mueve stock.`;

    const doc = await PurchaseInvoice.findOneAndUpdate(
      { branch: branch._id, externalId: row.externalId },
      {
        $set: {
          supplier: row.supplier,
          date,
          status: "confirmed",
          extractedBy: "manual",
          source: "closing",
          note,
          lines: [
            {
              rawName: row.rawName,
              ingredient: ing?._id ?? null,
              quantity,
              rawQuantity: row.quantity || 0,
              rawUnit: row.unit || "",
              unitCostCents: quantity > 0 ? Math.round(row.totalCents / quantity) : 0,
              totalCents: row.totalCents,
            },
          ],
          totalCents: row.totalCents,
          confirmedAt: date,
        },
        $setOnInsert: { invoiceNumber: "", imageUrl: "", imagePublicId: "", aiError: "" },
      },
      { upsert: true, new: true },
    ).lean<any>();
    if (existing.has(row.externalId)) updated++;
    else created++;
    if (!movesStock) historical++;

    if (movesStock && ing && quantity > 0) {
      const already = await InventoryMovement.exists({
        refModel: "PurchaseInvoice",
        refId: doc._id,
        ingredient: ing._id,
      });
      if (!already) {
        await applyMovement({
          branch: branch._id,
          ingredient: ing._id,
          type: "purchase",
          quantity,
          refModel: "PurchaseInvoice",
          refId: doc._id,
          note: `Caja chica ${row.supplier} ${row.date}`,
          date,
        });
        movementsApplied++;
      }
    }

    const t = totals.get(row.branch) ?? { count: 0, cents: 0 };
    totals.set(row.branch, { count: t.count + 1, cents: t.cents + row.totalCents });
  }

  // ---------- Resumen ----------
  console.log("\nResumen");
  const byBranch = new Map<string, { waiters: Set<string>; days: number; tables: number }>();
  for (const row of dayRows) {
    const b = byBranch.get(row.branch) ?? { waiters: new Set(), days: 0, tables: 0 };
    b.waiters.add(row.waiter);
    b.days++;
    b.tables += row.tables;
    byBranch.set(row.branch, b);
  }
  for (const [slug, b] of byBranch) {
    console.log(
      `  ${BRANCH_NAMES[slug] ?? slug}: ${b.waiters.size} meseras (${[...b.waiters].join(", ")}), ${b.days} días, ${b.tables} mesas`,
    );
  }
  if (dayResult) {
    console.log(
      `  Días de mesera: ${dayResult.upsertedCount} nuevos, ${dayResult.modifiedCount} actualizados`,
    );
  }
  for (const [slug, t] of totals) {
    console.log(`  Compras ${BRANCH_NAMES[slug] ?? slug}: ${t.count} (${money(t.cents)})`);
  }
  console.log(
    `  Compras: ${created} nuevas, ${updated} ya existían, ${historical} históricas sin mover stock, ${linked} cruzadas con insumo, ${movementsApplied} movimientos de stock`,
  );
  if (unmatchedHints.size) {
    console.log(`  Insumos no encontrados: ${[...unmatchedHints].join(", ")}`);
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => undefined);
  process.exitCode = 1;
});
