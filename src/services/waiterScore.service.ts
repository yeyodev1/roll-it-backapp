import { Types } from "mongoose";
import { Sale } from "../models/sale.model";
import { WaiterDay } from "../models/waiterDay.model";
import { ecuadorDateKey } from "../utils/time";
import {
  DashboardQuery,
  ECUADOR_TZ,
  ensureDb,
  parseBranch,
  ratio,
  resolveRange,
  salesMatch,
} from "./dashboard.service";

const MIN_TICKETS = 10;
// El cierre cuenta mesas, no tickets, y una mesera de medio tiempo junta pocas: con 5 ya se compara.
const MIN_CLOSING_TABLES = 5;
const TOP_SCORE = 65;
const ATTENTION_SCORE = 40;
// Un punto por cada 1% de diferencia contra el equipo: ±50% ya es 0 o 100.
const POINTS_PER_UNIT = 100;
// Por debajo de esta diferencia la métrica no merece una razón: es ruido.
const REASON_THRESHOLD = 0.05;

const WEIGHTS = { avgTicket: 0.4, ticketsPerDay: 0.35, itemsPerTicket: 0.25 } as const;
type Metric = keyof typeof WEIGHTS;
const ALL_METRICS = Object.keys(WEIGHTS) as Metric[];

/**
 * De dónde salen los números: `tickets` = ventas de SmartMenu con mesero;
 * `closings` = hoja VENTA DIARIA del cierre de mes (mesas y productos
 * sugeridos por mesera); `none` = no hay nada en el período.
 */
type Source = "tickets" | "closings" | "none";

interface WaiterRow {
  waiterId: any;
  name: string;
  branchId: any;
  branchName: string;
  // null: la fuente no trae venta en dólares por mesero.
  salesCents: number | null;
  // Tickets en SmartMenu; mesas atendidas en el cierre.
  tickets: number;
  // Ítems vendidos en SmartMenu; productos sugeridos en el cierre.
  items: number;
  daysWorked: number;
}

interface TeamAvg {
  avgTicketCents: number;
  ticketsPerDay: number;
  itemsPerTicket: number;
}

function teamAverage(rows: WaiterRow[]): TeamAvg {
  const sales = rows.reduce((a, r) => a + (r.salesCents ?? 0), 0);
  const tickets = rows.reduce((a, r) => a + r.tickets, 0);
  const items = rows.reduce((a, r) => a + r.items, 0);
  const days = rows.reduce((a, r) => a + r.daysWorked, 0);
  // Promedios ponderados por volumen: un mesero con 12 tickets no pesa igual que uno con 600.
  return {
    avgTicketCents: tickets ? Math.round(sales / tickets) : 0,
    ticketsPerDay: days ? tickets / days : 0,
    itemsPerTicket: tickets ? items / tickets : 0,
  };
}

function points(value: number, team: number): number {
  if (team <= 0) return 50;
  const score = 50 + (value / team - 1) * POINTS_PER_UNIT;
  return Math.max(0, Math.min(100, score));
}

function formatNumber(value: number, decimals = 1): string {
  const fixed = value.toFixed(decimals);
  const [int, dec] = fixed.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return dec && Number(dec) !== 0 ? `${grouped},${dec}` : grouped;
}

