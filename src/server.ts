import * as dotenv from 'dotenv'
dotenv.config()

import { prisma } from './prisma'
import type { Request, Response, NextFunction } from 'express'
const express = require('express')
const path = require('path')
const cors = require('cors')
import { startOfDay } from './dateUtils'
import { comparePassword, generateToken, verifyToken } from './auth'

const app = express()
app.use(cors())
app.use(express.json())

// ✅ Код-ревью: Хорошая структура импортов и инициализации

app.post('/api/login', async (req: Request, res: Response) => {
  const { username, password } = req.body
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' })
  }

  const user = await prisma.user.findUnique({ where: { username } })
  if (!user) {
    return res.status(401).json({ error: 'invalid credentials' })
  }

  const passwordValid = await comparePassword(password, user.passwordHash)
  if (!passwordValid) {
    return res.status(401).json({ error: 'invalid credentials' })
  }

  const token = generateToken(user.id, user.username)
  res.json({ token })
})

app.use(express.static(path.join(__dirname, '..', 'frontend')))

const authenticateToken = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1]

  if (token == null) return res.sendStatus(401)

  const user = verifyToken(token)
  if (!user) return res.sendStatus(403)

  next()
}

app.use('/api', authenticateToken)

app.get('/api/stats', async (req: Request, res: Response) => {
  const today = startOfDay(new Date())
  const [totalProducts, todayTransactions, lastActivity] = await Promise.all([
    prisma.product.count(),
    prisma.transaction.count({
      where: {
        date: { gte: today }
      }
    }),
    prisma.transaction.findFirst({
      orderBy: { date: 'desc' },
      select: { date: true }
    })
  ])
  res.json({ totalProducts, todayTransactions, lastActivity: lastActivity?.date })
})

app.get('/api/transactions/recent', async (req: Request, res: Response) => {
  const items = await prisma.transaction.findMany({
    take: 5,
    orderBy: { date: 'desc' },
    include: { product: true, worker: true, supplier: true, destination: true }
  })
  res.json(items)
})

app.get('/api/products', async (req: Request, res: Response) => {
  const search = String(req.query.search || '').trim()

  if (!search) {
    const products = await prisma.product.findMany({
      include: { transactions: { orderBy: { date: 'desc' } } }
    })
    return res.json(products)
  }

  const q = `%${search.replace(/%/g, '\\%')}%`

  // ✅ ФИКС: Исправлено имя колонки для PostgreSQL
  const rows: Array<{ id: number }> = await prisma.$queryRaw`
    SELECT id FROM product
    WHERE lower(name) LIKE lower(${q})
    ORDER BY "updatedAt" DESC
  `

  const ids = rows.map(r => r.id)
  if (ids.length === 0) return res.json([])

  const products = await prisma.product.findMany({
    where: { id: { in: ids } },
    include: { transactions: { orderBy: { date: 'desc' } } }
  })

  res.json(products)
})

app.post('/api/products', async (req: Request, res: Response) => {
  const { name, unit, quantity, supplierId } = req.body
  const displayName = String(name || '').trim()
  if (!displayName) return res.status(400).json({ error: 'name required' })
  const nameNormalized = displayName.toLowerCase()
  const qRaw = Number(quantity ?? 0)
  if (!Number.isInteger(qRaw) || qRaw < 0) return res.status(400).json({ error: 'quantity must be integer >= 0' })
  if (qRaw > 65535) return res.status(400).json({ error: 'quantity must be <= 65535' })
  
  // ✅ ФИКС: Исправлено имя колонки для PostgreSQL
  const existsRows = await prisma.$queryRaw<Array<{ id: number }>>`
    SELECT id FROM product WHERE "nameNormalized" = ${nameNormalized} LIMIT 1
  `
  const exists = existsRows.length > 0
  if (exists) return res.status(400).json({ error: 'product with this name exists' })
  
  const createData: any = { name: displayName, nameNormalized, unit: String(unit ?? ''), quantity: qRaw }
  const p = await prisma.product.create({ data: createData })

  if (supplierId && qRaw > 0) {
    try {
      const supplier = await prisma.supplier.findUnique({ where: { id: Number(supplierId) } })
      if (!supplier) throw new Error('supplier not found')
      
      const tData: any = {
        productId: p.id,
        productName: p.name,
        delta: qRaw,
        type: 'in',
        supplierName: supplier.name,
        supplierId: supplier.id
      }
      await prisma.transaction.create({ data: tData })
    } catch (e) {
      console.error('failed to create initial transaction', e)
    }
  }

  res.json(p)
})

