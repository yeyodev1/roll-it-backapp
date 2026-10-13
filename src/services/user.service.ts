import { Types } from "mongoose";
import { dbConnect, isConnected } from "../config/mongo";
import { CustomError } from "../errors/customError.error";
import { Branch } from "../models/branch.model";
import { User } from "../models/user.model";
import { createUser } from "./auth.service";

const PANEL_TYPES = ["admin", "staff"] as const;
type PanelType = (typeof PANEL_TYPES)[number];

export interface StaffUser {
  id: string;
  email: string;
  name: string;
  phone: string;
  accountType: string;
  branch: string | null;
  isActive: boolean;
}

async function ensureDb() {
  if (!isConnected() && !(await dbConnect())) {
    throw new CustomError("El servidor no tiene base de datos disponible", 503);
  }
}

function toStaffUser(user: any): StaffUser {
  return {
    id: user._id.toString(),
    email: user.email,
    name: user.name,
    phone: user.phone,
    accountType: user.accountType,
    branch: user.branch ? user.branch.toString() : null,
    isActive: user.isActive !== false,
  };
}

async function assertBranch(value: unknown): Promise<string> {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) throw new CustomError("El personal necesita una sucursal asignada", 400);
  if (!Types.ObjectId.isValid(id) || !(await Branch.exists({ _id: id }))) {
    throw new CustomError("Sucursal no encontrada", 404);
  }
  return id;
}

/** Solo cuentas del panel: los "customer" de la plantilla no se administran aquí. */
export async function listUsers(): Promise<StaffUser[]> {
  await ensureDb();
  const users = await User.find({ accountType: { $in: PANEL_TYPES } })
    .sort({ accountType: 1, name: 1 })
    .lean();
  return users.map(toStaffUser);
}

export async function createPanelUser(input: Record<string, unknown>): Promise<StaffUser> {
  await ensureDb();
  const accountType = input.accountType as PanelType;
  if (!PANEL_TYPES.includes(accountType)) {
    throw new CustomError("El tipo de cuenta debe ser admin o staff", 400);
  }
  const email = typeof input.email === "string" ? input.email.toLowerCase().trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!email || !password) throw new CustomError("Escribe el correo y la contraseña", 400);
  if (!name) throw new CustomError("Escribe el nombre de la persona", 400);

  // El dueño ve todas las sucursales: una sucursal en su cuenta no significaría nada.
  const branch = accountType === "staff" ? await assertBranch(input.branch) : null;

  if (await User.exists({ email })) {
    throw new CustomError("Ya existe una cuenta con ese correo", 409);
  }

  const session = await createUser({ email, password, name, accountType, branch });
  return { ...session, isActive: true };
}

export async function updatePanelUser(
  id: string,
  input: Record<string, unknown>,
  actorId: string,
): Promise<StaffUser> {
  await ensureDb();
  if (!Types.ObjectId.isValid(id)) throw new CustomError("Usuario inválido", 400);
  const user = await User.findOne({ _id: id, accountType: { $in: PANEL_TYPES } });
  if (!user) throw new CustomError("Usuario no encontrado", 404);

  if (input.name !== undefined) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) throw new CustomError("Escribe el nombre de la persona", 400);
    user.name = name;
  }
  if (input.branch !== undefined && user.accountType === "staff") {
    user.branch = new Types.ObjectId(await assertBranch(input.branch));
  }
  if (input.isActive !== undefined) {
    const isActive = Boolean(input.isActive);
    // Evita que el dueño se deje fuera del panel sin querer.
    if (!isActive && user._id.toString() === actorId) {
      throw new CustomError("No puedes desactivar tu propia cuenta", 400);
    }
    user.isActive = isActive;
  }
  if (input.password !== undefined && input.password !== "") {
    const password = typeof input.password === "string" ? input.password : "";
    if (password.length < 8) {
      throw new CustomError("La contraseña debe tener al menos 8 caracteres", 400);
    }
    user.password = password;
  }

  await user.save();
  return toStaffUser(user);
}
