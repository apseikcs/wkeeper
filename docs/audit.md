# Warehouse Keeper (`wkeeper`) — Security / Quality / Performance Audit

Read-only audit. No source files were modified; this document is the only artifact created. Every finding carries file:line and a code snippet; anything uncertain is marked `suspected` or moved to "Questions for the owner". `npm audit` and `tsc --noEmit` could not be run (no `node_modules`, no network); `git` is unavailable (no `.git` directory).

## 1. Summary

- **Stack:** Node.js + Express 4 + Prisma 6 (PostgreSQL datasource), JWT (`jsonwebtoken`) + `bcryptjs` auth, vanilla-JS + Tailwind frontend (no frontend build). All routes live in one file, `src/server.ts` (~1,867 lines); report logic in `src/reports.ts`.
- **Stock model:** balance is denormalized — `product.quantity` (Int) is the source of truth, mutated by atomic `increment` inside Prisma transactions; history lives in `transaction` / `transactionItem`.
- **Overall state:** feature-rich and internally consistent on stock math, but the **authorization model is effectively absent** — every `/api` route except `/api/login` only requires *any* valid token, and only `POST /api/workers` has a real admin gate. The worker/admin split is enforced only by hiding dashboard UI in JS, never by the backend.
- **Top 5 risks:** (1) privilege escalation / IDOR from missing role checks on ~30 mutating routes; (2) hardcoded JWT secret fallback; (3) stored XSS in transaction rendering; (4) weak default credentials in the seed; (5) report queries that load whole tables / N+1, which is the lag users actually feel.
- Also: no tests, no automated backup, no login rate limiting, open CORS, and no dependency audit possible here.

## 2. Route map

Every `/api/*` route except `/api/login` requires a valid JWT via `app.use('/api', ...)` (`src/server.ts:33-37`). "Role gate" below is the *additional* check beyond that token, if any.

| Method | Path | Additional role gate | Input validation | server.ts |
|---|---|---|---|---|
| POST | /api/login | public | username/password present | 71 |
| GET | /api/me | — | — | 127 |
| GET | /api/stats | — | — | 143 |
| GET | /api/transactions/recent | — | — | 160 |
| GET | /api/products | — | page≥1, limit 1..500 | 207 |
| POST | /api/products | — | name; qty 0..65535 | 311 |
| POST | /api/products/:id/adjust | `inventory:transact` (workers allowed by default) | type in/out; delta>0 | 356 |
| DELETE | /api/products/:id | — | — (`purge` flag) | 431 |
| GET | /api/workers | — | — | 470 |
| POST | /api/workers | **admin only** | fullName; phone | 484 |
| DELETE | /api/workers/:id | — | — | 531 |
| PATCH | /api/workers/:id | — | phone | 555 |
| GET | /api/suppliers | — | — | 608 |
| POST | /api/suppliers | — | name; phone/email | 633 |
| DELETE | /api/suppliers/:id | — | — | 662 |
| PATCH | /api/products/:id | — | name/unit | 676 |
| PATCH | /api/suppliers/:id | — | email | 729 |
| GET | /api/locations | — | sort whitelist | 782 |
| POST | /api/locations | — | name | 810 |
| DELETE | /api/locations/:id | — | — | 819 |
| PATCH | /api/locations/:id | — | name | 832 |
| GET | /api/transactions | — | **limit uncapped** | 862 |
| PATCH | /api/transactions/:id | — | — (note only) | 994 |
| GET | /api/search | — | — | 1005 |
| GET | /api/reports/inventory | — | — | 1028 |
| GET | /api/reports/transactions | — | from/to | 1037 |
| GET | /api/reports/top-products | — | limit | 1049 |
| GET | /api/reports/low-stock | — | threshold | 1062 |
| GET | /api/reports/worker-performance | — | from/to | 1073 |
| GET | /api/reports/consumption-forecast | — | days | 1085 |
| GET | /api/reports/destination-stats | — | from/to | 1096 |
| GET | /api/reports/supplier-stats | — | from/to | 1108 |
| GET | /api/reports/export | — | type/format | 1120 |
| GET | /api/tools | — | — | 1245 |
| POST | /api/tools | — | name; qty | 1259 |
| PATCH | /api/tools/:id | — | name; qty | 1283 |
| DELETE | /api/tools/:id | — | — | 1329 |
| POST | /api/workers/:workerId/assignTool/:toolId | — | qty | 1344 |
| POST | /api/workers/:workerId/unassignTool/:toolId | — | qty | 1394 |
| POST | /api/transactions/bulk-adjust | `inventory:transact` | items | 1477 |
| POST | /api/transactions | `inventory:transact` | items | 1593 |
| POST | /api/transactions/:id/items | — | delta | 1715 |
| DELETE | /api/transactions/:id/items/:itemId | — | — | 1770 |
| PATCH | /api/transactions/:id/items/:itemId | — | delta | 1808 |

