import mongoose, { Schema, Types } from "mongoose";

/**
 * Mesero o vendedor tal como aparece en SmartMenu. No es un usuario del
 * panel: solo existe para medir su desempeño.
 */
export interface IWaiter {
  _id: Types.ObjectId;
  name: string;
  normalizedName: string;
  branch: Types.ObjectId;
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

const waiterSchema = new Schema<IWaiter>(
  {
    name: { type: String, required: true, trim: true },
    normalizedName: { type: String, required: true },
    branch: { type: Schema.Types.ObjectId, ref: "Branch", required: true, index: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

waiterSchema.index({ branch: 1, normalizedName: 1 }, { unique: true });

export const Waiter = mongoose.models.Waiter || mongoose.model<IWaiter>("Waiter", waiterSchema);
