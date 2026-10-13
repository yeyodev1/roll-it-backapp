import { Types } from "mongoose";
import { dbConnect, isConnected } from "../config/mongo";
import { CustomError } from "../errors/customError.error";
import { Branch } from "../models/branch.model";
import { Sale } from "../models/sale.model";
import { StockLevel } from "../models/stockLevel.model";
import { computeStatus, effectiveThresholds } from "./stock.service";
import { ecuadorDateKey, parseEcuadorDate, startOfEcuadorDay } from "../utils/time";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 30;
// $dateToString necesita la zona como desfase; Ecuador no tiene horario de verano.
export const ECUADOR_TZ = "-05:00";

export interface DashboardQuery {
  branch?: unknown;
  from?: unknown;
  to?: unknown;
}

export interface DashboardRange {
  from: string;
  to: string;
  start: Date;
  // Exclusivo: inicio del día siguiente a `to`.
  end: Date;
}

export async function ensureDb() {
  if (isConnected()) return;
  if (!(await dbConnect())) {
    throw new CustomError("El servidor no tiene base de datos disponible", 503);
  }
}

export function parseBranch(value: unknown): Types.ObjectId | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || raw === "all") return null;
  if (!Types.ObjectId.isValid(raw)) throw new CustomError("Sucursal inválida", 400);
  return new Types.ObjectId(raw);
}

export function resolveRange(query: DashboardQuery): DashboardRange {
  const fromRaw = typeof query.from === "string" ? query.from.trim() : "";
  const toRaw = typeof query.to === "string" ? query.to.trim() : "";

  const toStart = toRaw ? parseEcuadorDate(toRaw) : startOfEcuadorDay(new Date());
  if (!toStart) throw new CustomError("La fecha 'to' debe tener el formato AAAA-MM-DD", 400);

  const start = fromRaw
    ? parseEcuadorDate(fromRaw)
    : new Date(toStart.getTime() - (DEFAULT_DAYS - 1) * DAY_MS);
  if (!start) throw new CustomError("La fecha 'from' debe tener el formato AAAA-MM-DD", 400);

  const end = new Date(toStart.getTime() + DAY_MS);
  if (start >= end) throw new CustomError("La fecha 'from' no puede ser posterior a 'to'", 400);

  return { from: ecuadorDateKey(start), to: ecuadorDateKey(toStart), start, end };
}

export function salesMatch(branch: Types.ObjectId | null, start: Date, end: Date) {
  const match: Record<string, unknown> = {
    date: { $gte: start, $lt: end },
    status: { $ne: "void" },
  };
  if (branch) match.branch = branch;
  return match;
}

export function ratio(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

async function totalsFor(branch: Types.ObjectId | null, start: Date, end: Date) {
  const [row] = await Sale.aggregate([
    { $match: salesMatch(branch, start, end) },
    {
      $group: {
        _id: null,
        salesCents: { $sum: "$totalCents" },
        tickets: { $sum: 1 },
        itemsSold: { $sum: { $sum: "$items.quantity" } },
      },
    },
  ]);
  const salesCents = row?.salesCents ?? 0;
  const tickets = row?.tickets ?? 0;
  return {
    salesCents,
    tickets,
    avgTicketCents: tickets ? Math.round(salesCents / tickets) : 0,
    itemsSold: row?.itemsSold ?? 0,
  };
}

/**
 * Alertas de inventario. Solo cuentan los StockLevel existentes: un insumo
 * que nunca tuvo stock en una sucursal suele ser uno que esa sucursal no usa,
 * y contarlo como agotado llenaría el tablero de falsas alarmas.
 */
async function inventoryAlerts(branch: Types.ObjectId | null) {
  const rows = await StockLevel.aggregate([
    { $match: branch ? { branch } : {} },
    { $lookup: { from: "ingredients", localField: "ingredient", foreignField: "_id", as: "ing" } },
    { $unwind: "$ing" },
    { $match: { "ing.isActive": true } },
    {
      $project: {
        quantity: 1,
        minStock: 1,
        maxStock: 1,
        defaultMinStock: "$ing.defaultMinStock",
        defaultMaxStock: "$ing.defaultMaxStock",
      },
    },
  ]);

  const counts = { out: 0, low: 0 };
  for (const row of rows) {
    const { minStock, maxStock } = effectiveThresholds(row, row);
    const status = computeStatus(row.quantity, minStock, maxStock);
    if (status === "out") counts.out++;
    if (status === "low") counts.low++;
  }
  return counts;
}

export async function getSummary(query: DashboardQuery) {
  await ensureDb();
  const branch = parseBranch(query.branch);
  const range = resolveRange(query);
  const { start, end } = range;
  const prevStart = new Date(start.getTime() - (end.getTime() - start.getTime()));

  const [current, previous, byBranchRaw, dailyRaw, alerts, branches] = await Promise.all([
    totalsFor(branch, start, end),
    totalsFor(branch, prevStart, start),
    Sale.aggregate([
      { $match: salesMatch(branch, start, end) },
      { $group: { _id: "$branch", salesCents: { $sum: "$totalCents" }, tickets: { $sum: 1 } } },
      { $sort: { salesCents: -1 } },
    ]),
    Sale.aggregate([
      { $match: salesMatch(branch, start, end) },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$date", timezone: ECUADOR_TZ } },
          salesCents: { $sum: "$totalCents" },
          tickets: { $sum: 1 },
        },
      },
    ]),
    inventoryAlerts(branch),
    Branch.find(branch ? { _id: branch } : {})
      .select("name lastSyncAt")
      .lean<any[]>(),
  ]);

  const names = new Map(branches.map((b) => [b._id.toString(), b.name as string]));
  const byBranch = byBranchRaw.map((row) => ({
    branch: { _id: row._id, name: names.get(row._id.toString()) ?? "Sucursal eliminada" },
    salesCents: row.salesCents,
    tickets: row.tickets,
    avgTicketCents: row.tickets ? Math.round(row.salesCents / row.tickets) : 0,
    share: ratio(row.salesCents, current.salesCents),
  }));

  // Los días sin ventas se rellenan para que el gráfico no salte fechas.
  const dailyMap = new Map(dailyRaw.map((row) => [row._id as string, row]));
  const daily: { date: string; salesCents: number; tickets: number }[] = [];
  for (let t = start.getTime(); t < end.getTime(); t += DAY_MS) {
    const key = ecuadorDateKey(new Date(t));
    const row = dailyMap.get(key);
    daily.push({ date: key, salesCents: row?.salesCents ?? 0, tickets: row?.tickets ?? 0 });
  }

  const syncTimes = branches
    .map((b) => (b.lastSyncAt ? new Date(b.lastSyncAt).getTime() : 0))
    .filter((t) => t > 0);

  return {
    range: { from: range.from, to: range.to },
    salesCents: current.salesCents,
    tickets: current.tickets,
    avgTicketCents: current.avgTicketCents,
    itemsSold: current.itemsSold,
    previous: {
      salesCents: previous.salesCents,
      tickets: previous.tickets,
      avgTicketCents: previous.avgTicketCents,
    },
    byBranch,
    daily,
    inventoryAlerts: alerts,
    lastSyncAt: syncTimes.length ? new Date(Math.max(...syncTimes)).toISOString() : null,
  };
}

