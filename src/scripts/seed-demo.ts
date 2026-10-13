/**
 * Datos de demostración mientras no hay acceso a SmartMenu.
 * Uso: pnpm seed:demo
 *
 * Es idempotente: borra solo lo marcado como demo (ventas `source: "demo"`,
 * movimientos con "[demo]" en la nota y facturas "DEMO-") y lo vuelve a crear.
 * Los catálogos se crean si faltan y no se pisan si alguien ya los editó.
 * Usa un generador con semilla fija: dos corridas el mismo día dan lo mismo.
 */
import "dotenv/config";
import crypto from "crypto";
import mongoose, { Types } from "mongoose";
import { env } from "../config/env";
import { Branch } from "../models/branch.model";
import { Ingredient, IngredientUnit } from "../models/ingredient.model";
import { InventoryMovement } from "../models/inventoryMovement.model";
import { Product } from "../models/product.model";
import { PurchaseInvoice } from "../models/purchaseInvoice.model";
import { Recipe } from "../models/recipe.model";
import { Sale } from "../models/sale.model";
import { StockLevel } from "../models/stockLevel.model";
import { User } from "../models/user.model";
import { Waiter } from "../models/waiter.model";
import { computeStatus } from "../services/stock.service";
import { normalizeName } from "../utils/normalize";
import { ecuadorDateKey, ecuadorParts, startOfEcuadorDay } from "../utils/time";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const HISTORY_DAYS = 400;
const INVENTORY_DAYS = 14;
const BATCH = 1000;
const DEMO_TAG = "[demo]";

// ---------- PRNG reproducible (mulberry32) ----------

let seed = 20261013;
function rand(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (min: number, max: number) => min + rand() * (max - min);

function poisson(lambda: number): number {
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > limit);
  return k - 1;
}

