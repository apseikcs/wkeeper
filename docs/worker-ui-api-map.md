# Worker UI → API map

Per-page list of every API call the frontend makes, whether `role=worker` can reach it under the current `authz.test.ts` matrix, and where that matrix would **break a screen a worker actually sees**.

Key frontend fact: `frontend/auth.js:22-27` — the `authFetch` wrapper treats **401 *and* 403** as "unauthorized": it clears the token and redirects to `/login.html`. So a single 403 on a page a worker loads logs the worker out. The dashboard hides some controls with CSS (`isWorker` in `index.html`) but the API calls still run.

Matrix (from `tests/authz.test.ts`) — worker allowed: `POST /api/login`, `GET /api/me`, `GET /api/stats`, `GET /api/products`, `GET /api/suppliers`, `GET /api/locations`, `GET /api/search`, `GET /api/tools`, `POST /api/transactions`, `POST /api/transactions/bulk-adjust`, `POST /api/products/:id/adjust`. Everything else is admin-only (worker → 403).

## index.html — dashboard (WORKER-VISIBLE; this is the worker's main screen)

| API call | Method | Used on load? | Worker reachable (matrix)? |
|---|---|---|---|
| `/api/stats` | GET | yes (`loadStats`) | allowed |
| `/api/transactions/recent` | GET | **yes (`loadStats`)** | **403 → logout + redirect** |
| `/api/products` | GET | yes | allowed |
| `/api/suppliers` | GET | yes | allowed |
| `/api/locations` | GET | yes | allowed |
| `/api/workers` | GET | on adjust/bulk modal open | **403 → logout + redirect** |
| `/api/products/:id/adjust` | POST | on +Приход / -Расход | allowed |
| `/api/transactions/bulk-adjust` | POST | on bulk dialog (button visible to workers) | allowed |
| `/api/products/:id` | PATCH | inline edit cell (hidden for workers) | 403 (hidden, so no screen break) |
| `/api/products` | POST | create product (button hidden for workers) | 403 (hidden) |
| `/api/products/:id?purge=` | DELETE | delete product (button hidden for workers) | 403 (hidden) |
| `/api/suppliers` | POST | create supplier (hidden for workers) | 403 (hidden) |
| `/api/locations` | POST | create location (hidden for workers) | 403 (hidden) |

## transactions.html — transactions list (nav hidden for workers, but the page is loadable)

| API call | Method | Worker reachable? |
|---|---|---|
| `/api/transactions` | GET | **403 → logout** |
| `/api/search` | GET | allowed |
| `/api/transactions/:id` | PATCH (note) | **403 → logout** (H3) |

## workers.html — worker management (admin page; nav hidden for workers)

| API call | Method | Worker reachable? |
|---|---|---|
| `/api/workers` | GET | **403** |
| `/api/tools` | GET | allowed |
| `/api/workers/:workerId/assignTool/:toolId` | POST | **403** |
| `/api/workers/:workerId/unassignTool/:toolId` | POST | **403** |
| `/api/workers/:id` | DELETE | **403** |
| `/api/workers/:id` | PATCH | **403** |
| `/api/workers` | POST | 403 (already enforced) |

## tools.html — tools (admin page)

| API call | Method | Worker reachable? |
|---|---|---|
| `/api/tools` | GET | allowed |
| `/api/workers` | GET | **403** |
| `/api/workers/:workerId/assignTool/:toolId` | POST | **403** |
| `/api/tools` | POST | **403** |
| `/api/tools/:id` | PATCH | **403** |
| `/api/tools/:id` | DELETE | **403** |

## suppliers.html — suppliers (admin page)

| API call | Method | Worker reachable? |
|---|---|---|
| `/api/suppliers` | GET | allowed |
| `/api/suppliers` | POST | **403** |
| `/api/suppliers/:id` | PATCH | **403** |
| `/api/suppliers/:id` | DELETE | **403** |

## destinations.html — locations (admin page)

| API call | Method | Worker reachable? |
|---|---|---|
| `/api/locations` | GET | allowed |
| `/api/locations` | POST | **403** |
| `/api/locations/:id` | PATCH | **403** |
| `/api/locations/:id` | DELETE | **403** |

## reports.html — reports (admin page)

| API call | Method | Worker reachable? |
|---|---|---|
| `/api/reports/inventory` | GET | **403** (M5) |
| `/api/reports/transactions` | GET | **403** (M5) |
| `/api/reports/top-products` | GET | **403** (M5) |
| `/api/reports/low-stock` | GET | **403** (M5) |
| `/api/reports/worker-performance` | GET | **403** (M5) |
| `/api/reports/consumption-forecast` | GET | **403** (M5) |
| `/api/reports/destination-stats` | GET | **403** (M5) |
| `/api/reports/supplier-stats` | GET | **403** (M5) |
| `/api/reports/export` | GET | **403** (M5) |

## login.html — public

| API call | Method | Worker reachable? |
|---|---|---|
| `/api/login` | POST | public |

## Routes where the current matrix (worker → 403) breaks a worker-visible screen

These are the conflict points. Both are on the **dashboard**, the one screen a worker is expected to use:

1. **`GET /api/transactions/recent`** — `index.html` `loadStats()` calls it on every dashboard load. Matrix says admin-only → 403 → `authFetch` logs the worker out and redirects to `/login.html`. **The worker dashboard is unusable as soon as the matrix is enforced.**
2. **`GET /api/workers`** — `index.html` calls it when opening the +Приход / -Расход modals (to pick the worker for an `out`) and the bulk dialog. Matrix says admin-only → 403 → logout. **Breaks the worker's adjust flow even if (1) is fixed.**

Indirect: `transactions.html` (`GET /api/transactions`) and all admin pages (`/api/workers`, `/api/tools`, `/api/suppliers`, `/api/locations`, `/api/reports/*`) also 403 for workers, but those pages are hidden from the worker nav, so enforcement there does not break a screen the worker is expected to open — it only matters if a worker navigates to the URL directly.

**Implication for the authz batch:** the matrix cannot be enforced as-is without either (a) allowing workers `GET /api/transactions/recent` and `GET /api/workers`, or (b) making `authFetch` stop treating 403 as logout (it should only log out on 401 and show an inline "forbidden" state on 403). Otherwise the fix for C1/M5 logs every worker out of the dashboard.