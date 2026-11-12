# Lint report

`eslint.config.mjs` uses the `typescript-eslint` **recommended** preset (flat config) and lints `src/`. Run with `npm run lint` — **no `--fix` was used**; this is a report of the current state, nothing was auto-fixed.

Generated: 2026-11-12T03:43:54.708Z

## Summary

- Files linted: 18
- Files with errors: 12
- Errors: **69**
- Warnings: 0
- Parse/fatal: 0

## Errors by rule

| Rule | Errors |
|---|---|
| `@typescript-eslint/no-explicit-any` | 64 |
| `@typescript-eslint/no-unused-vars` | 5 |

## Errors by file

| File | Errors |
|---|---|
| `src/reports.ts` | 26 |
| `src/routes/transactions.ts` | 16 |
| `src/routes/products.ts` | 6 |
| `src/routes/locations.ts` | 4 |
| `src/routes/reports.ts` | 4 |
| `src/routes/workers.ts` | 4 |
| `src/routes/suppliers.ts` | 3 |
| `src/middleware/permissions.ts` | 2 |
| `src/app.ts` | 1 |
| `src/middleware/auth.ts` | 1 |
| `src/routes/auth.ts` | 1 |
| `src/routes/tools.ts` | 1 |

Notes: the 64 `no-explicit-any` are the `(req as any)` / `: any` casts throughout the handlers and the Prisma `_sum` results; the 5 `no-unused-vars` are unused imports left in files. None are behavior issues; not fixed in this batch (report only).
