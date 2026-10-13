import { Types } from "mongoose";
import { dbConnect, isConnected } from "../config/mongo";
import { CustomError } from "../errors/customError.error";
import { Branch } from "../models/branch.model";
import { Ingredient } from "../models/ingredient.model";
import { IInvoiceLine, INVOICE_STATUSES, PurchaseInvoice } from "../models/purchaseInvoice.model";
import { isCloudinaryConfigured, uploadBuffer } from "./cloudinary.service";
import {
  canReadImage,
  extractInvoice,
  ExtractedLine,
  isInvoiceAiConfigured,
} from "./invoiceAi.service";
import { applyMovement } from "./stock.service";
import { normalizeName } from "../utils/normalize";
import { parseEcuadorDate } from "../utils/time";

const PAGE_SIZE = 20;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
const CLOUDINARY_FOLDER = "roll-it/facturas";

async function ensureDb() {
  if (isConnected()) return;
  if (!(await dbConnect())) {
    throw new CustomError("El servidor no tiene base de datos disponible", 503);
  }
}

function toObjectId(value: unknown, message: string): Types.ObjectId {
  const raw =
    typeof value === "string"
      ? value.trim()
      : value instanceof Types.ObjectId
        ? value.toString()
        : "";
  if (!raw || !Types.ObjectId.isValid(raw)) throw new CustomError(message, 400);
  return new Types.ObjectId(raw);
}

function serialize(doc: any) {
  return {
    _id: doc._id,
    branch:
      doc.branch && doc.branch.name !== undefined
        ? { _id: doc.branch._id, name: doc.branch.name }
        : doc.branch,
    supplier: doc.supplier,
    invoiceNumber: doc.invoiceNumber,
    date: doc.date,
    imageUrl: doc.imageUrl,
    status: doc.status,
    lines: (doc.lines ?? []).map((line: any) => ({
      rawName: line.rawName,
      ingredient: line.ingredient
        ? { _id: line.ingredient._id, name: line.ingredient.name, unit: line.ingredient.unit }
        : null,
      quantity: line.quantity,
      rawQuantity: line.rawQuantity,
      rawUnit: line.rawUnit,
      unitCostCents: line.unitCostCents,
      totalCents: line.totalCents,
    })),
    totalCents: doc.totalCents,
    extractedBy: doc.extractedBy,
    aiError: doc.aiError,
    createdAt: doc.createdAt,
    confirmedAt: doc.confirmedAt,
  };
}

function populated(query: any) {
  return query.populate("branch", "name").populate("lines.ingredient", "name unit").lean();
}

/** Un staff que pide una factura de otra sucursal recibe 404: ni siquiera se le confirma que existe. */
async function findScoped(id: string, scope: string | null) {
  if (!Types.ObjectId.isValid(id)) throw new CustomError("Factura no encontrada", 404);
  const filter: Record<string, unknown> = { _id: id };
  if (scope) filter.branch = scope;
  const invoice = await PurchaseInvoice.findOne(filter);
  if (!invoice) throw new CustomError("Factura no encontrada", 404);
  return invoice;
}

async function loadSerialized(id: Types.ObjectId | string) {
  return serialize(await populated(PurchaseInvoice.findById(id)));
}

// ---------- Unidades ----------

type UnitFamily = { base: "g" | "ml" | "unidad"; factor: number };

const UNIT_ALIASES: Record<string, string> = {
  kg: "kg",
  kgs: "kg",
  kilo: "kg",
  kilos: "kg",
  kilogramo: "kg",
  kilogramos: "kg",
  g: "g",
  gr: "g",
  grs: "g",
  gramo: "g",
  gramos: "g",
  l: "l",
  lt: "l",
  lts: "l",
  litro: "l",
  litros: "l",
  ml: "ml",
  mililitro: "ml",
  mililitros: "ml",
  u: "unidad",
  un: "unidad",
  und: "unidad",
  unid: "unidad",
  unidad: "unidad",
  unidades: "unidad",
  uds: "unidad",
  pz: "unidad",
  pza: "unidad",
};

const FAMILIES: Record<string, UnitFamily> = {
  kg: { base: "g", factor: 1000 },
  g: { base: "g", factor: 1 },
  l: { base: "ml", factor: 1000 },
  ml: { base: "ml", factor: 1 },
  unidad: { base: "unidad", factor: 1 },
};

