import { Types } from "mongoose";
import { dbConnect, isConnected } from "../config/mongo";
import { CustomError } from "../errors/customError.error";
import { Ingredient, INGREDIENT_UNITS, IngredientUnit } from "../models/ingredient.model";
import { normalizeName } from "../utils/normalize";

async function ensureDb() {
  if (!isConnected() && !(await dbConnect())) {
    throw new CustomError("El servidor no tiene base de datos disponible", 503);
  }
}

function assertId(id: string) {
  if (!Types.ObjectId.isValid(id)) throw new CustomError("Insumo inválido", 400);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nonNegative(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new CustomError(`${label} no es válido`, 400);
  return n;
}

function parseUnit(value: unknown): IngredientUnit {
  const unit = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!(INGREDIENT_UNITS as readonly string[]).includes(unit)) {
    throw new CustomError(`La unidad debe ser una de: ${INGREDIENT_UNITS.join(", ")}`, 400);
  }
  return unit as IngredientUnit;
}

function parseAliases(value: unknown): string[] {
  if (!Array.isArray(value)) throw new CustomError("Los alias deben ser una lista", 400);
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const raw of value) {
    const alias = typeof raw === "string" ? raw.trim() : "";
    const key = normalizeName(alias);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
  }
  return aliases;
}

export async function listIngredients(filters: { q?: string }) {
  await ensureDb();
  const q = normalizeName(filters.q ?? "");
  const filter = q
    ? {
        $or: [
          { normalizedName: { $regex: escapeRegex(q) } },
          { aliases: { $regex: escapeRegex(filters.q!.trim()), $options: "i" } },
        ],
      }
    : {};
  return Ingredient.find(filter).sort({ name: 1 }).lean();
}

async function assertUniqueName(normalizedName: string, exceptId?: string) {
  const filter: Record<string, unknown> = { normalizedName };
  if (exceptId) filter._id = { $ne: exceptId };
  if (await Ingredient.exists(filter)) {
    throw new CustomError("Ya existe un insumo con ese nombre", 409);
  }
}

export async function createIngredient(input: Record<string, unknown>) {
  await ensureDb();
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const normalizedName = normalizeName(name);
  if (!normalizedName) throw new CustomError("Escribe el nombre del insumo", 400);
  await assertUniqueName(normalizedName);

  const defaultMinStock =
    input.defaultMinStock === undefined ? 0 : nonNegative(input.defaultMinStock, "El stock mínimo");
  const defaultMaxStock =
    input.defaultMaxStock === undefined ? 0 : nonNegative(input.defaultMaxStock, "El stock máximo");
  if (defaultMaxStock > 0 && defaultMinStock > defaultMaxStock) {
    throw new CustomError("El stock mínimo no puede ser mayor que el máximo", 400);
  }

  const ingredient = await Ingredient.create({
    name,
    normalizedName,
    unit: input.unit === undefined ? "g" : parseUnit(input.unit),
    costPerUnitCents:
      input.costPerUnitCents === undefined ? 0 : nonNegative(input.costPerUnitCents, "El costo"),
    defaultMinStock,
    defaultMaxStock,
    aliases: input.aliases === undefined ? [] : parseAliases(input.aliases),
  });
  return ingredient.toObject();
}

export async function updateIngredient(id: string, input: Record<string, unknown>) {
  await ensureDb();
  assertId(id);
  const ingredient = await Ingredient.findById(id);
  if (!ingredient) throw new CustomError("Insumo no encontrado", 404);

  if (input.name !== undefined) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const normalizedName = normalizeName(name);
    if (!normalizedName) throw new CustomError("Escribe el nombre del insumo", 400);
    await assertUniqueName(normalizedName, id);
    ingredient.name = name;
    ingredient.normalizedName = normalizedName;
  }
  if (input.unit !== undefined) ingredient.unit = parseUnit(input.unit);
  if (input.costPerUnitCents !== undefined) {
    ingredient.costPerUnitCents = nonNegative(input.costPerUnitCents, "El costo");
  }
  if (input.defaultMinStock !== undefined) {
    ingredient.defaultMinStock = nonNegative(input.defaultMinStock, "El stock mínimo");
  }
  if (input.defaultMaxStock !== undefined) {
    ingredient.defaultMaxStock = nonNegative(input.defaultMaxStock, "El stock máximo");
  }
  if (ingredient.defaultMaxStock > 0 && ingredient.defaultMinStock > ingredient.defaultMaxStock) {
    throw new CustomError("El stock mínimo no puede ser mayor que el máximo", 400);
  }
  if (input.aliases !== undefined) ingredient.aliases = parseAliases(input.aliases);
  if (input.isActive !== undefined) ingredient.isActive = Boolean(input.isActive);

  await ingredient.save();
  return ingredient.toObject();
}
