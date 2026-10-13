import { Types } from "mongoose";
import { dbConnect, isConnected } from "../config/mongo";
import { CustomError } from "../errors/customError.error";
import { Branch } from "../models/branch.model";
import { slugify } from "../utils/slugify";

async function ensureDb() {
  if (!isConnected() && !(await dbConnect())) {
    throw new CustomError("El servidor no tiene base de datos disponible", 503);
  }
}

function assertId(id: string) {
  if (!Types.ObjectId.isValid(id)) throw new CustomError("Sucursal inválida", 400);
}

export async function listBranches() {
  await ensureDb();
  return Branch.find().sort({ name: 1 }).lean();
}

export async function createBranch(input: { name?: unknown; smartmenuUrl?: unknown }) {
  await ensureDb();
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new CustomError("Escribe el nombre de la sucursal", 400);

  const slug = slugify(name);
  if (!slug) throw new CustomError("El nombre de la sucursal no es válido", 400);
  if (await Branch.exists({ slug })) {
    throw new CustomError("Ya existe una sucursal con ese nombre", 409);
  }

  const branch = await Branch.create({
    name,
    slug,
    smartmenuUrl: typeof input.smartmenuUrl === "string" ? input.smartmenuUrl.trim() : "",
  });
  return branch.toObject();
}

export async function updateBranch(
  id: string,
  input: { name?: unknown; smartmenuUrl?: unknown; isActive?: unknown },
) {
  await ensureDb();
  assertId(id);
  const branch = await Branch.findById(id);
  if (!branch) throw new CustomError("Sucursal no encontrada", 404);

  // El slug no cambia al renombrar: es la llave con la que el agente de
  // SmartMenu de cada local se identifica, y cambiarlo cortaría la sincronización.
  if (input.name !== undefined) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) throw new CustomError("Escribe el nombre de la sucursal", 400);
    branch.name = name;
  }
  if (input.smartmenuUrl !== undefined) {
    branch.smartmenuUrl = typeof input.smartmenuUrl === "string" ? input.smartmenuUrl.trim() : "";
  }
  if (input.isActive !== undefined) branch.isActive = Boolean(input.isActive);

  await branch.save();
  return branch.toObject();
}
