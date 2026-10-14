import mongoose, { Schema, Types } from "mongoose";

export const INVOICE_STATUSES = ["review", "confirmed", "rejected"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export interface IInvoiceLine {
  rawName: string;
  ingredient: Types.ObjectId | null;
  // En la unidad del insumo (ya convertida), lista para sumar al stock.
  quantity: number;
  rawQuantity: number;
  rawUnit: string;
  unitCostCents: number;
  totalCents: number;
}

export const INVOICE_SOURCES = ["photo", "closing"] as const;
export type InvoiceSource = (typeof INVOICE_SOURCES)[number];

/**
 * Factura de un proveedor fotografiada en el local. La IA propone las líneas
 * y alguien las revisa: el stock solo sube al confirmar, nunca con lo que
 * leyó la IA sin revisar.
 *
 * `source: "closing"` es una compra copiada del cierre de mes del local (hoja
 * CAJA CHICA): no tiene foto y `externalId` la hace idempotente al reimportar.
 */
export interface IPurchaseInvoice {
  _id: Types.ObjectId;
  branch: Types.ObjectId;
  supplier: string;
  invoiceNumber: string;
  date: Date;
  imageUrl: string;
  imagePublicId: string;
  status: InvoiceStatus;
  lines: IInvoiceLine[];
  totalCents: number;
  extractedBy: "ai" | "manual";
  aiError: string;
  source: InvoiceSource;
  externalId: string;
  note: string;
  createdBy: Types.ObjectId | null;
  confirmedBy: Types.ObjectId | null;
  confirmedAt: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const invoiceLineSchema = new Schema<IInvoiceLine>(
  {
    rawName: { type: String, default: "" },
    ingredient: { type: Schema.Types.ObjectId, ref: "Ingredient", default: null },
    quantity: { type: Number, default: 0 },
    rawQuantity: { type: Number, default: 0 },
    rawUnit: { type: String, default: "" },
    unitCostCents: { type: Number, default: 0 },
    totalCents: { type: Number, default: 0 },
  },
  { _id: false },
);

const purchaseInvoiceSchema = new Schema<IPurchaseInvoice>(
  {
    branch: { type: Schema.Types.ObjectId, ref: "Branch", required: true, index: true },
    supplier: { type: String, default: "" },
    invoiceNumber: { type: String, default: "" },
    date: { type: Date, default: () => new Date() },
    imageUrl: { type: String, default: "" },
    imagePublicId: { type: String, default: "" },
    status: { type: String, enum: INVOICE_STATUSES, default: "review", index: true },
    lines: { type: [invoiceLineSchema], default: [] },
    totalCents: { type: Number, default: 0 },
    extractedBy: { type: String, enum: ["ai", "manual"], default: "manual" },
    aiError: { type: String, default: "" },
    source: { type: String, enum: INVOICE_SOURCES, default: "photo" },
    externalId: { type: String, default: "" },
    note: { type: String, default: "" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    confirmedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    confirmedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Solo las importadas llevan externalId: las fotos quedan fuera del índice único.
purchaseInvoiceSchema.index(
  { branch: 1, externalId: 1 },
  { unique: true, partialFilterExpression: { externalId: { $gt: "" } } },
);
purchaseInvoiceSchema.index({ date: -1 });

export const PurchaseInvoice =
  mongoose.models.PurchaseInvoice ||
  mongoose.model<IPurchaseInvoice>("PurchaseInvoice", purchaseInvoiceSchema);
