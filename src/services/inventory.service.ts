import { Types } from "mongoose";
import { dbConnect, isConnected } from "../config/mongo";
import { CustomError } from "../errors/customError.error";
import { Branch } from "../models/branch.model";
import { Ingredient } from "../models/ingredient.model";
import { InventoryMovement, MOVEMENT_TYPES } from "../models/inventoryMovement.model";
import { StockLevel } from "../models/stockLevel.model";
import { normalizeName } from "../utils/normalize";
import { applyMovement, computeStatus, effectiveThresholds, StockStatus } from "./stock.service";

const USAGE_WINDOW_DAYS = 14;
const STATUSES: StockStatus[] = ["out", "low", "ok", "over"];

export interface StockRow {
  ingredient: { _id: Types.ObjectId; name: string; unit: string };
  branch: { _id: Types.ObjectId; name: string };
  quantity: number;
  minStock: number;
  maxStock: number;
  status: StockStatus;
  daysLeft: number | null;
  avgDailyUse: number;
}

async function ensureDb() {
  if (!isConnected() && !(await dbConnect())) {
    throw new CustomError("El servidor no tiene base de datos disponible", 503);
  }
}

function assertId(id: string, message: string) {
  if (!Types.ObjectId.isValid(id)) throw new CustomError(message, 400);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

async function findBranch(id: string | null) {
  if (!id) throw new CustomError("Elige una sucursal", 400);
  assertId(id, "Sucursal inválida");
  const branch = await Branch.findById(id).select("name").lean<any>();
  if (!branch) throw new CustomError("Sucursal no encontrada", 404);
  return branch;
}

async function findIngredient(id: unknown) {
  const value = typeof id === "string" ? id : "";
  assertId(value, "Insumo inválido");
  const ingredient = await Ingredient.findById(value).lean<any>();
  if (!ingredient) throw new CustomError("Insumo no encontrado", 404);
  return ingredient;
}

/**
 * Arma las filas insumo × sucursal. Se recorre el producto cartesiano y no
 * solo los StockLevel existentes porque un insumo que nunca tuvo movimiento
 * también tiene que verse (en cero, agotado) para que alguien lo cargue.
 */
async function buildRows(branches: any[], ingredients: any[]): Promise<StockRow[]> {
  if (!branches.length || !ingredients.length) return [];
  const branchIds = branches.map((b) => b._id);
  const ingredientIds = ingredients.map((i) => i._id);
  const since = new Date(Date.now() - USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [levels, usage] = await Promise.all([
    StockLevel.find({ branch: { $in: branchIds }, ingredient: { $in: ingredientIds } }).lean<
      any[]
    >(),
    InventoryMovement.aggregate<{
      _id: { branch: Types.ObjectId; ingredient: Types.ObjectId };
      total: number;
    }>([
      {
        $match: {
          // Las devoluciones de tickets anulados o corregidos restan: si no, una anulación inflaría el consumo.
          $or: [{ type: "sale" }, { type: "adjustment", refModel: "Sale" }],
          branch: { $in: branchIds },
          ingredient: { $in: ingredientIds },
          date: { $gte: since },
        },
      },
      {
        $group: {
          _id: { branch: "$branch", ingredient: "$ingredient" },
          total: { $sum: "$quantity" },
        },
      },
    ]),
  ]);

  const key = (b: unknown, i: unknown) => `${String(b)}:${String(i)}`;
  const levelMap = new Map(levels.map((l) => [key(l.branch, l.ingredient), l]));
  // Las ventas se guardan en negativo: el consumo es el opuesto.
  const usageMap = new Map(usage.map((u) => [key(u._id.branch, u._id.ingredient), -u.total]));

  const rows: StockRow[] = [];
  for (const ingredient of ingredients) {
    for (const branch of branches) {
      const level = levelMap.get(key(branch._id, ingredient._id)) ?? null;
      const quantity = round(level?.quantity ?? 0, 4);
      const { minStock, maxStock } = effectiveThresholds(level, ingredient);
      const used = Math.max(usageMap.get(key(branch._id, ingredient._id)) ?? 0, 0);
      const avgDailyUse = round(used / USAGE_WINDOW_DAYS, 3);
      rows.push({
        ingredient: { _id: ingredient._id, name: ingredient.name, unit: ingredient.unit },
        branch: { _id: branch._id, name: branch.name },
        quantity,
        minStock,
        maxStock,
        status: computeStatus(quantity, minStock, maxStock),
        daysLeft: avgDailyUse > 0 ? round(Math.max(quantity, 0) / avgDailyUse, 1) : null,
        avgDailyUse,
      });
    }
  }
  return rows;
}

async function scopeBranches(branchId: string | null) {
  if (branchId) return [await findBranch(branchId)];
  return Branch.find({ isActive: true }).select("name").sort({ name: 1 }).lean<any[]>();
}

async function singleRow(branchId: string, ingredientId: string): Promise<StockRow> {
  const [branch, ingredient] = await Promise.all([
    findBranch(branchId),
    findIngredient(ingredientId),
  ]);
  const [row] = await buildRows([branch], [ingredient]);
  return row;
}

export async function getInventory(branchId: string | null, status?: string) {
  await ensureDb();
  if (status && !STATUSES.includes(status as StockStatus)) {
    throw new CustomError("Estado de stock inválido", 400);
  }
  const [branches, ingredients] = await Promise.all([
    scopeBranches(branchId),
    Ingredient.find({ isActive: true }).sort({ name: 1 }).lean<any[]>(),
  ]);
  const all = await buildRows(branches, ingredients);

  // Los conteos van sobre todas las filas para que las pestañas del panel muestren el total aunque se filtre.
  const counts = { out: 0, low: 0, ok: 0, over: 0 };
  for (const row of all) counts[row.status]++;

  const rows = status ? all.filter((r) => r.status === status) : all;
  return { rows, counts };
}

export async function listMovements(filters: {
  branch: string | null;
  ingredient?: string;
  type?: string;
  page?: number;
  limit?: number;
}) {
  await ensureDb();
  const query: Record<string, unknown> = {};
  if (filters.branch) {
    assertId(filters.branch, "Sucursal inválida");
    query.branch = filters.branch;
  }
  if (filters.ingredient) {
    assertId(filters.ingredient, "Insumo inválido");
    query.ingredient = filters.ingredient;
  }
  if (filters.type) {
    if (!(MOVEMENT_TYPES as readonly string[]).includes(filters.type)) {
      throw new CustomError("Tipo de movimiento inválido", 400);
    }
    query.type = filters.type;
  }

  const limit = Math.min(Math.max(Math.floor(filters.limit || 50), 1), 200);
  const page = Math.max(Math.floor(filters.page || 1), 1);

  const [items, total] = await Promise.all([
    InventoryMovement.find(query)
      .sort({ date: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("branch", "name")
      .populate("ingredient", "name unit")
      .populate("createdBy", "name")
      .select("branch ingredient type quantity note date createdBy")
      .lean(),
    InventoryMovement.countDocuments(query),
  ]);

  return { items, total, page, pages: Math.max(Math.ceil(total / limit), 1) };
}

export async function setInitialStock(
  branchId: string | null,
  items: unknown,
  userId: string | null,
) {
  await ensureDb();
  const branch = await findBranch(branchId);
  if (!Array.isArray(items) || !items.length) {
    throw new CustomError("Agrega al menos un insumo con su cantidad", 400);
  }

  // Si un insumo viene repetido gana la última cantidad, como en una planilla.
  const targets = new Map<string, number>();
  for (const raw of items as any[]) {
    const ingredient = typeof raw?.ingredient === "string" ? raw.ingredient : "";
    const quantity = Number(raw?.quantity);
    assertId(ingredient, "Insumo inválido");
    if (!Number.isFinite(quantity) || quantity < 0) {
      throw new CustomError("Las cantidades del inventario inicial no pueden ser negativas", 400);
    }
    targets.set(ingredient, quantity);
  }

  const ids = [...targets.keys()];
  const [found, levels] = await Promise.all([
    Ingredient.countDocuments({ _id: { $in: ids } }),
    StockLevel.find({ branch: branch._id, ingredient: { $in: ids } }).lean<any[]>(),
  ]);
  if (found !== ids.length) throw new CustomError("Algún insumo no existe", 404);
  const current = new Map(levels.map((l) => [String(l.ingredient), l.quantity ?? 0]));

  // Se mueve solo la diferencia: el libro sigue cuadrando con lo que había antes.
  let updated = 0;
  for (const [ingredient, target] of targets) {
    const diff = round(target - (current.get(ingredient) ?? 0), 4);
    if (diff === 0) continue;
    await applyMovement({
      branch: branch._id,
      ingredient,
      type: "initial",
      quantity: diff,
      note: "Inventario inicial",
      createdBy: userId,
    });
    updated++;
  }
  return { ok: true, updated };
}

export async function adjustStock(
  branchId: string | null,
  input: Record<string, unknown>,
  userId: string | null,
) {
  await ensureDb();
  const branch = await findBranch(branchId);
  const ingredient = await findIngredient(input.ingredient);
  const type = input.type;
  if (type !== "adjustment" && type !== "waste") {
    throw new CustomError("El tipo debe ser ajuste o merma", 400);
  }
  let quantity = Number(input.quantity);
  if (!Number.isFinite(quantity) || quantity === 0) {
    throw new CustomError("Escribe una cantidad distinta de cero", 400);
  }
  // Una merma siempre resta, aunque la escriban en positivo.
  if (type === "waste") quantity = -Math.abs(quantity);

  const note = typeof input.note === "string" ? input.note.trim() : "";
  await applyMovement({
    branch: branch._id,
    ingredient: ingredient._id,
    type,
    quantity,
    note: note || (type === "waste" ? "Merma" : "Ajuste manual"),
    createdBy: userId,
  });
  return singleRow(String(branch._id), String(ingredient._id));
}

function parseThreshold(value: unknown, label: string): number | null {
  // null o vacío = volver al umbral por defecto del insumo.
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new CustomError(`${label} no es válido`, 400);
  return n;
}

export async function setThresholds(branchId: string | null, input: Record<string, unknown>) {
  await ensureDb();
  const branch = await findBranch(branchId);
  const ingredient = await findIngredient(input.ingredient);
  const minStock = parseThreshold(input.minStock, "El stock mínimo");
  const maxStock = parseThreshold(input.maxStock, "El stock máximo");
  if (minStock !== null && maxStock !== null && maxStock > 0 && minStock > maxStock) {
    throw new CustomError("El stock mínimo no puede ser mayor que el máximo", 400);
  }

  // Solo umbrales: la cantidad la sigue moviendo únicamente stock.service.
  await StockLevel.findOneAndUpdate(
    { branch: branch._id, ingredient: ingredient._id },
    { $set: { minStock, maxStock } },
    { upsert: true, setDefaultsOnInsert: true },
  );
  return singleRow(String(branch._id), String(ingredient._id));
}

const STOP_WORDS = new Set([
  "cuanto",
  "cuanta",
  "cuantos",
  "cuantas",
  "queda",
  "quedan",
  "hay",
  "tenemos",
  "tengo",
  "de",
  "del",
  "el",
  "la",
  "los",
  "las",
  "en",
  "que",
  "me",
  "nos",
  "stock",
  "inventario",
]);

const STATUS_LABELS: Record<StockStatus, string> = {
  out: "agotado",
  low: "por acabarse",
  ok: "óptimo",
  over: "sobrestock",
};

const numberFormat = new Intl.NumberFormat("es-EC", { maximumFractionDigits: 1 });

/** "2400 g" se lee mejor como "2,4 kg" en una respuesta corta. */
function formatQuantity(quantity: number, unit: string): string {
  if (unit === "g" && Math.abs(quantity) >= 1000)
    return `${numberFormat.format(quantity / 1000)} kg`;
  if (unit === "ml" && Math.abs(quantity) >= 1000)
    return `${numberFormat.format(quantity / 1000)} l`;
  if (unit === "unidad")
    return `${numberFormat.format(quantity)} ${quantity === 1 ? "unidad" : "unidades"}`;
  return `${numberFormat.format(quantity)} ${unit}`;
}

function describeRow(row: StockRow): string {
  const where = `en ${row.branch.name}`;
  if (row.quantity <= 0) return `${row.ingredient.name}: no queda nada ${where} (agotado)`;
  let detail = STATUS_LABELS[row.status];
  if (row.daysLeft !== null) {
    detail +=
      row.daysLeft < 1
        ? ", no alcanza para un día"
        : `, alcanza ~${Math.round(row.daysLeft)} ${Math.round(row.daysLeft) === 1 ? "día" : "días"}`;
  }
  return `${row.ingredient.name}: quedan ${formatQuantity(row.quantity, row.ingredient.unit)} ${where} (${detail})`;
}

function matchIngredients(ingredients: any[], text: string): any[] {
  const keysOf = (i: any) =>
    [i.normalizedName, ...(i.aliases ?? []).map(normalizeName)].filter(Boolean);

  // 1) el texto está dentro del nombre ("salm" → "Salmón"); 2) el nombre está dentro de la frase
  // ("cuánto salmón queda"); 3) alguna palabra suelta de la frase está en el nombre.
  const direct = ingredients.filter((i) => keysOf(i).some((k: string) => k.includes(text)));
  if (direct.length) return direct;
  const inSentence = ingredients.filter((i) => keysOf(i).some((k: string) => text.includes(k)));
  if (inSentence.length) return inSentence;
  const words = text.split(" ").filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  return ingredients.filter((i) => keysOf(i).some((k: string) => words.some((w) => k.includes(w))));
}

export async function askStock(q: string, branchId: string | null) {
  await ensureDb();
  let text = normalizeName(q ?? "");
  if (!text) throw new CustomError("Escribe qué insumo quieres consultar", 400);

  let branches = await scopeBranches(branchId);
  // El dueño puede nombrar la sucursal en la pregunta ("salmón en villa club") sin elegirla en el filtro.
  if (!branchId) {
    const named = branches.filter((b) => text.includes(normalizeName(b.name)));
    if (named.length) {
      branches = named;
      for (const b of named) text = text.replace(normalizeName(b.name), " ");
      text = text.replace(/\s+/g, " ").trim();
    }
  }

  const ingredients = await Ingredient.find({ isActive: true }).sort({ name: 1 }).lean<any[]>();
  const matched = text ? matchIngredients(ingredients, text).slice(0, 5) : [];
  if (!matched.length) {
    return { answer: `No encontré un insumo que se parezca a «${q.trim()}»`, rows: [] };
  }

  const rows = await buildRows(branches, matched);
  const answer = rows.length
    ? rows.map(describeRow).join("\n")
    : "No hay sucursales activas para consultar";
  return { answer, rows };
}
