import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/AuthRequest";
import * as ingredientService from "../services/ingredient.service";

/** GET /api/ingredients — ?q= */
export async function list(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    res.status(200).json(await ingredientService.listIngredients({ q }));
  } catch (error) {
    next(error);
  }
}

/** POST /api/ingredients — body: { name, unit, costPerUnitCents?, defaultMinStock?, defaultMaxStock?, aliases? } */
export async function create(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await ingredientService.createIngredient(req.body ?? {}));
  } catch (error) {
    next(error);
  }
}

/** PUT /api/ingredients/:id — body parcial */
export async function update(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ingredient = await ingredientService.updateIngredient(
      String(req.params.id),
      req.body ?? {},
    );
    res.status(200).json(ingredient);
  } catch (error) {
    next(error);
  }
}
