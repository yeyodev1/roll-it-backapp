import ExcelJS from "exceljs";
import { dbConnect, isConnected } from "../config/mongo";
import { CustomError } from "../errors/customError.error";
import { Ingredient, IngredientUnit } from "../models/ingredient.model";
import { Product } from "../models/product.model";
import { Recipe } from "../models/recipe.model";
import { normalizeName } from "../utils/normalize";

type Field = "plato" | "ingrediente" | "cantidad" | "unidad" | "categoria";

interface RawRow {
  line: number;
  plato: string;
  ingrediente: string;
  cantidad: string;
  unidad: string;
  categoria: string;
}

export interface ImportResult {
  products: number;
  ingredients: number;
  recipes: number;
  warnings: string[];
}

const MAX_ROWS = 5000;
const MAX_WARNINGS = 50;

// Se mira cada palabra de la cabecera: "Cantidad (g)" o "Nombre del plato" también sirven.
const HEADER_KEYWORDS: [Field, string[]][] = [
  ["plato", ["plato", "platos", "producto", "productos"]],
  ["ingrediente", ["ingrediente", "ingredientes", "insumo", "insumos"]],
  ["cantidad", ["cantidad", "cant"]],
  ["unidad", ["unidad", "unidades", "unid", "medida"]],
  ["categoria", ["categoria", "categorias"]],
];

const UNIT_ALIASES: Record<string, IngredientUnit> = {
  g: "g",
  gr: "g",
  grs: "g",
  gramo: "g",
  gramos: "g",
  kg: "kg",
  kgs: "kg",
  kilo: "kg",
  kilos: "kg",
  kilogramo: "kg",
  kilogramos: "kg",
  ml: "ml",
  cc: "ml",
  mililitro: "ml",
  mililitros: "ml",
  l: "l",
  lt: "l",
  lts: "l",
  litro: "l",
  litros: "l",
  u: "unidad",
  un: "unidad",
  und: "unidad",
  unds: "unidad",
  unid: "unidad",
  unidad: "unidad",
  unidades: "unidad",
  pza: "unidad",
  pieza: "unidad",
  piezas: "unidad",
};

// Factor a la unidad base de cada dimensión; solo se convierte dentro de la misma dimensión.
const UNIT_FACTORS: Record<IngredientUnit, { dim: string; factor: number }> = {
  g: { dim: "masa", factor: 1 },
  kg: { dim: "masa", factor: 1000 },
  ml: { dim: "volumen", factor: 1 },
  l: { dim: "volumen", factor: 1000 },
  unidad: { dim: "conteo", factor: 1 },
};

async function ensureDb() {
  if (!isConnected() && !(await dbConnect())) {
    throw new CustomError("El servidor no tiene base de datos disponible", 503);
  }
}

export function normalizeUnit(value: string): IngredientUnit | null {
  const key = normalizeName(value).replace(/\s+/g, "");
  return UNIT_ALIASES[key] ?? null;
}

/** Convierte entre g↔kg y ml↔l; null si las unidades no son de la misma dimensión. */
export function convertQuantity(
  quantity: number,
  from: IngredientUnit,
  to: IngredientUnit,
): number | null {
  const a = UNIT_FACTORS[from];
  const b = UNIT_FACTORS[to];
  if (a.dim !== b.dim) return null;
  return (quantity * a.factor) / b.factor;
}

/** Acepta "2,5", "1.250,5", "1,250.5" y "120 g" (devuelve la unidad pegada al número). */
function parseQuantity(raw: string): { value: number | null; unit: string } {
  const match = raw.trim().match(/^(-?[\d.,]+)\s*(.*)$/);
  if (!match) return { value: null, unit: "" };
  let num = match[1];
  const lastComma = num.lastIndexOf(",");
  const lastDot = num.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    num = lastComma > lastDot ? num.replace(/\./g, "").replace(",", ".") : num.replace(/,/g, "");
  } else if (lastComma >= 0) {
    num = num.replace(",", ".");
  }
  const value = Number(num);
  return { value: Number.isFinite(value) ? value : null, unit: match[2].trim() };
}