/** Pasa la cantidad de la factura a la unidad del insumo; si no son compatibles se deja tal cual para que la persona la corrija. */
export function convertQuantity(quantity: number, rawUnit: string, targetUnit: string): number {
  const from = FAMILIES[UNIT_ALIASES[normalizeName(rawUnit).replace(/ /g, "")] ?? ""];
  const to = FAMILIES[targetUnit];
  if (!from || !to || from.base !== to.base) return quantity;
  return Math.round(((quantity * from.factor) / to.factor) * 10000) / 10000;
}

const cents = (value: number) => Math.round((Number(value) || 0) * 100);

async function matchLines(lines: ExtractedLine[]): Promise<IInvoiceLine[]> {
  const ingredients = await Ingredient.find({ isActive: true })
    .select("name normalizedName unit aliases")
    .lean<any[]>();
  const byKey = new Map<string, any>();
  for (const ing of ingredients) {
    byKey.set(ing.normalizedName, ing);
    for (const alias of ing.aliases ?? []) {
      const key = normalizeName(alias);
      if (key && !byKey.has(key)) byKey.set(key, ing);
    }
  }

  return lines.map((line) => {
    // El alias aprendido de facturas anteriores pesa más que la sugerencia de la IA.
    const ing =
      byKey.get(normalizeName(line.name)) ??
      (line.ingredientName ? byKey.get(normalizeName(line.ingredientName)) : undefined);
    const totalCents = line.total
      ? cents(line.total)
      : Math.round(cents(line.unitPrice) * line.quantity);
    return {
      rawName: line.name,
      ingredient: ing ? ing._id : null,
      quantity: ing ? convertQuantity(line.quantity, line.unit, ing.unit) : line.quantity,
      rawQuantity: line.quantity,
      rawUnit: line.unit,
      unitCostCents: cents(line.unitPrice),
      totalCents,
    };
  });
}

// ---------- Casos de uso ----------

