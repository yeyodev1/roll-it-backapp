import { Request, Response, NextFunction } from "express";
import * as syncService from "../services/sync.service";
import * as salesReportImportService from "../services/salesReportImport.service";

/** POST /api/sync/sales — header x-sync-key; body: { branch: slug, sales: [...] } */
export async function sales(req: Request, res: Response, next: NextFunction) {
  try {
    const body = req.body ?? {};
    res.status(200).json(await syncService.ingestSales(body.branch, body.sales));
  } catch (error) {
    next(error);
  }
}

/** GET /api/sync/status — última sincronización y tickets de hoy por sucursal. */
export async function status(_req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await syncService.getSyncStatus());
  } catch (error) {
    next(error);
  }
}

/** POST /api/sync/upload — multipart `file` (reporte de SmartMenu) y opcional `branch` (slug). */
export async function upload(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await salesReportImportService.importSalesReport(req.file, req.body?.branch);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}