app.post('/api/products/:id/adjust', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const { delta, type, supplierId, destinationId, workerId, date, note } = req.body
  if (!['in', 'out'].includes(type)) return res.status(400).json({ error: 'type must be in|out' })
  const product = await prisma.product.findUnique({ where: { id } })
  if (!product) return res.status(404).json({ error: 'product not found' })

  const rawDelta = Number(delta)
  if (!Number.isInteger(rawDelta) || rawDelta <= 0) {
    return res.status(400).json({ error: 'delta must be a positive integer' })
  }
  const numericDelta = type === 'out' ? -Math.abs(rawDelta) : Math.abs(rawDelta)
  if (type === 'out' && product.quantity + numericDelta < 0) {
    return res.status(400).json({ error: 'not enough stock' })
  }
  if (type === 'in' && product.quantity + numericDelta > 65535) {
    return res.status(400).json({ error: 'exceeds max stock 65535' })
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      let supplierName: string | undefined = undefined
      let destinationName: string | undefined = undefined

      if (supplierId) {
        const s = await tx.supplier.findUnique({ where: { id: Number(supplierId) } })
        if (!s) throw new Error('supplier not found')
        supplierName = s.name
      }

      if (destinationId) {
        const d = await tx.location.findUnique({ where: { id: Number(destinationId) } })
        if (!d) throw new Error('destination not found')
        destinationName = d.name
      }

      const tData: any = {
        productId: id,
        productName: product.name,
        delta: numericDelta,
        type,
        date: date ? new Date(date) : undefined,
        supplierName,
        destinationName,
        supplierId: supplierId ? Number(supplierId) : undefined,
        destinationId: destinationId ? Number(destinationId) : undefined,
        workerId: workerId ? Number(workerId) : undefined,
        note
      }
      const t = await tx.transaction.create({ data: tData })
      const newQty = product.quantity + numericDelta
      await tx.product.update({ where: { id }, data: { quantity: newQty } })
      return { transaction: t, newQty }
    })
    res.json(updated)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'internal error' })
  }
})

app.delete('/api/products/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const purge = String(req.query.purge || 'false') === 'true'

  const product = await prisma.product.findUnique({ where: { id } })
  if (!product) return res.status(404).json({ error: 'product not found' })

  try {
    if (purge) {
      await prisma.$transaction([
        prisma.transaction.deleteMany({ where: { productId: id } }),
        prisma.product.delete({ where: { id } })
      ])
      return res.json({ ok: true, purged: true })
    } else {
      await prisma.product.delete({ where: { id } })
      return res.json({ ok: true, purged: false })
    }
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'failed to delete product' })
  }
})

app.get('/api/workers', async (req: Request, res: Response) => {
  const showDeleted = req.query.showDeleted === 'true'
  const w = await prisma.worker.findMany({
    where: showDeleted ? undefined : { deleted: false },
    include: {
      assignments: {
        where: { returnedAt: null },
        include: { tool: true }
      }
    }
  })
  res.json(w)
})

