import mongoose, { Schema, Types } from "mongoose";

/** Cuánto de cada insumo consume UNA unidad vendida del plato. */
export interface IRecipeItem {
  ingredient: Types.ObjectId;
  quantity: number;
}

export interface IRecipe {
  _id: Types.ObjectId;
  product: Types.ObjectId;
  items: IRecipeItem[];
  notes: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const recipeItemSchema = new Schema<IRecipeItem>(
  {
    ingredient: { type: Schema.Types.ObjectId, ref: "Ingredient", required: true },
    quantity: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const recipeSchema = new Schema<IRecipe>(
  {
    product: { type: Schema.Types.ObjectId, ref: "Product", required: true, unique: true, index: true },
    items: { type: [recipeItemSchema], default: [] },
    notes: { type: String, default: "" },
  },
  { timestamps: true },
);

export const Recipe = mongoose.models.Recipe || mongoose.model<IRecipe>("Recipe", recipeSchema);
