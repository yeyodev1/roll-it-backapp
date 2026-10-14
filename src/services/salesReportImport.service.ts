import * as XLSX from "xlsx";
import { dbConnect, isConnected } from "../config/mongo";
import { CustomError } from "../errors/customError.error";
import { Branch } from "../models/branch.model";
import { Product } from "../models/product.model";
import { Sale } from "../models/sale.model";
import { normalizeName } from "../utils/normalize";
import { ingestSales } from "./sync.service";

/**
 * Carga a mano del exporte "REPORTE DE VENTAS DETALLADO" de SmartMenu (.xls).
 *
 * Mientras no haya agente en cada local, el dueño baja el reporte y lo sube
 * desde el panel. Se arma el mismo payload que manda `/sync/sales` y se pasa
 * por `ingestSales`, así el cruce de platos, el descuento de inventario y la
 * idempotencia por `externalId` son exactamente los del sincronizador.
 *
 * El parseo replica `prep.py`, el preprocesado con el que se importó la
 * historia: mismo `externalId` (`FACTURA-1551`), mismas exclusiones (líneas
 * anuladas, fees de franquicia), cortesías en 0 y el nombre sin canal. Por eso
 * subir un reporte que se cruza con lo ya importado actualiza y no duplica.
 */

// Lotes chicos: cada ticket nuevo descuenta inventario movimiento por movimiento.
const BATCH_SIZE = 100;
// Vercel corta la función a los 60 s (vercel.json): se deja margen para responder.
const DEFAULT_TIME_BUDGET_MS = 45_000;
// Cuánto historial de ventas se revisa antes del reporte para detectar códigos ambiguos.
const CODE_HISTORY_DAYS = 120;

const CHANNELS = [
  "UBER Y PEDIDOS YA",
  "PEDIDOS YA",
  "LOCAL",
  "UBER",
  "APPS",
  "RAPPI",
  "PEDIDOS",
  "PDYA",
  "X1",
];
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CHANNEL_SUFFIX = new RegExp(`(\\s+(${CHANNELS.map(escapeRegex).join("|")}))+$`);
const FEE = /\bFEE\b/;
const OBS = /\s+OBS:.*$/i;
const SALE_DATE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const SALE_DATE_DMY = /^(\d{2})[/-](\d{2})[/-](\d{4}) (\d{2}):(\d{2})(?::(\d{2}))?$/;

// La fila 3 del reporte trae la dirección del local: es lo único que dice de qué sucursal es.
const BRANCH_BY_ADDRESS: [RegExp, string][] = [
  [/PACIFICO/, "villa-club"],
  [/PUNTILLA|SAMBORONDON/, "marbol"],
];

type Column =
  | "documento"
  | "numero"
  | "fecha"
  | "producto"
  | "codigo"
  | "categoria"
  | "precio"
  | "cantidad"
  | "descuento"
  | "subtotal"
  | "total"
  | "informacion";

const HEADERS: Record<Column, string> = {
  documento: "documento",
  numero: "numero documento",
  fecha: "fecha",
  producto: "producto",
  codigo: "codigo producto",
  categoria: "categoria producto",
  precio: "precio unitario",
  cantidad: "cantidad",
  descuento: "descuento",
  subtotal: "subtotal",
  total: "total",
  informacion: "informacion",
};
const REQUIRED: Column[] = ["documento", "numero", "fecha", "producto", "cantidad", "total"];

interface ReportItem {
  name: string;
  code: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
}

interface ReportTicket {
  externalId: string;
  date: string | null;
  items: ReportItem[];
  lines: number;
  voided: number;
}

export interface SalesReportResult {
  branch: { _id: string; name: string; slug: string };
  from: string | null;
  to: string | null;
  rows: number;
  tickets: number;
  received: number;
  // Tickets que ya estaban cargados tal cual: no se reenvían.
  unchanged: number;
  created: number;
  updated: number;
  inventoryApplied: number;
  unmappedProducts: string[];
  // Tickets que no alcanzaron a cargarse por el límite de tiempo: se sube el mismo archivo otra vez.
  pending: number;
}

async function ensureDb() {
  if (!isConnected() && !(await dbConnect())) {
    throw new CustomError("El servidor no tiene base de datos disponible", 503);
  }
}

