import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";

// La API acepta imágenes de hasta 5 MB; más grandes se mandan por URL redimensionada.
const MAX_INLINE_BYTES = 5 * 1024 * 1024;
const VISION_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
type VisionType = (typeof VISION_TYPES)[number];

export interface KnownIngredient {
  name: string;
  unit: string;
  aliases: string[];
}

export interface ExtractedLine {
  name: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  total: number;
  ingredientName: string;
}

export interface ExtractedInvoice {
  supplier: string;
  invoiceNumber: string;
  date: string;
  lines: ExtractedLine[];
  total: number;
}

const invoiceSchema = {
  type: "object",
  properties: {
    supplier: {
      type: "string",
      description: "Razón social o nombre comercial del proveedor; vacío si no se lee",
    },
    invoiceNumber: {
      type: "string",
      description: "Número de factura tal como aparece (ej. 001-002-000123456); vacío si no se lee",
    },
    date: {
      type: "string",
      description: "Fecha de emisión en formato YYYY-MM-DD; vacío si no se lee",
    },
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Descripción del producto tal como está escrita en la factura",
          },
          quantity: { type: "number" },
          unit: {
            type: "string",
            description: "Unidad de la factura: kg, g, l, ml, unidad, caja, etc.",
          },
          unitPrice: { type: "number", description: "Precio unitario en dólares" },
          total: { type: "number", description: "Total de la línea en dólares" },
          ingredientName: {
            type: "string",
            description:
              "Nombre EXACTO del insumo de la lista que corresponde a esta línea, o vacío si ninguno",
          },
        },
        required: ["name", "quantity", "unit", "unitPrice", "total", "ingredientName"],
        additionalProperties: false,
      },
    },
    total: { type: "number", description: "Total a pagar de la factura en dólares" },
  },
  required: ["supplier", "invoiceNumber", "date", "lines", "total"],
  additionalProperties: false,
} as const;

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    // Timeout corto con un reintento: la persona espera con el celular en la mano.
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 90_000, maxRetries: 1 });
  }
  return client;
}

export function isInvoiceAiConfigured(): boolean {
  return !!env.ANTHROPIC_API_KEY;
}

export function canReadImage(mimeType: string): boolean {
  return (VISION_TYPES as readonly string[]).includes(mimeType);
}

function buildPrompt(ingredients: KnownIngredient[]): string {
  const catalog = ingredients
    .map(
      (i) =>
        `- ${i.name} (${i.unit})${i.aliases.length ? ` — también: ${i.aliases.join(", ")}` : ""}`,
    )
    .join("\n");
  return [
    "Esta es la foto de una factura de un proveedor de un restaurante de sushi y burritos en Ecuador.",
    "Extrae el proveedor, el número de factura, la fecha de emisión, cada línea de producto y el total.",
    "Los montos están en dólares (USD); usa punto decimal en los números aunque la factura use coma.",
    "Ignora líneas de subtotal, IVA, descuentos y propinas: solo productos comprados.",
    "Si la unidad viene dentro de la descripción (ej. 'SALMON FILETE KG'), úsala como unidad.",
    "Para cada línea, si corresponde a uno de estos insumos del restaurante, pon su nombre exacto en ingredientName; si no, déjalo vacío:",
    catalog || "(no hay insumos registrados todavía)",
  ].join("\n");
}

/**
 * Lee la factura con Claude y devuelve las líneas tal como las ve. No cruza
 * con la base ni convierte unidades: eso lo decide invoice.service, que es
 * quien conoce los insumos reales.
 */
export async function extractInvoice(input: {
  buffer: Buffer;
  mimeType: string;
  imageUrl?: string;
  ingredients: KnownIngredient[];
}): Promise<ExtractedInvoice> {
  if (!isInvoiceAiConfigured()) {
    throw new CustomError("La lectura automática no está configurada", 503);
  }
  if (!canReadImage(input.mimeType)) {
    throw new CustomError("La IA no puede leer este formato de imagen; sube JPG, PNG o WEBP", 415);
  }

  let image: Anthropic.ImageBlockParam;
  if (input.buffer.length <= MAX_INLINE_BYTES) {
    image = {
      type: "image",
      source: {
        type: "base64",
        media_type: input.mimeType as VisionType,
        data: input.buffer.toString("base64"),
      },
    };
  } else if (input.imageUrl) {
    // Cloudinary redimensiona al vuelo; 2000 px alcanzan para leer una factura.
    const url = input.imageUrl.replace("/upload/", "/upload/w_2000,c_limit,q_auto,f_jpg/");
    image = { type: "image", source: { type: "url", url } };
  } else {
    throw new CustomError(
      "La foto pesa más de 5 MB y no se pudo subir para leerla; toma una más liviana",
      413,
    );
  }

  let response;
  try {
    response = await getClient().messages.parse({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium", format: jsonSchemaOutputFormat(invoiceSchema) },
      messages: [
        {
          role: "user",
          content: [image, { type: "text", text: buildPrompt(input.ingredients) }],
        },
      ],
    });
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      throw new CustomError(
        "La IA está saturada en este momento; intenta de nuevo en un minuto",
        503,
      );
    }
    if (error instanceof Anthropic.APIConnectionTimeoutError) {
      throw new CustomError("La IA tardó demasiado en leer la factura", 504);
    }
    if (error instanceof Anthropic.BadRequestError) {
      throw new CustomError("La IA no aceptó la imagen de la factura", 422);
    }
    if (error instanceof Anthropic.APIError) {
      throw new CustomError(`La IA no respondió (${error.status ?? "sin conexión"})`, 502);
    }
    throw error;
  }

  if (response.stop_reason === "refusal") {
    throw new CustomError("La IA no quiso procesar esta imagen", 422);
  }
  if (response.stop_reason === "max_tokens" || !response.parsed_output) {
    throw new CustomError("La IA no devolvió una lectura completa de la factura", 502);
  }

  const out = response.parsed_output;
  return {
    supplier: out.supplier.trim(),
    invoiceNumber: out.invoiceNumber.trim(),
    date: out.date.trim(),
    total: Number(out.total) || 0,
    lines: out.lines.map((line) => ({
      name: line.name.trim(),
      quantity: Number(line.quantity) || 0,
      unit: line.unit.trim(),
      unitPrice: Number(line.unitPrice) || 0,
      total: Number(line.total) || 0,
      ingredientName: line.ingredientName.trim(),
    })),
  };
}
