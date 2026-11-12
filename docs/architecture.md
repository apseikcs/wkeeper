# Architecture

## Module map

```
src/
  server.ts          entry: dotenv.config() -> import app -> app.listen(PORT)
  config.ts          the ONLY place env is read (JWT_SECRET w/ insecure fallback, PORT, WK_PRISMA_QUERY_LOG)
  app.ts             wiring only: cors, json, /api auth, static, fonts log, mount 9 routers (~47 lines)
  auth.ts            password hashing + JWT sign/verify
  prisma.ts          PrismaClient singleton (query events only when WK_PRISMA_QUERY_LOG=1)
  dateUtils.ts       Moscow date helpers
  reports.ts         report queries: inventory, summary, top products, low stock, worker/dest/supplier stats, forecast, CSV
  middleware/
    auth.ts          authenticateToken + apiAuth (global /api auth, skips /login)
    permissions.ts   getDbUserFromReq, authorizePermission, authorizeRole (contains the `axelerator` hardcode)
  routes/
    auth.ts          POST /api/login, GET /api/me
    search-stats.ts  GET /api/stats, GET /api/search
    products.ts      /api/products* (GET, POST, POST :id/adjust, DELETE :id, PATCH :id)
    suppliers.ts     /api/suppliers* (GET, POST, DELETE :id, PATCH :id)
    locations.ts     /api/locations* (GET, POST, DELETE :id, PATCH :id)
    workers.ts       /api/workers* (CRUD + assignTool/unassignTool)
    tools.ts         /api/tools* (GET, POST, PATCH :id, DELETE :id)
    transactions.ts  /api/transactions* (recent, GET, PATCH :id, bulk-adjust, POST, :id/items POST, item DELETE/PATCH)
    reports.ts       /api/reports/* (9 endpoints incl. export)
```

Each router file registers routes with **full paths** (`router.get('/api/products', ...)`) and is mounted with `app.use(<router>)` (no prefix). Route bodies were moved verbatim; only the receiver changed `app.` -> `router.`.

## Request flow

1. `src/server.ts` calls `dotenv.config()`, then imports `config.ts` (env) and `app.ts`; starts `app.listen(PORT)`.
2. `src/app.ts` registers, in order: `cors()` -> `express.json()` -> `app.use('/api', apiAuth)` (skips `/login`, otherwise `authenticateToken`) -> `express.static(frontend)` -> `/fonts` static -> fonts existence log -> mounts the 9 routers.
3. An `/api/*` request hits `apiAuth` (JWT verify, attaches `authUser`), then the matching router; per-route middleware `authorizeRole`/`authorizePermission` (in `middleware/permissions.ts`) may run, then the handler queries `prisma` and responds.
4. A non-`/api` request is served by `express.static` (the SPA pages in `frontend/`).

Route registration order is behavior-neutral: every route is a distinct (method, path) with no overlapping patterns, so grouping by resource does not change matching. This is enforced by `tests/routes-manifest.test.ts` (44-route snapshot) and the full suite.

## Where each audit finding now lives

| Finding | New location |
|---|---|
| C1 missing role gates (mutating routes open to workers) | `src/routes/products.ts` (DELETE/PATCH), `src/routes/workers.ts`, `src/routes/suppliers.ts`, `src/routes/locations.ts`, `src/routes/tools.ts`, `src/routes/transactions.ts` (item routes) |
| C2 hardcoded JWT secret fallback | `src/config.ts:3` |
| C3 stored XSS (`innerHTML`) | `frontend/transactions.html` (~210-220), `frontend/index.html` (~1442-1449) |
| H1 seed credentials | `prisma/seed.ts:16-18` |
| H2 no login rate limit | `src/routes/auth.ts:8` (login handler) |
| H3 transactions/items editable by any user | `src/routes/transactions.ts` (POST/DELETE/PATCH `.../items`) |
| H4 full-history load + JS aggregation | `src/reports.ts:110` (`getTransactionSummary`) |
| H5 all-items load for lastMovement | `src/reports.ts:55` (`getInventoryStatus`) |
| H6 tool-assign race | `src/routes/workers.ts:167-185` (availableQuantity read/check/decrement) |
| H7 reports page loads 8 endpoints | `frontend/reports.html:970-981` |
| M4 N+1 stats queries | `src/reports.ts:233` / `:317` / `:353` (`getWorkerPerformance`/`getDestinationStats`/`getSupplierStats`) |
| M5 reports/export have no role gate | `src/routes/reports.ts` (all 9 routes) |
| M6 no global error handler | `src/app.ts` (none registered) |
| M7 CORS wildcard | `src/app.ts:18` (`app.use(cors())`) |
| M8 `axelerator` superuser bypass | `src/middleware/permissions.ts:17` (`authorizePermission`), `:50` (`authorizeRole`) |
| L1 `nowInMoscow()` returns local time | `src/dateUtils.ts:31` |
| L3 legacy `t.delta` / `t.productName` reads | `src/reports.ts:154` |
| L4 no tests | `tests/` (addressed in batch 0/0b) |
| L5 no backup in repo | repo root (`.gitignore` still ignores `backup.sql`) |