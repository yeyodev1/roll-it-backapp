import { Types } from "mongoose";
import { dbConnect, isConnected } from "../config/mongo";
import { CustomError } from "../errors/customError.error";
import { AgentMode, Branch } from "../models/branch.model";
import { InventoryMovement } from "../models/inventoryMovement.model";
import { Product } from "../models/product.model";
import { Recipe } from "../models/recipe.model";
import { Sale } from "../models/sale.model";
import { Waiter } from "../models/waiter.model";
import { normalizeName } from "../utils/normalize";
import { ecuadorParts, startOfEcuadorDay } from "../utils/time";
import { applyMovements, MovementInput } from "./stock.service";

const MAX_SALES_PER_BATCH = 2000;

type RecipeItems = { ingredient: Types.ObjectId; quantity: number }[];
export type RecipeMap = Map<string, RecipeItems>;

export interface SyncResult {
  received: number;
  created: number;
  updated: number;
  inventoryApplied: number;
  unmappedProducts: string[];
}

async function ensureDb() {
  if (!isConnected() && !(await dbConnect())) {
    throw new CustomError("El servidor no tiene base de datos disponible", 503);
  }
}

function cents(value: unknown): number | null {
  const n = Number(value);
  return value === undefined || value === null || value === "" || !Number.isFinite(n)
    ? null
    : Math.round(n);
}

/**
 * SmartMenu corre en la PC del local y puede mandar la hora sin zona
 * ("2026-10-13T21:30:00"). En Vercel eso se leería como UTC y la venta
 * quedaría 5 horas corrida: sin zona se asume hora de Ecuador.
 */
