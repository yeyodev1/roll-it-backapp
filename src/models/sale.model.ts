import mongoose, { Schema, Types } from "mongoose";

export interface ISaleItem {
  product: Types.ObjectId | null;
  productName: string;
  smartmenuCode: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
}

/**
 * Ticket de venta copiado desde SmartMenu. `externalId` es el número de
 * ticket del sistema de la sucursal: con él la sincronización es idempotente
 * (mandar el mismo ticket dos veces no lo duplica ni descuenta dos veces).
 */
export interface ISale {
  _id: Types.ObjectId;
  branch: Types.ObjectId;
  externalId: string;
  waiter: Types.ObjectId | null;
  waiterName: string;
  date: Date;
  // Día de la semana (0 = domingo) y hora en zona Ecuador, precalculados para las franjas horarias.
  weekday: number;
  hour: number;
  items: ISaleItem[];
  subtotalCents: number;
  totalCents: number;
  guests: number;
  table: string;
  status: "paid" | "void";
  inventoryApplied: boolean;
  source: "smartmenu" | "demo" | "manual";
  createdAt?: Date;
  updatedAt?: Date;
}

const saleItemSchema = new Schema<ISaleItem>(
  {
    product: { type: Schema.Types.ObjectId, ref: "Product", default: null },
    productName: { type: String, required: true },
    smartmenuCode: { type: String, default: "" },
    quantity: { type: Number, required: true, min: 0 },
    unitPriceCents: { type: Number, default: 0 },
    totalCents: { type: Number, default: 0 },
  },
  { _id: false },
);

const saleSchema = new Schema<ISale>(
  {
    branch: { type: Schema.Types.ObjectId, ref: "Branch", required: true },
    externalId: { type: String, required: true },
    waiter: { type: Schema.Types.ObjectId, ref: "Waiter", default: null },
    waiterName: { type: String, default: "" },
    date: { type: Date, required: true },
    weekday: { type: Number, required: true, min: 0, max: 6 },
    hour: { type: Number, required: true, min: 0, max: 23 },
    items: { type: [saleItemSchema], default: [] },
    subtotalCents: { type: Number, default: 0 },
    totalCents: { type: Number, default: 0 },
    guests: { type: Number, default: 0 },
    table: { type: String, default: "" },
    status: { type: String, enum: ["paid", "void"], default: "paid" },
    inventoryApplied: { type: Boolean, default: false },
    source: { type: String, enum: ["smartmenu", "demo", "manual"], default: "smartmenu" },
  },
  { timestamps: true },
);

saleSchema.index({ branch: 1, externalId: 1 }, { unique: true });
saleSchema.index({ date: -1, branch: 1 });
saleSchema.index({ waiter: 1, date: -1 });

export const Sale = mongoose.models.Sale || mongoose.model<ISale>("Sale", saleSchema);
