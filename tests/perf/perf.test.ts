import { describe, it, beforeAll, afterAll } from 'vitest'
import { writeFileSync } from 'node:fs'
import { api, resetDb, seedRoles, type Roles } from '../helpers'
import { prisma } from '../../src/prisma'
import { seedPerf } from './seed'

let roles: Roles
let queryCount = 0
;(prisma as any).$on('query', () => {
  queryCount++
})

const rows: Array<{ name: string; queries: number; ms: number; status: number }> = []

beforeAll(async () => {
  await resetDb()
  roles = await seedRoles()
  await seedPerf(prisma)
}, 480000)

afterAll(async () => {
  await resetDb()
  writeFileSync('docs/perf-baseline.md', renderMd(rows))
}, 120000)

const at = () => ({ Authorization: `Bearer ${roles.adminToken}` })

async function measure(name: string, make: () => Promise<any>) {
  queryCount = 0
  const t0 = performance.now()
  const r = await make()
  const ms = performance.now() - t0
  await new Promise((res) => setTimeout(res, 40)) // let query events flush
  rows.push({ name, queries: queryCount, ms: Math.round(ms), status: r.status })
}

function renderMd(rs: Array<{ name: string; queries: number; ms: number; status: number }>) {
  const out: string[] = []
  out.push('# Perf baseline — report endpoints')
  out.push('')
  out.push(`Generated: ${new Date().toISOString()}`)
  out.push('')
  out.push('Fixture: 2000 products, 50,000 transactions, 150,000 transaction items (see tests/perf/seed.ts).')
  out.push('')
  out.push('**No thresholds** — informational only. Query count comes from Prisma `query` events (`WK_PRISMA_QUERY_LOG=1`, `src/prisma.ts`); wall time is measured around the supertest request. Run with `npm run test:perf`.')
  out.push('')
  out.push('| Endpoint | Queries | Wall time (ms) | Status |')
  out.push('|---|---|---|---|')
  for (const r of rs) out.push(`| ${r.name} | ${r.queries} | ${r.ms} | ${r.status} |`)
  out.push('')
  return out.join('\n')
}

describe('report endpoint performance baseline (no thresholds)', () => {
  it('GET /api/transactions?limit=200', async () => {
    await measure('GET /api/transactions?limit=200', () => api().get('/api/transactions?limit=200').set(at()))
  })
  it('GET /api/transactions (no limit -> default 200)', async () => {
    await measure('GET /api/transactions', () => api().get('/api/transactions').set(at()))
  })
  it('GET /api/reports/inventory', async () => {
    await measure('GET /api/reports/inventory', () => api().get('/api/reports/inventory').set(at()))
  })
  it('GET /api/reports/transactions', async () => {
    await measure('GET /api/reports/transactions', () => api().get('/api/reports/transactions').set(at()))
  })
  it('GET /api/reports/top-products', async () => {
    await measure('GET /api/reports/top-products', () => api().get('/api/reports/top-products').set(at()))
  })
  it('GET /api/reports/low-stock', async () => {
    await measure('GET /api/reports/low-stock', () => api().get('/api/reports/low-stock').set(at()))
  })
  it('GET /api/reports/worker-performance', async () => {
    await measure('GET /api/reports/worker-performance', () => api().get('/api/reports/worker-performance').set(at()))
  })
  it('GET /api/reports/consumption-forecast', async () => {
    await measure('GET /api/reports/consumption-forecast', () => api().get('/api/reports/consumption-forecast').set(at()))
  })
  it('GET /api/reports/destination-stats', async () => {
    await measure('GET /api/reports/destination-stats', () => api().get('/api/reports/destination-stats').set(at()))
  })
  it('GET /api/reports/supplier-stats', async () => {
    await measure('GET /api/reports/supplier-stats', () => api().get('/api/reports/supplier-stats').set(at()))
  })
  it('GET /api/reports/export?type=transactions&format=csv', async () => {
    await measure('GET /api/reports/export?type=transactions&format=csv', () => api().get('/api/reports/export?type=transactions&format=csv').set(at()))
  })
})