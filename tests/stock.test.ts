import { describe, it, expect, beforeEach } from 'vitest'
import {
  api,
  createProduct,
  createTool,
  createWorkerEntity,
  resetDb,
  seedRoles,
  type Roles,
} from './helpers'
import { prisma } from '../src/prisma'

let roles: Roles
beforeEach(async () => {
  await resetDb()
  roles = await seedRoles()
})

const auth = (t?: string) => (t ? { Authorization: `Bearer ${t}` } : {})

async function ledger(productId: number): Promise<number> {
  const agg = await prisma.transactionItem.aggregate({ where: { productId }, _sum: { delta: true } })
  return Number(agg._sum.delta ?? 0)
}

describe('stock math', () => {
  it('adjust in/out keeps product.quantity equal to the ledger', async () => {
    const p = await createProduct()
    const in1 = await api().post(`/api/products/${p.id}/adjust`).set(auth(roles.adminToken)).send({ type: 'in', delta: 10 })
    expect(in1.status).toBe(200)
    const out1 = await api().post(`/api/products/${p.id}/adjust`).set(auth(roles.adminToken)).send({ type: 'out', delta: 4 })
    expect(out1.status).toBe(200)

    const product = await prisma.product.findUnique({ where: { id: p.id } })
    expect(product!.quantity).toBe(6)
    expect(await ledger(p.id)).toBe(6)
  })

  it('out beyond available stock is rejected (400) and does not change balance', async () => {
    const p = await createProduct()
    await api().post(`/api/products/${p.id}/adjust`).set(auth(roles.adminToken)).send({ type: 'in', delta: 2 })
    const res = await api().post(`/api/products/${p.id}/adjust`).set(auth(roles.adminToken)).send({ type: 'out', delta: 5 })
    // Current behavior: 400 { error: 'not enough stock' }.
    expect(res.status).toBe(400)
    const product = await prisma.product.findUnique({ where: { id: p.id } })
    expect(product!.quantity).toBe(2)
    expect(await ledger(p.id)).toBe(2)
  })

  it('bulk-adjust updates each product and matches the ledger', async () => {
    const p1 = await createProduct()
    const p2 = await createProduct()
    const res = await api().post('/api/transactions/bulk-adjust').set(auth(roles.adminToken)).send({
      type: 'in',
      items: [{ productId: p1.id, delta: 10 }, { productId: p2.id, delta: 20 }],
    })
    expect(res.status).toBe(200)
    expect((await prisma.product.findUnique({ where: { id: p1.id } }))!.quantity).toBe(10)
    expect((await prisma.product.findUnique({ where: { id: p2.id } }))!.quantity).toBe(20)
    expect(await ledger(p1.id)).toBe(10)
    expect(await ledger(p2.id)).toBe(20)
  })

  it('multi-item transaction adjusts each product and matches the ledger', async () => {
    const p1 = await createProduct()
    const p2 = await createProduct()
    await api().post(`/api/products/${p1.id}/adjust`).set(auth(roles.adminToken)).send({ type: 'in', delta: 10 })
    await api().post(`/api/products/${p2.id}/adjust`).set(auth(roles.adminToken)).send({ type: 'in', delta: 20 })

    const res = await api().post('/api/transactions').set(auth(roles.adminToken)).send({
      type: 'out',
      items: [{ productId: p1.id, delta: 3 }, { productId: p2.id, delta: 4 }],
    })
    expect(res.status).toBe(200)
    expect((await prisma.product.findUnique({ where: { id: p1.id } }))!.quantity).toBe(7)
    expect((await prisma.product.findUnique({ where: { id: p2.id } }))!.quantity).toBe(16)
    expect(await ledger(p1.id)).toBe(7)
    expect(await ledger(p2.id)).toBe(16)
  })

  it('editing an item delta re-applies the difference to the balance', async () => {
    const p = await createProduct()
    await api().post(`/api/products/${p.id}/adjust`).set(auth(roles.adminToken)).send({ type: 'in', delta: 10 })

    const created = await api().post('/api/transactions').set(auth(roles.adminToken)).send({
      type: 'out',
      items: [{ productId: p.id, delta: 3 }],
    })
    expect(created.status).toBe(200)
    const txId = created.body.transaction.id
    const itemId = created.body.items[0].id
    expect((await prisma.product.findUnique({ where: { id: p.id } }))!.quantity).toBe(7)

    const patched = await api().patch(`/api/transactions/${txId}/items/${itemId}`).set(auth(roles.adminToken)).send({ delta: 5 })
    expect(patched.status).toBe(200)
    expect((await prisma.product.findUnique({ where: { id: p.id } }))!.quantity).toBe(5)
    expect(await ledger(p.id)).toBe(5)
  })

  it('deleting an item reverses its effect on the balance', async () => {
    const p = await createProduct()
    await api().post(`/api/products/${p.id}/adjust`).set(auth(roles.adminToken)).send({ type: 'in', delta: 10 })

    const created = await api().post('/api/transactions').set(auth(roles.adminToken)).send({
      type: 'out',
      items: [{ productId: p.id, delta: 3 }],
    })
    const txId = created.body.transaction.id
    const itemId = created.body.items[0].id
    expect((await prisma.product.findUnique({ where: { id: p.id } }))!.quantity).toBe(7)

    const del = await api().delete(`/api/transactions/${txId}/items/${itemId}`).set(auth(roles.adminToken))
    expect(del.status).toBe(200)
    expect((await prisma.product.findUnique({ where: { id: p.id } }))!.quantity).toBe(10)
    expect(await ledger(p.id)).toBe(10)
  })

  it('DELETE /api/transactions/:id does not exist (404) — whole-transaction delete is a gap', async () => {
    const res = await api().delete('/api/transactions/1').set(auth(roles.adminToken))
    expect(res.status).toBe(404)
  })
})