/** Igual que `key()` de prep.py: mayúsculas, sin tildes y un solo espacio. */
function key(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
}

/**
 * Nombre del plato sin canal. SmartMenu pega producto + presentación y el canal:
 * "KANI FRIES KANI FRIES UBER" → "KANI FRIES".
 */
function baseName(value: string): string {
  let p = key(value).replace(CHANNEL_SUFFIX, "");
  const words = p.split(" ");
  const half = words.length / 2;
  if (words.length % 2 === 0 && words.slice(0, half).join(" ") === words.slice(half).join(" ")) {
    p = words.slice(0, half).join(" ");
  }
  return p.replace(CHANNEL_SUFFIX, "");
}

function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const n = Number(String(value ?? "").trim());
  return String(value ?? "").trim() && Number.isFinite(n) ? n : 0;
}

/**
 * Centavos con redondeo al par, como `round()` de Python en prep.py: con el
 * redondeo de JS un total que cae justo en medio centavo no coincidiría con lo
 * ya importado y el ticket se reescribiría con un centavo de diferencia.
 */
function toCents(value: number): number {
  const x = value * 100;
  const floor = Math.floor(x);
  if (x - floor === 0.5) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(x);
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Fecha de la línea como "YYYY-MM-DD HH:MM:SS". El .xls la trae como texto; un
 * .xlsx o .csv editado en Excel puede traerla como fecha real o en DD/MM/YYYY.
 */
function saleDateText(value: unknown): string | null {
  if (typeof value === "number" && value > 0) {
    const d = XLSX.SSF.parse_date_code(value);
    if (!d) return null;
    return `${d.y}-${pad(d.m)}-${pad(d.d)} ${pad(d.H)}:${pad(d.M)}:${pad(Math.floor(d.S))}`;
  }
  const raw = String(value ?? "").trim();
  if (SALE_DATE.test(raw)) return raw;
  const dmy = raw.match(SALE_DATE_DMY);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]} ${dmy[4]}:${dmy[5]}:${dmy[6] ?? "00"}`;
  return null;
}

/** UTF-8 si se puede; si no, Windows-1252, que es como guarda Excel un CSV en Windows. */
function decodeCsv(buffer: Buffer): string {
  const utf8 = buffer.toString("utf8").replace(/^\uFEFF/, "");
  return utf8.includes("\uFFFD") ? buffer.toString("latin1") : utf8;
}

function readTable(file: { buffer: Buffer; originalname: string }): unknown[][] {
  const name = file.originalname.toLowerCase();
  const isCsv = name.endsWith(".csv");
  if (!isCsv && !name.endsWith(".xls") && !name.endsWith(".xlsx")) {
    throw new CustomError("El archivo debe ser el reporte de SmartMenu (.xls, .xlsx o .csv)", 400);
  }
  let workbook: XLSX.WorkBook;
  try {
    // Solo valores: nada de fórmulas ni macros del archivo. En CSV `raw` evita que
    // SheetJS adivine fechas y números a su manera.
    const options: XLSX.ParsingOptions = { raw: isCsv, cellFormula: false, cellHTML: false };
    workbook = isCsv
      ? XLSX.read(decodeCsv(file.buffer), { ...options, type: "string" })
      : XLSX.read(file.buffer, { ...options, type: "buffer" });
  } catch {
    throw new CustomError(
      "No se pudo leer el archivo. ¿Es el reporte exportado de SmartMenu?",
      400,
    );
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new CustomError("El archivo no tiene hojas", 400);
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: "" });
}

/** Busca la fila de cabecera (la 8 en el .xls) y devuelve la columna de cada campo. */
function findHeader(table: unknown[][]): { row: number; columns: Partial<Record<Column, number>> } {
  for (let r = 0; r < Math.min(table.length, 20); r++) {
    const cells = (table[r] ?? []).map((c) => normalizeName(String(c ?? "")));
    if (cells[0] !== "documento" && !cells.includes("numero documento")) continue;
    const columns: Partial<Record<Column, number>> = {};
    for (const [field, header] of Object.entries(HEADERS) as [Column, string][]) {
      const index = cells.indexOf(header);
      if (index >= 0) columns[field] = index;
    }
    const missing = REQUIRED.filter((field) => columns[field] === undefined);
    if (missing.length) {
      throw new CustomError(
        `Al reporte le faltan columnas: ${missing.map((f) => HEADERS[f]).join(", ")}`,
        400,
      );
    }
    return { row: r, columns };
  }
  throw new CustomError(
    "No encontré la cabecera del reporte (Documento, Número documento, Fecha, Producto…). Exporta el «Reporte de ventas detallado» de SmartMenu",
    400,
  );
}

function detectBranchSlug(table: unknown[][], headerRow: number): string | null {
  // En el .xls es la fila 3; se mira todo el encabezado por si el archivo se reacomodó.
  for (let r = 0; r < headerRow; r++) {
    const text = key((table[r] ?? []).map((c) => String(c ?? "")).join(" "));
    for (const [pattern, slug] of BRANCH_BY_ADDRESS) if (pattern.test(text)) return slug;
  }
  return null;
}

/** Agrupa las líneas por documento con las mismas reglas de prep.py. */
function parseTickets(
  table: unknown[][],
  headerRow: number,
  columns: Partial<Record<Column, number>>,
): { rows: number; tickets: ReportTicket[] } {
  const cell = (row: unknown[], field: Column) =>
    columns[field] === undefined ? "" : row[columns[field]!];
  const tickets = new Map<string, ReportTicket>();
  let rows = 0;

  for (let r = headerRow + 1; r < table.length; r++) {
    const row = table[r] ?? [];
    const doc = String(cell(row, "documento") ?? "")
      .trim()
      .toUpperCase();
    if (doc !== "FACTURA" && doc !== "TICKETS") continue;
    rows++;
    const externalId = `${doc}-${Math.trunc(num(cell(row, "numero")))}`;
    let ticket = tickets.get(externalId);
    if (!ticket) {
      ticket = { externalId, date: null, items: [], lines: 0, voided: 0 };
      tickets.set(externalId, ticket);
    }
    ticket.lines++;

    if (
      String(cell(row, "informacion") ?? "")
        .toUpperCase()
        .includes("ANULADA POR")
    ) {
      ticket.voided++;
      continue;
    }
    const category = String(cell(row, "categoria") ?? "").trim();
    const raw = String(cell(row, "producto") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .join(" ");
    // Hay fees de franquicia mal categorizados ("BRAND FEE UBER EATS" en ENTRADAS): no son venta del local.
    if (key(category) === "FRANCHISE FEE" || FEE.test(key(raw))) continue;

    const date = saleDateText(cell(row, "fecha"));
    if (!date) {
      throw new CustomError(
        `Fila ${r + 1}: la fecha «${String(cell(row, "fecha"))}» no tiene el formato del reporte (AAAA-MM-DD HH:MM:SS)`,
        400,
      );
    }
    if (ticket.date === null) ticket.date = `${date.replace(" ", "T")}-05:00`;

    // El mesero anota "OBS: sin tempura" pegado al nombre: no cambia el plato.
    const clean = raw.replace(OBS, "").trim() || raw;
    const subtotal = num(cell(row, "subtotal"));
    const discount = num(cell(row, "descuento"));
    // Cortesía: el descuento se come todo el subtotal.
    const courtesy = discount > 0 && subtotal <= 0.005;
    ticket.items.push({
      name: baseName(clean),
      code: String(cell(row, "codigo") ?? "").trim(),
      quantity: num(cell(row, "cantidad")),
      unitPriceCents: toCents(num(cell(row, "precio"))),
      totalCents: courtesy ? 0 : toCents(num(cell(row, "total"))),
    });
  }
  return { rows, tickets: [...tickets.values()] };
}

/**
 * SmartMenu reutiliza códigos (MEDIO ACEVICHADO sale con ROLL005, el código del
 * rollo entero). Cruzar por un código así manda la venta al plato equivocado y
 * el sincronizador además lo "aprendería" para siempre. Un código se usa solo si
 * ya está en el catálogo o si en el archivo corresponde a un único plato, y en
 * ambos casos nunca si el historial de ventas lo muestra con dos platos.
 */
async function ambiguousCodes(tickets: ReportTicket[], since: Date): Promise<Set<string>> {
  const namesByCode = new Map<string, Set<string>>();
  for (const t of tickets) {
    for (const item of t.items) {
      if (!item.code) continue;
      if (!namesByCode.has(item.code)) namesByCode.set(item.code, new Set());
      namesByCode.get(item.code)!.add(normalizeName(item.name));
    }
  }
  const codes = [...namesByCode.keys()];
  if (!codes.length) return new Set();

  const [catalog, history] = await Promise.all([
    Product.find({ smartmenuCode: { $in: codes } })
      .select("smartmenuCode")
      .lean<any[]>(),
    Sale.aggregate<{ _id: string }>([
      { $match: { date: { $gte: since }, "items.smartmenuCode": { $in: codes } } },
      { $unwind: "$items" },
      { $match: { "items.smartmenuCode": { $in: codes } } },
      { $group: { _id: "$items.smartmenuCode", products: { $addToSet: "$items.product" } } },
      { $match: { "products.1": { $exists: true } } },
      { $project: { _id: 1 } },
    ]),
  ]);
  const inCatalog = new Set(catalog.map((p) => p.smartmenuCode));
  const ambiguous = new Set(history.map((h) => h._id));
  for (const [code, names] of namesByCode) {
    if (!inCatalog.has(code) && names.size > 1) ambiguous.add(code);
  }
  return ambiguous;
}

/**
 * Huella de un ticket sin depender de cómo se cruzaron los platos: cantidad e
 * importe de cada línea. La historia se importó con alias de platos que no
 * viven en el repo; si se reenviara un ticket ya cargado, el sincronizador lo
 * cruzaría por nombre, vería platos "distintos" y rehacería su inventario.
 */
function fingerprint(items: { quantity: number; totalCents: number }[], totalCents: number) {
  const lines = items.map((i) => `${i.quantity}:${i.totalCents}`).sort();
  return `${totalCents}|${lines.join(",")}`;
}

async function resolveBranch(detected: string | null, requested: unknown) {
  const chosen = typeof requested === "string" ? requested.trim().toLowerCase() : "";
  if (detected && chosen && detected !== chosen) {
    throw new CustomError(
      `El reporte es de la sucursal «${detected}» pero elegiste «${chosen}». Revisa el archivo`,
      400,
    );
  }
  const slug = detected ?? chosen;
  if (!slug) {
    throw new CustomError(
      "No reconocí la sucursal por la dirección del reporte. Elige la sucursal y vuelve a subirlo",
      400,
    );
  }
  const branch = await Branch.findOne({ slug }).select("_id name slug lastSyncAt").lean<any>();
  if (!branch) throw new CustomError(`La sucursal «${slug}» no existe`, 404);
  return branch;
}

export async function importSalesReport(
  file: { buffer: Buffer; originalname: string } | undefined,
  requestedBranch?: unknown,
  options: { timeBudgetMs?: number } = {},
): Promise<SalesReportResult> {
  const startedAt = Date.now();
  if (!file?.buffer?.length) {
    throw new CustomError("Sube el reporte de ventas de SmartMenu (.xls, .xlsx o .csv)", 400);
  }
  const table = readTable(file);
  const { row: headerRow, columns } = findHeader(table);
  const { rows, tickets } = parseTickets(table, headerRow, columns);
  if (!rows) throw new CustomError("El reporte no tiene ventas", 400);

  await ensureDb();
  const branch = await resolveBranch(detectBranchSlug(table, headerRow), requestedBranch);

  // Un ticket anulado entero solo importa si ya estaba cargado: se manda como `void`
  // para que el sincronizador devuelva su stock. Si nunca llegó, no se crea. Sus
  // líneas anuladas no traen fecha útil, así que se conserva la que ya tenía.
  const fullyVoided = tickets.filter((t) => t.voided === t.lines).map((t) => t.externalId);
  const voidedKnown = fullyVoided.length
    ? await Sale.find({ branch: branch._id, externalId: { $in: fullyVoided }, status: "paid" })
        .select("externalId date")
        .lean<any[]>()
    : [];

  const valid = tickets
    .map((t) => ({ ...t, items: t.items.filter((i) => i.quantity > 0) }))
    .filter((t) => t.date !== null && t.items.length)
    .map((t) => ({ ...t, totalCents: t.items.reduce((sum, i) => sum + i.totalCents, 0) }));

  // Lo que ya está cargado igual que en el archivo no se toca: así re-subir un
  // reporte que se cruza con lo importado no duplica ni mueve inventario.
  const loaded = valid.length
    ? await Sale.find({ branch: branch._id, externalId: { $in: valid.map((t) => t.externalId) } })
        .select("externalId status totalCents items.quantity items.totalCents")
        .lean<any[]>()
    : [];
  const loadedPrints = new Map(
    loaded
      .filter((s) => s.status === "paid")
      .map((s) => [s.externalId, fingerprint(s.items ?? [], s.totalCents)]),
  );
  const unchanged = valid.filter(
    (t) => loadedPrints.get(t.externalId) === fingerprint(t.items, t.totalCents),
  );
  const unchangedIds = new Set(unchanged.map((t) => t.externalId));
  const toSend = valid.filter((t) => !unchangedIds.has(t.externalId));

  const firstDate = toSend.reduce<string | null>(
    (min, t) => (min === null || t.date! < min ? t.date : min),
    null,
  );
  const since = new Date(
    new Date(firstDate ?? Date.now()).getTime() - CODE_HISTORY_DAYS * 24 * 60 * 60 * 1000,
  );
  const ambiguous = await ambiguousCodes(toSend, since);

  const sales = [
    ...toSend.map((t) => ({
      externalId: t.externalId,
      date: t.date!,
      status: "paid" as const,
      items: t.items.map((i) => (ambiguous.has(i.code) ? { ...i, code: "" } : i)),
      totalCents: t.totalCents,
    })),
    ...voidedKnown.map((s) => ({
      externalId: s.externalId as string,
      date: new Date(s.date).toISOString(),
      status: "void" as const,
      items: [] as ReportItem[],
      totalCents: 0,
    })),
  ];
  // En orden de fecha: si se acaba el tiempo, lo cargado es un tramo continuo y
  // `lastSyncAt` no deja huecos antes de la última venta.
  sales.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  const result: SalesReportResult = {
    branch: { _id: String(branch._id), name: branch.name, slug: branch.slug },
    from: null,
    to: null,
    rows,
    tickets: valid.length + voidedKnown.length,
    received: 0,
    unchanged: unchanged.length,
    created: 0,
    updated: 0,
    inventoryApplied: 0,
    unmappedProducts: [],
    pending: 0,
  };

  const budget = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const unmapped = new Set<string>();
  let lastDate: Date | null = null;
  let done = 0;
  for (let i = 0; i < sales.length; i += BATCH_SIZE) {
    if (i > 0 && Date.now() - startedAt > budget) break;
    const batch = sales.slice(i, i + BATCH_SIZE);
    const synced = await ingestSales(branch.slug, batch);
    result.received += synced.received;
    result.created += synced.created;
    result.updated += synced.updated;
    result.inventoryApplied += synced.inventoryApplied;
    for (const name of synced.unmappedProducts) unmapped.add(name);
    done += batch.length;
    lastDate = new Date(batch[batch.length - 1].date);
  }
  result.pending = sales.length - done;
  result.unmappedProducts = [...unmapped];

  const dates = [...valid.map((t) => t.date!), ...sales.map((s) => s.date)].map((d) =>
    new Date(d).getTime(),
  );
  if (dates.length) {
    result.from = new Date(Math.min(...dates)).toISOString();
    result.to = new Date(Math.max(...dates)).toISOString();
  }
  // Con tickets pendientes los datos están completos solo hasta el último lote cargado.
  if (!result.pending && dates.length) lastDate = new Date(Math.max(...dates));

  // `ingestSales` marca la hora actual; con un reporte manual los datos llegan
  // solo hasta la última venta, y el panel ancla sus filtros a esa fecha. Nunca
  // se retrocede: subir un reporte viejo no esconde lo que ya estaba al día.
  const previous = branch.lastSyncAt ? new Date(branch.lastSyncAt) : null;
  const lastSyncAt =
    previous && (!lastDate || previous > lastDate) ? previous : (lastDate ?? previous);
  await Branch.updateOne({ _id: branch._id }, { $set: { lastSyncAt } });

  return result;
}
