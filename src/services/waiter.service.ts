import { Types } from "mongoose";
import { dbConnect, isConnected } from "../config/mongo";
import { CustomError } from "../errors/customError.error";
import { Waiter } from "../models/waiter.model";
import { normalizeName } from "../utils/normalize";

async function ensureDb() {
  if (!isConnected() && !(await dbConnect())) {
    throw new CustomError("El servidor no tiene base de datos disponible", 503);
  }
}

export async function listWaiters(branchId: string | null) {
  await ensureDb();
  const filter: Record<string, unknown> = {};
  if (branchId) {
    if (!Types.ObjectId.isValid(branchId)) throw new CustomError("Sucursal inválida", 400);
    filter.branch = branchId;
  }
  return Waiter.find(filter).select("name branch isActive").sort({ name: 1 }).lean();
}

export async function updateWaiter(id: string, input: { name?: unknown; isActive?: unknown }) {
  await ensureDb();
  if (!Types.ObjectId.isValid(id)) throw new CustomError("Mesero inválido", 400);
  const waiter = await Waiter.findById(id);
  if (!waiter) throw new CustomError("Mesero no encontrado", 404);

  if (input.name !== undefined) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const normalizedName = normalizeName(name);
    if (!normalizedName) throw new CustomError("Escribe el nombre del mesero", 400);
    const taken = await Waiter.exists({
      branch: waiter.branch,
      normalizedName,
      _id: { $ne: waiter._id },
    });
    if (taken) throw new CustomError("Ya existe un mesero con ese nombre en la sucursal", 409);
    waiter.name = name;
    waiter.normalizedName = normalizedName;
  }
  if (input.isActive !== undefined) waiter.isActive = Boolean(input.isActive);

  await waiter.save();
  const { _id, name, branch, isActive } = waiter.toObject();
  return { _id, name, branch, isActive };
}
