import { Types } from "mongoose";
import { Sale } from "../models/sale.model";
import { DashboardQuery, ECUADOR_TZ, ensureDb, parseBranch, salesMatch } from "./dashboard.service";
import { ECUADOR_OFFSET_HOURS, startOfEcuadorDay } from "../utils/time";

const MONTHS = 24;
const OFFSET_MS = ECUADOR_OFFSET_HOURS * 60 * 60 * 1000;

/** 00:00 del día 1 de (year, month0) en Ecuador, en UTC. Date.UTC normaliza meses fuera de rango. */
function monthStart(year: number, month0: number): Date {
  return new Date(Date.UTC(year, month0, 1) - OFFSET_MS);
}

function monthKey(year: number, month0: number): string {
  const d = new Date(Date.UTC(year, month0, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function salesBetween(
  branch: Types.ObjectId | null,
  start: Date,
  end: Date,
): Promise<number> {
  const [row] = await Sale.aggregate([
    { $match: salesMatch(branch, start, end) },
    { $group: { _id: null, salesCents: { $sum: "$totalCents" } } },
  ]);
  return row?.salesCents ?? 0;
}

/**
 * Finanzas mira meses y años completos, así que ignora `from`/`to` a
 * propósito: un rango de 7 días no permite proyectar el mes ni comparar el año.
 * Solo respeta `branch`.
 */
export async function getFinance(query: DashboardQuery) {
  await ensureDb();
  const branch = parseBranch(query.branch);

  // Mientras SmartMenu no mande ventas en vivo, "este mes" es el de la última
  // venta: si no, Finanzas mostraría un mes actual vacío. Con ventas de hoy,
  // la referencia vuelve a ser ahora.
  const lastSale = await Sale.findOne(salesMatch(branch, new Date(0), new Date()))
    .sort({ date: -1 })
    .select("date")
    .lean<{ date: Date }>();
  const now = lastSale && lastSale.date < startOfEcuadorDay(new Date()) ? lastSale.date : new Date();
  const local = new Date(now.getTime() + OFFSET_MS);
  const year = local.getUTCFullYear();
  const month0 = local.getUTCMonth();
  const firstMonth = monthStart(year, month0 - (MONTHS - 1));
  const nextMonth = monthStart(year, month0 + 1);

  const [monthlyRaw, ytd, lastYtd] = await Promise.all([
    Sale.aggregate([
      { $match: salesMatch(branch, firstMonth, nextMonth) },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m", date: "$date", timezone: ECUADOR_TZ } },
          salesCents: { $sum: "$totalCents" },
          tickets: { $sum: 1 },
        },
      },
    ]),
    salesBetween(branch, monthStart(year, 0), now),
    // Mismo tramo del año pasado: 1 de enero hasta este mismo instante hace un año.
    salesBetween(
      branch,
      monthStart(year - 1, 0),
      new Date(
        Date.UTC(year - 1, month0, local.getUTCDate(), local.getUTCHours(), local.getUTCMinutes()) -
          OFFSET_MS,
      ),
    ),
  ]);

  const byMonth = new Map(monthlyRaw.map((row) => [row._id as string, row]));
  const monthly = [];
  for (let i = MONTHS - 1; i >= 0; i--) {
    const key = monthKey(year, month0 - i);
    const row = byMonth.get(key);
    const salesCents = row?.salesCents ?? 0;
    const tickets = row?.tickets ?? 0;
    monthly.push({
      month: key,
      salesCents,
      tickets,
      avgTicketCents: tickets ? Math.round(salesCents / tickets) : 0,
    });
  }

  const current = monthly[monthly.length - 1];
  const daysElapsed = local.getUTCDate();
  const daysInMonth = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const projectedCents = Math.round((current.salesCents / daysElapsed) * daysInMonth);
  const lastYear = byMonth.get(monthKey(year - 1, month0))?.salesCents ?? 0;

  return {
    asOf: now.toISOString(),
    monthly,
    currentMonth: {
      month: current.month,
      salesCents: current.salesCents,
      daysElapsed,
      daysInMonth,
      projectedCents,
      lastYearCents: lastYear || null,
      // Variación de la proyección contra el mes completo del año pasado: 0.12 = +12%.
      vsLastYear: lastYear ? projectedCents / lastYear - 1 : null,
    },
    yearToDate: {
      salesCents: ytd,
      lastYearSameRangeCents: lastYtd || null,
    },
  };
}