## 3. Findings table (sorted by severity)

| ID | Severity | Status | File:line | Problem | Why it matters here | Fix | Effort |
|---|---|---|---|---|---|---|---|
| C1 | critical | confirmed | server.ts:431,531,555,633,662,676,729,810,819,832,994,1259,1283,1329,1715,1770,1808 | Mutating/admin routes have **no role gate** — any logged-in worker can delete products, edit/delete workers, suppliers, locations, tools, and add/edit/delete transaction items | The two-role design is defeated: a disgruntled worker can wipe inventory or alter financial history | Add `authorizeRole(['admin'])` (or granular permission) middleware to every admin route; apply `inventory:transact` to item edits | L |
| C2 | critical | confirmed | auth.ts:4 | `JWT_SECRET` falls back to a hardcoded string | If `JWT_SECRET` is unset in prod, anyone can forge admin tokens | Require the env var at startup (throw if missing); rotate the secret | S |
| C3 | critical | confirmed | transactions.html:210-220, index.html:1442-1449 | User-controlled values interpolated into `innerHTML` without escaping (note, product/supplier/destination/worker names) | Stored XSS: a worker who can create a product or set a note runs script in every other user's session (token theft) | Escape all interpolated fields (`escapeHtml`) — `authorUsername` is already escaped on these exact lines | S |
| H1 | high | confirmed | seed.ts:16-18 | Hardcoded credentials: `admin123`, `worker123`, and `axelerator`'s password `tNNzvoO44` in the repo | Known/weak passwords if the seed was ever used in prod, or reused | Remove from seed; force password change on first login; rotate any live accounts | S |
| H2 | high | confirmed | server.ts:71-89 | No rate limiting or lockout on `/api/login` | Trivial brute-force of the fixed accounts | Add rate limiting / account lockout on login | S |
| H3 | high | confirmed | server.ts:994,1715,1770,1808,439-458 | Transactions and items can be edited/deleted by any user with no audit log; `DELETE /api/products/:id?purge=true` hard-deletes transaction history | Breaks the stock ledger — history silently mutates or disappears; balances can't be reconstructed | Require admin for edits/deletes; soft-delete + audit rows; never let workers purge history | M |
| H4 | high | confirmed | reports.ts:119-183 | `getTransactionSummary` loads **all** transactions + items and aggregates in JS | `/api/reports/transactions` (and its export) scans the whole ledger every open — primary source of lag | Push `groupBy`/`_sum` and date filtering into SQL/Prisma; bound by date | M |
| H5 | high | confirmed | reports.ts:82-92 | `getInventoryStatus` loads **every** `transactionItem` for **every** product into memory to compute `lastMovement` | Inventory report grows O(total items) and degrades as history accumulates | Compute last-movement per product with one grouped/window query | M |
| H6 | high | confirmed | server.ts:1351-1385 | Tool assignment reads `availableQuantity` outside the transaction, then decrements | Concurrent assigns can drive `availableQuantity` negative | Move read+check inside `$transaction` and validate `>=0` after decrement | S |
| H7 | high | confirmed | reports.html:970-981 | Reports page fires all 8 report endpoints in parallel on open | Multiplies H4/H5/M4 into one slow page load | Load lazily per tab, cache, or make endpoints cheap first | M |
| M1 | medium | confirmed | server.ts:870 | `limit` on `/api/transactions` is uncapped (`Math.max(1, Number(...))`, no upper bound) | A single request can stream the whole ledger | Cap `limit` (e.g. ≤500) like `/api/products` | S |
| M2 | medium | confirmed | server.ts:980-989 | product/quantity sort applied in JS **after** `take: limit`, so it sorts only the current page | Sorting looks broken across pages | Sort in SQL (or before pagination) | M |
| M3 | medium | confirmed | server.ts:940-991 | `total` counts transactions but `items` is flattened items; page size in items ≠ total | Pagination is inconsistent (pages overflow/underflow) | Count and page by the same unit (items) | M |
| M4 | medium | confirmed | reports.ts:249-264,333-348,369-378 | N+1: per-entity `count` + `aggregate` + `findUnique` in `Promise.all` loops | Worker/destination/supplier stats scale with entity count | Single `groupBy` per report | S |
| M5 | medium | confirmed | server.ts:1028-1120 | Reports and export endpoints have no role gate | A worker can read all-worker performance and supplier stats, and export them | Gate reports/export behind admin (or intended role) | S |
| M6 | medium | confirmed | server.ts:127-141,470-482 | No global error handler; several routes lack try/catch, so a thrown Prisma error becomes an unhandled rejection | 500s with no response; process can log noise or crash | Add a 4-arg express error handler + centralize async errors | S |
| M7 | medium | confirmed | server.ts:16 | `app.use(cors())` allows any origin | Any website can call the API with a user's token if it obtains one (C3 makes this worse) | Restrict CORS to the app origin | S |
| M8 | medium | confirmed | auth.js:6, auth.ts:16, server.ts:51,115 | Token in `localStorage` with 24h life; hardcoded `axelerator` superuser bypass in two places | XSS (C3) yields a long-lived token; `axelerator` is an implicit backdoor regardless of DB role | Shorten expiry, add refresh; remove the username hardcode | S |
| L1 | low | suspected | dateUtils.ts:31-33 | `nowInMoscow()` returns `new Date()` (server-local), not Moscow time | Month boundaries in `getInventoryStatus` shift if server TZ ≠ Europe/Moscow | Use `Intl`/offset consistently or store UTC | S |
| L2 | low | confirmed | index.html:1515, destinations.html:468, suppliers.html:423, tools.html:433, workers.html:533 | `escapeHtml` duplicated in 5 files (plus inline translit table in server.ts) | Drift/typos — C3 happened because one page skipped it | Share one utility | S |
| L3 | low | confirmed | reports.ts:154,478 + schema.prisma:75-77,91-92 | Legacy fields (`t.delta`, `t.productName`, `transaction.product/productId`) are read but no longer exist on the model | Dead code path returns `undefined` (delta 0) for legacy-style transactions | Remove legacy references/columns or migrate old data | S |
| L4 | low | confirmed | package.json:5-11 | No `test` script, no test files | No regression safety net for the fixes above | Add unit tests around stock math + integration tests for role gates | M |
| L5 | low | confirmed | .gitignore:1-5 | `backup.sql` is empty and gitignored; no backup job in repo; `prisma/dev.db.bak` (32 KB SQLite) present and **not** gitignored | No disaster recovery; a stray DB file risks committing data | Add a scheduled `pg_dump` job; ignore/remove `.bak` | M |
| L6 | low | confirmed | index.html:1343-1354 | Bulk product create issues N sequential `POST /api/products` | Slow for larger imports; partial-failure prone | Add a bulk create endpoint | S |
| L7 | low | confirmed | server.ts (various) | Input validation is inconsistent (some routes validate, many `Number(...)` accept NaN/negative) | Bad data and 500s from malformed requests | Centralize request validation (e.g. zod) | M |
## 4. Evidence (code snippets, ≤10 lines each)

