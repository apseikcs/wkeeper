import { describe, it, expect, beforeEach } from 'vitest'
import {
  api,
  createLocation,
  createProduct,
  createSupplier,
  createTool,
  createWorkerEntity,
  resetDb,
  seedRoles,
  type Roles,
} from './helpers'

let roles: Roles
let ids: { product: number; worker: number; supplier: number; location: number; tool: number }

beforeEach(async () => {
  await resetDb()
  roles = await seedRoles()
  const p = await createProduct()
  const w = await createWorkerEntity()
  const s = await createSupplier()
  const l = await createLocation()
  const t = await createTool()
  ids = { product: p.id, worker: w.id, supplier: s.id, location: l.id, tool: t.id }
})

const at = () => roles.adminToken
const auth = (t: string) => ({ Authorization: `Bearer ${t}` })
let n = 0
const uniq = (p: string) => `${p}-${Date.now()}-${n++}`

type Case = { name: string; method: 'post' | 'patch' | 'delete'; path: () => string; body?: () => any; statuses: number[] }

const cases: Case[] = [
  { name: 'products: missing name', method: 'post', path: () => '/api/products', body: () => ({ unit: 'шт', quantity: 1 }), statuses: [400] },
  { name: 'products: negative quantity', method: 'post', path: () => '/api/products', body: () => ({ name: uniq('neg'), unit: 'шт', quantity: -5 }), statuses: [400] },
  { name: 'products: huge quantity', method: 'post', path: () => '/api/products', body: () => ({ name: uniq('huge'), unit: 'шт', quantity: 999999 }), statuses: [400] },
  { name: 'products: NaN quantity (string)', method: 'post', path: () => '/api/products', body: () => ({ name: uniq('nan'), unit: 'шт', quantity: 'abc' }), statuses: [400] },
  { name: 'adjust: missing type', method: 'post', path: () => `/api/products/${ids.product}/adjust`, body: () => ({ delta: 1 }), statuses: [400] },
  { name: 'adjust: invalid type', method: 'post', path: () => `/api/products/${ids.product}/adjust`, body: () => ({ type: 'sideways', delta: 1 }), statuses: [400] },
  { name: 'adjust: negative delta', method: 'post', path: () => `/api/products/${ids.product}/adjust`, body: () => ({ type: 'in', delta: -1 }), statuses: [400] },
  { name: 'adjust: NaN delta', method: 'post', path: () => `/api/products/${ids.product}/adjust`, body: () => ({ type: 'in', delta: 'abc' }), statuses: [400] },
  { name: 'adjust: missing delta', method: 'post', path: () => `/api/products/${ids.product}/adjust`, body: () => ({ type: 'in' }), statuses: [400] },
  { name: 'transactions: missing items', method: 'post', path: () => '/api/transactions', body: () => ({ type: 'in' }), statuses: [400] },
  { name: 'transactions: empty items', method: 'post', path: () => '/api/transactions', body: () => ({ type: 'in', items: [] }), statuses: [400] },
  { name: 'transactions: invalid type', method: 'post', path: () => '/api/transactions', body: () => ({ type: 'x', items: [{ productId: ids.product, delta: 1 }] }), statuses: [400] },
  { name: 'transactions: NaN productId', method: 'post', path: () => '/api/transactions', body: () => ({ type: 'in', items: [{ productId: 'abc', delta: 1 }] }), statuses: [400] },
  { name: 'transactions: negative delta', method: 'post', path: () => '/api/transactions', body: () => ({ type: 'in', items: [{ productId: ids.product, delta: -2 }] }), statuses: [400] },
  { name: 'transactions: nonexistent product', method: 'post', path: () => '/api/transactions', body: () => ({ type: 'in', items: [{ productId: 99999999, delta: 1 }] }), statuses: [404] },
  { name: 'transactions: huge delta exceeds max', method: 'post', path: () => '/api/transactions', body: () => ({ type: 'in', items: [{ productId: ids.product, delta: 999999 }] }), statuses: [400] },
  { name: 'bulk: missing items', method: 'post', path: () => '/api/transactions/bulk-adjust', body: () => ({ type: 'in' }), statuses: [400] },
  { name: 'bulk: negative delta', method: 'post', path: () => '/api/transactions/bulk-adjust', body: () => ({ type: 'in', items: [{ productId: ids.product, delta: -1 }] }), statuses: [400] },
  { name: 'bulk: NaN productId', method: 'post', path: () => '/api/transactions/bulk-adjust', body: () => ({ type: 'in', items: [{ productId: 'x', delta: 1 }] }), statuses: [400] },
  { name: 'suppliers: missing name', method: 'post', path: () => '/api/suppliers', body: () => ({ phone: '+7-900-000-0001' }), statuses: [400] },
  { name: 'suppliers: missing phone+email', method: 'post', path: () => '/api/suppliers', body: () => ({ name: uniq('sup') }), statuses: [400] },
  { name: 'locations: missing name', method: 'post', path: () => '/api/locations', body: () => ({ city: 'x' }), statuses: [400] },
  { name: 'tools: missing name', method: 'post', path: () => '/api/tools', body: () => ({ totalQuantity: 1 }), statuses: [400] },
  { name: 'tools: totalQuantity < 1', method: 'post', path: () => '/api/tools', body: () => ({ name: uniq('tool'), totalQuantity: 0 }), statuses: [400] },
  { name: 'tools PATCH: totalQuantity < 1', method: 'patch', path: () => `/api/tools/${ids.tool}`, body: () => ({ name: 'z', totalQuantity: 0 }), statuses: [400] },
  { name: 'product PATCH: nonexistent', method: 'patch', path: () => '/api/products/99999999', body: () => ({ unit: 'kg' }), statuses: [404] },
  { name: 'product DELETE: nonexistent', method: 'delete', path: () => '/api/products/99999999', statuses: [404] },
  { name: 'supplier PATCH: nonexistent', method: 'patch', path: () => '/api/suppliers/99999999', body: () => ({ phone: '+7-900-000-0001' }), statuses: [404] },
  { name: 'location PATCH: nonexistent', method: 'patch', path: () => '/api/locations/99999999', body: () => ({ city: 'x' }), statuses: [404] },
  { name: 'worker PATCH: nonexistent', method: 'patch', path: () => '/api/workers/99999999', body: () => ({ fullName: 'x' }), statuses: [404] },
  { name: 'worker DELETE: nonexistent', method: 'delete', path: () => '/api/workers/99999999', statuses: [404] },
]

describe('input validation + 404 (malformed input is rejected with 4xx)', () => {
  for (const c of cases) {
    it(c.name, async () => {
      const r = await (api() as any)[c.method](c.path()).set(auth(at())).send(c.body ? c.body() : {})
      expect(c.statuses).toContain(r.status)
    })
  }

  it.fails('adjust on a nonexistent product returns 404 (today: 500 FK violation) (error-handling gap)', async () => {
    const r = await api().post('/api/products/99999999/adjust').set(auth(at())).send({ type: 'in', delta: 1 })
    expect(r.status).toBe(404)
  })
})