app.post('/api/workers', async (req: Request, res: Response) => {
  const { fullName, phone, position } = req.body;
  
  if (!fullName) {
    return res.status(400).json({ error: 'Full name is required' });
  }
  
  try {
    const existingWorker = await prisma.worker.findFirst({
      where: { 
        fullName: fullName.trim(),
        deleted: false
      }
    });
    
    if (existingWorker) {
      return res.status(400).json({ error: 'Worker with this name already exists' });
    }

    let normalizedPhone: string | undefined = undefined
    if (phone) {
      const digits = phone.replace(/\D/g, '')
      if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
        const raw = digits.slice(1)
        normalizedPhone = `+7-${raw.slice(0,3)}-${raw.slice(3,6)}-${raw.slice(6,8)}-${raw.slice(8,10)}`
      } else if (digits.length === 10) {
        normalizedPhone = `+7-${digits.slice(0,3)}-${digits.slice(3,6)}-${digits.slice(6,8)}-${digits.slice(8,10)}`
      } else {
        return res.status(400).json({ error: 'номер должен содержать 10 цифр или 11 цифр начиная с 7/8' })
      }
    }
    
    const worker = await prisma.worker.create({
      data: {
        fullName: fullName.trim(),
        phone: normalizedPhone,
        position: position ? position.trim() : null,
      }
    });
    
    res.json(worker);
  } catch (error) {
    console.error('Error creating worker:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/workers/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  
  try {
    const worker = await prisma.worker.findUnique({
      where: { id }
    });
    
    if (!worker) {
      return res.status(404).json({ error: 'Worker not found' });
    }
    
    await prisma.worker.update({
      where: { id },
      data: { deleted: true }
    });
    
    res.json({ ok: true });
  } catch (error) {
    console.error('Error deleting worker:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/suppliers', async (req: Request, res: Response) => {
  const showDeleted = req.query.showDeleted === 'true'
  const suppliers = await prisma.supplier.findMany({
    where: showDeleted ? undefined : { deleted: false }
  })
  
  // ✅ ФИКС: Исправлены имена колонок для PostgreSQL
  const rows = await prisma.$queryRaw<Array<{ supplierId: number, productId: number, name: string, total: number }>>`
    SELECT 
      t."supplierId" as "supplierId",
      t."productId" as "productId",
      p.name as name,
      CAST(CAST(sum(t.delta) AS INTEGER) AS REAL) as total
    FROM "transaction" t
    JOIN product p ON p.id = t."productId"
    WHERE t."supplierId" IS NOT NULL AND t.type = 'in'
    GROUP BY t."supplierId", t."productId"
  `
  
  const map: Record<number, Array<{ productId: number, name: string, total: number }>> = {}
  rows.forEach(r=>{
    if (!map[r.supplierId]) map[r.supplierId] = []
    map[r.supplierId].push({ productId: r.productId, name: r.name, total: r.total })
  })
  const result = suppliers.map(s=>({ ...s, supplied: map[s.id] || [] }))
  res.json(result)
})

app.post('/api/suppliers', async (req: Request, res: Response) => {
  const { name, phone, email } = req.body
  if (!name) return res.status(400).json({ error: 'name required' })
  const existing = await prisma.supplier.findUnique({ where: { name } })
  if (existing) return res.status(400).json({ error: 'supplier exists' })

  const phoneStr = phone ? String(phone).trim() : ''
  const emailStr = email ? String(email).trim() : ''
  if (!phoneStr && !emailStr) return res.status(400).json({ error: 'phone or email required' })

  let normalizedPhone: string | undefined = undefined
  if (phoneStr) {
    const digits = phoneStr.replace(/\D/g, '')
    if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
      const raw = digits.slice(1)
      normalizedPhone = `+7-${raw.slice(0,3)}-${raw.slice(3,6)}-${raw.slice(6,8)}-${raw.slice(8,10)}`
    } else if (digits.length === 10) {
      normalizedPhone = `+7-${digits.slice(0,3)}-${digits.slice(3,6)}-${digits.slice(6,8)}-${digits.slice(8,10)}`
    } else {
      return res.status(400).json({ error: 'номер должен содержать 10 цифр или 11 цифр начиная с 7/8' })
    }
  }

  if (emailStr && !/^\S+@\S+\.\S+$/.test(emailStr)) return res.status(400).json({ error: 'invalid email' })

  const s = await prisma.supplier.create({ data: { name, phone: normalizedPhone, email: emailStr || null } })
  res.json(s)
})

app.delete('/api/suppliers/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  try {
    await prisma.supplier.update({ 
      where: { id },
      data: { deleted: true }
    })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: 'failed to delete supplier' })
  }
})

app.get('/api/locations', async (req: Request, res: Response) => {
  const showDeleted = req.query.showDeleted === 'true'
  const l = await prisma.location.findMany({
    where: showDeleted ? undefined : { deleted: false }
  })
  res.json(l)
})

app.post('/api/locations', async (req: Request, res: Response) => {
  const { name, city, district, address } = req.body
  if (!name) return res.status(400).json({ error: 'name required' })
  const existing = await prisma.location.findUnique({ where: { name } })
  if (existing) return res.status(400).json({ error: 'location exists' })
  const l = await prisma.location.create({ data: { name, city: city || null, district: district || null, address: address || null } as any })
  res.json(l)
})

