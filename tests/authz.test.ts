import { describe, it, expect, beforeEach } from 'vitest'
import {
  api,
  createProduct,
  createSupplier,
  createLocation,
  createTool,
  createWorkerEntity,
  resetDb,
  seedRoles,
  type Roles,
} from './helpers'
import { prisma } from '../src/prisma'
import { hashPassword } from '../src/auth'

let roles: Roles
let ids: { product: number; worker: number; supplier: number; location: number; tool: number; tx: number; item: number } = { product: 0, worker: 0, supplier: 0, location: 0, tool: 0, tx: 0, item: 0 }

beforeEach(async () => {
  await resetDb()
  roles = await seedRoles()
  const p = await createProduct({ quantity: 10 })
  const w = await createWorkerEntity()
  const s = await createSupplier()
  const l = await createLocation()
  const t = await createTool({ totalQuantity: 1 })
  const tx = await prisma.transaction.create({ data: { type: 'in' } })
  const it = await prisma.transactionItem.create({ data: { transactionId: tx.id, productId: p.id, productName: p.name, delta: 2 } })
  ids = { product: p.id, worker: w.id, supplier: s.id, location: l.id, tool: t.id, tx: tx.id, item: it.id }
})

const auth = (t?: string) => (t ? { Authorization: `Bearer ${t}` } : {})

type Spec = {
  method: 'get' | 'post' | 'patch' | 'delete'
  path: () => string
  body?: () => unknown
  workerAllowed: boolean
  findingId?: string // present => worker should be 403 but currently is not (marked it.fails)
}

const specs: Spec[] = [
  // worker-allowed
  { method: 'get', path: () => '/api/me', workerAllowed: true },
  { method: 'get', path: () => '/api/stats', workerAllowed: true },
  { method: 'get', path: () => '/api/products', workerAllowed: true },
  { method: 'get', path: () => '/api/suppliers', workerAllowed: true },
  { method: 'get', path: () => '/api/locations', workerAllowed: true },
  { method: 'get', path: () => '/api/search?q=a', workerAllowed: true },
  { method: 'get', path: () => '/api/tools', workerAllowed: true },
  { method: 'post', path: () => `/api/products/${ids.product}/adjust`, body: () => ({ type: 'in', delta: 1 }), workerAllowed: true },
  { method: 'post', path: () => '/api/transactions', body: () => ({ type: 'in', items: [{ productId: ids.product, delta: 1 }] }), workerAllowed: true },
  { method: 'post', path: () => '/api/transactions/bulk-adjust', body: () => ({ type: 'in', items: [{ productId: ids.product, delta: 1 }] }), workerAllowed: true },

  // admin-only, currently unenforced (it.fails)
  { method: 'post', path: () => '/api/products', body: () => ({ name: 'newprod', unit: 'шт', quantity: 0 }), workerAllowed: false, findingId: 'C1' },
  { method: 'delete', path: () => `/api/products/${ids.product}`, workerAllowed: false, findingId: 'C1' },
  { method: 'get', path: () => '/api/workers', workerAllowed: false, findingId: 'C1' },
  { method: 'delete', path: () => `/api/workers/${ids.worker}`, workerAllowed: false, findingId: 'C1' },
  { method: 'patch', path: () => `/api/workers/${ids.worker}`, body: () => ({ fullName: 'updated' }), workerAllowed: false, findingId: 'C1' },
  { method: 'post', path: () => '/api/suppliers', body: () => ({ name: 'newsup', phone: '+7-900-000-0001' }), workerAllowed: false, findingId: 'C1' },
  { method: 'delete', path: () => `/api/suppliers/${ids.supplier}`, workerAllowed: false, findingId: 'C1' },
  { method: 'patch', path: () => `/api/products/${ids.product}`, body: () => ({ unit: 'kg' }), workerAllowed: false, findingId: 'C1' },
  { method: 'patch', path: () => `/api/suppliers/${ids.supplier}`, body: () => ({ phone: '+7-900-000-0001' }), workerAllowed: false, findingId: 'C1' },
  { method: 'post', path: () => '/api/locations', body: () => ({ name: 'newloc' }), workerAllowed: false, findingId: 'C1' },
  { method: 'delete', path: () => `/api/locations/${ids.location}`, workerAllowed: false, findingId: 'C1' },
  { method: 'patch', path: () => `/api/locations/${ids.location}`, body: () => ({ city: 'Moscow' }), workerAllowed: false, findingId: 'C1' },
  { method: 'get', path: () => '/api/transactions', workerAllowed: false, findingId: 'C1' },
  { method: 'get', path: () => '/api/transactions/recent', workerAllowed: false, findingId: 'C1' },
  { method: 'patch', path: () => `/api/transactions/${ids.tx}`, body: () => ({ note: 'x' }), workerAllowed: false, findingId: 'H3' },
  { method: 'get', path: () => '/api/reports/inventory', workerAllowed: false, findingId: 'M5' },
  { method: 'get', path: () => '/api/reports/transactions', workerAllowed: false, findingId: 'M5' },
  { method: 'get', path: () => '/api/reports/top-products', workerAllowed: false, findingId: 'M5' },
  { method: 'get', path: () => '/api/reports/low-stock', workerAllowed: false, findingId: 'M5' },
  { method: 'get', path: () => '/api/reports/worker-performance', workerAllowed: false, findingId: 'M5' },
  { method: 'get', path: () => '/api/reports/consumption-forecast', workerAllowed: false, findingId: 'M5' },
  { method: 'get', path: () => '/api/reports/destination-stats', workerAllowed: false, findingId: 'M5' },
  { method: 'get', path: () => '/api/reports/supplier-stats', workerAllowed: false, findingId: 'M5' },
  { method: 'get', path: () => '/api/reports/export?type=inventory&format=csv', workerAllowed: false, findingId: 'M5' },
  { method: 'post', path: () => '/api/tools', body: () => ({ name: 'newtool' }), workerAllowed: false, findingId: 'C1' },
  { method: 'patch', path: () => `/api/tools/${ids.tool}`, body: () => ({ name: 'renamed' }), workerAllowed: false, findingId: 'C1' },
  { method: 'delete', path: () => `/api/tools/${ids.tool}`, workerAllowed: false, findingId: 'C1' },
  { method: 'post', path: () => `/api/workers/${ids.worker}/assignTool/${ids.tool}`, body: () => ({ quantity: 1 }), workerAllowed: false, findingId: 'C1' },
  { method: 'post', path: () => `/api/workers/${ids.worker}/unassignTool/${ids.tool}`, body: () => ({ quantity: 1 }), workerAllowed: false, findingId: 'C1' },
  { method: 'post', path: () => `/api/transactions/${ids.tx}/items`, body: () => ({ productId: ids.product, delta: 1 }), workerAllowed: false, findingId: 'H3' },
  { method: 'delete', path: () => `/api/transactions/${ids.tx}/items/${ids.item}`, workerAllowed: false, findingId: 'H3' },
  { method: 'patch', path: () => `/api/transactions/${ids.tx}/items/${ids.item}`, body: () => ({ delta: 3 }), workerAllowed: false, findingId: 'H3' },

  // admin-only, already enforced today (worker -> 403), so a normal passing test
  { method: 'post', path: () => '/api/workers', body: () => ({ fullName: 'newworker' }), workerAllowed: false },
]