export async function listInvoices(params: {
  scope: string | null;
  status?: unknown;
  page?: unknown;
}) {
  await ensureDb();
  const filter: Record<string, unknown> = {};
  if (params.scope) filter.branch = toObjectId(params.scope, "Sucursal inválida");
  if (typeof params.status === "string" && params.status) {
    if (!(INVOICE_STATUSES as readonly string[]).includes(params.status)) {
      throw new CustomError("Estado de factura inválido", 400);
    }
    filter.status = params.status;
  }
  const page = Math.max(1, Number.parseInt(String(params.page ?? "1"), 10) || 1);

  const [docs, total] = await Promise.all([
    populated(
      PurchaseInvoice.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE),
    ),
    PurchaseInvoice.countDocuments(filter),
  ]);
  return {
    items: docs.map(serialize),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

export async function getInvoice(id: string, scope: string | null) {
  await ensureDb();
  const invoice = await findScoped(id, scope);
  return loadSerialized(invoice._id);
}

export async function createInvoice(input: {
  file?: { buffer: Buffer; mimetype: string; size: number };
  branch: string | null;
  userId: string;
}) {
  await ensureDb();
  const { file } = input;
  if (!file) throw new CustomError("Adjunta la foto de la factura en el campo 'image'", 400);
  if (!IMAGE_TYPES.includes(file.mimetype)) {
    throw new CustomError("La foto debe ser JPG, PNG, WEBP o HEIC", 415);
  }
  if (file.size > MAX_IMAGE_BYTES) throw new CustomError("La foto pesa más de 10 MB", 413);

  if (!input.branch) throw new CustomError("Indica la sucursal de la factura", 400);
  const branchId = toObjectId(input.branch, "Sucursal inválida");
  if (!(await Branch.exists({ _id: branchId })))
    throw new CustomError("Sucursal no encontrada", 404);

  const warnings: string[] = [];
  let imageUrl = "";
  let imagePublicId = "";
  // Sin foto guardada igual se puede cargar la factura a mano: no se bloquea al personal.
  if (isCloudinaryConfigured()) {
    try {
      const uploaded = await uploadBuffer(file.buffer, CLOUDINARY_FOLDER);
      imageUrl = uploaded.url;
      imagePublicId = uploaded.publicId;
    } catch (error) {
      console.error("[invoice] no se pudo subir la foto:", error);
      warnings.push("No se pudo guardar la foto de la factura.");
    }
  } else {
    warnings.push("La foto no se guardó: el almacenamiento de imágenes no está configurado.");
  }

  let extracted = null;
  if (!isInvoiceAiConfigured()) {
    warnings.push("La lectura automática no está configurada: carga las líneas a mano.");
  } else if (!canReadImage(file.mimetype)) {
    warnings.push("La IA no lee fotos HEIC: carga las líneas a mano o sube la foto en JPG.");
  } else {
    try {
      const ingredients = await Ingredient.find({ isActive: true })
        .select("name unit aliases")
        .lean<any[]>();
      extracted = await extractInvoice({
        buffer: file.buffer,
        mimeType: file.mimetype,
        imageUrl,
        ingredients: ingredients.map((i) => ({
          name: i.name,
          unit: i.unit,
          aliases: i.aliases ?? [],
        })),
      });
    } catch (error: any) {
      console.error("[invoice] la IA no pudo leer la factura:", error);
      const reason =
        error instanceof CustomError ? error.message : "Error inesperado al leer la factura";
      warnings.push(`${reason}. Carga las líneas a mano.`);
    }
  }

  const lines = extracted ? await matchLines(extracted.lines) : [];
  const invoice = await PurchaseInvoice.create({
    branch: branchId,
    supplier: extracted?.supplier ?? "",
    invoiceNumber: extracted?.invoiceNumber ?? "",
    date: (extracted?.date && parseEcuadorDate(extracted.date)) || new Date(),
    imageUrl,
    imagePublicId,
    status: "review",
    lines,
    totalCents: extracted?.total
      ? cents(extracted.total)
      : lines.reduce((a, l) => a + l.totalCents, 0),
    extractedBy: extracted ? "ai" : "manual",
    aiError: warnings.join(" "),
    createdBy: input.userId,
  });

  return loadSerialized(invoice._id);
}

function parseLine(raw: any, index: number, known: Set<string>): IInvoiceLine {
  if (!raw || typeof raw !== "object")
    throw new CustomError(`La línea ${index + 1} no es válida`, 400);
  const ingredientRaw =
    raw.ingredient && typeof raw.ingredient === "object" ? raw.ingredient._id : raw.ingredient;
  let ingredient: Types.ObjectId | null = null;
  if (ingredientRaw) {
    ingredient = toObjectId(String(ingredientRaw), `Insumo inválido en la línea ${index + 1}`);
    if (!known.has(ingredient.toString()))
      throw new CustomError(`El insumo de la línea ${index + 1} no existe`, 400);
  }
  const num = (v: unknown) => {
    const n = Number(v ?? 0);
    if (!Number.isFinite(n))
      throw new CustomError(`Hay un número inválido en la línea ${index + 1}`, 400);
    return n;
  };
  const quantity = num(raw.quantity);
  if (quantity < 0)
    throw new CustomError(`La cantidad de la línea ${index + 1} no puede ser negativa`, 400);
  return {
    rawName: String(raw.rawName ?? "").trim(),
    ingredient,
    quantity,
    rawQuantity: raw.rawQuantity === undefined ? quantity : num(raw.rawQuantity),
    rawUnit: String(raw.rawUnit ?? "").trim(),
    unitCostCents: Math.round(num(raw.unitCostCents)),
    totalCents: Math.round(num(raw.totalCents)),
  };
}

export async function updateInvoice(id: string, scope: string | null, body: any) {
  await ensureDb();
  const invoice = await findScoped(id, scope);
  if (invoice.status !== "review")
    throw new CustomError("Solo se puede editar una factura en revisión", 409);

  if (body?.supplier !== undefined) invoice.supplier = String(body.supplier).trim();
  if (body?.invoiceNumber !== undefined) invoice.invoiceNumber = String(body.invoiceNumber).trim();
  if (body?.date !== undefined) {
    const raw = String(body.date);
    const date = parseEcuadorDate(raw) ?? new Date(raw);
    if (Number.isNaN(date.getTime())) throw new CustomError("Fecha de factura inválida", 400);
    invoice.date = date;
  }
  if (body?.lines !== undefined) {
    if (!Array.isArray(body.lines)) throw new CustomError("'lines' debe ser una lista", 400);
    const ids = body.lines
      .map((l: any) =>
        l?.ingredient && typeof l.ingredient === "object" ? l.ingredient._id : l?.ingredient,
      )
      .filter((v: unknown) => v && Types.ObjectId.isValid(String(v)));
    const found = await Ingredient.find({ _id: { $in: ids } })
      .select("_id")
      .lean<any[]>();
    const known = new Set(found.map((i) => i._id.toString()));
    invoice.lines = body.lines.map((l: any, i: number) => parseLine(l, i, known));
    invoice.totalCents = invoice.lines.reduce((a: number, l: IInvoiceLine) => a + l.totalCents, 0);
  }

  await invoice.save();
  return loadSerialized(invoice._id);
}

export async function confirmInvoice(id: string, scope: string | null, userId: string) {
  await ensureDb();
  const current = await findScoped(id, scope);

  // Se reclama la factura con un update condicional: dos toques seguidos en "Confirmar" no suman el stock dos veces.
  const invoice = await PurchaseInvoice.findOneAndUpdate(
    { _id: current._id, status: "review" },
    { $set: { status: "confirmed", confirmedBy: userId, confirmedAt: new Date() } },
    { new: true },
  );
  if (!invoice) {
    const status = (await PurchaseInvoice.findById(current._id).select("status").lean<any>())
      ?.status;
    throw new CustomError(
      status === "confirmed"
        ? "Esta factura ya fue confirmada"
        : "Solo se puede confirmar una factura en revisión",
      409,
    );
  }

  const ingredientIds = invoice.lines
    .filter((l: IInvoiceLine) => l.ingredient)
    .map((l: IInvoiceLine) => l.ingredient);
  const ingredients = await Ingredient.find({ _id: { $in: ingredientIds } })
    .select("name normalizedName aliases")
    .lean<any[]>();
  const byId = new Map(ingredients.map((i) => [i._id.toString(), i]));

  const note =
    `Factura ${invoice.supplier || "sin proveedor"} ${invoice.invoiceNumber || "s/n"}`.trim();
  const warnings: string[] = [];
  let applied = 0;

  for (const [index, line] of (invoice.lines as IInvoiceLine[]).entries()) {
    const ing = line.ingredient ? byId.get(line.ingredient.toString()) : null;
    if (!ing) {
      warnings.push(
        `Línea ${index + 1} (${line.rawName || "sin nombre"}) sin insumo: no se sumó al stock.`,
      );
      continue;
    }
    if (!(line.quantity > 0)) {
      warnings.push(
        `Línea ${index + 1} (${line.rawName || ing.name}) con cantidad 0: no se sumó al stock.`,
      );
      continue;
    }
    await applyMovement({
      branch: invoice.branch,
      ingredient: ing._id,
      type: "purchase",
      quantity: line.quantity,
      refModel: "PurchaseInvoice",
      refId: invoice._id,
      note,
      createdBy: userId,
    });
    applied++;

    // Aprende cómo escribe este proveedor el insumo, para cruzarlo solo la próxima vez.
    const rawKey = normalizeName(line.rawName || "");
    const knownKeys = new Set([
      ing.normalizedName,
      ...(ing.aliases ?? []).map((a: string) => normalizeName(a)),
    ]);
    if (rawKey && !knownKeys.has(rawKey)) {
      await Ingredient.updateOne({ _id: ing._id }, { $addToSet: { aliases: line.rawName.trim() } });
      ing.aliases = [...(ing.aliases ?? []), line.rawName.trim()];
    }
  }

  return { ...(await loadSerialized(invoice._id)), applied, warnings };
}

export async function rejectInvoice(id: string, scope: string | null) {
  await ensureDb();
  const current = await findScoped(id, scope);
  const invoice = await PurchaseInvoice.findOneAndUpdate(
    { _id: current._id, status: "review" },
    { $set: { status: "rejected" } },
    { new: true },
  );
  if (!invoice) throw new CustomError("Solo se puede rechazar una factura en revisión", 409);
  return loadSerialized(invoice._id);
}
