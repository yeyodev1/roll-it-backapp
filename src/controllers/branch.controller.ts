import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/AuthRequest";
import * as branchService from "../services/branch.service";

/** GET /api/branches */
export async function list(_req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await branchService.listBranches());
  } catch (error) {
    next(error);
  }
}

/** POST /api/branches — body: { name, smartmenuUrl? } */
export async function create(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await branchService.createBranch(req.body ?? {}));
  } catch (error) {
    next(error);
  }
}

/** PUT /api/branches/:id — body: { name?, smartmenuUrl?, isActive? } */
export async function update(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await branchService.updateBranch(String(req.params.id), req.body ?? {}));
  } catch (error) {
    next(error);
  }
}
