# Tests — how to run, what is covered, known-failing cases

This is the Batch 0 + Batch 0b test harness. **No app behavior changes** were made for testability except two clearly-scoped ones:

1. `src/server.ts` was split into `src/app.ts` (exports `app`) + `src/server.ts` (dotenv + `app.listen`), so the Express app can be imported without starting a server.
2. `src/prisma.ts` enables Prisma `query` events **only when `WK_PRISMA_QUERY_LOG=1`** (perf runs). Unset in normal runs and production -> the client is constructed identically to before.

## Prerequisites

- Node 22 (vitest 3).
- A **throwaway PostgreSQL database whose name ends with `_test`**. Docker example:

  ```bash
  docker run --name wkeeper-pg -e POSTGRES_PASSWORD=postgres -p 55432:5432 -d postgres:16
  docker exec wkeeper-pg createdb -U postgres wkeeper_test
  ```

- `TEST_DATABASE_URL` pointing at it, e.g. `postgresql://postgres:postgres@127.0.0.1:55432/wkeeper_test`.

`npm ci` installs everything (`vitest`, `supertest`, `@types/supertest`, `jsdom`, `@vitest/coverage-v8`).

## How to run

```bash
# Windows PowerShell
$env:TEST_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:55432/wkeeper_test"
npm test              # main suite (fast, deterministic, fileParallelism:false)
npm run test:coverage # same suite with v8 coverage, threshold: lines >= 85%
npm run test:perf     # seeds 2k products / 50k transactions / 150k items and writes docs/perf-baseline.md
```

If `npm test` prints `No test files found`, `TEST_DATABASE_URL` is unset or failed the guard.

## Test database safety (three layers)

1. `tests/guard.ts` — `TEST_DATABASE_URL` must be a `postgresql://` URL whose database name ends with `_test`; otherwise the run aborts before touching anything. Never reads `.env`.
2. `tests/global-setup.ts` — applies the committed migrations with `prisma migrate deploy` **against the test URL only** (env overridden for that subprocess). The `*_test` database must already exist.
3. `tests/helpers.ts` `resetDb()` — runs `SELECT current_database()` through the app's Prisma client and aborts unless it ends with `_test`, before deleting any rows.

## Test files

| File | Covers |
|---|---|
| `tests/stock.test.ts` | adjust in/out, bulk-adjust, multi-item transaction, edit item delta, delete item — asserting `product.quantity === SUM(transactionItem.delta)`; out-beyond-stock (current 400); `DELETE /api/transactions/:id` gap (404). |
| `tests/concurrency.test.ts` | product `out` race (10 parallel × 20 rounds), tool-assign race (H6, `it.fails`), item-delta-edit race (`it.fails`). |
| `tests/authz.test.ts` | full route matrix: no token -> 401, worker -> expected, admin -> expected, for every route in the audit route table (C1/M5/H3 `it.fails`). |
| `tests/validation.test.ts` | malformed input (NaN, negative, huge, wrong types, missing fields) + 404s on every write route. |
| `tests/routes-extra.test.ts` | branch/variant coverage (product-with-stock, purge, renames, tool qty edit, assign->unassign, product search, transaction filters/sorts, supplier email/phone validation). |
| `tests/reports.test.ts` | every report endpoint with data + CSV/Excel export for all 7 types + unknown type/format. |
| `tests/security.test.ts` | `it.fails` for login rate limit (H2), `axelerator` superuser bypass (M8), missing `JWT_SECRET` (C2), CORS wildcard (M7). |
| `tests/xss.test.ts` | jsdom render of `transactions.html` + `index.html` row templates with `<img src=x onerror=...>` payloads (`it.fails`, C3). |
| `tests/perf/perf.test.ts` | query count + wall time per report endpoint and `GET /api/transactions` (separate config). |

## Concurrency / races (`tests/concurrency.test.ts`)