app.delete('/api/locations/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  try {
    await prisma.location.update({ 
      where: { id },
      data: { deleted: true }
    })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: 'failed to delete location' })
  }
})

app.get('/api/transactions', async (req: Request, res: Response) => {
  const sort = String(req.query.sort || 'date_desc')
  const productId = req.query.productId ? Number(req.query.productId) : undefined
  const searchProduct = req.query.searchProduct ? String(req.query.searchProduct) : undefined
  const entityType = req.query.entityType ? String(req.query.entityType) : undefined
  const entityId = req.query.entityId ? Number(req.query.entityId) : undefined
  const search = req.query.search ? String(req.query.search) : undefined
  const page = req.query.page ? Math.max(1, Number(req.query.page)) : 1
  const limit = req.query.limit ? Math.max(1, Number(req.query.limit)) : 200

  const where: any = {}

  if (productId) {
    where.productId = productId
  } else if (searchProduct) {
    const q = `%${String(searchProduct).replace(/%/g, '\\%')}%`
    // ✅ ФИКС: Исправлено имя колонки для PostgreSQL
    const rows: Array<{ id: number }> = await prisma.$queryRaw`
      SELECT id FROM product
      WHERE lower(name) LIKE lower(${q})
    `
    const ids = rows.map(r => r.id)
    if (ids.length === 0) {
      where.productId = { in: [] }
    } else {
      where.productId = { in: ids }
    }
  }

  if (entityType && entityId) {
    if (entityType === 'product') where.productId = entityId
    if (entityType === 'supplier') where.supplierId = entityId
    if (entityType === 'destination') where.destinationId = entityId
    if (entityType === 'worker') where.workerId = entityId
  } else if (search) {
    const like = `%${search.replace(/%/g, '\\%')}%`
    // ✅ ФИКС: Исправлены имена колонок для PostgreSQL
    const [prodIds, supIds, locIds, workerIds] = await Promise.all([
      prisma.$queryRaw<Array<{id:number}>>`SELECT id FROM product WHERE lower(name) LIKE lower(${like})`,
      prisma.$queryRaw<Array<{id:number}>>`SELECT id FROM supplier WHERE lower(name) LIKE lower(${like})`,
      prisma.$queryRaw<Array<{id:number}>>`SELECT id FROM location WHERE lower(name) LIKE lower(${like})`,
      prisma.$queryRaw<Array<{id:number}>>`SELECT id FROM worker WHERE lower("fullName") LIKE lower(${like})`
    ])
    const anyFilter: any[] = []
    if (prodIds.length) anyFilter.push({ productId: { in: prodIds.map(r=>r.id) } })
    if (supIds.length) anyFilter.push({ supplierId: { in: supIds.map(r=>r.id) } })
    if (locIds.length) anyFilter.push({ destinationId: { in: locIds.map(r=>r.id) } })
    if (workerIds.length) anyFilter.push({ workerId: { in: workerIds.map(r=>r.id) } })
    if (anyFilter.length) {
      where.OR = anyFilter
    } else {
      where.id = { in: [] }
    }
  }

  let orderBy: any = {}
  switch (sort) {
    case 'date_asc': orderBy = { date: 'asc' }; break
    case 'date_desc': orderBy = { date: 'desc' }; break
    case 'product_asc': orderBy = { productName: 'asc' }; break
    case 'product_desc': orderBy = { productName: 'desc' }; break
    case 'worker_asc': orderBy = { worker: { fullName: 'asc' } }; break
    case 'worker_desc': orderBy = { worker: { fullName: 'desc' } }; break
    case 'type_asc': orderBy = { type: 'asc' }; break
    case 'type_desc': orderBy = { type: 'desc' }; break
    case 'quantity_asc': orderBy = { delta: 'asc' }; break
    case 'quantity_desc': orderBy = { delta: 'desc' }; break
    default: orderBy = { date: 'desc' }
  }

  const transactions = await prisma.transaction.findMany({
    where,
    include: { product: true, worker: true },
    orderBy,
    skip: (page - 1) * limit,
    take: limit
  })

  res.json({ page, limit, items: transactions })
})

app.patch('/api/transactions/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const { note } = req.body
  try {
    const t = await prisma.transaction.update({ where: { id }, data: { note: note ?? null } })
    res.json(t)
  } catch (e) {
    res.status(400).json({ error: 'failed to update note' })
  }
})

