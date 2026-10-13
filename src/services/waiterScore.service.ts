import { Sale } from "../models/sale.model";
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
const TOP_SCORE = 65;
const ATTENTION_SCORE = 40;
// Un punto por cada 1% de diferencia contra el equipo: ±50% ya es 0 o 100.
const POINTS_PER_UNIT = 100;
// Por debajo de esta diferencia la métrica no merece una razón: es ruido.
const REASON_THRESHOLD = 0.05;

const WEIGHTS = { avgTicket: 0.4, ticketsPerDay: 0.35, itemsPerTicket: 0.25 } as const;
type Metric = keyof typeof WEIGHTS;

interface WaiterRow {
  waiterId: any;
  name: string;
  branchId: any;
  branchName: string;
  salesCents: number;
  tickets: number;
  items: number;
  daysWorked: number;
}

interface TeamAvg {
  avgTicketCents: number;
  ticketsPerDay: number;
  itemsPerTicket: number;
}

function teamAverage(rows: WaiterRow[]): TeamAvg {
  const sales = rows.reduce((a, r) => a + r.salesCents, 0);
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

function reasonFor(metric: Metric, value: number, team: number): string {
  const diff = value / team - 1;
  const pct = Math.round(Math.abs(diff) * 100);
  const up = diff > 0;
  if (metric === "avgTicket") {
    return `Ticket promedio ${pct}% ${up ? "sobre" : "bajo"} el equipo (${formatMoney(value)} vs ${formatMoney(team)})`;
  }
  if (metric === "ticketsPerDay") {
    return `Atiende ${pct}% ${up ? "más" : "menos"} mesas por día que el promedio (${formatNumber(value)} vs ${formatNumber(team)})`;
  }
  return `Vende ${pct}% ${up ? "más" : "menos"} ítems por ticket que el promedio (${formatNumber(value)} vs ${formatNumber(team)})`;
}

export async function getWaiters(query: DashboardQuery) {
  await ensureDb();
  const branch = parseBranch(query.branch);
  const { start, end } = resolveRange(query);

  const raw = await Sale.aggregate([
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
    { $lookup: { from: "waiters", localField: "_id.waiter", foreignField: "_id", as: "w" } },
    { $lookup: { from: "branches", localField: "_id.branch", foreignField: "_id", as: "b" } },
    {
      $project: {
        _id: 0,
        waiterId: "$_id.waiter",
        branchId: "$_id.branch",
        name: { $ifNull: [{ $first: "$w.name" }, "Sin nombre"] },
        branchName: { $ifNull: [{ $first: "$b.name" }, "Sucursal eliminada"] },
        salesCents: 1,
        tickets: 1,
        items: 1,
        daysWorked: { $size: "$days" },
      },
    },
  ]);
  const rows = raw as WaiterRow[];

  const byBranch = new Map<string, WaiterRow[]>();
  for (const row of rows) {
    const key = row.branchId.toString();
    byBranch.set(key, [...(byBranch.get(key) ?? []), row]);
  }
  const teams = new Map([...byBranch].map(([key, list]) => [key, teamAverage(list)]));
  const branchSales = new Map(
    [...byBranch].map(([key, list]) => [key, list.reduce((a, r) => a + r.salesCents, 0)]),
  );

  const waiters = rows.map((row) => {
    const key = row.branchId.toString();
    const team = teams.get(key)!;
    const values: Record<Metric, { value: number; team: number }> = {
      avgTicket: {
        value: row.tickets ? row.salesCents / row.tickets : 0,
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

    const metrics = Object.keys(WEIGHTS) as Metric[];
    const score = Math.round(
      metrics.reduce((acc, m) => acc + points(values[m].value, values[m].team) * WEIGHTS[m], 0),
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
          Math.abs(values[b].value / values[b].team - 1) * WEIGHTS[b] -
          Math.abs(values[a].value / values[a].team - 1) * WEIGHTS[a],
      )
      .slice(0, 3)
      .map((m) => reasonFor(m, values[m].value, values[m].team));
    if (!reasons.length)
      reasons.push(
        "En línea con el promedio del equipo en ticket, mesas por día e ítems por ticket",
      );

    return {
      waiter: { _id: row.waiterId, name: row.name },
      branch: { _id: row.branchId, name: row.branchName },
      salesCents: row.salesCents,
      tickets: row.tickets,
      avgTicketCents: Math.round(values.avgTicket.value),
      itemsPerTicket: Math.round(values.itemsPerTicket.value * 100) / 100,
      ticketsPerDay: Math.round(values.ticketsPerDay.value * 100) / 100,
      // Participación dentro de su sucursal: comparar contra el total de todas premiaría a quien está en la más grande.
      share: ratio(row.salesCents, branchSales.get(key) ?? 0),
      daysWorked: row.daysWorked,
      score,
      level,
      reasons,
    };
  });

  waiters.sort((a, b) => b.score - a.score);
  const global = teamAverage(rows);

  return {
    teamAvg: {
      avgTicketCents: global.avgTicketCents,
      ticketsPerDay: Math.round(global.ticketsPerDay * 100) / 100,
      itemsPerTicket: Math.round(global.itemsPerTicket * 100) / 100,
    },
    waiters,
  };
}
