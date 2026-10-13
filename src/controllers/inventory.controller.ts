import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/AuthRequest";
import { resolveBranchScope } from "../utils/branchScope";
import * as inventoryService from "../services/inventory.service";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** GET /api/inventory — ?branch=&status= */
export async function list(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const branch = resolveBranchScope(req, req.query.branch);
    res.status(200).json(await inventoryService.getInventory(branch, text(req.query.status)));
  } catch (error) {
    next(error);
  }
}

/** GET /api/inventory/movements — ?branch=&ingredient=&type=&page=&limit= */
export async function movements(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const result = await inventoryService.listMovements({
      branch: resolveBranchScope(req, req.query.branch),
      ingredient: text(req.query.ingredient),
      type: text(req.query.type),
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 50,
    });
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

/** POST /api/inventory/initial — body: { branch, items: [{ ingredient, quantity }] } */
export async function initial(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const body = req.body ?? {};
    const result = await inventoryService.setInitialStock(
      resolveBranchScope(req, body.branch),
      body.items,
      req.user?.userId ?? null,
    );
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

/** POST /api/inventory/adjust — body: { branch, ingredient, quantity, type, note } */
export async function adjust(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const body = req.body ?? {};
    const row = await inventoryService.adjustStock(
      resolveBranchScope(req, body.branch),
      body,
      req.user?.userId ?? null,
    );
    res.status(200).json(row);
  } catch (error) {
    next(error);
  }
}

/** PUT /api/inventory/thresholds — body: { branch, ingredient, minStock, maxStock } */
export async function thresholds(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const body = req.body ?? {};
    const row = await inventoryService.setThresholds(resolveBranchScope(req, body.branch), body);
    res.status(200).json(row);
  } catch (error) {
    next(error);
  }
}

/** GET /api/inventory/ask — ?q=&branch= */
export async function ask(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const branch = resolveBranchScope(req, req.query.branch);
    res.status(200).json(await inventoryService.askStock(text(req.query.q), branch));
  } catch (error) {
    next(error);
  }
}
