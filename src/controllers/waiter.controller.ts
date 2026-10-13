import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/AuthRequest";
import { resolveBranchScope } from "../utils/branchScope";
import * as waiterService from "../services/waiter.service";

/** GET /api/waiters — ?branch= (el personal solo ve los de su sucursal) */
export async function list(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const branch = resolveBranchScope(req, req.query.branch);
    res.status(200).json(await waiterService.listWaiters(branch));
  } catch (error) {
    next(error);
  }
}

/** PUT /api/waiters/:id — body: { name?, isActive? } */
export async function update(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await waiterService.updateWaiter(String(req.params.id), req.body ?? {}));
  } catch (error) {
    next(error);
  }
}