export async function getOperations(query: DashboardQuery) {
  await ensureDb();
  const branch = parseBranch(query.branch);
  const { start, end } = resolveRange(query);
  const match = salesMatch(branch, start, end);

  const [productAgg, heatRaw] = await Promise.all([
    Sale.aggregate([
      { $match: match },
      { $unwind: "$items" },
      {
        // Se agrupa por plato antes del $lookup para no buscar el producto una vez por ítem vendido.
        $group: {
          _id: { $ifNull: ["$items.product", "$items.productName"] },
          product: { $first: "$items.product" },
          name: { $first: "$items.productName" },
          quantity: { $sum: "$items.quantity" },
          salesCents: { $sum: "$items.totalCents" },
        },
      },
      { $lookup: { from: "products", localField: "product", foreignField: "_id", as: "p" } },
      {
        $project: {
          name: { $ifNull: [{ $first: "$p.name" }, "$name"] },
          category: { $ifNull: [{ $first: "$p.category" }, "Sin categoría"] },
          quantity: 1,
          salesCents: 1,
        },
      },
      {
        $facet: {
          top: [{ $sort: { salesCents: -1 } }, { $limit: 15 }],
          byCategory: [
            {
              $group: {
                _id: "$category",
                quantity: { $sum: "$quantity" },
                salesCents: { $sum: "$salesCents" },
              },
            },
            { $sort: { salesCents: -1 } },
          ],
        },
      },
    ]),
    Sale.aggregate([
      { $match: match },
      {
        $group: {
          _id: { weekday: "$weekday", hour: "$hour" },
          salesCents: { $sum: "$totalCents" },
          tickets: { $sum: 1 },
        },
      },
      { $sort: { "_id.weekday": 1, "_id.hour": 1 } },
    ]),
  ]);

  const { top, byCategory: categories } = productAgg[0] ?? { top: [], byCategory: [] };
  const itemsTotal = categories.reduce((acc: number, c: any) => acc + c.salesCents, 0);

  const heatmap = heatRaw.map((row) => ({
    weekday: row._id.weekday as number,
    hour: row._id.hour as number,
    salesCents: row.salesCents as number,
    tickets: row.tickets as number,
  }));

  let best: (typeof heatmap)[number] | null = null;
  let worst: (typeof heatmap)[number] | null = null;
  for (const cell of heatmap) {
    if (!best || cell.salesCents > best.salesCents) best = cell;
    if (!worst || cell.salesCents < worst.salesCents) worst = cell;
  }
  const slot = (cell: typeof best) =>
    cell ? { weekday: cell.weekday, hour: cell.hour, salesCents: cell.salesCents } : null;

  return {
    topProducts: top.map((p: any) => ({
      name: p.name,
      category: p.category,
      quantity: p.quantity,
      salesCents: p.salesCents,
      share: ratio(p.salesCents, itemsTotal),
    })),
    byCategory: categories.map((c: any) => ({
      category: c._id,
      quantity: c.quantity,
      salesCents: c.salesCents,
      share: ratio(c.salesCents, itemsTotal),
    })),
    heatmap,
    bestSlot: slot(best),
    worstOpenSlot: slot(worst),
  };
}