function pickWeighted<T>(items: T[], weight: (item: T) => number): T {
  const total = items.reduce((a, i) => a + weight(i), 0);
  let r = rand() * total;
  for (const item of items) {
    r -= weight(item);
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

const round = (value: number, decimals: number) =>
  Math.round(value * 10 ** decimals) / 10 ** decimals;

// ---------- Catálogos ----------

const BRANCHES = [
  {
    name: "Villa Club",
    slug: "villa-club",
    smartmenuUrl: "http://10.221.11.156/SMARTMENU",
    base: 3.2,
  },
  {
    name: "Sucursal 2",
    slug: "sucursal-2",
    smartmenuUrl: "http://10.221.11.140/SMARTMENU",
    base: 2.2,
  },
  {
    name: "Sucursal 3",
    slug: "sucursal-3",
    smartmenuUrl: "http://10.221.11.206/SMARTMENU",
    base: 1.7,
  },
];

const INGREDIENTS: {
  name: string;
  unit: IngredientUnit;
  cost: number;
  min: number;
  max: number;
}[] = [
  { name: "Salmón", unit: "kg", cost: 1800, min: 3, max: 15 },
  { name: "Langostino", unit: "kg", cost: 1400, min: 2, max: 10 },
  { name: "Atún", unit: "kg", cost: 1600, min: 1, max: 6 },
  { name: "Arroz para sushi", unit: "kg", cost: 250, min: 10, max: 50 },
  { name: "Alga nori", unit: "unidad", cost: 15, min: 100, max: 500 },
  { name: "Queso crema", unit: "kg", cost: 900, min: 2, max: 10 },
  { name: "Aguacate", unit: "unidad", cost: 60, min: 30, max: 150 },
  { name: "Pepino", unit: "unidad", cost: 40, min: 20, max: 100 },
  { name: "Tortilla de harina", unit: "unidad", cost: 25, min: 40, max: 200 },
  { name: "Pollo", unit: "kg", cost: 650, min: 3, max: 15 },
  { name: "Panko", unit: "kg", cost: 400, min: 1, max: 5 },
  { name: "Salsa de soya", unit: "l", cost: 350, min: 2, max: 10 },
  { name: "Limón", unit: "unidad", cost: 8, min: 60, max: 300 },
  { name: "Carne de res", unit: "kg", cost: 950, min: 2, max: 10 },
  { name: "Frijoles", unit: "kg", cost: 300, min: 1, max: 6 },
  { name: "Cebolla paiteña", unit: "kg", cost: 120, min: 1, max: 6 },
  { name: "Edamame", unit: "kg", cost: 700, min: 1, max: 5 },
  { name: "Masa para gyozas", unit: "unidad", cost: 10, min: 100, max: 500 },
  { name: "Azúcar", unit: "kg", cost: 110, min: 2, max: 10 },
  { name: "Coca Cola 350 ml", unit: "unidad", cost: 45, min: 48, max: 240 },
  { name: "Mochi", unit: "unidad", cost: 120, min: 20, max: 80 },
];

type RecipeSpec = [string, number][];
const PRODUCTS: {
  name: string;
  category: string;
  price: number;
  weight: number;
  recipe: RecipeSpec;
}[] = [
  {
    name: "Maki Acevichado",
    category: "Rolls",
    price: 1150,
    weight: 10,
    recipe: [
      ["Salmón", 0.08],
      ["Arroz para sushi", 0.12],
      ["Alga nori", 1],
      ["Aguacate", 0.25],
      ["Limón", 1],
      ["Cebolla paiteña", 0.02],
      ["Salsa de soya", 0.01],
    ],
  },
  {
    name: "California Roll",
    category: "Rolls",
    price: 950,
    weight: 8,
    recipe: [
      ["Langostino", 0.04],
      ["Arroz para sushi", 0.12],
      ["Alga nori", 1],
      ["Aguacate", 0.25],
      ["Pepino", 0.25],
      ["Queso crema", 0.02],
    ],
  },
  {
    name: "Roll Tempura de Langostino",
    category: "Rolls",
    price: 1250,
    weight: 8,
    recipe: [
      ["Langostino", 0.08],
      ["Panko", 0.03],
      ["Arroz para sushi", 0.12],
      ["Alga nori", 1],
      ["Queso crema", 0.03],
      ["Aguacate", 0.25],
    ],
  },
  {
    name: "Philadelphia Roll",
    category: "Rolls",
    price: 1100,
    weight: 7,
    recipe: [
      ["Salmón", 0.07],
      ["Queso crema", 0.05],
      ["Arroz para sushi", 0.12],
      ["Alga nori", 1],
      ["Pepino", 0.25],
    ],
  },
  {
    name: "Roll Parrillero",
    category: "Rolls",
    price: 1200,
    weight: 5,
    recipe: [
      ["Carne de res", 0.08],
      ["Arroz para sushi", 0.12],
      ["Alga nori", 1],
      ["Queso crema", 0.03],
      ["Aguacate", 0.25],
      ["Cebolla paiteña", 0.02],
    ],
  },
  {
    name: "Spicy Tuna Roll",
    category: "Rolls",
    price: 1150,
    weight: 4,
    recipe: [
      ["Atún", 0.08],
      ["Arroz para sushi", 0.12],
      ["Alga nori", 1],
      ["Pepino", 0.25],
    ],
  },
  {
    name: "Dragon Roll",
    category: "Rolls",
    price: 1350,
    weight: 4,
    recipe: [
      ["Langostino", 0.06],
      ["Aguacate", 0.5],
      ["Arroz para sushi", 0.12],
      ["Alga nori", 1],
      ["Queso crema", 0.02],
    ],
  },
  {
    name: "Roll Vegetariano",
    category: "Rolls",
    price: 850,
    weight: 2,
    recipe: [
      ["Aguacate", 0.5],
      ["Pepino", 0.5],
      ["Queso crema", 0.03],
      ["Arroz para sushi", 0.12],
      ["Alga nori", 1],
    ],
  },
  {
    name: "Burrito de Pollo",
    category: "Burritos",
    price: 890,
    weight: 8,
    recipe: [
      ["Tortilla de harina", 1],
      ["Pollo", 0.12],
      ["Frijoles", 0.05],
      ["Arroz para sushi", 0.1],
      ["Aguacate", 0.25],
      ["Cebolla paiteña", 0.03],
    ],
  },
  {
    name: "Burrito de Salmón",
    category: "Burritos",
    price: 1190,
    weight: 6,
    recipe: [
      ["Tortilla de harina", 1],
      ["Salmón", 0.1],
      ["Arroz para sushi", 0.12],
      ["Aguacate", 0.25],
      ["Queso crema", 0.03],
      ["Pepino", 0.25],
    ],
  },
  {
    name: "Burrito de Carne",
    category: "Burritos",
    price: 990,
    weight: 5,
    recipe: [
      ["Tortilla de harina", 1],
      ["Carne de res", 0.12],
      ["Frijoles", 0.05],
      ["Arroz para sushi", 0.1],
      ["Cebolla paiteña", 0.03],
    ],
  },
  {
    name: "Burrito de Langostino",
    category: "Burritos",
    price: 1150,
    weight: 3,
    recipe: [
      ["Tortilla de harina", 1],
      ["Langostino", 0.1],
      ["Arroz para sushi", 0.1],
      ["Aguacate", 0.25],
      ["Panko", 0.02],
    ],
  },
  {
    name: "Poke Bowl de Salmón",
    category: "Bowls",
    price: 1250,
    weight: 6,
    recipe: [
      ["Salmón", 0.12],
      ["Arroz para sushi", 0.18],
      ["Aguacate", 0.5],
      ["Pepino", 0.5],
      ["Edamame", 0.03],
      ["Salsa de soya", 0.02],
    ],
  },
  {
    name: "Poke Bowl de Pollo",
    category: "Bowls",
    price: 990,
    weight: 3,
    recipe: [
      ["Pollo", 0.14],
      ["Arroz para sushi", 0.18],
      ["Aguacate", 0.5],
      ["Edamame", 0.03],
      ["Salsa de soya", 0.02],
    ],
  },
  {
    name: "Gyozas",
    category: "Entradas",
    price: 650,
    weight: 5,
    recipe: [
      ["Masa para gyozas", 6],
      ["Pollo", 0.08],
      ["Salsa de soya", 0.02],
    ],
  },
  {
    name: "Edamame",
    category: "Entradas",
    price: 450,
    weight: 4,
    recipe: [
      ["Edamame", 0.15],
      ["Limón", 1],
    ],
  },
  {
    name: "Wantán de Langostino",
    category: "Entradas",
    price: 590,
    weight: 3,
    recipe: [
      ["Masa para gyozas", 6],
      ["Langostino", 0.06],
      ["Queso crema", 0.03],
    ],
  },
  {
    name: "Limonada",
    category: "Bebidas",
    price: 250,
    weight: 8,
    recipe: [
      ["Limón", 3],
      ["Azúcar", 0.03],
    ],
  },
  {
    name: "Té Helado",
    category: "Bebidas",
    price: 250,
    weight: 6,
    recipe: [
      ["Limón", 1],
      ["Azúcar", 0.03],
    ],
  },
  {
    name: "Coca Cola",
    category: "Bebidas",
    price: 200,
    weight: 7,
    recipe: [["Coca Cola 350 ml", 1]],
  },
  { name: "Mochi", category: "Postres", price: 350, weight: 3, recipe: [["Mochi", 1]] },
  {
    name: "Cheesecake de Maracuyá",
    category: "Postres",
    price: 450,
    weight: 2,
    recipe: [
      ["Queso crema", 0.08],
      ["Azúcar", 0.03],
    ],
  },
];
const MAIN_CATEGORIES = ["Rolls", "Burritos", "Bowls"];

// speed = cuántas mesas toma frente al resto; upsell = tendencia a sumar ítems; attend = días que trabaja.
const WAITERS: Record<string, { name: string; speed: number; upsell: number; attend: number }[]> = {
  "villa-club": [
    { name: "Andrea Castillo", speed: 1.35, upsell: 1.3, attend: 0.9 },
    { name: "Kevin Mora", speed: 1.0, upsell: 1.0, attend: 0.85 },
    { name: "Valeria Paredes", speed: 1.05, upsell: 1.1, attend: 0.8 },
    { name: "Jonathan Vera", speed: 0.7, upsell: 0.7, attend: 0.85 },
    { name: "Daniela Salazar", speed: 0.95, upsell: 1.0, attend: 0.6 },
  ],
  "sucursal-2": [
    { name: "Bryan Cedeño", speed: 1.3, upsell: 1.25, attend: 0.9 },
    { name: "Mishell Andrade", speed: 1.0, upsell: 1.05, attend: 0.85 },
    { name: "Carlos Zambrano", speed: 0.95, upsell: 0.95, attend: 0.8 },
    { name: "Paola Jaramillo", speed: 0.7, upsell: 0.75, attend: 0.8 },
  ],
  "sucursal-3": [
    { name: "Karla Mendoza", speed: 1.3, upsell: 1.3, attend: 0.9 },
    { name: "Josué Intriago", speed: 1.0, upsell: 1.0, attend: 0.85 },
    { name: "Gabriela Ruiz", speed: 1.0, upsell: 0.95, attend: 0.75 },
    { name: "Steven Alvarado", speed: 0.75, upsell: 0.7, attend: 0.85 },
  ],
};

// Cerrado o casi nada antes de las 12h; picos de almuerzo (13–15h) y cena (19–22h).
const HOUR_FACTOR: Record<number, number> = {
  11: 0.1,
  12: 0.6,
  13: 1.6,
  14: 1.5,
  15: 0.8,
  16: 0.4,
  17: 0.4,
  18: 0.7,
  19: 1.3,
  20: 1.6,
  21: 1.4,
  22: 0.6,
};
// 0 = domingo. Viernes y sábado fuertes, lunes flojo.
const WEEKDAY_FACTOR = [1.1, 0.65, 0.8, 0.85, 0.95, 1.35, 1.45];

// Estado de inventario que debe verse hoy en cada sucursal; el resto queda en "Óptimo".
const STOCK_PLAN: Record<string, Record<string, "out" | "low" | "over">> = {
  "villa-club": { Edamame: "out", Salmón: "low", "Alga nori": "low", "Arroz para sushi": "over" },
  "sucursal-2": { "Queso crema": "low", "Tortilla de harina": "over" },
  "sucursal-3": { Mochi: "out", Langostino: "low", Limón: "low" },
};
const PURCHASES = [
  { branch: "villa-club", ingredient: "Pollo", supplier: "Pronaca", daysAgo: 6 },
  { branch: "sucursal-2", ingredient: "Langostino", supplier: "Mariscos del Pacífico", daysAgo: 4 },
];

const niceThreshold = (value: number, unit: IngredientUnit) =>
  unit === "unidad" ? Math.max(1, Math.round(value)) : Math.max(0.1, round(value, 1));
const qty = (value: number, unit: IngredientUnit) =>
  unit === "unidad" ? Math.round(value) : round(value, 3);

// ---------- Seed ----------

async function upsertCatalogs() {
  const branches = [];
  for (const b of BRANCHES) {
    const doc = await Branch.findOneAndUpdate(
      { slug: b.slug },
      {
        $setOnInsert: { name: b.name, slug: b.slug, smartmenuUrl: b.smartmenuUrl, isActive: true },
      },
      { upsert: true, new: true },
    );
    branches.push({ ...b, doc });
  }

  const ingredients = new Map<string, any>();
  for (const i of INGREDIENTS) {
    const doc = await Ingredient.findOneAndUpdate(
      { normalizedName: normalizeName(i.name) },
      {
        $setOnInsert: {
          name: i.name,
          unit: i.unit,
          costPerUnitCents: i.cost,
          defaultMinStock: i.min,
          defaultMaxStock: i.max,
          aliases: [],
          isActive: true,
        },
      },
      { upsert: true, new: true },
    );
    ingredients.set(i.name, doc);
  }

  const products = [];
  for (const [n, p] of PRODUCTS.entries()) {
    const doc = await Product.findOneAndUpdate(
      { normalizedName: normalizeName(p.name) },
      {
        $setOnInsert: {
          name: p.name,
          smartmenuCode: `RI-${String(n + 1).padStart(3, "0")}`,
          category: p.category,
          priceCents: p.price,
          isActive: true,
        },
      },
      { upsert: true, new: true },
    );
    const recipe = await Recipe.findOneAndUpdate(
      { product: doc._id },
      {
        $setOnInsert: {
          product: doc._id,
          items: p.recipe.map(([name, quantity]) => ({
            ingredient: ingredients.get(name)._id,
            quantity,
          })),
          notes: "Receta de demostración",
        },
      },
      { upsert: true, new: true },
    );
    // Se usa la receta guardada (puede haber sido editada) para que el consumo cuadre con lo que ve el panel.
    products.push({
      spec: p,
      doc,
      recipe: recipe.items as { ingredient: Types.ObjectId; quantity: number }[],
    });
  }

  const waiters = new Map<string, { doc: any; profile: (typeof WAITERS)[string][number] }[]>();
  for (const b of branches) {
    const list = [];
    for (const profile of WAITERS[b.slug]) {
      const doc = await Waiter.findOneAndUpdate(
        { branch: b.doc._id, normalizedName: normalizeName(profile.name) },
        { $setOnInsert: { name: profile.name, branch: b.doc._id, isActive: true } },
        { upsert: true, new: true },
      );
      list.push({ doc, profile });
    }
    waiters.set(b.slug, list);
  }

  return { branches, ingredients, products, waiters };
}

async function main() {
  console.log("Conectando a MongoDB...");
  await mongoose.connect(env.DB_URI);

  const { branches, ingredients, products, waiters } = await upsertCatalogs();
  const ingredientById = new Map([...ingredients.values()].map((i) => [i._id.toString(), i]));

  // Limpieza de la corrida anterior: solo lo marcado como demo.
  const demoInvoices = await PurchaseInvoice.find({ invoiceNumber: /^DEMO-/ })
    .select("_id")
    .lean<any[]>();
  const [delSales, delMovs] = await Promise.all([
    Sale.deleteMany({ source: "demo" }),
    InventoryMovement.deleteMany({
      $or: [{ note: { $regex: "\\[demo\\]" } }, { refId: { $in: demoInvoices.map((i) => i._id) } }],
    }),
  ]);
  await PurchaseInvoice.deleteMany({ invoiceNumber: /^DEMO-/ });
  console.log(
    `Limpieza: ${delSales.deletedCount} ventas y ${delMovs.deletedCount} movimientos demo borrados`,
  );

  const now = new Date();
  const today = startOfEcuadorDay(now);
  const inventoryStart = new Date(today.getTime() - (INVENTORY_DAYS - 1) * DAY_MS);
  const mains = products.filter((p) => MAIN_CATEGORIES.includes(p.spec.category));

  // consumo[sucursal][insumo][día] de los últimos 14 días, para los movimientos agregados.
  const usage = new Map<string, Map<string, Map<string, number>>>();
  const lastSale = new Map<string, Date>();
  let totalSales = 0;
  let totalCents = 0;

  for (const branch of branches) {
    const team = waiters.get(branch.slug)!;
    const branchUsage = new Map<string, Map<string, number>>();
    usage.set(branch.slug, branchUsage);
    let counter = 0;
    let batch: any[] = [];

    for (let d = HISTORY_DAYS - 1; d >= 0; d--) {
      const dayStart = new Date(today.getTime() - d * DAY_MS);
      const { weekday } = ecuadorParts(new Date(dayStart.getTime() + 12 * HOUR_MS));
      // Crecimiento leve: el negocio vende ~18% más hoy que hace 400 días.
      const growth = 0.85 + 0.15 * ((HISTORY_DAYS - d) / HISTORY_DAYS);
      const dayNoise = between(0.85, 1.15);

      let working = team.filter((w) => rand() < w.profile.attend);
      if (working.length < 2) working = team.slice(0, 2);

      for (let hour = 11; hour <= 22; hour++) {
        const lambda =
          branch.base * WEEKDAY_FACTOR[weekday] * HOUR_FACTOR[hour] * growth * dayNoise;
        const count = poisson(lambda);
        for (let t = 0; t < count; t++) {
          const date = new Date(dayStart.getTime() + hour * HOUR_MS + Math.floor(rand() * HOUR_MS));
          if (date > now) continue;

          const waiter = pickWeighted(working, (w) => w.profile.speed);
          const { upsell } = waiter.profile;
          let nItems = pickWeighted([1, 2, 3, 4, 5], (k) => [0.2, 0.3, 0.25, 0.15, 0.1][k - 1]);
          if (upsell > 1 && rand() < (upsell - 1) * 2) nItems++;
          if (upsell < 1 && rand() < (1 - upsell) * 2) nItems--;
          nItems = Math.max(1, Math.min(5, nItems));

          const chosen = [pickWeighted(mains, (p) => p.spec.weight)];
          for (let k = 1; k < nItems; k++)
            chosen.push(pickWeighted(products, (p) => p.spec.weight));

          const lines = new Map<string, { product: any; quantity: number }>();
          for (const p of chosen) {
            const key = p.doc._id.toString();
            const line = lines.get(key) ?? { product: p, quantity: 0 };
            line.quantity += 1;
            lines.set(key, line);
          }
          const items = [...lines.values()].map(({ product, quantity }) => ({
            product: product.doc._id,
            productName: product.doc.name,
            smartmenuCode: product.doc.smartmenuCode,
            quantity,
            unitPriceCents: product.doc.priceCents,
            totalCents: product.doc.priceCents * quantity,
          }));
          const subtotal = items.reduce((a, i) => a + i.totalCents, 0);
          const isVoid = rand() < 0.01;
          const { weekday: wd, hour: hr } = ecuadorParts(date);

          batch.push({
            branch: branch.doc._id,
            externalId: `DEMO-${branch.slug}-${++counter}`,
            waiter: waiter.doc._id,
            waiterName: waiter.doc.name,
            date,
            weekday: wd,
            hour: hr,
            items,
            subtotalCents: subtotal,
            totalCents: subtotal,
            guests: Math.max(1, Math.min(6, nItems - 1 + Math.floor(rand() * 2))),
            table: `M${1 + Math.floor(rand() * 18)}`,
            status: isVoid ? "void" : "paid",
            // Histórico de demo: las ventas viejas cuentan como aplicadas aunque no tengan movimiento,
            // así el sincronizador no las descuenta de nuevo. Solo los últimos 14 días tienen libro.
            inventoryApplied: !isVoid,
            source: "demo",
          });

          if (!isVoid) {
            totalSales++;
            totalCents += subtotal;
            if (!lastSale.has(branch.slug) || date > lastSale.get(branch.slug)!)
              lastSale.set(branch.slug, date);
            if (date >= inventoryStart) {
              const dayKey = ecuadorDateKey(date);
              for (const { product, quantity } of lines.values()) {
                for (const item of product.recipe) {
                  const ingKey = item.ingredient.toString();
                  const byDay = branchUsage.get(ingKey) ?? new Map<string, number>();
                  byDay.set(dayKey, (byDay.get(dayKey) ?? 0) + item.quantity * quantity);
                  branchUsage.set(ingKey, byDay);
                }
              }
            }
          }

          if (batch.length >= BATCH) {
            await Sale.insertMany(batch);
            batch = [];
          }
        }
      }
    }
    if (batch.length) await Sale.insertMany(batch);
    console.log(`  ${branch.name}: ${counter} tickets generados`);
  }

  // ---------- Inventario ----------
  const initialDate = new Date(today.getTime() - INVENTORY_DAYS * DAY_MS + 9 * HOUR_MS);
  const movements: any[] = [];
  const statusCounts: Record<string, Record<string, number>> = {};

  for (const branch of branches) {
    const branchUsage = usage.get(branch.slug)!;
    const plan = STOCK_PLAN[branch.slug] ?? {};
    statusCounts[branch.name] = { out: 0, low: 0, ok: 0, over: 0 };

    for (const [ingKey, byDay] of branchUsage) {
      const ing = ingredientById.get(ingKey);
      if (!ing) continue;
      const unit = ing.unit as IngredientUnit;
      const daily = [...byDay.entries()]
        .map(([day, used]) => ({ day, used: qty(used, unit) }))
        .filter((d) => d.used > 0);
      const consumed = daily.reduce((a, d) => a + d.used, 0);
      const avgDaily = consumed / INVENTORY_DAYS;
      // Umbrales por sucursal según su consumo real: mínimo ~3 días de uso, máximo ~12.
      const minStock = niceThreshold(avgDaily * 3, unit);
      const maxStock = niceThreshold(avgDaily * 12, unit);

      const target = plan[ing.name];
      let finalQty: number;
      if (target === "out") finalQty = 0;
      else if (target === "low") finalQty = qty(minStock * 0.6, unit);
      else if (target === "over") finalQty = qty(maxStock * 1.25, unit);
      else finalQty = qty(minStock + (maxStock - minStock) * between(0.3, 0.75), unit);

      const purchase = PURCHASES.find((p) => p.branch === branch.slug && p.ingredient === ing.name);
      const purchaseQty = purchase ? qty(consumed * 0.5, unit) : 0;
      const initialQty = qty(finalQty + consumed - purchaseQty, unit);

      movements.push({
        branch: branch.doc._id,
        ingredient: ing._id,
        type: "initial",
        quantity: initialQty,
        note: `${DEMO_TAG} Conteo inicial`,
        date: initialDate,
      });
      for (const { day, used } of daily) {
        movements.push({
          branch: branch.doc._id,
          ingredient: ing._id,
          type: "sale",
          quantity: -used,
          note: `${DEMO_TAG} Ventas del día ${day}`,
          date: new Date(Math.min(new Date(`${day}T23:30:00-05:00`).getTime(), now.getTime())),
        });
      }
      if (purchase && purchaseQty > 0) {
        const date = new Date(today.getTime() - purchase.daysAgo * DAY_MS + 10 * HOUR_MS);
        const invoice = await PurchaseInvoice.create({
          branch: branch.doc._id,
          supplier: purchase.supplier,
          invoiceNumber: `DEMO-001-${String(movements.length).padStart(6, "0")}`,
          date,
          status: "confirmed",
          lines: [
            {
              rawName: ing.name.toUpperCase(),
              ingredient: ing._id,
              quantity: purchaseQty,
              rawQuantity: purchaseQty,
              rawUnit: unit,
              unitCostCents: ing.costPerUnitCents,
              totalCents: Math.round(purchaseQty * ing.costPerUnitCents),
            },
          ],
          totalCents: Math.round(purchaseQty * ing.costPerUnitCents),
          extractedBy: "manual",
          confirmedAt: date,
        });
        movements.push({
          branch: branch.doc._id,
          ingredient: ing._id,
          type: "purchase",
          quantity: purchaseQty,
          refModel: "PurchaseInvoice",
          refId: invoice._id,
          note: `Factura ${purchase.supplier} ${invoice.invoiceNumber}`,
          date,
        });
      }

      await StockLevel.updateOne(
        { branch: branch.doc._id, ingredient: ing._id },
        { $set: { minStock, maxStock } },
        { upsert: true },
      );
    }
  }

  for (let i = 0; i < movements.length; i += BATCH) {
    await InventoryMovement.insertMany(movements.slice(i, i + BATCH));
  }

  // La existencia se recalcula desde el libro completo: así cuadra aunque haya movimientos reales previos.
  const sums = await InventoryMovement.aggregate([
    { $match: { branch: { $in: branches.map((b) => b.doc._id) } } },
    {
      $group: {
        _id: { branch: "$branch", ingredient: "$ingredient" },
        quantity: { $sum: "$quantity" },
      },
    },
  ]);
  for (const row of sums) {
    await StockLevel.updateOne(
      { branch: row._id.branch, ingredient: row._id.ingredient },
      { $set: { quantity: round(row.quantity, 4) } },
      { upsert: true },
    );
  }

  const levels = await StockLevel.find({ branch: { $in: branches.map((b) => b.doc._id) } }).lean<
    any[]
  >();
  for (const level of levels) {
    const branch = branches.find((b) => b.doc._id.equals(level.branch));
    const ing = ingredientById.get(level.ingredient.toString());
    if (!branch || !ing) continue;
    const status = computeStatus(
      level.quantity,
      level.minStock ?? ing.defaultMinStock,
      level.maxStock ?? ing.defaultMaxStock,
    );
    statusCounts[branch.name][status]++;
  }

  for (const branch of branches) {
    const last = lastSale.get(branch.slug);
    if (last && !branch.doc.lastSyncAt)
      await Branch.updateOne({ _id: branch.doc._id }, { $set: { lastSyncAt: last } });
  }

  // ---------- Usuario de sucursal ----------
  const villaClub = branches.find((b) => b.slug === "villa-club")!;
  let staffPassword: string | null = null;
  if (!(await User.exists({ email: "villaclub@rollit.ec" }))) {
    staffPassword = crypto.randomBytes(9).toString("base64url");
    await User.create({
      email: "villaclub@rollit.ec",
      password: staffPassword,
      name: "Personal Villa Club",
      accountType: "staff",
      branch: villaClub.doc._id,
    });
  }

  console.log("\nResumen del seed demo");
  console.log(`  Sucursales: ${branches.length}`);
  console.log(
    `  Platos: ${products.length} · Insumos: ${ingredients.size} · Recetas: ${products.length}`,
  );
  console.log(`  Meseros: ${[...waiters.values()].reduce((a, l) => a + l.length, 0)}`);
  console.log(`  Ventas pagadas: ${totalSales} · Total: $${(totalCents / 100).toFixed(2)}`);
  console.log(`  Movimientos de inventario: ${movements.length}`);
  for (const [name, counts] of Object.entries(statusCounts)) {
    console.log(
      `  Stock ${name}: ${counts.out} agotados, ${counts.low} por acabarse, ${counts.ok} óptimos, ${counts.over} sobrestock`,
    );
  }
  if (staffPassword) {
    console.log(`\n  Usuario staff creado: villaclub@rollit.ec / ${staffPassword}`);
  } else {
    console.log("\n  Usuario staff villaclub@rollit.ec ya existía: no se tocó");
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("✖ Falló el seed demo:", error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
