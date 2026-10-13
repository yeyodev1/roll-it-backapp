import mongoose, { Schema, Types } from "mongoose";

export const INGREDIENT_UNITS = ["g", "kg", "ml", "l", "unidad"] as const;
export type IngredientUnit = (typeof INGREDIENT_UNITS)[number];

/**
 * Insumo (salmón, arroz, alga…). Las cantidades de stock y recetas se guardan
 * siempre en la unidad del insumo para no convertir en cada cálculo.
 */
export interface IIngredient {
  _id: Types.ObjectId;
  name: string;
  normalizedName: string;
  unit: IngredientUnit;
  costPerUnitCents: number;
  // Umbrales por defecto; cada sucursal puede sobreescribirlos en su StockLevel.
  defaultMinStock: number;
  defaultMaxStock: number;
  aliases: string[];
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

const ingredientSchema = new Schema<IIngredient>(
  {
    name: { type: String, required: true, trim: true },
    normalizedName: { type: String, required: true, unique: true, index: true },
    unit: { type: String, enum: INGREDIENT_UNITS, default: "g" },
    costPerUnitCents: { type: Number, default: 0, min: 0 },
    defaultMinStock: { type: Number, default: 0, min: 0 },
    defaultMaxStock: { type: Number, default: 0, min: 0 },
    // Cómo lo escribe el proveedor en la factura ("SALMON FRESCO NORUEGO"): ayuda al cruce automático.
    aliases: { type: [String], default: [] },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const Ingredient =
  mongoose.models.Ingredient || mongoose.model<IIngredient>("Ingredient", ingredientSchema);
