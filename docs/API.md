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
Invoice     { _id, branch: { _id, name }, supplier, invoiceNumber, date, imageUrl, status: "review"|"confirmed"|"rejected", lines: InvoiceLine[], totalCents, extractedBy: "ai"|"manual", aiError, source: "photo"|"closing", note, createdAt, confirmedAt }
// source "closing" = compra copiada de la hoja CAJA CHICA del cierre de mes (pnpm import:drive):
// imageUrl "", status "confirmed", una línea con el motivo tal cual y quantity 0 (la caja chica no
// anota cantidades). `note` dice si es histórica (anterior al conteo inicial: no mueve stock).
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
| GET | `/invoices` | `?branch=&status=&page=` — ordenadas por `date` de la factura, más nuevas primero | `{ items: Invoice[], total, page, pages }` |
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
| POST | `/sync/upload` | — (JWT admin, no sync key) multipart `file` + opcional `branch` (slug). Ver abajo. | `SalesReportResult` |

Reglas: upsert por `(branch, externalId)`. Plato se cruza por `code` → `smartmenuCode`, si no por nombre
normalizado; si no existe se crea (sin receta) y se reporta en `unmappedProducts`. Mesero se crea por nombre.
Al quedar `paid` y con `inventoryApplied: false` se descuenta el inventario con la receta y se marca. Si un
ticket pasa a `void` después de aplicado, se devuelve el stock con un movimiento `adjustment`.

### Subir el reporte de SmartMenu a mano (`POST /sync/upload`)

Mientras no haya agente en el local, el dueño exporta en SmartMenu el **REPORTE DE VENTAS DETALLADO** y lo
sube desde el panel. Las ventas quedan cargadas al instante, con las mismas reglas de `/sync/sales` (por
dentro se llama a la misma función).

- Archivo: `.xls` (el exporte tal cual, Excel 97), `.xlsx` o `.csv` (UTF-8 o Windows-1252, con `,` o `;`).
  Máximo 15 MB. Se busca la cabecera en las primeras 20 filas; columnas por nombre (sin importar
  mayúsculas ni tildes): `Documento`, `Número documento`, `Fecha`, `Producto`, `Cantidad`, `Total`
  obligatorias; `Código producto`, `Categoría producto`, `Precio unitario`, `Descuento ($)`, `Subtotal`,
  `Información` opcionales. `Fecha` como `AAAA-MM-DD HH:MM:SS` (hora de Ecuador) o `DD/MM/AAAA HH:MM`.
- Sucursal: se detecta por la dirección del encabezado (`PACIFICO` → `villa-club`; `PUNTILLA` o
  `SAMBORONDON` → `marbol`). Si no se reconoce (p. ej. un CSV sin encabezado) se usa `branch`; sin ninguno
  responde 400. Si se detecta una y `branch` dice otra, 400 (evita cargar ventas en el local equivocado).
- Un ticket = las líneas con el mismo `Documento` + `Número documento`; `externalId` = `FACTURA-1551` /
  `TICKETS-1551`, el mismo con que se importó la historia. Solo cuentan `FACTURA` y `TICKETS`.
- Se excluyen las líneas con `ANULADA POR` en `Información` y los fees de franquicia (categoría
  `FRANCHISE FEE` o `FEE` en el nombre). Cortesía (descuento > 0 y subtotal 0) → `totalCents: 0`. El nombre
  del plato se limpia del canal (`LOCAL`, `UBER`, `PEDIDOS YA`…) y de la presentación repetida.
- Platos: por `Código producto` y si no por nombre, como en `/sync/sales`. Un código que el historial
  muestra con dos platos (SmartMenu los reutiliza) no se usa: esa línea se cruza por nombre.
- Idempotente: un ticket que ya está cargado con las mismas líneas (cantidad e importe) no se reenvía
  (`unchanged`); uno que cambió se actualiza; uno anulado entero que ya estaba cargado pasa a `void` y
  devuelve su stock. Subir el mismo archivo dos veces no duplica ni descuenta dos veces.
