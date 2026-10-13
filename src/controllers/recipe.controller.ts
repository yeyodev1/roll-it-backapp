import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/AuthRequest";
import * as recipeService from "../services/recipe.service";
import * as recipeImportService from "../services/recipeImport.service";

/** GET /api/recipes */
export async function list(_req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await recipeService.listRecipes());
  } catch (error) {
    next(error);
  }
}

/** GET /api/recipes/product/:productId */
export async function getByProduct(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await recipeService.getRecipeByProduct(String(req.params.productId)));
  } catch (error) {
    next(error);
  }
}

/** PUT /api/recipes/product/:productId — body: { items: [{ ingredient, quantity }], notes? } */
export async function upsert(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const recipe = await recipeService.upsertRecipe(String(req.params.productId), req.body ?? {});
    res.status(200).json(recipe);
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/recipes/product/:productId */
export async function remove(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await recipeService.deleteRecipe(String(req.params.productId)));
  } catch (error) {
    next(error);
  }
}

/** POST /api/recipes/import — multipart `file` (.xlsx o .csv) */
export async function importFile(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await recipeImportService.importRecipes(req.file));
  } catch (error) {
    next(error);
  }
}
