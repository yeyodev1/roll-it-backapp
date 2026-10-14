import mongoose, { Schema, Types } from "mongoose";

export type AgentMode = "descubrir" | "carpeta" | "auto";

export interface IAgentStatus {
  version: string;
  mode: AgentMode | "";
  // Último error que reportó el agente; vacío si el último ciclo salió bien.
  lastError: string;
}

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
  // Último latido del agente de la PC del local: dice si está vivo aunque no haya ventas nuevas.
  agentLastSeenAt: Date | null;
  agentStatus: IAgentStatus;
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
    agentLastSeenAt: { type: Date, default: null },
    agentStatus: {
      version: { type: String, default: "" },
      mode: { type: String, default: "" },
      lastError: { type: String, default: "" },
    },
  },
  { timestamps: true },
);

export const Branch = mongoose.models.Branch || mongoose.model<IBranch>("Branch", branchSchema);