- **Product `out`**: 1 unit, 10 parallel `out`, 20 rounds with reset between rounds -> exactly one 200 and nine 400, `quantity === 0`. Passes today (atomic `increment` + post-check).
- **Tool assign (H6)**: 1 tool, 10 parallel assigns, 20 rounds -> desired: one success + nine rejections, `availableQuantity === 0`. Marked `it.fails`; today multiple assigns pass the out-of-transaction `availableQuantity` check and it goes negative (verified 0/20 rounds satisfy the desired behavior — the race reproduces every round, so no delay hook is needed).
- **Item-delta edit race**: 10 parallel `PATCH …/items/:itemId`, 20 rounds -> desired: `quantity === ledger`. Marked `it.fails`; today concurrent edits read a stale `item.delta` at transaction start and corrupt `product.quantity` (observed 126 vs ledger 90; verified 0/20 rounds satisfy the desired behavior).## `it.fails` list (41 total — desired behavior encoded, not yet implemented)

Each `it.fails` encodes the DESIRED behavior and is green because it currently fails. Flip it to a passing `it` when the finding is fixed.

### C1 — missing role gates (19, `tests/authz.test.ts`; worker should get 403)
`POST /api/products`, `DELETE /api/products/:id`, `GET /api/workers`, `DELETE /api/workers/:id`, `PATCH /api/workers/:id`, `POST /api/suppliers`, `DELETE /api/suppliers/:id`, `PATCH /api/products/:id`, `PATCH /api/suppliers/:id`, `POST /api/locations`, `DELETE /api/locations/:id`, `PATCH /api/locations/:id`, `GET /api/transactions`, `GET /api/transactions/recent`, `POST /api/tools`, `PATCH /api/tools/:id`, `DELETE /api/tools/:id`, `POST /api/workers/:workerId/assignTool/:toolId`, `POST /api/workers/:workerId/unassignTool/:toolId`.
(`POST /api/workers` is already admin-gated and asserted as a normal passing 403 test.)

### M5 — reports/export have no role gate (9, `tests/authz.test.ts`; worker should get 403)
`GET /api/reports/inventory`, `/transactions`, `/top-products`, `/low-stock`, `/worker-performance`, `/consumption-forecast`, `/destination-stats`, `/supplier-stats`, `/export`.

### H3 — transactions/items editable by any user (4, `tests/authz.test.ts`; worker should get 403)
`PATCH /api/transactions/:id`, `POST /api/transactions/:id/items`, `DELETE /api/transactions/:id/items/:itemId`, `PATCH /api/transactions/:id/items/:itemId`.

### H6 — tool assignment race (1, `tests/concurrency.test.ts`)
Two-then-ten parallel assigns for the last tool; `availableQuantity` must stay >= 0 (today it goes negative).

### Item-delta edit race (1, `tests/concurrency.test.ts`)
Concurrent item-delta edits must keep `product.quantity === ledger` (today they diverge — stock-integrity race, related to H3/H6).

### H2 — login rate limiting (1, `tests/security.test.ts`)
Repeated failed logins must be throttled (429); today always 401.

### M8 — hardcoded superuser bypass (1, `tests/security.test.ts`)
A user named `axelerator` with role `worker` must not pass `authorizeRole(['admin'])`; today the username hardcode lets it through.

### C2 — missing JWT_SECRET (1, `tests/security.test.ts`)
A token forged with the old hardcoded fallback secret (`your-super-secret-key-that-is-long`) must be rejected; today `verifyToken` accepts it.

### M7 — CORS wildcard (1, `tests/security.test.ts`)
Cross-origin requests must not be answered with `Access-Control-Allow-Origin: *`; today they are.

### Error-handling — adjust on a missing product (1, `tests/validation.test.ts`)
`POST /api/products/:id/adjust` on a nonexistent product should return 404; today 500 (FK violation, because the transaction item is created before the product is validated).

### C3 — stored XSS (2, `tests/xss.test.ts`)
`transactions.html` note/product/supplier/destination/worker names and `index.html` recent-transactions product/supplier names must render the payload as **text, not an element**; today they are unescaped `innerHTML` interpolation.
## Coverage (`npm run test:coverage`)

v8 provider, threshold `lines >= 85`. Latest run: **All files 86.02% lines** (216 tests, 8 files).