function formatMoney(cents: number): string {
  const [int, dec] = (cents / 100).toFixed(2).split(".");
  return `$${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
}

function reasonFor(metric: Metric, value: number, team: number, source: Source): string {
  const diff = value / team - 1;
  const pct = Math.round(Math.abs(diff) * 100);
  const up = diff > 0;
  if (metric === "avgTicket") {
    return `Ticket promedio ${pct}% ${up ? "sobre" : "bajo"} el equipo (${formatMoney(value)} vs ${formatMoney(team)})`;
  }
  if (metric === "ticketsPerDay") {
    return `Atiende ${pct}% ${up ? "más" : "menos"} mesas por día que el promedio (${formatNumber(value)} vs ${formatNumber(team)})`;
  }
  if (source === "closings") {
    return `Vende ${pct}% ${up ? "más" : "menos"} productos sugeridos (cócteles, cervezas, postres, jugos, entradas) por mesa que el promedio (${formatNumber(value, 2)} vs ${formatNumber(team, 2)})`;
  }
  return `Vende ${pct}% ${up ? "más" : "menos"} ítems por ticket que el promedio (${formatNumber(value)} vs ${formatNumber(team)})`;
}

const LOOKUPS = [
  { $lookup: { from: "waiters", localField: "_id.waiter", foreignField: "_id", as: "w" } },
  { $lookup: { from: "branches", localField: "_id.branch", foreignField: "_id", as: "b" } },
];
const NAMES = {
  _id: 0,
  waiterId: "$_id.waiter",
  branchId: "$_id.branch",
  name: { $ifNull: [{ $first: "$w.name" }, "Sin nombre"] },
  branchName: { $ifNull: [{ $first: "$b.name" }, "Sucursal eliminada"] },
};

async function rowsFromTickets(branch: Types.ObjectId | null, start: Date, end: Date) {
  return (await Sale.aggregate([
    { $match: { ...salesMatch(branch, start, end), waiter: { $ne: null } } },
    {
      $group: {
        _id: { waiter: "$waiter", branch: "$branch" },
        salesCents: { $sum: "$totalCents" },
        tickets: { $sum: 1 },
        items: { $sum: { $sum: "$items.quantity" } },
        days: {
          $addToSet: { $dateToString: { format: "%Y-%m-%d", date: "$date", timezone: ECUADOR_TZ } },
        },
      },
    },
    { $match: { tickets: { $gte: MIN_TICKETS } } },
    ...LOOKUPS,
    { $project: { ...NAMES, salesCents: 1, tickets: 1, items: 1, daysWorked: { $size: "$days" } } },
  ])) as WaiterRow[];
}

function closingsMatch(branch: Types.ObjectId | null, start?: Date, end?: Date) {
  const match: Record<string, unknown> = {};
  if (start && end) match.date = { $gte: start, $lt: end };
  if (branch) match.branch = branch;
  return match;
}

async function rowsFromClosings(branch: Types.ObjectId | null, start: Date, end: Date) {
  return (await WaiterDay.aggregate([
    { $match: closingsMatch(branch, start, end) },
    {
      $group: {
        _id: { waiter: "$waiter", branch: "$branch" },
        salesCents: { $sum: "$salesCents" },
        // 1 solo si todos los días traen venta en $: si falta uno, el ticket promedio sería falso.
        salesKnown: {
          $min: { $cond: [{ $eq: [{ $ifNull: ["$salesCents", null] }, null] }, 0, 1] },
        },
        tickets: { $sum: "$tables" },
        items: { $sum: "$upsellUnits" },
        daysWorked: { $sum: 1 },
      },
    },
    { $match: { tickets: { $gte: MIN_CLOSING_TABLES } } },
    ...LOOKUPS,
    {
      $project: {
        ...NAMES,
        salesCents: { $cond: [{ $eq: ["$salesKnown", 1] }, "$salesCents", null] },
        tickets: 1,
        items: 1,
        daysWorked: 1,
      },
    },
  ])) as WaiterRow[];
}

/** Primer y último día con cierre cargado: el panel lo ofrece si el rango elegido no tiene datos. */
async function closingsRange(branch: Types.ObjectId | null) {
  const [row] = await WaiterDay.aggregate([
    { $match: closingsMatch(branch) },
    { $group: { _id: null, from: { $min: "$date" }, to: { $max: "$date" } } },
  ]);
  return row ? { from: ecuadorDateKey(row.from), to: ecuadorDateKey(row.to) } : null;
}

export async function getWaiters(query: DashboardQuery) {
  await ensureDb();
  const branch = parseBranch(query.branch);
  const { start, end } = resolveRange(query);

  // Los tickets con mesero mandan; el cierre de mes es el respaldo mientras SmartMenu no lo traiga.
  let source: Source = "tickets";
  let rows = await rowsFromTickets(branch, start, end);
  if (!rows.length) {
    rows = await rowsFromClosings(branch, start, end);
    source = rows.length ? "closings" : "none";
  }
  const metrics: Metric[] =
    source === "closings" && rows.some((r) => r.salesCents === null)
      ? ALL_METRICS.filter((m) => m !== "avgTicket")
      : ALL_METRICS;
  const hasSales = metrics.includes("avgTicket");
  // Los pesos se reparten entre las métricas que sí hay: 35/25 pasa a 58/42.
  const weightSum = metrics.reduce((a, m) => a + WEIGHTS[m], 0);
  const weight = (m: Metric) => WEIGHTS[m] / weightSum;

  const byBranch = new Map<string, WaiterRow[]>();
  for (const row of rows) {
    const key = row.branchId.toString();
    byBranch.set(key, [...(byBranch.get(key) ?? []), row]);
  }
  const teams = new Map([...byBranch].map(([key, list]) => [key, teamAverage(list)]));
  const branchSales = new Map(
    [...byBranch].map(([key, list]) => [key, list.reduce((a, r) => a + (r.salesCents ?? 0), 0)]),
  );

  const waiters = rows.map((row) => {
    const key = row.branchId.toString();
    const team = teams.get(key)!;
    const values: Record<Metric, { value: number; team: number }> = {
      avgTicket: {
        value: row.tickets ? (row.salesCents ?? 0) / row.tickets : 0,
        team: team.avgTicketCents,
      },
      ticketsPerDay: {
        value: row.daysWorked ? row.tickets / row.daysWorked : 0,
        team: team.ticketsPerDay,
      },
      itemsPerTicket: {
        value: row.tickets ? row.items / row.tickets : 0,
        team: team.itemsPerTicket,
      },
    };

    const score = Math.round(
      metrics.reduce((acc, m) => acc + points(values[m].value, values[m].team) * weight(m), 0),
    );
    const level = score >= TOP_SCORE ? "top" : score < ATTENTION_SCORE ? "attention" : "ok";

    // Las razones van de la que más mueve el puntaje a la que menos.
    const reasons = metrics
      .filter(
        (m) =>
          values[m].team > 0 && Math.abs(values[m].value / values[m].team - 1) >= REASON_THRESHOLD,
      )
      .sort(
        (a, b) =>
          Math.abs(values[b].value / values[b].team - 1) * weight(b) -
          Math.abs(values[a].value / values[a].team - 1) * weight(a),
      )
      .slice(0, 3)
      .map((m) => reasonFor(m, values[m].value, values[m].team, source));
    if (!reasons.length) {
      reasons.push(
        hasSales
          ? "En línea con el promedio del equipo en ticket, mesas por día e ítems por ticket"
          : "En línea con el promedio del equipo en mesas por día y productos sugeridos por mesa",
      );
    }
    if (!hasSales) {
      reasons.push(
        "Sin venta en $ por mesera en el cierre de mes: el ticket promedio no entra en el puntaje",
      );
    }

    return {
      waiter: { _id: row.waiterId, name: row.name },
      branch: { _id: row.branchId, name: row.branchName },
      salesCents: hasSales ? row.salesCents : null,
      tickets: row.tickets,
      avgTicketCents: hasSales ? Math.round(values.avgTicket.value) : null,
      itemsPerTicket: Math.round(values.itemsPerTicket.value * 100) / 100,
      ticketsPerDay: Math.round(values.ticketsPerDay.value * 100) / 100,
      // Participación dentro de su sucursal: comparar contra el total de todas premiaría a quien está en la más grande.
      share: hasSales ? ratio(row.salesCents ?? 0, branchSales.get(key) ?? 0) : null,
      daysWorked: row.daysWorked,
      score,
      level,
      reasons,
    };
  });

  waiters.sort((a, b) => b.score - a.score);
  const global = teamAverage(rows);

  return {
    source,
    metrics,
    closingsRange: await closingsRange(branch),
    teamAvg: {
      avgTicketCents: hasSales ? global.avgTicketCents : null,
      ticketsPerDay: Math.round(global.ticketsPerDay * 100) / 100,
      itemsPerTicket: Math.round(global.itemsPerTicket * 100) / 100,
    },
    waiters,
  };
}
