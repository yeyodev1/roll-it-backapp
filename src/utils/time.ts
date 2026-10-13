/**
 * Ecuador continental está en UTC-5 todo el año (sin horario de verano), así
 * que basta un desfase fijo. Vercel corre en UTC: sin esto una venta de las
 * 21:00 caería en "mañana" y en la franja equivocada.
 */
export const ECUADOR_OFFSET_HOURS = -5;
const OFFSET_MS = ECUADOR_OFFSET_HOURS * 60 * 60 * 1000;

/** Día de la semana (0 = domingo) y hora (0-23) en hora de Ecuador. */
export function ecuadorParts(date: Date): { weekday: number; hour: number } {
  const local = new Date(date.getTime() + OFFSET_MS);
  return { weekday: local.getUTCDay(), hour: local.getUTCHours() };
}

/** Inicio del día (00:00 en Ecuador) expresado en UTC. */
export function startOfEcuadorDay(date: Date): Date {
  const local = new Date(date.getTime() + OFFSET_MS);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - OFFSET_MS);
}

/** "2026-10-13" → 00:00 de ese día en Ecuador, en UTC. */
export function parseEcuadorDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00-05:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Fecha en Ecuador como "YYYY-MM-DD". */
export function ecuadorDateKey(date: Date): string {
  return new Date(date.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}
