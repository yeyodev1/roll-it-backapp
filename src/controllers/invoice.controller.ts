import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/AuthRequest";
import { CustomError } from "../errors/customError.error";
import { resolveBranchScope } from "../utils/branchScope";
import * as invoiceService from "../services/invoice.service";

function userId(req: AuthRequest): string {
  if (!req.user) throw new CustomError("No autorizado", 401);
  return req.user.userId;
}

function idParam(req: AuthRequest): string {
  return String(req.params.id ?? "");
}

/** GET /api/invoices — ?branch=&status=&page= */
export async function list(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const result = await invoiceService.listInvoices({
      scope: resolveBranchScope(req, req.query.branch),
      status: req.query.status,
      page: req.query.page,
    });
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

/** GET /api/invoices/:id */
export async function getById(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await invoiceService.getInvoice(idParam(req), resolveBranchScope(req)));
  } catch (error) {
    next(error);
  }
}

/** POST /api/invoices — multipart: image + branch (el staff siempre usa la suya). */
export async function create(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const invoice = await invoiceService.createInvoice({
      file: req.file
        ? { buffer: req.file.buffer, mimetype: req.file.mimetype, size: req.file.size }
        : undefined,
      branch: resolveBranchScope(req, req.body?.branch),
      userId: userId(req),
    });
    res.status(201).json(invoice);
  } catch (error) {
    next(error);
  }
}

/** PUT /api/invoices/:id — { supplier?, invoiceNumber?, date?, lines? } solo en revisión. */
export async function update(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res
      .status(200)
      .json(
        await invoiceService.updateInvoice(idParam(req), resolveBranchScope(req), req.body ?? {}),
      );
  } catch (error) {
    next(error);
  }
}

/** POST /api/invoices/:id/confirm — suma al stock. */
export async function confirm(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res
      .status(200)
      .json(
        await invoiceService.confirmInvoice(idParam(req), resolveBranchScope(req), userId(req)),
      );
  } catch (error) {
    next(error);
  }
}

/** POST /api/invoices/:id/reject */
export async function reject(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await invoiceService.rejectInvoice(idParam(req), resolveBranchScope(req)));
  } catch (error) {
    next(error);
  }
}
