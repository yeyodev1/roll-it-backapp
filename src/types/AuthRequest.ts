import { Request } from "express";

export interface JwtPayload {
  userId: string;
  email: string;
  accountType: string;
  // Sucursal del personal; null para el dueño.
  branch: string | null;
}

export interface AuthRequest extends Request {
  user?: JwtPayload;
}
