import { Types } from "mongoose";
import { InventoryMovement, MovementType } from "../models/inventoryMovement.model";
import { StockLevel } from "../models/stockLevel.model";

export type StockStatus = "out" | "low" | "ok" | "over";

type Id = string | Types.ObjectId;

export interface MovementInput {
  branch: Id;
  ingredient: Id;
  type: MovementType;
  // Con signo: positivo entra, negativo sale.
  quantity: number;
  refModel?: "Sale" | "PurchaseInvoice" | null;
  refId?: Id | null;
  note?: string;
  createdBy?: Id | null;
  date?: Date;
}

/**
 * Única puerta para mover stock: escribe el movimiento en el libro y ajusta
 * la existencia con $inc (atómico, no se pisa con otra venta que entra a la
 * vez). Ningún otro service debe tocar StockLevel.quantity directamente.
 */
export async function applyMovement(input: MovementInput) {
  if (!Number.isFinite(input.quantity) || input.quantity === 0) return null;

  await InventoryMovement.create({
    branch: input.branch,
    ingredient: input.ingredient,
    type: input.type,
    quantity: input.quantity,
    refModel: input.refModel ?? null,
    refId: input.refId ?? null,
    note: input.note ?? "",
    createdBy: input.createdBy ?? null,
    date: input.date ?? new Date(),
  });

  return StockLevel.findOneAndUpdate(
    { branch: input.branch, ingredient: input.ingredient },
    { $inc: { quantity: input.quantity } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

/** Varios movimientos de una vez (una venta descuenta varios insumos). */
export async function applyMovements(inputs: MovementInput[]) {
  for (const input of inputs) {
    await applyMovement(input);
  }
}

/** Umbrales efectivos: los de la sucursal si existen, si no los del insumo. */
export function effectiveThresholds(
  level: { minStock?: number | null; maxStock?: number | null } | null,
  ingredient: { defaultMinStock?: number; defaultMaxStock?: number },
): { minStock: number; maxStock: number } {
  return {
    minStock: level?.minStock ?? ingredient.defaultMinStock ?? 0,
    maxStock: level?.maxStock ?? ingredient.defaultMaxStock ?? 0,
  };
}

/** Reglas de docs/API.md: agotado, por acabarse, óptimo, sobrestock. */
export function computeStatus(quantity: number, minStock: number, maxStock: number): StockStatus {
  if (quantity <= 0) return "out";
  if (quantity <= minStock) return "low";
  if (maxStock > 0 && quantity > maxStock) return "over";
  return "ok";
}
