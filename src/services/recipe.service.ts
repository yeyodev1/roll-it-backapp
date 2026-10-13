import { Types } from "mongoose";
import { dbConnect, isConnected } from "../config/mongo";
import { CustomError } from "../errors/customError.error";
import { Ingredient } from "../models/ingredient.model";
import { Product } from "../models/product.model";
import { Recipe } from "../models/recipe.model";

async function ensureDb() {
  if (!isConnected() && !(await dbConnect())) {
    throw new CustomError("El servidor no tiene base de datos disponible", 503);
  }
}

function assertProductId(id: string) {
  if (!Types.ObjectId.isValid(id)) throw new CustomError("Plato inválido", 400);
}

function populated(query: any) {
  return query
    .populate("product", "name category")
    .populate("items.ingredient", "name unit")
    .lean();
}

export async function listRecipes() {
  await ensureDb();
  const recipes: any[] = await populated(Recipe.find());
  // Una receta cuyo plato se borró a mano en la base no sirve de nada en el panel.
  return recipes
    .filter((r) => r.product)
    .map((r) => ({ ...r, items: r.items.filter((i: any) => i.ingredient) }))
    .sort((a, b) => a.product.name.localeCompare(b.product.name, "es"));
}

export async function getRecipeByProduct(productId: string) {
  await ensureDb();
  assertProductId(productId);
  const recipe = await populated(Recipe.findOne({ product: productId }));
  if (!recipe) throw new CustomError("Este plato todavía no tiene receta", 404);
  return recipe;
}

export async function upsertRecipe(productId: string, input: { items?: unknown; notes?: unknown }) {
  await ensureDb();
  assertProductId(productId);
  if (!(await Product.exists({ _id: productId }))) {
    throw new CustomError("Plato no encontrado", 404);
  }
  if (!Array.isArray(input.items)) {
    throw new CustomError("La receta necesita una lista de insumos", 400);
  }

  // Si el mismo insumo viene dos veces se suma: así la receta queda con una línea por insumo.
  const quantities = new Map<string, number>();
  for (const raw of input.items as any[]) {
    const ingredient =
      typeof raw?.ingredient === "string" ? raw.ingredient : String(raw?.ingredient ?? "");
    const quantity = Number(raw?.quantity);
    if (!Types.ObjectId.isValid(ingredient)) {
      throw new CustomError("Insumo inválido en la receta", 400);
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new CustomError("Cada insumo de la receta necesita una cantidad mayor a cero", 400);
    }
    quantities.set(ingredient, (quantities.get(ingredient) ?? 0) + quantity);
  }

  const ids = [...quantities.keys()];
  const found = await Ingredient.countDocuments({ _id: { $in: ids } });
  if (found !== ids.length) throw new CustomError("Algún insumo de la receta no existe", 404);

  const update: Record<string, unknown> = {
    items: ids.map((ingredient) => ({ ingredient, quantity: quantities.get(ingredient) })),
  };
  if (input.notes !== undefined) {
    update.notes = typeof input.notes === "string" ? input.notes.trim() : "";
  }

  await Recipe.findOneAndUpdate(
    { product: productId },
    { $set: update },
    { upsert: true, setDefaultsOnInsert: true },
  );
  return getRecipeByProduct(productId);
}

export async function deleteRecipe(productId: string) {
  await ensureDb();
  assertProductId(productId);
  await Recipe.deleteOne({ product: productId });
  return { ok: true };
}