| File | Lines % | Uncovered and why |
|---|---|---|
| `src/app.ts` | 84.84% | Remaining gaps are error-handling `catch` blocks (the 5xx paths for every route), `authorizePermission`/`authorizeRole` edge branches (`axelerator` bypass, worker permission-deny, `dbUser` not found), phone-normalization variants, and a few `from`/`to`-dependent guards — only reachable via invalid tokens, induced DB errors, or alternate phone formats. |
| `src/reports.ts` | 90.88% | The `from`/`to` date-filter branches in every report function and the export date filter (exercised only when `?from`/`?to` are passed), plus the legacy single-item fallback (lines 151-153, dead for current data). |
| `src/auth.ts` | 90.9% | `verifyToken` catch (lines 25-26) — only hit by an invalid/expired token. |
| `src/dateUtils.ts` | 75% | `formatDate` (23-29) — exported but **unused in `src/`** (dead code). |
| `src/prisma.ts` | 83.33% | Line 7 — the `WK_PRISMA_QUERY_LOG=1` query-event branch, taken only during the perf run. |
| `src/server.ts` | excluded | Process entry (`dotenv` + `app.listen`); tests import `src/app.ts`, not the entry. |

## Performance baseline (`npm run test:perf` -> `docs/perf-baseline.md`)

Fixture: 2000 products, 50,000 transactions, 150,000 items. Latest measurements (query count from Prisma `query` events, wall time around the supertest request; **no thresholds**):

| Endpoint | Queries | Wall time |
|---|---|---|
| GET /api/reports/transactions | 7 | ~8,431 ms |
| GET /api/reports/export?type=transactions&format=csv | 7 | ~11,486 ms |
| GET /api/reports/inventory | 6 | ~3,005 ms |
| GET /api/reports/worker-performance | 32 | ~171 ms |
| GET /api/reports/destination-stats | 31 | ~144 ms |
| GET /api/reports/supplier-stats | 31 | ~120 ms |
| GET /api/transactions(?limit=200) | 7 | ~46-72 ms |

The 31–32 queries on the N+1 stats reports and the multi-second full-table scans on transactions/inventory/export match the audit's H4/H5/M4 findings.

## Worker UI -> API map (`docs/worker-ui-api-map.md`)

Per-page API calls vs the authz matrix. Key conflict: `frontend/auth.js:22-27` logs the user out on **any** 401/403, so enforcing worker->403 on `GET /api/transactions/recent` and `GET /api/workers` (both called by the dashboard `index.html`) would log every worker out of the dashboard. See that doc for the full per-page table.

## Report: raw SQL and TypeScript errors

### Raw SQL (`$queryRaw` / `$queryRawUnsafe` / `Prisma.sql` / `Prisma.raw`)

- `$queryRawUnsafe`: **none**. `Prisma.raw`: **none**.
- `$queryRaw` (17 call sites, all in `src/app.ts`): every one is a tagged template with bound parameters, or `Prisma.sql`/`Prisma.join` building a parameterized `IN` list (`src/app.ts:272-273`).
- `LIKE` search inputs are bound parameters with `%` escaped (`src/app.ts:222, 876, 894-897, 1008-1011`); `_` is not escaped (LIKE-wildcard only, not SQL injection).
- **Conclusion: no user input reaches any raw query unparameterized.**

### `tsc --noEmit`

Current: **0 errors** (`tsc --noEmit --skipLibCheck` exits 0).
The 8 errors reported in Batch 0 were all caused by an incompletely generated Prisma client (the interrupted `npm install` left `@prisma/client` uninitialized). After a clean `prisma generate` they are gone. All 8 were types-only (no runtime bug): `Prisma.sql`/`Prisma.join` namespace typing (3), `transactionIds` possibly-undefined strict-null (1), and `reports.ts` arithmetic over loosely-typed `_sum`/`Map.get` results (4).

## Known gaps

- `DELETE /api/transactions/:id` does not exist (only `…/items/:itemId`); `tests/stock.test.ts` asserts the 404. Deleting all items leaves an empty transaction row.
- `npm audit` reports 24 vulnerabilities in the existing dependency tree (not addressed in this batch).