app.get('/api/search', async (req: Request, res: Response) => {
  const q = String(req.query.q || '').trim().toLowerCase()
  if (!q) return res.json({ items: [] })
  const like = `%${q.replace(/%/g, '\\%')}%`
  
  // ✅ ФИКС: Исправлены имена колонок для PostgreSQL
  const [products, suppliers, locations, workers] = await Promise.all([
    prisma.$queryRaw<Array<{id:number,name:string}>>`SELECT id, name FROM product WHERE lower(name) LIKE lower(${like}) LIMIT 20`,
    prisma.$queryRaw<Array<{id:number,name:string}>>`SELECT id, name FROM supplier WHERE lower(name) LIKE lower(${like}) LIMIT 20`,
    prisma.$queryRaw<Array<{id:number,name:string}>>`SELECT id, name FROM location WHERE lower(name) LIKE lower(${like}) LIMIT 20`,
    prisma.$queryRaw<Array<{id:number,name:string}>>`SELECT id, "fullName" as name FROM worker WHERE lower("fullName") LIKE lower(${like}) LIMIT 20`
  ])
  
  const items = [
    ...products.map(p=>({ type: 'product', id: p.id, name: p.name })),
    ...suppliers.map(s=>({ type: 'supplier', id: s.id, name: s.name })),
    ...locations.map(l=>({ type: 'destination', id: l.id, name: l.name })),
    ...workers.map(w=>({ type: 'worker', id: w.id, name: w.name }))
  ]
  res.json({ items })
})

import { getInventoryStatus, getTransactionSummary, getTopProducts, getLowStock, exportToCsv, getWorkerPerformance, getConsumptionForecast, getDestinationStats, getSupplierStats } from './reports'

app.get('/api/reports/inventory', async (req: Request, res: Response) => {
  try {
    const data = await getInventoryStatus()
    res.json(data)
  } catch (e) {
    res.status(500).json({ error: 'failed to get inventory report' })
  }
})

app.get('/api/reports/transactions', async (req: Request, res: Response) => {
  try {
    const from = req.query.from ? new Date(String(req.query.from)) : undefined
    const to = req.query.to ? new Date(String(req.query.to)) : undefined
    const data = await getTransactionSummary(from, to)
    res.json(data)
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'failed to get transaction report' })
  }
})

app.get('/api/reports/top-products', async (req: Request, res: Response) => {
  try {
    const from = req.query.from ? new Date(String(req.query.from)) : undefined
    const to = req.query.to ? new Date(String(req.query.to)) : undefined
    const limit = req.query.limit ? Number(req.query.limit) : 20
    const data = await getTopProducts(from, to, limit)
    res.json(data)
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'failed to get top products report' })
  }
})

app.get('/api/reports/low-stock', async (req: Request, res: Response) => {
  try {
    const threshold = req.query.threshold ? Number(req.query.threshold) : 10
    const data = await getLowStock(threshold)
    res.json(data)
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'failed to get low stock report' })
  }
})

app.get('/api/reports/worker-performance', async (req: Request, res: Response) => {
  try {
    const from = req.query.from ? new Date(String(req.query.from)) : undefined
    const to = req.query.to ? new Date(String(req.query.to)) : undefined
    const data = await getWorkerPerformance(from, to)
    res.json(data)
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'failed to get worker performance report' })
  }
})

app.get('/api/reports/consumption-forecast', async (req: Request, res: Response) => {
  try {
    const days = req.query.days ? Number(req.query.days) : 30
    const data = await getConsumptionForecast(days)
    res.json(data)
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'failed to get consumption forecast' })
  }
})

app.get('/api/reports/destination-stats', async (req: Request, res: Response) => {
  try {
    const from = req.query.from ? new Date(String(req.query.from)) : undefined
    const to = req.query.to ? new Date(String(req.query.to)) : undefined
    const data = await getDestinationStats(from, to)
    res.json(data)
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'failed to get destination stats' })
  }
})

app.get('/api/reports/supplier-stats', async (req: Request, res: Response) => {
  try {
    const from = req.query.from ? new Date(String(req.query.from)) : undefined
    const to = req.query.to ? new Date(String(req.query.to)) : undefined
    const data = await getSupplierStats(from, to)
    res.json(data)
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'failed to get supplier stats' })
  }
})

