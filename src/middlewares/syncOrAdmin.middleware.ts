import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/AuthRequest";
import { authMiddleware } from "./auth.middleware";
import { adminMiddleware } from "./admin.middleware";
import { syncKeyMiddleware } from "./syncKey.middleware";

/**
 * La misma ruta la usan el dueño desde el panel (JWT admin) y el agente del
 * local (header `x-sync-key`). Si llega el header se valida solo la llave: un
 * header equivocado responde 401 y no cae al JWT, así un agente mal configurado
 * se nota enseguida.
 */
export function syncOrAdminMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.headers["x-sync-key"] !== undefined) {
    syncKeyMiddleware(req, res, () => {
      req.syncAgent = true;
      next();
    });
    return;
  }
  authMiddleware(req, res, () => adminMiddleware(req, res, next));
}