**C2 — hardcoded JWT secret** (`src/auth.ts:4`):
```ts
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-that-is-long'
```

**C1 — missing role gates** (`src/server.ts:431-461`, product delete incl. history purge; same pattern on the other listed routes):
```ts
app.delete('/api/products/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const purge = String(req.query.purge || 'false') === 'true'
  const product = await prisma.product.findUnique({ where: { id } })
  if (!product) return res.status(404).json({ error: 'product not found' })
  try {
    if (purge) {
      await prisma.$transaction(async (tx) => {
        await tx.transactionItem.deleteMany({ where: { productId: id } })
        // ...deletes transactions and the product (lines 439-458)
```

**C3 — stored XSS** (`frontend/transactions.html:210-220`) — `note`/`productName`/`supplier.name`/`destination.name`/`worker.fullName` unescaped (note `authorUsername` *is* escaped on line 219):
```js
tr.innerHTML = `
  <td>${r.id}</td>
  <td>${formatDate(r.date)}</td>
  <td>${r.productName || ''}</td>
  <td>${Math.abs(r.delta)}</td>
  <td class="type ${r.type}">${r.type}</td>
  <td>${r.supplier ? r.supplier.name : (r.supplierName || '')}</td>
  <td>${r.destination ? r.destination.name : (r.destinationName || '')}</td>
  <td>${r.worker ? r.worker.fullName : ''}</td>
  <td>${r.authorUsername ? `@${escapeHtml(r.authorUsername)}` : '—'}</td>
  <td contenteditable data-id="${r.id}" class="note-cell">${r.note || ''}</td>`
```