app.get('/api/reports/export', async (req: Request, res: Response) => {
  try {
    const type = String(req.query.type)
    const from = req.query.from ? new Date(String(req.query.from)) : undefined
    const to = req.query.to ? new Date(String(req.query.to)) : undefined
    const format = String(req.query.format || 'csv').toLowerCase()
    const extra = {
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      threshold: req.query.threshold ? Number(req.query.threshold) : undefined,
      days: req.query.days ? Number(req.query.days) : undefined
    }
    const ts = new Date().toISOString().slice(0,10)

    if (format === 'csv') {
      const { csv, filename } = await exportToCsv(type, from, to, extra)
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      return res.send(csv)
    }

    const { csv } = await exportToCsv(type, from, to, extra)
    const lines = String(csv || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean)

    const parseCsvLine = (line: string) => {
      const cols: string[] = []
      let cur = '', inQuotes = false
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (ch === '"' && line[i+1] === '"') { cur += '"'; i++; continue }
        if (ch === '"') { inQuotes = !inQuotes; continue }
        if (ch === ',' && !inQuotes) { cols.push(cur); cur = ''; continue }
        cur += ch
      }
      cols.push(cur)
      return cols
    }

    const rows = lines.map(l => parseCsvLine(l))

    if (format === 'excel' || format === 'xls' || format === 'xlsx') {
      const ExcelJS = require('exceljs')
      const wb = new ExcelJS.Workbook()
      wb.creator = 'warehouse-keeper'
      const ws = wb.addWorksheet(type || 'report')

      if (rows.length === 0) {
        ws.addRow(['empty'])
      } else {
        const header = rows[0].map(c => (c || '').trim())
        ws.addRow(header)
        for (let i = 1; i < rows.length; i++) {
          ws.addRow(rows[i].map(c => (c || '').trim()))
        }

        const headerRow = ws.getRow(1)
        headerRow.eachCell((cell) => {
          cell.font = { bold: true }
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF3F4F6' }
          }
          cell.border = {
            top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' }
          }
          cell.alignment = { vertical: 'middle', horizontal: 'left' }
        })

        ws.views = [{ state: 'frozen', ySplit: 1 }]

        ws.columns.forEach((col) => {
          let max = 10
          col.eachCell({ includeEmpty: true }, (cell) => {
            const v = cell.value ? String(cell.value) : ''
            if (v.length > max) max = Math.min(80, v.length)
          })
          col.width = max + 2
        })
      }

      const buf = await wb.xlsx.writeBuffer()
      const filename = `${type || 'report'}-${ts}.xlsx`
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.setHeader('Content-Length', String(Buffer.byteLength(buf)))
      return res.end(Buffer.from(buf))
    }

    if (format === 'pdf') {
      const puppeteer = require('puppeteer')
      const tableHtml = ['<table role="table" style="border-collapse:collapse;width:100%">',
        '<thead><tr>',
        ...rows[0].map(h => `<th style="border:1px solid #ccc;padding:8px;background:#f3f4f6;text-align:left">${(h||'')}</th>`),
        '</tr></thead>',
        '<tbody>',
        ...rows.slice(1).map(r => `<tr>${r.map(c => `<td style="border:1px solid #ccc;padding:6px">${(c||'')}</td>`).join('')}</tr>`),
        '</tbody></table>'
      ].join('\n')

      const html = `
        <!doctype html>
        <html>
          <head>
            <meta charset="utf-8">
            <meta http-equiv="X-UA-Compatible" content="IE=edge" />
            <meta name="viewport" content="width=device-width,initial-scale=1" />
            <!-- Noto Sans from Google (supports Cyrillic) -->
            <link href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;700&display=swap" rel="stylesheet">
            <style>
              body { font-family: 'Noto Sans', sans-serif; font-size:12px; color:#111; padding:20px; }
              h1 { font-size:16px; margin-bottom:8px; }
              table { font-size:12px; }
              th { background:#f3f4f6; font-weight:700; }
              td, th { border:1px solid #ddd; padding:6px; vertical-align:top; }
              @media print {
                body { -webkit-print-color-adjust: exact; }
              }
            </style>
          </head>
          <body>
            <h1>Отчет: ${type || ''} — ${ts}</h1>
            ${tableHtml}
          </body>
        </html>
      `

      // launch puppeteer
      const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      })
      try {
        const page = await browser.newPage()
        await page.setContent(html, { waitUntil: 'networkidle0' })
        const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top: 20, bottom: 20, left: 20, right: 20 } })
        const filename = `${type || 'report'}-${ts}.pdf`
        res.setHeader('Content-Type', 'application/pdf')
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
        res.setHeader('Content-Length', String(pdfBuffer.length))
        return res.end(pdfBuffer)
      } finally {
        await browser.close()
      }
    }

    return res.status(400).json({ error: 'unknown format' })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'failed to export data' })
  }
})

