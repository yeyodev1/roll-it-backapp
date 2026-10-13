import mongoose, { Schema, Types } from "mongoose";

export const MOVEMENT_TYPES = ["initial", "purchase", "sale", "adjustment", "waste"] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

/**
 * Libro de inventario. Nunca se edita ni se borra un movimiento: una
 * corrección es otro movimiento de tipo "adjustment". Así siempre se puede
 * explicar de dónde sale el stock de hoy.
 */
export interface IInventoryMovement {
  _id: Types.ObjectId;
  branch: Types.ObjectId;
  ingredient: Types.ObjectId;
  type: MovementType;
  // Con signo: positivo entra, negativo sale.
  quantity: number;
  refModel: "Sale" | "PurchaseInvoice" | null;
  refId: Types.ObjectId | null;
  note: string;
  createdBy: Types.ObjectId | null;
  date: Date;
  createdAt?: Date;
}

const inventoryMovementSchema = new Schema<IInventoryMovement>(
  {
    branch: { type: Schema.Types.ObjectId, ref: "Branch", required: true, index: true },
    ingredient: { type: Schema.Types.ObjectId, ref: "Ingredient", required: true, index: true },
    type: { type: String, enum: MOVEMENT_TYPES, required: true },
    quantity: { type: Number, required: true },
    refModel: { type: String, enum: ["Sale", "PurchaseInvoice", null], default: null },
    refId: { type: Schema.Types.ObjectId, default: null },
    note: { type: String, default: "" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    date: { type: Date, default: () => new Date(), index: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

inventoryMovementSchema.index({ branch: 1, date: -1 });

export const InventoryMovement =
  mongoose.models.InventoryMovement ||
  mongoose.model<IInventoryMovement>("InventoryMovement", inventoryMovementSchema);
