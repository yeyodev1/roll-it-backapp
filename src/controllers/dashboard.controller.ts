import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/AuthRequest";
import * as dashboardService from "../services/dashboard.service";
import * as waiterScoreService from "../services/waiterScore.service";
import * as financeService from "../services/finance.service";

function readQuery(req: AuthRequest): dashboardService.DashboardQuery {
  return { branch: req.query.branch, from: req.query.from, to: req.query.to };
}

/** GET /api/dashboard/summary — ?branch=&from=&to= */
export async function summary(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await dashboardService.getSummary(readQuery(req)));
  } catch (error) {
    next(error);
  }
}

/** GET /api/dashboard/operations — ?branch=&from=&to= */
export async function operations(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await dashboardService.getOperations(readQuery(req)));
  } catch (error) {
    next(error);
  }
}

/** GET /api/dashboard/waiters — ?branch=&from=&to= */
export async function waiters(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await waiterScoreService.getWaiters(readQuery(req)));
  } catch (error) {
    next(error);
  }
}

/** GET /api/dashboard/finance — ?branch= (from/to no aplican) */
export async function finance(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await financeService.getFinance(readQuery(req)));
  } catch (error) {
    next(error);
  }
}