app.get('/api/tools', async (req: Request, res: Response) => {
  const tools = await prisma.tool.findMany({
    where: { deleted: false },
    orderBy: { name: 'asc' },
    include: {
      assignments: {
        where: { returnedAt: null },
        include: { worker: true }
      }
    }
  });
   res.json(tools);
});

app.post('/api/tools', async (req: Request, res: Response) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }

  try {
    const tool = await prisma.tool.create({
      data: { name }
    });
    res.json(tool);
  } catch (error) {
    console.error('Error creating tool:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/api/tools/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({ error: 'Status is required' });
  }

  try {
    const tool = await prisma.tool.update({
      where: { id },
      data: { status }
    });
    res.json(tool);
  } catch (error) {
    console.error('Error updating tool:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/tools/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);

  try {
    await prisma.tool.update({
      where: { id },
      data: { deleted: true }
    });
    res.json({ ok: true });
  } catch (error) {
    console.error('Error deleting tool:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/workers/:workerId/assignTool/:toolId', async (req: Request, res: Response) => {
  const workerId = Number(req.params.workerId);
  const toolId = Number(req.params.toolId);

  try {
    const worker = await prisma.worker.findUnique({ where: { id: workerId } });
    const tool = await prisma.tool.findUnique({ where: { id: toolId } });

    if (!worker) {
      return res.status(404).json({ error: 'Worker not found' });
    }

    if (!tool) {
      return res.status(404).json({ error: 'Tool not found' });
    }

    const existingAssignment = await prisma.toolAssignment.findFirst({
      where: {
        toolId: toolId,
        returnedAt: null
      }
    });

    if (existingAssignment) {
      return res.status(400).json({ error: 'Tool is already assigned to another worker' });
    }

    const existingWorkerAssignment = await prisma.toolAssignment.findFirst({
      where: {
        workerId: workerId,
        returnedAt: null
      }
    });

    if (existingWorkerAssignment) {
      await prisma.toolAssignment.update({
        where: { id: existingWorkerAssignment.id },
        data: { returnedAt: new Date() }
      });
    }

    const assignment = await prisma.toolAssignment.create({
      data: {
        toolId: toolId,
        workerId: workerId
      }
    });

    await prisma.tool.update({
      where: { id: toolId },
      data: { status: 'assigned' }
    });

    res.json(assignment);
  } catch (error) {
    console.error('Error assigning tool:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/workers/:workerId/unassignTool/:toolId', async (req: Request, res: Response) => {
  const workerId = Number(req.params.workerId);
  const toolId = Number(req.params.toolId);

  try {
    const worker = await prisma.worker.findUnique({ where: { id: workerId } });
    const tool = await prisma.tool.findUnique({ where: { id: toolId } });

    if (!worker) {
      return res.status(404).json({ error: 'Worker not found' });
    }

    if (!tool) {
      return res.status(404).json({ error: 'Tool not found' });
    }

    const assignment = await prisma.toolAssignment.findFirst({
      where: {
        workerId: workerId,
        toolId: toolId,
        returnedAt: null
      }
    });

    if (!assignment) {
      return res.status(404).json({ error: 'Tool is not assigned to this worker' });
    }

    await prisma.toolAssignment.update({
      where: { id: assignment.id },
      data: { returnedAt: new Date() }
    });

    await prisma.tool.update({
      where: { id: toolId },
      data: { status: 'available' }
    });

    res.json({ ok: true });
  } catch (error) {
    console.error('Error unassigning tool:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const port = process.env.PORT ?? 3000
app.listen(port, () => console.log(`server started on http://localhost:${port}`))