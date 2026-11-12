# Perf baseline — report endpoints

Generated: 2026-11-12T02:06:37.058Z

Fixture: 2000 products, 50,000 transactions, 150,000 transaction items (see tests/perf/seed.ts).

**No thresholds** — informational only. Query count comes from Prisma `query` events (`WK_PRISMA_QUERY_LOG=1`, `src/prisma.ts`); wall time is measured around the supertest request. Run with `npm run test:perf`.

| Endpoint | Queries | Wall time (ms) | Status |
|---|---|---|---|
| GET /api/transactions?limit=200 | 7 | 72 | 200 |
| GET /api/transactions | 7 | 46 | 200 |
| GET /api/reports/inventory | 6 | 3005 | 200 |
| GET /api/reports/transactions | 7 | 8431 | 200 |
| GET /api/reports/top-products | 1 | 40 | 200 |
| GET /api/reports/low-stock | 1 | 8 | 200 |
| GET /api/reports/worker-performance | 32 | 171 | 200 |
| GET /api/reports/consumption-forecast | 2 | 51 | 200 |
| GET /api/reports/destination-stats | 31 | 144 | 200 |
| GET /api/reports/supplier-stats | 31 | 120 | 200 |
| GET /api/reports/export?type=transactions&format=csv | 7 | 11486 | 200 |