function mapHeaders(cells: string[]): Partial<Record<Field, number>> {
  const columns: Partial<Record<Field, number>> = {};
  cells.forEach((cell, index) => {
    const words = normalizeName(cell).split(" ");
    for (const [field, keywords] of HEADER_KEYWORDS) {
      if (columns[field] === undefined && keywords.some((k) => words.includes(k))) {
        columns[field] = index;
        return;
      }
    }
  });
  return columns;
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  const v = value as any;
  if (Array.isArray(v.richText))
    return v.richText
      .map((t: any) => t.text)
      .join("")
      .trim();
  if (v.result !== undefined) return cellText(v.result);
  if (typeof v.text === "string") return v.text.trim();
  return "";
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function readCsv(buffer: Buffer): string[][] {
  const text = buffer.toString("utf8").replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  const first = lines.find((l) => l.trim()) ?? "";
  // Excel en español guarda los CSV con ";" porque la coma es el separador decimal.
  const delimiter = [";", ",", "\t"]
    .map((d) => ({ d, count: splitCsvLine(first, d).length }))
    .sort((a, b) => b.count - a.count)[0].d;
  return lines.map((l) => (l.trim() ? splitCsvLine(l, delimiter) : []));
}

async function readXlsx(buffer: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as any);
  } catch {
    throw new CustomError("No se pudo leer el archivo de Excel", 400);
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new CustomError("El archivo de Excel no tiene hojas", 400);
  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const values = row.values as ExcelJS.CellValue[];
    // row.values empieza en el índice 1 (convención de ExcelJS).
    rows[rowNumber - 1] = values.slice(1).map(cellText);
  });
  return Array.from(rows, (r) => r ?? []);
}

function toRawRows(table: string[][]): RawRow[] {
  const headerIndex = table.slice(0, 10).findIndex((cells) => {
    const cols = mapHeaders(cells);
    return cols.plato !== undefined && cols.ingrediente !== undefined;
  });
  if (headerIndex < 0) {
    throw new CustomError(
      "No encontré las columnas Plato e Ingrediente en la cabecera del archivo",
      400,
    );
  }
  const columns = mapHeaders(table[headerIndex]);
  if (columns.cantidad === undefined) {
    throw new CustomError("Falta la columna Cantidad en el archivo", 400);
  }

  const pick = (cells: string[], field: Field) =>
    columns[field] === undefined ? "" : (cells[columns[field]!] ?? "").trim();

  const rows: RawRow[] = [];
  for (let i = headerIndex + 1; i < table.length; i++) {
    const cells = table[i] ?? [];
    const row: RawRow = {
      line: i + 1,
      plato: pick(cells, "plato"),
      ingrediente: pick(cells, "ingrediente"),
      cantidad: pick(cells, "cantidad"),
      unidad: pick(cells, "unidad"),
      categoria: pick(cells, "categoria"),
    };
    if (!row.plato && !row.ingrediente && !row.cantidad) continue;
    rows.push(row);
  }
  if (rows.length > MAX_ROWS) {
    throw new CustomError(`El archivo tiene más de ${MAX_ROWS} filas`, 400);
  }
  return rows;
}

/**
 * Importa recetas desde .xlsx o .csv: crea los platos e insumos que falten y
 * reemplaza la receta completa de cada plato que aparece en el archivo.
 * Las filas con problemas no frenan la carga: se saltan y se avisan.
 */
