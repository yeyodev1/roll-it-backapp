import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/AuthRequest";

/** Dueño o personal de sucursal. Va siempre después de authMiddleware. */
export function staffMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const type = req.user?.accountType;
  if (type !== "admin" && type !== "staff") {
    res.status(403).json({ message: "No tienes permiso para ver esto" });
    return;
  }
  if (type === "staff" && !req.user?.branch) {
    res.status(403).json({ message: "Tu cuenta no tiene una sucursal asignada" });
    return;
  }
  next();
}
