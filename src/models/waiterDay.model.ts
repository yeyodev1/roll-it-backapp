import mongoose, { Schema, Types } from "mongoose";

export interface IWaiterUpsell {
  cocktails: number;
  beers: number;
  desserts: number;
  juices: number;
  starters: number;
}

/**
 * Un día de trabajo de una mesera tal como lo anota el local en su cierre de
 * mes (hoja VENTA DIARIA): mesas atendidas y productos sugeridos vendidos
 * (cócteles, cervezas, postres, jugos y entradas). Existe porque el reporte de
 * ventas de SmartMenu no dice quién atendió cada ticket.
 *
 * `salesCents` queda en null mientras el cierre no traiga venta en dólares
 * por mesera: el ranking no inventa un ticket promedio.
 */
export interface IWaiterDay {
  _id: Types.ObjectId;
  branch: Types.ObjectId;
  waiter: Types.ObjectId;
  // Medianoche de Ecuador del día trabajado.
  date: Date;
  tables: number;
  upsell: IWaiterUpsell;
  upsellUnits: number;
  salesCents: number | null;
  source: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const upsellSchema = new Schema<IWaiterUpsell>(
  {
    cocktails: { type: Number, default: 0 },
    beers: { type: Number, default: 0 },
    desserts: { type: Number, default: 0 },
    juices: { type: Number, default: 0 },
    starters: { type: Number, default: 0 },
  },
  { _id: false },
);

const waiterDaySchema = new Schema<IWaiterDay>(
  {
    branch: { type: Schema.Types.ObjectId, ref: "Branch", required: true },
    waiter: { type: Schema.Types.ObjectId, ref: "Waiter", required: true },
    date: { type: Date, required: true },
    tables: { type: Number, default: 0, min: 0 },
    upsell: { type: upsellSchema, default: () => ({}) },
    upsellUnits: { type: Number, default: 0, min: 0 },
    salesCents: { type: Number, default: null },
    source: { type: String, default: "" },
  },
  { timestamps: true },
);

// Un registro por mesera y día: volver a importar el cierre lo reemplaza, no lo duplica.
waiterDaySchema.index({ waiter: 1, date: 1 }, { unique: true });
waiterDaySchema.index({ branch: 1, date: 1 });

export const WaiterDay =
  mongoose.models.WaiterDay || mongoose.model<IWaiterDay>("WaiterDay", waiterDaySchema);