export async function importRecipes(file?: {
  buffer: Buffer;
  originalname: string;
}): Promise<ImportResult> {
  if (!file?.buffer?.length) throw new CustomError("Sube un archivo .xlsx o .csv", 400);
  const name = file.originalname.toLowerCase();
  let table: string[][];
  if (name.endsWith(".xlsx")) table = await readXlsx(file.buffer);
  else if (name.endsWith(".csv")) table = readCsv(file.buffer);
  else throw new CustomError("El archivo debe ser .xlsx o .csv", 400);

  const rows = toRawRows(table);
  if (!rows.length) throw new CustomError("El archivo no tiene filas con recetas", 400);

  await ensureDb();
  const warnings: string[] = [];
  const warn = (message: string) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(message);
    else if (warnings.length === MAX_WARNINGS) warnings.push("Hay más avisos que no se muestran");
  };

  const productKeys = [...new Set(rows.map((r) => normalizeName(r.plato)).filter(Boolean))];
  const existingProducts = await Product.find({ normalizedName: { $in: productKeys } }).lean<
    any[]
  >();
  const products = new Map<string, any>(existingProducts.map((p) => [p.normalizedName, p]));

  // El catálogo de insumos es chico: se carga entero para cruzar también por alias.
  const allIngredients = await Ingredient.find().lean<any[]>();
  const ingredients = new Map<string, any>();
  for (const ing of allIngredients) {
    for (const alias of ing.aliases ?? []) {
      const key = normalizeName(alias);
      if (key && !ingredients.has(key)) ingredients.set(key, ing);
    }
  }
  for (const ing of allIngredients) ingredients.set(ing.normalizedName, ing);

  let createdProducts = 0;
  let createdIngredients = 0;
  const recipes = new Map<string, Map<string, number>>();

  for (const row of rows) {
    const productKey = normalizeName(row.plato);
    const ingredientKey = normalizeName(row.ingrediente);
    if (!productKey) {
      warn(`Fila ${row.line}: falta el plato, se omitió`);
      continue;
    }

    let product = products.get(productKey);
    if (!product) {
      product = (
        await Product.create({
          name: row.plato,
          normalizedName: productKey,
          category: row.categoria || "General",
        })
      ).toObject();
      products.set(productKey, product);
      createdProducts++;
    }
    const recipeKey = product._id.toString();
    if (!recipes.has(recipeKey)) recipes.set(recipeKey, new Map());

    if (!ingredientKey) {
      if (row.cantidad) warn(`Fila ${row.line}: falta el ingrediente de «${row.plato}», se omitió`);
      continue;
    }

    const parsed = parseQuantity(row.cantidad);
    if (parsed.value === null || parsed.value <= 0) {
      warn(
        `Fila ${row.line}: la cantidad «${row.cantidad}» de ${row.ingrediente} no es válida, se omitió`,
      );
      continue;
    }
    const rawUnit = row.unidad || parsed.unit;
    const fileUnit = rawUnit ? normalizeUnit(rawUnit) : null;
    if (rawUnit && !fileUnit) {
      warn(`Fila ${row.line}: no reconozco la unidad «${rawUnit}» de ${row.ingrediente}`);
    }

    let ingredient = ingredients.get(ingredientKey);
    if (!ingredient) {
      ingredient = (
        await Ingredient.create({
          name: row.ingrediente,
          normalizedName: ingredientKey,
          unit: fileUnit ?? "unidad",
        })
      ).toObject();
      ingredients.set(ingredientKey, ingredient);
      createdIngredients++;
    }

    // Sin unidad legible se asume la del insumo: es lo habitual en recetas hechas a mano.
    let quantity = parsed.value;
    if (fileUnit && fileUnit !== ingredient.unit) {
      const converted = convertQuantity(quantity, fileUnit, ingredient.unit);
      if (converted === null) {
        warn(
          `Fila ${row.line}: ${ingredient.name} se mide en ${ingredient.unit} y el archivo dice ${fileUnit}; se omitió`,
        );
        continue;
      }
      quantity = converted;
    }

    const items = recipes.get(recipeKey)!;
    const ingredientId = ingredient._id.toString();
    items.set(ingredientId, (items.get(ingredientId) ?? 0) + quantity);
  }

  const operations = [...recipes.entries()]
    .filter(([, items]) => items.size > 0)
    .map(([productId, items]) => ({
      updateOne: {
        filter: { product: productId },
        update: {
          $set: {
            items: [...items.entries()].map(([ingredient, quantity]) => ({
              ingredient,
              quantity: Math.round(quantity * 10000) / 10000,
            })),
          },
        },
        upsert: true,
      },
    }));
  for (const [productId, items] of recipes) {
    if (items.size === 0) {
      const product = [...products.values()].find((p) => p._id.toString() === productId);
      warn(`«${product?.name ?? "Plato"}» no tiene ingredientes válidos: su receta no se tocó`);
    }
  }
  if (operations.length) await Recipe.bulkWrite(operations as any);

  return {
    products: createdProducts,
    ingredients: createdIngredients,
    recipes: operations.length,
    warnings,
  };
}