**C3 (dashboard)** (`frontend/index.html:1442-1449`) — `productDisplay` and `g.who` unescaped:
```js
tr.innerHTML = `
  <td>${formatDate(g.date)}</td>
  <td>${productDisplay}</td>
  <td>${g.totalDelta}</td>
  <td class="type ${g.type}">${g.type}</td>
  <td>${g.who}</td>
  <td>${g.authorUsername ? `@${escapeHtml(g.authorUsername)}` : '—'}</td>
`;
```

**H1 — seed credentials** (`prisma/seed.ts:16-24`):
```ts
const axPass = await hashPassword('tNNzvoO44')
const adminPass = await hashPassword('admin123')
const workerPass = await hashPassword('worker123')
// ...
{ username: 'axelerator', passwordHash: axPass, role: 'admin' },
{ username: 'admin', passwordHash: adminPass, role: 'admin' },
{ username: 'worker1', passwordHash: workerPass, role: 'worker' }
```

**H2 — no rate limiting** (`src/server.ts:71-88`):
```ts
app.post('/api/login', async (req: Request, res: Response) => {
  const { username, password } = req.body
  if (!username || !password) return res.status(400).json({ error: 'username and password required' })
  const user = await prisma.user.findUnique({ where: { username } })
  if (!user) return res.status(401).json({ error: 'invalid credentials' })
  const passwordValid = await comparePassword(password, user.passwordHash)
  if (!passwordValid) return res.status(401).json({ error: 'invalid credentials' })
  const token = generateToken(user.id, user.username, user.role)
  res.json({ token })
})
```

**H3 — history mutable by any user** (`src/server.ts:994-1003`, note edit; same missing gate on item POST/DELETE/PATCH at 1715/1770/1808):
```ts
app.patch('/api/transactions/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const { note } = req.body
  try {
    const t = await prisma.transaction.update({ where: { id }, data: { note: note ?? null } })
    res.json(t)
  } catch (e) { res.status(400).json({ error: 'failed to update note' }) }
})
```

**H4 — full-history load + JS aggregation** (`src/reports.ts:119-183`):
```ts
const transactions: any[] = await prisma.transaction.findMany({
  where: whereDate,
  include: { items: true, worker: true, supplier: true, destination: true, product: true },
  orderBy: { date: 'desc' }
});
// ...then flatMap + groupBy(...) + reduce in JS (lines 125-183)
```

**H5 — all items loaded for lastMovement** (`src/reports.ts:82-92`):
```ts
const recentItems = await prisma.transactionItem.findMany({
  where: { productId: { in: products.map(p => p.id) } },
  include: { transaction: { select: { date: true } } },
  orderBy: { transaction: { date: 'desc' } }
});
```

**H6 — tool assign race** (`src/server.ts:1351-1385`) — check outside the transaction:
```ts
const tool = await prisma.tool.findUnique({ where: { id: toolId } });
// ...
if (assignQty > tool.availableQuantity) { return res.status(400).json({ error: `Not enough tools available...` }) }
const [assignment] = await prisma.$transaction([
  prisma.toolAssignment.create({ ... }),
  prisma.tool.update({ where: { id: toolId }, data: { availableQuantity: { decrement: assignQty } } })
]);
```

**H7 — 8 reports in parallel** (`frontend/reports.html:970-981`):
```js
await Promise.all([
  ReportSections.loadInventory(),
  ReportSections.loadTransactions(),
  ReportSections.loadTopProducts(),
  ReportSections.loadLowStock(),
  ReportSections.loadWorkerPerformance(),
  ReportSections.loadConsumptionForecast(),
  ReportSections.loadDestinationStats(),
  ReportSections.loadSupplierStats()
]);
```

**M1 — uncapped limit** (`src/server.ts:870`):
```ts
const limit = req.query.limit ? Math.max(1, Number(req.query.limit)) : 200
```

**M2/M3 — sort after paging + mixed count unit** (`src/server.ts:940-991`):
```ts
const totalTransactions = await prisma.transaction.count({ where })   // counts transactions
const transactions = await prisma.transaction.findMany({ where, include: {...}, orderBy, skip, take: limit })
const flattenedItems = transactions.flatMap(t => t.items.map(item => ({...})))
// sort product/quantity in JS on flattenedItems (lines 980-989)
res.json({ page, limit, total: totalTransactions, items: sortedItems })
```

**M4 — N+1** (`src/reports.ts:249-257`; identical shape in 333-341 and 369-377):
```ts
const results = await Promise.all(workerIds.map(async wid => {
  const count = await prisma.transactionItem.count({ where: { transaction: { type: 'out', workerId: wid, ...whereDate } } });
  const sum = await prisma.transactionItem.aggregate({ where: { transaction: { type: 'out', workerId: wid, ...whereDate } }, _sum: { delta: true } });
  const worker = await prisma.worker.findUnique({ where: { id: wid } });
  return { ... };
}));
```