- `lastSyncAt` de la sucursal queda en la fecha de la última venta del reporte (nunca retrocede).
- Límite de tiempo de Vercel: se carga por lotes y, si se acerca a los 60 s, responde con lo cargado y
  `pending > 0`. Se sube el mismo archivo otra vez para terminar. Un reporte de dos semanas entra de una.

```ts
SalesReportResult {
  branch: { _id, name, slug },
  from: string | null, to: string | null,   // primera y última venta del reporte (ISO)
  rows,             // líneas de venta leídas (FACTURA/TICKETS)
  tickets,          // tickets válidos en el archivo
  received,         // tickets enviados al sincronizador (nuevos, cambiados o anulados)
  unchanged,        // ya estaban cargados igual: no se tocaron
  created, updated, inventoryApplied,
  unmappedProducts: string[],   // platos creados sin receta
  pending           // tickets que faltan por el límite de tiempo (normalmente 0)
}
```

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
  source: "tickets" | "closings" | "none",   // de dónde salen los números (ver abajo)
  metrics: ("avgTicket" | "ticketsPerDay" | "itemsPerTicket")[],   // las que entran en el puntaje
  closingsRange: { from, to } | null,        // días con cierre de mes cargado (para ofrecerlos si el rango está vacío)
  teamAvg: { avgTicketCents: number | null, ticketsPerDay, itemsPerTicket },
  waiters: [{
    waiter: { _id, name }, branch: { _id, name },
    salesCents: number | null, tickets, avgTicketCents: number | null, itemsPerTicket, ticketsPerDay,
    share: number | null, daysWorked,
    score: 0..100,
    level: "top" | "ok" | "attention",
    reasons: string[]    // en español, concretas: "Ticket promedio 18% bajo el equipo ($12,40 vs $15,10)"
  }]
}

GET /dashboard/finance → {
  asOf: string,   // instante de referencia: ahora, o la última venta si los datos no están al día
  monthly: [{ month: "YYYY-MM", salesCents, tickets, avgTicketCents }],     // últimos 24 meses
  currentMonth: { month, salesCents, daysElapsed, daysInMonth, projectedCents, lastYearCents | null, vsLastYear: number | null },
  yearToDate: { salesCents, lastYearSameRangeCents | null }
}
```

Score de meseros: compara contra el promedio del equipo en su sucursal → ticket promedio (40%), tickets por
día trabajado (35%), ítems por ticket (25%); 50 = igual al equipo. `top` ≥ 65, `attention` < 40. Las
`reasons` citan la métrica, el % y los valores. Se excluyen meseros con menos de 10 tickets en el período.

Fuentes de meseros:
- `tickets`: ventas (`Sale`) con `waiter`. Es la fuente buena y manda siempre que haya alguna en el período.
- `closings`: si no hay tickets con mesero, se usa `WaiterDay` (hoja VENTA DIARIA del cierre de mes, cargada
  con `pnpm import:drive`): un registro por mesera y día con `tables` (mesas atendidas) y `upsellUnits`
  (cócteles, cervezas, postres, jugos y entradas sugeridos). Ahí `tickets` = mesas, `ticketsPerDay` = mesas
  por día trabajado (día con mesas o sugeridos) e `itemsPerTicket` = productos sugeridos por mesa. El cierre
  no trae venta en $ por mesera: `salesCents`, `avgTicketCents`, `share` y `teamAvg.avgTicketCents` van en
  `null`, `metrics` no incluye `avgTicket`, el puntaje reparte los pesos entre las dos métricas que hay
  (58% / 42%) y `reasons` termina avisando que el ticket promedio no entra. Mínimo: 5 mesas en el período.
- `none`: no hay ni tickets con mesero ni cierres en el período (`waiters: []`). Si `closingsRange` no es
  null, el panel ofrece saltar a esas fechas.
