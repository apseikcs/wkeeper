import request from 'supertest'
import { app } from '../src/app'
import { prisma } from '../src/prisma'
import { generateToken } from '../src/auth'

let counter = 0
const next = () => ++counter

export const api = () => request(app)

// Full wipe in FK-safe order. Refuses to run unless the active database name
// ends with `_test` (defense-in-depth on top of tests/guard.ts).
export async function resetDb() {
  const [row] = await prisma.$queryRaw<Array<{ db: string }>>`SELECT current_database() AS db`
  const db = row?.db ?? ''
  if (!db.endsWith('_test')) {
    throw new Error(`resetDb: refusing to touch database "${db}" (name must end with "_test")`)
  }
  await prisma.transactionItem.deleteMany()
  await prisma.transaction.deleteMany()
  await prisma.toolAssignment.deleteMany()
  await prisma.tool.deleteMany()
  await prisma.worker.deleteMany()
  await prisma.supplier.deleteMany()
  await prisma.location.deleteMany()
  await prisma.product.deleteMany()
  await prisma.user.deleteMany()
}

export type Roles = {
  admin: { id: number; username: string; role: string }
  worker: { id: number; username: string; role: string }
  adminToken: string
  workerToken: string
}

export async function seedRoles(): Promise<Roles> {
  const admin = await prisma.user.create({ data: { username: 'admin', passwordHash: 'x', role: 'admin' } })
  const worker = await prisma.user.create({ data: { username: 'worker1', passwordHash: 'x', role: 'worker' } })
  return {
    admin,
    worker,
    adminToken: generateToken(admin.id, admin.username, admin.role),
    workerToken: generateToken(worker.id, worker.username, worker.role),
  }
}

export async function createProduct(overrides: { name?: string; unit?: string; quantity?: number } = {}) {
  const name = overrides.name ?? `product-${next()}`
  return prisma.product.create({
    data: { name, nameNormalized: name.toLowerCase(), unit: overrides.unit ?? 'шт', quantity: overrides.quantity ?? 0 },
  })
}

export async function createWorkerEntity(overrides: { fullName?: string } = {}) {
  return prisma.worker.create({ data: { fullName: overrides.fullName ?? `worker-${next()}` } })
}

export async function createSupplier(name?: string) {
  return prisma.supplier.create({ data: { name: name ?? `supplier-${next()}` } })
}

export async function createLocation(name?: string) {
  return prisma.location.create({ data: { name: name ?? `loc-${next()}` } })
}

export async function createTool(overrides: { name?: string; totalQuantity?: number; availableQuantity?: number } = {}) {
  const total = overrides.totalQuantity ?? 1
  return prisma.tool.create({
    data: {
      name: overrides.name ?? `tool-${next()}`,
      totalQuantity: total,
      availableQuantity: overrides.availableQuantity ?? total,
    },
  })
}