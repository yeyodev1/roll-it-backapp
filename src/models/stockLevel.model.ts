import mongoose, { Schema, Types } from "mongoose";

/**
 * Existencia actual de un insumo en una sucursal. Es una caché del libro de
 * movimientos: se actualiza con $inc en cada movimiento para leer el stock sin
 * sumar todo el historial.
 */
export interface IStockLevel {
  _id: Types.ObjectId;
  branch: Types.ObjectId;
  ingredient: Types.ObjectId;
  quantity: number;
  // null = usar el umbral por defecto del insumo.
  minStock: number | null;
  maxStock: number | null;
  updatedAt?: Date;
  createdAt?: Date;
}

const stockLevelSchema = new Schema<IStockLevel>(
  {
    branch: { type: Schema.Types.ObjectId, ref: "Branch", required: true },
    ingredient: { type: Schema.Types.ObjectId, ref: "Ingredient", required: true },
    quantity: { type: Number, default: 0 },
    minStock: { type: Number, default: null },
    maxStock: { type: Number, default: null },
  },
  { timestamps: true },
);

stockLevelSchema.index({ branch: 1, ingredient: 1 }, { unique: true });

export const StockLevel =
  mongoose.models.StockLevel || mongoose.model<IStockLevel>("StockLevel", stockLevelSchema);
