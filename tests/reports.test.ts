import { describe, it, expect, beforeEach } from 'vitest'
import { api, resetDb, seedRoles, type Roles } from './helpers'
import { prisma } from '../src/prisma'

let roles: Roles
beforeEach(async () => {
  await resetDb()
  roles = await seedRoles()
  const p1 = await prisma.product.create({ data: { name: 'rpt-A', nameNormalized: 'rpt-a', unit: 'шт', quantity: 5 } })
  const p2 = await prisma.product.create({ data: { name: 'rpt-B', nameNormalized: 'rpt-b', unit: 'м', quantity: 10 } })
  const p3 = await prisma.product.create({ data: { name: 'rpt-C', nameNormalized: 'rpt-c', unit: 'шт', quantity: 0 } })
  const sup = await prisma.supplier.create({ data: { name: 'rpt-sup', phone: '+7-900-000-0001' } })
  const loc = await prisma.location.create({ data: { name: 'rpt-loc', city: 'Voronezh' } })
  const wrk = await prisma.worker.create({ data: { fullName: 'rpt-wrk' } })
  const today = new Date()
  const tIn = await prisma.transaction.create({ data: { type: 'in', supplierId: sup.id, supplierName: sup.name, date: today } })
  await prisma.transactionItem.create({ data: { transactionId: tIn.id, productId: p1.id, productName: p1.name, delta: 10 } })
  const tOut = await prisma.transaction.create({ data: { type: 'out', workerId: wrk.id, destinationId: loc.id, destinationName: loc.name, date: today } })
  await prisma.transactionItem.create({ data: { transactionId: tOut.id, productId: p1.id, productName: p1.name, delta: -3 } })
  await prisma.transactionItem.create({ data: { transactionId: tOut.id, productId: p3.id, productName: p3.name, delta: -2 } })
})

const at = () => ({ Authorization: `Bearer ${roles.adminToken}` })

const reportPaths = [
  '/api/reports/inventory',
  '/api/reports/transactions',
  '/api/reports/top-products',
  '/api/reports/low-stock',
  '/api/reports/worker-performance',
  '/api/reports/consumption-forecast',
  '/api/reports/destination-stats',
  '/api/reports/supplier-stats',
]

const exportTypes = ['top-products', 'low-stock', 'worker-performance', 'consumption-forecast', 'destination-stats', 'supplier-stats', 'transactions']

describe('report endpoints (data present) and CSV/Excel export', () => {
  for (const p of reportPaths) {
    it(`GET ${p} -> 200`, async () => {
      const r = await api().get(p).set(at())
      expect(r.status).toBe(200)
    })
  }

  for (const type of exportTypes) {
    it(`export ${type} (csv) -> 200`, async () => {
      const r = await api().get(`/api/reports/export?type=${type}&format=csv`).set(at())
      expect(r.status).toBe(200)
      expect(String(r.headers['content-type'])).toContain('text/csv')
    })
    it(`export ${type} (excel) -> 200`, async () => {
      const r = await api().get(`/api/reports/export?type=${type}&format=excel`).set(at())
      expect(r.status).toBe(200)
    })
  }

  it('export unknown type -> 500', async () => {
    const r = await api().get('/api/reports/export?type=nope&format=csv').set(at())
    expect(r.status).toBe(500)
  })

  it('export unknown format -> 400', async () => {
    const r = await api().get('/api/reports/export?type=top-products&format=pdf').set(at())
    expect(r.status).toBe(400)
  })
})