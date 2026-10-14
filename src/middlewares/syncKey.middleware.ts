import { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "crypto";
import { env } from "../config/env";

/** true si el header trae la llave del agente. Sin SYNC_API_KEY configurada nunca coincide. */
export function isValidSyncKey(header: unknown): boolean {
  if (!env.SYNC_API_KEY) return false;
  const received = Buffer.from(typeof header === "string" ? header : "");
  const expected = Buffer.from(env.SYNC_API_KEY);
  // Comparación en tiempo constante: no deja adivinar la llave midiendo cuánto tarda la respuesta.
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/**
 * Llave compartida del agente que corre en la PC de cada sucursal.
 *
 * Sin SYNC_API_KEY configurada la ruta queda cerrada: es preferible que no
 * entren ventas a que cualquiera pueda inyectarlas desde internet.
 */
export function syncKeyMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!env.SYNC_API_KEY) {
    res.status(503).json({ message: "La sincronización no está configurada" });
    return;
  }
  if (!isValidSyncKey(req.headers["x-sync-key"])) {
    res.status(401).json({ message: "Llave de sincronización inválida" });
    return;
  }
  next();
}