function parseSaleDate(value: unknown): Date | null {
  if (typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  let raw = value.trim();
  const hasTime = /\d{2}:\d{2}/.test(raw);
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  if (hasTime && !hasZone) raw = `${raw.replace(" ", "T")}-05:00`;
  else if (!hasTime && /^\d{4}-\d{2}-\d{2}$/.test(raw)) raw = `${raw}T00:00:00-05:00`;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Recetas de varios platos en una sola consulta. */
export async function loadRecipes(productIds: (string | Types.ObjectId)[]): Promise<RecipeMap> {
  const ids = [...new Set(productIds.map(String))].filter((id) => Types.ObjectId.isValid(id));
  if (!ids.length) return new Map();
  const recipes = await Recipe.find({ product: { $in: ids } })
    .select("product items")
    .lean<any[]>();
  return new Map(recipes.map((r) => [String(r.product), r.items ?? []]));
}

/**
 * Descuenta del inventario lo que consumió un ticket pagado, según la receta
 * de cada plato. Devuelve true si este llamado fue el que lo aplicó.
 *
 * La marca `inventoryApplied` se toma con un update condicional antes de
 * mover stock: si el agente reenvía el mismo lote o dos syncs se cruzan, solo
 * uno gana y el ticket nunca descuenta dos veces.
 */
export async function applySaleInventory(sale: any, recipes?: RecipeMap): Promise<boolean> {
  if (!sale?._id || sale.status !== "paid" || sale.inventoryApplied) return false;
  await ensureDb();

  const items: any[] = sale.items ?? [];
  const recipeMap = recipes ?? (await loadRecipes(items.map((i) => i.product).filter(Boolean)));

  const claimed = await Sale.findOneAndUpdate(
    { _id: sale._id, status: "paid", inventoryApplied: false },
    { $set: { inventoryApplied: true } },
  )
    .select("_id")
    .lean();
  if (!claimed) return false;
  sale.inventoryApplied = true;

  // Un movimiento por insumo y ticket, aunque varios platos usen el mismo insumo.
  const totals = new Map<string, number>();
  for (const item of items) {
    if (!item.product) continue;
    for (const r of recipeMap.get(String(item.product)) ?? []) {
      const key = String(r.ingredient);
      totals.set(key, (totals.get(key) ?? 0) + r.quantity * (Number(item.quantity) || 0));
    }
  }

  const movements: MovementInput[] = [...totals.entries()]
    .filter(([, quantity]) => quantity > 0)
    .map(([ingredient, quantity]) => ({
      branch: sale.branch,
      ingredient,
      type: "sale",
      quantity: -Math.round(quantity * 10000) / 10000,
      refModel: "Sale",
      refId: sale._id,
      note: `Venta ticket ${sale.externalId}`,
      date: sale.date,
    }));
  await applyMovements(movements);
  return true;
}

/**
 * Devuelve al stock lo que un ticket descontó. Se calcula desde el libro de
 * movimientos y no desde la receta actual, porque la receta pudo cambiar
 * después de la venta.
 */
async function revertSaleInventory(sale: any, note: string): Promise<boolean> {
  const claimed = await Sale.findOneAndUpdate(
    { _id: sale._id, inventoryApplied: true },
    { $set: { inventoryApplied: false } },
  )
    .select("_id")
    .lean();
  if (!claimed) return false;

  const net = await InventoryMovement.aggregate<{ _id: Types.ObjectId; total: number }>([
    { $match: { refModel: "Sale", refId: sale._id } },
    { $group: { _id: "$ingredient", total: { $sum: "$quantity" } } },
  ]);
  await applyMovements(
    net
      .filter((n) => Math.abs(n.total) > 1e-9)
      .map((n) => ({
        branch: sale.branch,
        ingredient: n._id,
        type: "adjustment" as const,
        quantity: -Math.round(n.total * 10000) / 10000,
        refModel: "Sale" as const,
        refId: sale._id,
        note,
      })),
  );
  return true;
}

function itemsSignature(items: any[]): string {
  return items
    .map((i) => `${String(i.product ?? i.productName)}:${i.quantity}`)
    .sort()
    .join("|");
}

export async function ingestSales(branchSlug: unknown, sales: unknown): Promise<SyncResult> {
  await ensureDb();
  const slug = typeof branchSlug === "string" ? branchSlug.trim().toLowerCase() : "";
  if (!slug) throw new CustomError("Falta la sucursal (slug)", 400);
  if (!Array.isArray(sales)) throw new CustomError("Falta la lista de ventas", 400);
  if (sales.length > MAX_SALES_PER_BATCH) {
    throw new CustomError(`Manda como máximo ${MAX_SALES_PER_BATCH} ventas por lote`, 413);
  }

  const branch = await Branch.findOne({ slug }).lean<any>();
  if (!branch) throw new CustomError(`La sucursal «${slug}» no existe`, 404);

  const result: SyncResult = {
    received: sales.length,
    created: 0,
    updated: 0,
    inventoryApplied: 0,
    unmappedProducts: [],
  };
  if (!sales.length) {
    await Branch.updateOne({ _id: branch._id }, { $set: { lastSyncAt: new Date() } });
    return result;
  }

  // --- Platos: un solo find para todo el lote, y se crean los que falten.
  const rawItems = (sales as any[]).flatMap((s) => (Array.isArray(s?.items) ? s.items : []));
  const codes = [...new Set(rawItems.map((i) => String(i?.code ?? "").trim()).filter(Boolean))];
  const names = [
    ...new Set(rawItems.map((i) => normalizeName(String(i?.name ?? ""))).filter(Boolean)),
  ];
  const known = await Product.find({
    $or: [{ smartmenuCode: { $in: codes } }, { normalizedName: { $in: names } }],
  }).lean<any[]>();
  const byCode = new Map<string, any>();
  const byName = new Map<string, any>();
  for (const p of known) {
    if (p.smartmenuCode && !byCode.has(p.smartmenuCode)) byCode.set(p.smartmenuCode, p);
    byName.set(p.normalizedName, p);
  }

  const unmapped = new Set<string>();
  async function resolveProduct(item: any): Promise<any | null> {
    const code = String(item?.code ?? "").trim();
    const name = String(item?.name ?? "").trim();
    const key = normalizeName(name);
    if (code && byCode.has(code)) return byCode.get(code);
    if (key && byName.has(key)) {
      const product = byName.get(key);
      // Se aprende el código para que el próximo cruce no dependa de cómo escriban el nombre.
      if (code && !product.smartmenuCode) {
        await Product.updateOne({ _id: product._id }, { $set: { smartmenuCode: code } });
        product.smartmenuCode = code;
        byCode.set(code, product);
      }
      return product;
    }
    if (!key) return null;
    const unitPrice = cents(item.unitPriceCents) ?? 0;
    const product = await Product.findOneAndUpdate(
      { normalizedName: key },
      {
        $setOnInsert: {
          name,
          normalizedName: key,
          smartmenuCode: code,
          category: "General",
          priceCents: Math.max(unitPrice, 0),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean<any>();
    byName.set(key, product);
    if (code) byCode.set(code, product);
    unmapped.add(name);
    return product;
  }

  // --- Meseros del lote, creando los que no existan en la sucursal.
  const waiterNames = new Map<string, string>();
  for (const s of sales as any[]) {
    const name = typeof s?.waiterName === "string" ? s.waiterName.trim() : "";
    const key = normalizeName(name);
    if (key && !waiterNames.has(key)) waiterNames.set(key, name);
  }
  const waiters = new Map<string, Types.ObjectId>();
  const knownWaiters = await Waiter.find({
    branch: branch._id,
    normalizedName: { $in: [...waiterNames.keys()] },
  })
    .select("normalizedName")
    .lean<any[]>();
  for (const w of knownWaiters) waiters.set(w.normalizedName, w._id);
  for (const [key, name] of waiterNames) {
    if (waiters.has(key)) continue;
    const waiter = await Waiter.findOneAndUpdate(
      { branch: branch._id, normalizedName: key },
      { $setOnInsert: { name, normalizedName: key, branch: branch._id } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    )
      .select("_id")
      .lean<any>();
    waiters.set(key, waiter._id);
  }

  // --- Tickets que ya existían, para saber si se crean o se actualizan.
  const externalIds = (sales as any[])
    .map((s) => String(s?.externalId ?? "").trim())
    .filter(Boolean);
  const existing = await Sale.find({ branch: branch._id, externalId: { $in: externalIds } })
    .select("externalId items status inventoryApplied branch")
    .lean<any[]>();
  const existingMap = new Map(existing.map((s) => [s.externalId, s]));

  // Se resuelven todos los platos antes para cargar sus recetas en una sola consulta.
  const prepared: { raw: any; items: any[]; date: Date; externalId: string }[] = [];
  for (const raw of sales as any[]) {
    const externalId = String(raw?.externalId ?? "").trim();
    const date = parseSaleDate(raw?.date);
    if (!externalId || !date) {
      console.warn("[sync] venta sin externalId o fecha válida, se omite", raw?.externalId);
      continue;
    }
    const items: any[] = [];
    for (const item of Array.isArray(raw.items) ? raw.items : []) {
      const quantity = Number(item?.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) continue;
      const product = await resolveProduct(item);
      if (!product) continue;
      let unitPriceCents = cents(item.unitPriceCents);
      let totalCents = cents(item.totalCents);
      if (totalCents === null) totalCents = Math.round((unitPriceCents ?? 0) * quantity);
      if (unitPriceCents === null) unitPriceCents = Math.round(totalCents / quantity);
      items.push({
        product: product._id,
        productName: String(item.name ?? product.name).trim() || product.name,
        smartmenuCode: String(item.code ?? "").trim(),
        quantity,
        unitPriceCents,
        totalCents,
      });
    }
    prepared.push({ raw, items, date, externalId });
  }

  const recipes = await loadRecipes(prepared.flatMap((p) => p.items.map((i) => i.product)));

  for (const { raw, items, date, externalId } of prepared) {
    const { weekday, hour } = ecuadorParts(date);
    const subtotalCents = items.reduce((sum, i) => sum + i.totalCents, 0);
    const waiterName = typeof raw.waiterName === "string" ? raw.waiterName.trim() : "";
    const fields = {
      waiter: waiters.get(normalizeName(waiterName)) ?? null,
      waiterName,
      date,
      weekday,
      hour,
      items,
      subtotalCents,
      totalCents: cents(raw.totalCents) ?? subtotalCents,
      guests: Math.max(Math.round(Number(raw.guests) || 0), 0),
      table: raw.table === undefined || raw.table === null ? "" : String(raw.table).trim(),
      status: raw.status === "void" ? "void" : "paid",
    };

    const previous = existingMap.get(externalId);
    let sale: any;
    let stillApplied = false;
    if (previous) {
      await Sale.updateOne({ _id: previous._id }, { $set: fields });
      result.updated++;
      sale = { ...previous, ...fields };
      stillApplied = previous.inventoryApplied;
      if (previous.inventoryApplied && fields.status === "void") {
        await revertSaleInventory(sale, `Anulación ticket ${externalId}`);
        stillApplied = false;
      } else if (
        previous.inventoryApplied &&
        itemsSignature(previous.items ?? []) !== itemsSignature(items)
      ) {
        // El ticket se editó en SmartMenu después de descontar: se devuelve lo anterior y se aplica lo nuevo.
        await revertSaleInventory(sale, `Corrección ticket ${externalId}`);
        stillApplied = false;
      }
    } else {
      try {
        sale = (
          await Sale.create({ ...fields, branch: branch._id, externalId, source: "smartmenu" })
        ).toObject();
        result.created++;
      } catch (error: any) {
        // Otro sync guardó el mismo ticket en paralelo: ese se encarga del inventario.
        if (error?.code === 11000) continue;
        throw error;
      }
    }

    if (fields.status === "paid" && !stillApplied) {
      sale.inventoryApplied = false;
      if (await applySaleInventory(sale, recipes)) result.inventoryApplied++;
    }
  }

  await Branch.updateOne({ _id: branch._id }, { $set: { lastSyncAt: new Date() } });
  result.unmappedProducts = [...unmapped];
  return result;
}

const AGENT_MODES: AgentMode[] = ["descubrir", "carpeta", "auto"];
// Con un latido cada pocos minutos, 10 sin noticias ya es que la PC o internet se cayó.
export const AGENT_LIVE_MS = 10 * 60 * 1000;
const MAX_ERROR_LENGTH = 500;

export type AgentState = "live" | "offline" | "none";

export function agentState(
  lastSeenAt: Date | string | null | undefined,
  now = new Date(),
): AgentState {
  if (!lastSeenAt) return "none";
  return now.getTime() - new Date(lastSeenAt).getTime() < AGENT_LIVE_MS ? "live" : "offline";
}

/** POST /sync/heartbeat: el agente avisa que sigue vivo en cada ciclo. */
export async function recordHeartbeat(body: any) {
  await ensureDb();
  const slug = typeof body?.branch === "string" ? body.branch.trim().toLowerCase() : "";
  if (!slug) throw new CustomError("Falta la sucursal (slug)", 400);
  const mode = typeof body?.mode === "string" ? body.mode.trim().toLowerCase() : "";
  if (!AGENT_MODES.includes(mode as AgentMode)) {
    throw new CustomError(`El modo debe ser ${AGENT_MODES.join(", ")}`, 400);
  }
  const version =
    typeof body?.agentVersion === "string" ? body.agentVersion.trim().slice(0, 40) : "";
  const lastError =
    typeof body?.lastError === "string" ? body.lastError.trim().slice(0, MAX_ERROR_LENGTH) : "";

  const now = new Date();
  const branch = await Branch.findOneAndUpdate(
    { slug },
    { $set: { agentLastSeenAt: now, agentStatus: { version, mode, lastError } } },
    { new: true },
  )
    .select("_id name slug agentLastSeenAt agentStatus")
    .lean<any>();
  if (!branch) throw new CustomError(`La sucursal «${slug}» no existe`, 404);
  return {
    ok: true,
    branch: { _id: branch._id, name: branch.name, slug: branch.slug },
    serverTime: now,
  };
}

export async function getSyncStatus() {
  await ensureDb();
  const since = startOfEcuadorDay(new Date());
  const [branches, today] = await Promise.all([
    Branch.find().sort({ name: 1 }).lean<any[]>(),
    Sale.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { date: { $gte: since }, status: "paid" } },
      { $group: { _id: "$branch", count: { $sum: 1 } } },
    ]),
  ]);
  const counts = new Map(today.map((t) => [String(t._id), t.count]));
  const now = new Date();
  return branches.map((branch) => ({
    branch,
    lastSyncAt: branch.lastSyncAt ?? null,
    salesToday: counts.get(String(branch._id)) ?? 0,
    agent: {
      state: agentState(branch.agentLastSeenAt, now),
      lastSeenAt: branch.agentLastSeenAt ?? null,
      version: branch.agentStatus?.version ?? "",
      mode: branch.agentStatus?.mode ?? "",
      lastError: branch.agentStatus?.lastError ?? "",
    },
  }));
}
