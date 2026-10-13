import { AuthRequest } from "../types/AuthRequest";

/**
 * Qué sucursal puede consultar quien hace la petición.
 *
 * El dueño elige (o null = todas). El personal siempre queda en la suya,
 * aunque mande otra en el query: así no hace falta validarlo en cada service.
 */
export function resolveBranchScope(req: AuthRequest, requested?: unknown): string | null {
  if (req.user?.accountType === "staff") return req.user.branch;
  const value = typeof requested === "string" ? requested.trim() : "";
  return value && value !== "all" ? value : null;
}
