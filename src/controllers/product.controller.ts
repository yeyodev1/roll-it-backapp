import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/AuthRequest";
import * as productService from "../services/product.service";

/** GET /api/products — ?q=&category=&onlyWithoutRecipe=true */
export async function list(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { q, category, onlyWithoutRecipe } = req.query;
    const products = await productService.listProducts({
      q: typeof q === "string" ? q : "",
      category: typeof category === "string" ? category : "",
      onlyWithoutRecipe: onlyWithoutRecipe === "true",
    });
    res.status(200).json(products);
  } catch (error) {
    next(error);
  }
}

/** POST /api/products — body: { name, smartmenuCode?, category?, priceCents? } */
export async function create(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await productService.createProduct(req.body ?? {}));
  } catch (error) {
    next(error);
  }
}

/** PUT /api/products/:id — body parcial */
export async function update(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await productService.updateProduct(String(req.params.id), req.body ?? {}));
  } catch (error) {
    next(error);
  }
}
