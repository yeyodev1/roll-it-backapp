import { PipelineStage, Types } from "mongoose";
import { dbConnect, isConnected } from "../config/mongo";
import { CustomError } from "../errors/customError.error";
import { Product } from "../models/product.model";
import { Recipe } from "../models/recipe.model";
import { normalizeName } from "../utils/normalize";

async function ensureDb() {
  if (!isConnected() && !(await dbConnect())) {
    throw new CustomError("El servidor no tiene base de datos disponible", 503);
  }
}

function assertId(id: string) {
  if (!Types.ObjectId.isValid(id)) throw new CustomError("Plato inválido", 400);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toCents(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new CustomError("El precio no es válido", 400);
  return Math.round(n);
}

export async function listProducts(filters: {
  q?: string;
  category?: string;
  onlyWithoutRecipe?: boolean;
}) {
  await ensureDb();
  const match: Record<string, unknown> = {};
  const q = normalizeName(filters.q ?? "");
  if (q) match.normalizedName = { $regex: escapeRegex(q) };
  if (filters.category?.trim()) {
    match.category = { $regex: `^${escapeRegex(filters.category.trim())}$`, $options: "i" };
  }

  const pipeline: PipelineStage[] = [
    { $match: match },
    {
      $lookup: {
        from: Recipe.collection.name,
        localField: "_id",
        foreignField: "product",
        as: "recipe",
        pipeline: [{ $project: { count: { $size: "$items" } } }],
      },
    },
    // Una receta vacía no descuenta nada: para el panel es lo mismo que no tenerla.
    { $addFields: { hasRecipe: { $gt: [{ $sum: "$recipe.count" }, 0] } } },
    { $project: { recipe: 0 } },
  ];
  if (filters.onlyWithoutRecipe) pipeline.push({ $match: { hasRecipe: false } });
  pipeline.push({ $sort: { category: 1, name: 1 } });

  return Product.aggregate(pipeline);
}

async function withRecipeFlag(product: any) {
  const recipe = await Recipe.findOne({ product: product._id }).select("items").lean<any>();
  return { ...product, hasRecipe: Boolean(recipe?.items?.length) };
}

async function assertUniqueName(normalizedName: string, exceptId?: string) {
  const filter: Record<string, unknown> = { normalizedName };
  if (exceptId) filter._id = { $ne: exceptId };
  if (await Product.exists(filter)) {
    throw new CustomError("Ya existe un plato con ese nombre", 409);
  }
}

export async function createProduct(input: Record<string, unknown>) {
  await ensureDb();
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const normalizedName = normalizeName(name);
  if (!normalizedName) throw new CustomError("Escribe el nombre del plato", 400);
  await assertUniqueName(normalizedName);

  const product = await Product.create({
    name,
    normalizedName,
    smartmenuCode: typeof input.smartmenuCode === "string" ? input.smartmenuCode.trim() : "",
    category:
      typeof input.category === "string" && input.category.trim()
        ? input.category.trim()
        : "General",
    priceCents: input.priceCents === undefined ? 0 : toCents(input.priceCents),
  });
  return withRecipeFlag(product.toObject());
}

export async function updateProduct(id: string, input: Record<string, unknown>) {
  await ensureDb();
  assertId(id);
  const product = await Product.findById(id);
  if (!product) throw new CustomError("Plato no encontrado", 404);

  if (input.name !== undefined) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const normalizedName = normalizeName(name);
    if (!normalizedName) throw new CustomError("Escribe el nombre del plato", 400);
    await assertUniqueName(normalizedName, id);
    product.name = name;
    product.normalizedName = normalizedName;
  }
  if (input.smartmenuCode !== undefined) {
    product.smartmenuCode =
      typeof input.smartmenuCode === "string" ? input.smartmenuCode.trim() : "";
  }
  if (input.category !== undefined) {
    product.category =
      typeof input.category === "string" && input.category.trim()
        ? input.category.trim()
        : "General";
  }
  if (input.priceCents !== undefined) product.priceCents = toCents(input.priceCents);
  if (input.isActive !== undefined) product.isActive = Boolean(input.isActive);

  await product.save();
  return withRecipeFlag(product.toObject());
}
