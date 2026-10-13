import mongoose, { Schema, Types } from "mongoose";

/**
 * Plato del menú tal como sale en SmartMenu. `smartmenuCode` es la llave para
 * cruzar una venta con su receta; si SmartMenu no trae código se cruza por nombre.
 */
export interface IProduct {
  _id: Types.ObjectId;
  name: string;
  normalizedName: string;
  smartmenuCode: string;
  category: string;
  priceCents: number;
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

const productSchema = new Schema<IProduct>(
  {
    name: { type: String, required: true, trim: true },
    // Nombre en minúsculas y sin tildes: así "Maki Acevichado" y "maki acevichado " son el mismo plato.
    normalizedName: { type: String, required: true, unique: true, index: true },
    smartmenuCode: { type: String, default: "", index: true },
    category: { type: String, default: "General", trim: true },
    priceCents: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const Product = mongoose.models.Product || mongoose.model<IProduct>("Product", productSchema);
