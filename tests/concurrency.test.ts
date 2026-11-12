import { describe, it, expect, beforeEach } from 'vitest'
import { api, createProduct, createTool, createWorkerEntity, resetDb, seedRoles, type Roles } from './helpers'
import { prisma } from '../src/prisma'

let roles: Roles
beforeEach(async () => {
  await resetDb()
  roles = await seedRoles()
})

const auth = (t?: string) => (t ? { Authorization: `Bearer ${t}` } : {})
const ROUNDS = 20
const PARALLEL = 10

async function ledger(productId: number): Promise<number> {
  const agg = await prisma.transactionItem.aggregate({ where: { productId }, _sum: { delta: true } })
  return Number(agg._sum.delta ?? 0)
}

describe('concurrency', () => {
  it('product "out" race: exactly 1 success and 9 rejections EVERY round, quantity stays 0', async () => {
    for (let round = 1; round <= ROUNDS; round++) {
      await resetDb()
      const r = await seedRoles()
      const p = await createProduct()
      await api().post(`/api/products/${p.id}/adjust`).set(auth(r.adminToken)).send({ type: 'in', delta: 1 })

      const results = await Promise.all(
        Array.from({ length: PARALLEL }, () =>
          api().post(`/api/products/${p.id}/adjust`).set(auth(r.adminToken)).send({ type: 'out', delta: 1 }),
        ),
      )
      const ok = results.filter((x) => x.status === 200).length
      const rejected = results.filter((x) => x.status === 400).length
      expect({ round, ok }).toEqual({ round, ok: 1 })
      expect({ round, rejected }).toEqual({ round, rejected: PARALLEL - 1 })
      const product = await prisma.product.findUnique({ where: { id: p.id } })
      expect({ round, qty: product!.quantity }).toEqual({ round, qty: 0 })
    }
  })

  it.fails('tool assign race (H6): exactly 1 success + 9 rejections EVERY round, availableQuantity stays 0', async () => {
    let satisfiedRounds = 0
    for (let round = 1; round <= ROUNDS; round++) {
      await resetDb()
      const r = await seedRoles()
      const w = await createWorkerEntity()
      const t = await createTool({ totalQuantity: 1 })

      const results = await Promise.all(
        Array.from({ length: PARALLEL }, () =>
          api().post(`/api/workers/${w.id}/assignTool/${t.id}`).set(auth(r.adminToken)).send({ quantity: 1 }),
        ),
      )
      const ok = results.filter((x) => x.status === 200).length
      const tool = await prisma.tool.findUnique({ where: { id: t.id } })
      if (ok === 1 && tool!.availableQuantity === 0) satisfiedRounds++
    }
    // eslint-disable-next-line no-console
    console.log(`[H6] product tool-assign rounds satisfying desired behavior: ${satisfiedRounds}/${ROUNDS}`)
    // Desired: every round satisfies. Today the H6 race corrupts every round (0).
    expect(satisfiedRounds).toBe(ROUNDS)
  })

  it.fails('item-delta edit race: quantity === ledger EVERY round (stock-integrity race)', async () => {
    let satisfiedRounds = 0
    for (let round = 1; round <= ROUNDS; round++) {
      await resetDb()
      const r = await seedRoles()
      const p = await createProduct()
      await api().post(`/api/products/${p.id}/adjust`).set(auth(r.adminToken)).send({ type: 'in', delta: 100 })

      const created = await api().post('/api/transactions').set(auth(r.adminToken)).send({
        type: 'out',
        items: [{ productId: p.id, delta: 10 }],
      })
      const txId = created.body.transaction.id
      const itemId = created.body.items[0].id

      const deltas = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
      const results = await Promise.all(
        deltas.map((d) => api().patch(`/api/transactions/${txId}/items/${itemId}`).set(auth(r.adminToken)).send({ delta: d })),
      )
      const product = await prisma.product.findUnique({ where: { id: p.id } })
      const led = await ledger(p.id)
      const allOk = results.every((x) => x.status === 200)
      if (allOk && product!.quantity >= 0 && product!.quantity === led) satisfiedRounds++
    }
    // eslint-disable-next-line no-console
    console.log(`[item-race] rounds satisfying desired (quantity === ledger): ${satisfiedRounds}/${ROUNDS}`)
    expect(satisfiedRounds).toBe(ROUNDS)
  })
})