describe('authorization matrix', () => {
  for (const s of specs) {
    const label = `${s.method.toUpperCase()} ${s.path()}`

    it(`${label} — no token → 401`, async () => {
      const r = await (api() as any)[s.method](s.path()).send(s.body?.() ?? {})
      expect(r.status).toBe(401)
    })

    if (s.workerAllowed) {
      it(`${label} — worker → allowed`, async () => {
        const r = await (api() as any)[s.method](s.path()).set(auth(roles.workerToken)).send(s.body?.() ?? {})
        expect(r.status).not.toBe(401)
        expect(r.status).not.toBe(403)
      })
    } else if (s.findingId) {
      it.fails(`${label} — worker → 403 (${s.findingId})`, async () => {
        const r = await (api() as any)[s.method](s.path()).set(auth(roles.workerToken)).send(s.body?.() ?? {})
        expect(r.status).toBe(403)
      })
    } else {
      it(`${label} — worker → 403 (already enforced)`, async () => {
        const r = await (api() as any)[s.method](s.path()).set(auth(roles.workerToken)).send(s.body?.() ?? {})
        expect(r.status).toBe(403)
      })
    }

    it(`${label} — admin → allowed`, async () => {
      const r = await (api() as any)[s.method](s.path()).set(auth(roles.adminToken)).send(s.body?.() ?? {})
      expect(r.status).not.toBe(401)
      expect(r.status).not.toBe(403)
    })
  }

  it('POST /api/login — public, returns a token for valid credentials', async () => {
    const hash = await hashPassword('secret')
    await prisma.user.create({ data: { username: 'loginuser', passwordHash: hash, role: 'worker' } })
    const r = await api().post('/api/login').send({ username: 'loginuser', password: 'secret' })
    expect(r.status).toBe(200)
    expect(r.body.token).toBeTruthy()
  })
})