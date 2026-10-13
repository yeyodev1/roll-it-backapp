# Contrato del API — Roll It

Base: `/api`. Auth con `Authorization: Bearer <token>` salvo donde se indique.
Errores: `{ message }` en español. Dinero siempre en **centavos** (`*Cents`). Fechas en query como
`YYYY-MM-DD` interpretadas en hora de Ecuador (UTC-5); en respuestas, ISO.

Roles (`accountType`):
- `admin` — el dueño. Ve y edita todo, todas las sucursales.
- `staff` — personal de una sucursal (`user.branch`). Solo inventario y facturas de la suya; el
  backend fuerza su sucursal aunque mande otra (`resolveBranchScope`).

Query comunes de lectura: `branch` (id de sucursal, o `all`/vacío = todas), `from`, `to` (`YYYY-MM-DD`,
`to` inclusivo). Por defecto `from` = hace 29 días, `to` = hoy.

## Tipos

```ts
Branch      { _id, name, slug, smartmenuUrl, isActive, lastSyncAt }
Product     { _id, name, smartmenuCode, category, priceCents, isActive, hasRecipe }
Ingredient  { _id, name, unit: "g"|"kg"|"ml"|"l"|"unidad", costPerUnitCents, defaultMinStock, defaultMaxStock, aliases, isActive }
Recipe      { _id, product: { _id, name, category }, items: [{ ingredient: { _id, name, unit }, quantity }], notes }
Waiter      { _id, name, branch, isActive }
StaffUser   { id, email, name, phone, accountType, branch, isActive }

StockStatus = "out" | "low" | "ok" | "over"
//  out  = quantity <= 0                         → "Agotado"
//  low  = quantity <= min                       → "Por acabarse"
//  over = max > 0 && quantity > max             → "Sobrestock"
//  ok   = el resto                              → "Óptimo"
StockRow    { ingredient: { _id, name, unit }, branch: { _id, name }, quantity, minStock, maxStock, status: StockStatus, daysLeft: number|null, avgDailyUse: number }
// daysLeft = quantity / consumo diario promedio de los últimos 14 días (null si no hay consumo)

Movement    { _id, branch: { _id, name }, ingredient: { _id, name, unit }, type: "initial"|"purchase"|"sale"|"adjustment"|"waste", quantity, note, date, createdBy: { _id, name } | null }

InvoiceLine { rawName, ingredient: { _id, name, unit } | null, quantity, rawQuantity, rawUnit, unitCostCents, totalCents }
Invoice     { _id, branch: { _id, name }, supplier, invoiceNumber, date, imageUrl, status: "review"|"confirmed"|"rejected", lines: InvoiceLine[], totalCents, extractedBy: "ai"|"manual", aiError, createdAt, confirmedAt }
```

## Catálogos (lectura: admin y staff; escritura: solo admin)

| Método | Ruta | Body / Query | Respuesta |
|---|---|---|---|
| GET | `/branches` | — | `Branch[]` |
| POST | `/branches` | `{ name, smartmenuUrl? }` | `Branch` |
| PUT | `/branches/:id` | `{ name?, smartmenuUrl?, isActive? }` | `Branch` |
| GET | `/products` | `?q=&category=&onlyWithoutRecipe=true` | `Product[]` |
| POST | `/products` | `{ name, smartmenuCode?, category?, priceCents? }` | `Product` |
| PUT | `/products/:id` | parcial | `Product` |
| GET | `/ingredients` | `?q=` | `Ingredient[]` |
| POST | `/ingredients` | `{ name, unit, costPerUnitCents?, defaultMinStock?, defaultMaxStock?, aliases? }` | `Ingredient` |
| PUT | `/ingredients/:id` | parcial | `Ingredient` |
| GET | `/waiters` | `?branch=` | `Waiter[]` |
| PUT | `/waiters/:id` | `{ name?, isActive? }` | `Waiter` |
| GET | `/users` | — (admin) | `StaffUser[]` |
| POST | `/users` | `{ email, password, name, accountType: "admin"|"staff", branch? }` (admin) | `StaffUser` |
| PUT | `/users/:id` | `{ name?, branch?, isActive?, password? }` (admin) | `StaffUser` |

## Recetas (admin)

| Método | Ruta | Body | Respuesta |
|---|---|---|---|
| GET | `/recipes` | — | `Recipe[]` |
| GET | `/recipes/product/:productId` | — | `Recipe` o 404 |
| PUT | `/recipes/product/:productId` | `{ items: [{ ingredient: id, quantity }], notes? }` (upsert) | `Recipe` |
| DELETE | `/recipes/product/:productId` | — | `{ ok: true }` |
| POST | `/recipes/import` | multipart `file` (.xlsx o .csv). Columnas (cabecera, sin importar mayúsculas/tildes): `Plato`, `Ingrediente`, `Cantidad`, `Unidad`, opcional `Categoria`. Crea platos e insumos que no existan y reemplaza la receta de cada plato del archivo. | `{ products: n, ingredients: n, recipes: n, warnings: string[] }` |

## Inventario (admin y staff)