**M8 — hardcoded superuser** (`src/server.ts:51` and `:115`):
```ts
if (dbUser.username === 'axelerator') return next()
```

**L1 — misnamed now()** (`src/dateUtils.ts:31-33`):
```ts
export function nowInMoscow(): Date {
  return new Date()
}
```

**L3 — legacy fields** (`src/reports.ts:154` — `t.delta` does not exist on `transaction`):
```ts
delta: t.delta,
```

**L6 — N sequential product creates** (`frontend/index.html:1343-1354`):
```js
for (const item of items) {
  const response = await authFetch('/api/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item)
  });
  // ...
}
```
## 5. Questions for the owner

1. **Which routes are actually admin-only in your mental model?** Only `POST /api/workers` is gated. Is it intended that workers can create/edit/delete products, suppliers, locations, tools, and transaction items, or should those be admin-only? (C1)
2. **How are user accounts created/rotated in production?** There is no user-management or password-change endpoint — users exist only via `prisma/seed.ts` (which also hardcodes `admin123`/`worker123`). Who manages logins today? (H1)
3. **Is the `axelerator` account a real person or a leftover?** It bypasses every role check by username regardless of its DB `role`. (M8)
4. **Should workers see all reports?** Worker-performance, supplier-stats, destination-stats, and export are open to any authenticated user. If these are admin-only, say so and they'll be gated. (M5)
5. **What timezone does the production server run in?** `nowInMoscow()` returns server-local time, which shifts report month boundaries if the host isn't UTC+3. (L1)
6. **Are edits to posted transactions ever legitimate?** The API lets any user change an item's `delta` (and therefore the product balance) and edit notes after posting — is silent correction intended, or should there be reversal/adjustment records? (H3)
7. **What is `prisma/dev.db.bak`?** It's a 32 KB SQLite file (schema says PostgreSQL) sitting in the repo and not gitignored. Safe to delete? (L5)
8. **Backups:** `backup.sql` is empty and gitignored. Is there a scheduled `pg_dump`/backup outside this repo? (L5)
9. **Fractional quantities:** all quantities are integers, and `unit` is free text. Do you ever need `0.5` kg / meters, or per-unit costing? (design note, not a bug)
10. **Environment:** can you confirm `JWT_SECRET` is set (and unique) in the production environment so the hardcoded fallback is never used? (C2)

## 6. Proposed fix batches

Each batch = one branch + one session, ordered by dependency and risk. Tests listed must exist **before** touching code in that batch.

### Batch A — auth & access control (highest risk, do first)
- C2 (require `JWT_SECRET`), C1 (add role gates), M5 (gate reports), M8 (remove `axelerator` hardcode), H2 (rate limit login), M7 (CORS allow-list).
- **Tests first:** a route-level test asserting 401/403 per role for every route in §2; a login brute-force test; a secret-missing startup test.

### Batch B — XSS & frontend escaping
- C3 (escape all interpolated values in `transactions.html` and `index.html`), L2 (share one `escapeHtml`).
- **Tests first:** a DOM-level test that renders a product/note containing `<img src=x onerror=...>` and asserts it appears as text, not an element.

### Batch C — stock integrity
- H3 (restrict transaction/item edit/delete + audit trail + stop history purge by workers), H6 (tool assign race), H1 (remove seed passwords / force change).
- **Tests first:** unit tests for balance math (in/out/adjust/item-edit/item-delete → quantity), a concurrency test for tool assignment (two parallel assigns must not go negative), and a purge-permission test.

### Batch D — report performance (the lag users feel)
- H4 (SQL aggregation + date bounds), H5 (grouped lastMovement), M4 (single `groupBy`), H7 (lazy report loading), M1 (cap limit), M2/M3 (fix sort + pagination).
- **Tests first:** load tests / query-plan checks proving each report issues a bounded number of queries independent of history size; pagination boundary tests.

### Batch E — hygiene & ops
- M6 (global error handler), L7 (centralized validation), L6 (bulk create), L3 (remove legacy fields), L1 (timezone), L4 (add test harness), L5 (backup job + ignore `.bak`).
- **Tests first:** error-handler test (a throwing route returns JSON 500), validation tests for the centralized schema.

## 7. Notes on what I could not verify

- `npm audit` and `tsc --noEmit` were not run (no `node_modules`, no network). Dependency versions are pinned in `package-lock.json`; run `npm audit` in a networked environment before release.
- No `.git` directory is present, so `git log/blame/diff` were unavailable; version history and ownership were not checked.
