import mongoose, { Schema, Types } from "mongoose";

/**
 * Sucursal. Cada una tiene su propio SmartMenu en un servidor físico del local,
 * por eso la URL interna vive acá y no en el entorno: cambia por sucursal.
 */
export interface IBranch {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  smartmenuUrl: string;
  isActive: boolean;
  lastSyncAt: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const branchSchema = new Schema<IBranch>(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, index: true, lowercase: true, trim: true },
    smartmenuUrl: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
    lastSyncAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const Branch = mongoose.models.Branch || mongoose.model<IBranch>("Branch", branchSchema);
