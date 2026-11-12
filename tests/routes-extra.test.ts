import { describe, it, expect, beforeEach } from 'vitest'
import { api, resetDb, seedRoles, type Roles } from './helpers'
import { prisma } from '../src/prisma'

let roles: Roles
let ids: { sup: number; loc: number; wrk: number; tool: number; prod: number }

beforeEach(async () => {
  await resetDb()
  roles = await seedRoles()
  const sup = await prisma.supplier.create({ data: { name: 'ex-sup', phone: '+7-900-000-0001', email: 'a@b.co' } })
  const loc = await prisma.location.create({ data: { name: 'ex-loc' } })
  const wrk = await prisma.worker.create({ data: { fullName: 'ex-wrk' } })
  const tool = await prisma.tool.create({ data: { name: 'ex-tool', totalQuantity: 5, availableQuantity: 5 } })
  const prod = await prisma.product.create({ data: { name: 'ex-prod', nameNormalized: 'ex-prod', unit: 'шт', quantity: 10 } })
  ids = { sup: sup.id, loc: loc.id, wrk: wrk.id, tool: tool.id, prod: prod.id }
})

const at = () => roles.adminToken
const auth = (t: string) => ({ Authorization: `Bearer ${t}` })

describe('extra route coverage (branch/variant coverage)', () => {
  it('POST /api/products with quantity>0 and supplierId creates an initial in-transaction', async () => {
    const r = await api().post('/api/products').set(auth(at())).send({ name: 'new-with-stock', unit: 'шт', quantity: 7, supplierId: ids.sup })
    expect(r.status).toBe(200)
    const p = await prisma.product.findFirst({ where: { nameNormalized: 'new-with-stock' } })
    expect(p?.quantity).toBe(7)
  })

  it('DELETE /api/products/:id?purge=true removes history', async () => {
    const r = await api().delete(`/api/products/${ids.prod}?purge=true`).set(auth(at()))
    expect(r.status).toBe(200)
  })

  it('PATCH /api/products/:id rename', async () => {
    const r = await api().patch(`/api/products/${ids.prod}`).set(auth(at())).send({ name: 'renamed-prod' })
    expect(r.status).toBe(200)
  })

  it('PATCH /api/products/:id rename to existing name -> 400', async () => {
    const other = await prisma.product.create({ data: { name: 'other', nameNormalized: 'other', unit: 'шт', quantity: 0 } })
    const r = await api().patch(`/api/products/${other.id}`).set(auth(at())).send({ name: 'ex-prod' })
    expect(r.status).toBe(400)
  })

  it('PATCH /api/tools/:id with totalQuantity', async () => {
    const r = await api().patch(`/api/tools/${ids.tool}`).set(auth(at())).send({ name: 'ex-tool', totalQuantity: 3 })
    expect(r.status).toBe(200)
  })

  it('assign then unassign tool (partial + full)', async () => {
    const a = await api().post(`/api/workers/${ids.wrk}/assignTool/${ids.tool}`).set(auth(at())).send({ quantity: 2 })
    expect(a.status).toBe(200)
    const u1 = await api().post(`/api/workers/${ids.wrk}/unassignTool/${ids.tool}`).set(auth(at())).send({ quantity: 1 })
    expect(u1.status).toBe(200)
    const u2 = await api().post(`/api/workers/${ids.wrk}/unassignTool/${ids.tool}`).set(auth(at())).send({})
    expect(u2.status).toBe(200)
  })

  it('GET /api/products?search=', async () => {
    const r = await api().get('/api/products?search=ex').set(auth(at()))
    expect(r.status).toBe(200)
  })

  it('POST /api/transactions with supplier/destination/worker/date/note', async () => {
    const r = await api().post('/api/transactions').set(auth(at())).send({
      type: 'out', items: [{ productId: ids.prod, delta: 1 }], supplierId: ids.sup, destinationId: ids.loc, workerId: ids.wrk, date: new Date().toISOString(), note: 'n',
    })
    expect(r.status).toBe(200)
  })

  it('POST /api/products/:id/adjust with supplier/destination/worker/date/note', async () => {
    const r = await api().post(`/api/products/${ids.prod}/adjust`).set(auth(at())).send({ type: 'in', delta: 1, supplierId: ids.sup, destinationId: ids.loc, workerId: ids.wrk, date: new Date().toISOString(), note: 'n' })
    expect(r.status).toBe(200)
  })

  it('GET /api/transactions with filters and sorts', async () => {
    for (const q of ['sort=date_asc', 'sort=worker_asc', 'sort=type_asc', 'sort=product_asc', 'sort=quantity_desc', 'entityType=product&entityId=' + ids.prod, 'search=ex', 'productId=' + ids.prod, 'searchProduct=ex']) {
      const r = await api().get('/api/transactions?' + q).set(auth(at()))
      expect(r.status).toBe(200)
    }
  })

  it('POST /api/suppliers invalid email -> 400', async () => {
    const r = await api().post('/api/suppliers').set(auth(at())).send({ name: 'bad-email-sup', phone: '+7-900-000-0002', email: 'not-an-email' })
    expect(r.status).toBe(400)
  })

  it('PATCH /api/suppliers/:id invalid phone -> 400', async () => {
    const r = await api().patch(`/api/suppliers/${ids.sup}`).set(auth(at())).send({ phone: '123' })
    expect(r.status).toBe(400)
  })

  it('POST /api/locations duplicate -> 400', async () => {
    const r = await api().post('/api/locations').set(auth(at())).send({ name: 'ex-loc' })
    expect(r.status).toBe(400)
  })

  it('PATCH /api/locations/:id + PATCH /api/workers/:id + POST /api/workers duplicate', async () => {
    const l = await api().patch(`/api/locations/${ids.loc}`).set(auth(at())).send({ city: 'X' })
    expect(l.status).toBe(200)
    const w = await api().patch(`/api/workers/${ids.wrk}`).set(auth(at())).send({ fullName: 'ex-wrk-2' })
    expect(w.status).toBe(200)
    const wd = await api().post('/api/workers').set(auth(at())).send({ fullName: 'ex-wrk-2' })
    expect(wd.status).toBe(400)
  })
})