| Método | Ruta | Body / Query | Respuesta |
|---|---|---|---|
| GET | `/inventory` | `?branch=&status=` | `{ rows: StockRow[], counts: { out, low, ok, over } }` |
| GET | `/inventory/movements` | `?branch=&ingredient=&type=&page=&limit=` | `{ items: Movement[], total, page, pages }` |
| POST | `/inventory/initial` | `{ branch, items: [{ ingredient, quantity }] }` — fija el stock (crea un movimiento `initial` por la diferencia) | `{ ok: true, updated: n }` |
| POST | `/inventory/adjust` | `{ branch, ingredient, quantity (con signo), type: "adjustment"|"waste", note }` | `StockRow` |
| PUT | `/inventory/thresholds` | `{ branch, ingredient, minStock, maxStock }` (admin) | `StockRow` |
| GET | `/inventory/ask` | `?q=salmón&branch=` — respuesta corta en texto para consultas rápidas ("¿cuánto salmón queda en Villa Club?") | `{ answer: string, rows: StockRow[] }` |

## Facturas de proveedor (admin y staff)

| Método | Ruta | Body | Respuesta |
|---|---|---|---|
| GET | `/invoices` | `?branch=&status=&page=` | `{ items: Invoice[], total, page, pages }` |
| GET | `/invoices/:id` | — | `Invoice` |
| POST | `/invoices` | multipart `image` + `branch` (staff: se ignora y usa la suya). Sube a Cloudinary, la IA lee la factura y propone líneas cruzadas con insumos. Sin IA configurada queda con `lines: []` para cargar a mano. | `Invoice` (status `review`) |
| PUT | `/invoices/:id` | `{ supplier?, invoiceNumber?, date?, lines? }` solo en `review` | `Invoice` |
| POST | `/invoices/:id/confirm` | — suma al stock cada línea con insumo; las líneas sin insumo se ignoran y se avisa | `Invoice` |
| POST | `/invoices/:id/reject` | — | `Invoice` |

## Sincronización con SmartMenu (sin JWT)

Header `x-sync-key: <SYNC_API_KEY>`. Lo usa el agente que corre en la PC de cada sucursal.

| Método | Ruta | Body | Respuesta |
|---|---|---|---|
| POST | `/sync/sales` | `{ branch: slug, sales: [{ externalId, date (ISO), waiterName?, table?, guests?, status?: "paid"|"void", items: [{ name, code?, quantity, unitPriceCents?, totalCents? }], totalCents? }] }` | `{ received, created, updated, inventoryApplied, unmappedProducts: string[] }` |
| GET | `/sync/status` | — (JWT admin, no sync key) | `[{ branch: Branch, lastSyncAt, salesToday }]` |

Reglas: upsert por `(branch, externalId)`. Plato se cruza por `code` → `smartmenuCode`, si no por nombre
normalizado; si no existe se crea (sin receta) y se reporta en `unmappedProducts`. Mesero se crea por nombre.
Al quedar `paid` y con `inventoryApplied: false` se descuenta el inventario con la receta y se marca. Si un
ticket pasa a `void` después de aplicado, se devuelve el stock con un movimiento `adjustment`.

## Dashboard (solo admin)

Todos aceptan `?branch=&from=&to=`.

```ts
GET /dashboard/summary → {
  range: { from, to },
  salesCents, tickets, avgTicketCents, itemsSold,
  previous: { salesCents, tickets, avgTicketCents },     // mismo largo de período, justo antes
  byBranch: [{ branch: { _id, name }, salesCents, tickets, avgTicketCents, share }],  // share 0..1
  daily: [{ date: "YYYY-MM-DD", salesCents, tickets }],
  inventoryAlerts: { out, low },
  lastSyncAt: string | null
}

GET /dashboard/operations → {
  topProducts: [{ name, category, quantity, salesCents, share }],   // top 15 por venta
  byCategory: [{ category, quantity, salesCents, share }],
  heatmap: [{ weekday: 0..6, hour: 0..23, salesCents, tickets }],    // solo celdas con datos
  bestSlot: { weekday, hour, salesCents } | null,
  worstOpenSlot: { weekday, hour, salesCents } | null              // franja abierta (con ventas) que menos vende
}

GET /dashboard/waiters → {
  teamAvg: { avgTicketCents, ticketsPerDay, itemsPerTicket },
  waiters: [{
    waiter: { _id, name }, branch: { _id, name },
    salesCents, tickets, avgTicketCents, itemsPerTicket, ticketsPerDay, share, daysWorked,
    score: 0..100,
    level: "top" | "ok" | "attention",
    reasons: string[]    // en español, concretas: "Ticket promedio 18% bajo el equipo ($12,40 vs $15,10)"
  }]
}

GET /dashboard/finance → {
  monthly: [{ month: "YYYY-MM", salesCents, tickets, avgTicketCents }],     // últimos 24 meses
  currentMonth: { month, salesCents, daysElapsed, daysInMonth, projectedCents, lastYearCents | null, vsLastYear: number | null },
  yearToDate: { salesCents, lastYearSameRangeCents | null }
}
```

Score de meseros: compara contra el promedio del equipo en su sucursal → ticket promedio (40%), tickets por
día trabajado (35%), ítems por ticket (25%); 50 = igual al equipo. `top` ≥ 65, `attention` < 40. Las
`reasons` citan la métrica, el % y los valores. Se excluyen meseros con menos de 10 tickets en el período.
