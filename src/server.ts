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

app.use('/fonts', express.static(path.join(__dirname, '..', 'fonts'), {
  maxAge: '30d',
  setHeaders: (res: any, filePath: string) => {
    if (filePath.endsWith('.ttf')) res.setHeader('Content-Type', 'font/ttf')
    if (filePath.endsWith('.otf')) res.setHeader('Content-Type', 'font/otf')
    res.setHeader('Access-Control-Allow-Origin', '*')
  }
}))

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

app.patch('/api/workers/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const { fullName, phone, position } = req.body

  try {
    const existing = await prisma.worker.findUnique({ where: { id } })
    if (!existing) return res.status(404).json({ error: 'worker not found' })

    if (fullName && fullName.trim() !== existing.fullName) {
      const dup = await prisma.worker.findFirst({
        where: {
          fullName: fullName.trim(),
          deleted: false,
          id: { not: id } as any
        } as any
      })
      if (dup) return res.status(400).json({ error: 'Worker with this name already exists' })
    }

    let normalizedPhone: string | null = existing.phone ?? null
    if (phone !== undefined) {
      const phoneStr = String(phone || '').trim()
      if (!phoneStr) {
        normalizedPhone = null
      } else {
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
    }

    const updated = await prisma.worker.update({
      where: { id },
      data: {
        fullName: fullName !== undefined ? fullName.trim() : existing.fullName,
        phone: normalizedPhone,
        position: position !== undefined ? (position ? position.trim() : null) : existing.position
      } as any
    })

    res.json(updated)
  } catch (err) {
    console.error('Error updating worker:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
});

app.get('/api/suppliers', async (req: Request, res: Response) => {
  const showDeleted = req.query.showDeleted === 'true'
  const suppliers = await prisma.supplier.findMany({
    where: showDeleted ? undefined : { deleted: false }
  })
  
  const rows = await prisma.$queryRaw<Array<{ supplierId: number, productId: number, name: string, total: number }>>`
    SELECT 
      t."supplierId" as "supplierId",
      t."productId" as "productId",
      p.name as name,
      CAST(CAST(sum(t.delta) AS INTEGER) AS REAL) as total
    FROM "transaction" t
    JOIN product p ON p.id = t."productId"
    WHERE t."supplierId" IS NOT NULL AND t.type = 'in'
    GROUP BY t."supplierId", t."productId", p.name
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


app.patch('/api/products/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const { name, unit } = req.body

  try {
    const product = await prisma.product.findUnique({ where: { id } })
    if (!product) {
      return res.status(404).json({ error: 'product not found' })
    }

    const updateData: any = {}
    
    if (name !== undefined) {
      const displayName = String(name).trim()
      if (!displayName) {
        return res.status(400).json({ error: 'name cannot be empty' })
      }
      
      const nameNormalized = displayName.toLowerCase()
      
      if (nameNormalized !== product.nameNormalized) {
        const existsRows = await prisma.$queryRaw<Array<{ id: number }>>`
          SELECT id FROM product WHERE "nameNormalized" = ${nameNormalized} AND id != ${id} LIMIT 1
        `
        if (existsRows.length > 0) {
          return res.status(400).json({ error: 'product with this name already exists' })
        }
        
        updateData.name = displayName
        updateData.nameNormalized = nameNormalized
      }
    }

    if (unit !== undefined) {
      updateData.unit = String(unit ?? '')
    }

    if (Object.keys(updateData).length === 0) {
      return res.json(product)
    }

    const updatedProduct = await prisma.product.update({
      where: { id },
      data: updateData
    })

    res.json(updatedProduct)
  } catch (err) {
    console.error('Error updating product:', err)
    res.status(500).json({ error: 'internal server error' })
  }
})

app.patch('/api/suppliers/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const { name, phone, email } = req.body

  try {
    const existing = await prisma.supplier.findUnique({ where: { id } })
    if (!existing) return res.status(404).json({ error: 'supplier not found' })

    if (name && name !== existing.name) {
      const dup = await prisma.supplier.findFirst({ where: { name, id: { not: id } } as any })
      if (dup) return res.status(400).json({ error: 'supplier with this name exists' })
    }

    let normalizedPhone: string | null = existing.phone ?? null
    if (phone !== undefined) {
      const phoneStr = String(phone || '').trim()
      if (!phoneStr) {
        normalizedPhone = null
      } else {
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
    }

    const emailStr = email !== undefined ? (String(email).trim() || null) : existing.email

    if (emailStr && !/^\S+@\S+\.\S+$/.test(emailStr)) {
      return res.status(400).json({ error: 'invalid email' })
    }

    const updated = await prisma.supplier.update({
      where: { id },
      data: {
        name: name !== undefined ? name : existing.name,
        phone: normalizedPhone,
        email: emailStr
      } as any
    })

    res.json(updated)
  } catch (err) {
    console.error('Error updating supplier:', err)
    res.status(500).json({ error: 'Internal server error' })
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

app.patch('/api/locations/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const { name, city, district, address } = req.body

  try {
    const existing = await prisma.location.findUnique({ where: { id } })
    if (!existing) return res.status(404).json({ error: 'location not found' })

    if (name && name !== existing.name) {
      const dup = await prisma.location.findUnique({ where: { name } })
      if (dup && dup.id !== id) return res.status(400).json({ error: 'location exists' })
    }

    const updated = await prisma.location.update({
      where: { id },
      data: {
        name: name !== undefined ? name : existing.name,
        city: city !== undefined ? (city || null) : existing.city,
        district: district !== undefined ? (district || null) : existing.district,
        address: address !== undefined ? (address || null) : existing.address
      } as any
    })

    res.json(updated)
  } catch (err) {
    console.error('Error updating location:', err)
    res.status(500).json({ error: 'Internal server error' })
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
    const format = String(req.query.format ?? 'excel').toLowerCase()
    const extra = {
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      threshold: req.query.threshold ? Number(req.query.threshold) : undefined,
      days: req.query.days ? Number(req.query.days) : undefined
    }
    const ts = new Date().toISOString().slice(0,10)

    function contentDispositionHeader(filename: string) {
      const map: Record<string,string> = {
        'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z','и':'i','й':'y',
        'к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f',
        'х':'h','ц':'ts','ч':'ch','ш':'sh','щ':'shch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya'
      }

      function translit(s: string) {
        return s.split('').map(ch => {
          if (ch.charCodeAt(0) < 128) return ch; 
          const lower = ch.toLowerCase();
          if (map[lower] !== undefined) {
            const out = map[lower];
            return ch === lower ? out : (out.charAt(0).toUpperCase() + out.slice(1));
          }
          return '_';
        }).join('')
         .replace(/[^\w\-.() ]+/g, '_') 
         .replace(/\s+/g, '_')          
         .replace(/_+/g, '_')           
         .replace(/^_+|_+$/g, '')       
      }

      const fallback = translit(filename) || 'report'
      return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    }

    if (format === 'csv') {
      const { csv, filename } = await exportToCsv(type, from, to, extra)
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition')
      res.setHeader('Content-Disposition', contentDispositionHeader(filename))
      return res.send(csv)
    }

    const { csv, filename: csvFilename } = await exportToCsv(type, from, to, extra)
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
        const header = rows[0].map(c => (c || '').toString().trim())
        ws.addRow(header)
        for (let i = 1; i < rows.length; i++) {
          ws.addRow(rows[i].map(c => (c || '').toString().trim()))
        }

        const headerRow = ws.getRow(1)
        headerRow.eachCell((cell: any) => {
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

        ws.columns.forEach((col: any) => {
          let max = 10
          col.eachCell({ includeEmpty: true }, (cell: any) => {
            const v = cell.value ? String(cell.value) : ''
            if (v.length > max) max = Math.min(80, v.length)
          })
          col.width = max + 2
        })
      }

      const outBuf = Buffer.from(await wb.xlsx.writeBuffer())

      const filenameBase = csvFilename && typeof csvFilename === 'string' ? csvFilename.replace(/\.csv$/i, '') : (type || 'report')
      const filename = `${filenameBase}-${ts}.xlsx`
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition')
      res.setHeader('Content-Disposition', contentDispositionHeader(filename))
      res.setHeader('Content-Length', String(outBuf.length))
      return res.end(outBuf)
    }

    if (format === 'pdf') {
      const fs = require('fs')
      async function ensureFonts(): Promise<{ normal: string, bold: string } | null> {
        try {
          const candidates = [
            path.join(__dirname, '..', 'fonts'),
            path.join(process.cwd(), 'fonts'),
            path.join(__dirname, 'fonts'),
            path.join(__dirname, '..', 'frontend', 'fonts')
          ]
          for (const dir of candidates) {
            const normal = path.join(dir, 'NotoSans-Regular.ttf')
            const bold = path.join(dir, 'NotoSans-Bold.ttf')
            if (fs.existsSync(normal) && fs.existsSync(bold)) {
              console.info('Fonts found in:', dir)
              return { normal, bold }
            }
            if (fs.existsSync(normal) && !fs.existsSync(bold)) {
              try {
                fs.copyFileSync(normal, bold)
                console.warn('NotoSans-Bold not found; created Bold fallback from Regular in:', dir)
                return { normal, bold }
              } catch (copyErr) {
                console.error('failed to create bold fallback from regular font in', dir, copyErr)
              }
            }
          }
          console.warn('No fonts found in candidate locations:', candidates.join(', '))
          return null
        } catch (err) {
          console.error('fonts ensure error', err)
          return null
        }
      }

      const fontsPaths = await ensureFonts()
      if (!fontsPaths) {
        console.error('PDF export: fonts not available')
        return res.status(501).json({ error: 'PDF export unavailable: missing fonts. Add fonts/NotoSans-*.ttf to the repository.' })
      }
 
      try {
        let PdfPrinter: any = null
        try {
          PdfPrinter = require('pdfmake/src/printer')
        } catch (e1) {
          try {
            const pm = require('pdfmake')
            PdfPrinter = pm && (pm.Printer || pm.PdfPrinter || pm.default || pm)
          } catch (e2) {
            console.error('pdfmake require error', e1, e2)
            return res.status(500).json({ error: 'pdfmake module not found. Run: npm install pdfmake' })
          }
        }
        const fontsObj: any = {
           NotoSans: {
             normal: fontsPaths.normal,
             bold: fontsPaths.bold
           }
         }
         const printer = new PdfPrinter(fontsObj)

        const header: string[] = rows.length ? rows[0].map(h => (h || '').toString()) : []
        const body: Array<Array<any>> = []
        if (header.length) {
          body.push(header.map(h => ({ text: h, style: 'tableHeader' })))
          for (let i = 1; i < rows.length; i++) {
            body.push(rows[i].map(c => ({ text: (c || '').toString() })))
          }
        } else {
          body.push([{ text: 'empty', colSpan: 1 } as any])
        }

        const colCount = header.length || 0
        const pageOrientation = colCount > 6 ? 'landscape' : 'portrait'
        const computedFontSize = colCount > 10 ? 8 : (colCount > 6 ? 9 : 10)
        const widths = header.length ? header.map(() => (colCount > 12 ? 'auto' : '*')) : ['*']

        const compactTableLayout: any = {
          hLineWidth: (i: number, node: any) => 0.5,
          vLineWidth: (i: number, node: any) => 0.5,
          paddingLeft: (i: number, node: any) => 6,
          paddingRight: (i: number, node: any) => 6,
          paddingTop: (i: number, node: any) => 4,
          paddingBottom: (i: number, node: any) => 4
        }

        const docDefinition: any = {
          pageSize: 'A4',
          pageOrientation,
          content: [
            { text: `Отчет: ${type || ''} — ${ts}`, style: 'title' },
            {
              table: {
                headerRows: header.length ? 1 : 0,
                widths,
                body
              },
              layout: compactTableLayout,
              margin: [0, 8, 0, 0]
            }
          ],
          styles: {
            title: { fontSize: 14, bold: true, margin: [0, 0, 0, 8] },
            tableHeader: { bold: true, fillColor: '#f3f4f6' }
          },
          defaultStyle: { font: 'NotoSans', fontSize: computedFontSize, lineHeight: 1.05 }
        }

        const pdfDoc = printer.createPdfKitDocument(docDefinition)
        const chunks: any[] = []
        pdfDoc.on('data', (chunk: any) => chunks.push(chunk))
        pdfDoc.on('end', () => {
          const result = Buffer.concat(chunks)
          const filenameBasePdf = csvFilename && typeof csvFilename === 'string' ? csvFilename.replace(/\.csv$/i, '') : (type || 'report')
          const filename = `${filenameBasePdf}-${ts}.pdf`
          res.setHeader('Content-Type', 'application/pdf')
          res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition')
          res.setHeader('Content-Disposition', contentDispositionHeader(filename))
          res.setHeader('Content-Length', String(result.length))
          return res.end(result)
        })
        pdfDoc.end()
        return
      } catch (err) {
        console.error('PDF generation error (pdfmake)', err)
        return res.status(500).json({ error: 'failed to generate PDF (see server logs for details)' })
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

{
  const fs = require('fs')
  const repoFonts = path.join(__dirname, '..', 'fonts')
  const normal = fs.existsSync(path.join(repoFonts, 'NotoSans-Regular.ttf'))
  const bold = fs.existsSync(path.join(repoFonts, 'NotoSans-Bold.ttf'))
  console.info(`Fonts: NotoSans-Regular=${normal}, NotoSans-Bold=${bold}`)
}

// bulk adjust route (keep creating individual transaction rows; no schema change)
app.post('/api/transactions/bulk-adjust', async (req: Request, res: Response) => {
  const { type, items, supplierId, destinationId, workerId, date, note } = req.body;
  if (!['in', 'out'].includes(type)) return res.status(400).json({ error: 'type must be in|out' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items required' });

  // Normalize and validate items
  const parsedItems = items.map((it: any) => ({
    productId: Number(it.productId),
    delta: Number(it.delta)
  }));

  for (const it of parsedItems) {
    if (!Number.isInteger(it.productId) || it.productId <= 0) return res.status(400).json({ error: 'invalid productId in items' });
    if (!Number.isInteger(it.delta) || it.delta <= 0) return res.status(400).json({ error: 'each delta must be positive integer' });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Load involved products
      const productIds = Array.from(new Set(parsedItems.map(p => p.productId)));
      const products = await tx.product.findMany({ where: { id: { in: productIds } } });
      const prodMap: Record<number, any> = {};
      products.forEach(p => prodMap[p.id] = p);

      // Verify all products exist
      for (const id of productIds) {
        if (!prodMap[id]) throw new Error(`product not found: ${id}`);
      }

      // Optionally fetch supplier/destination/worker names (common for all items)
      let supplierName: string | undefined = undefined;
      let destinationName: string | undefined = undefined;
      if (supplierId) {
        const s = await tx.supplier.findUnique({ where: { id: Number(supplierId) } });
        if (!s) throw new Error('supplier not found');
        supplierName = s.name;
      }
      if (destinationId) {
        const d = await tx.location.findUnique({ where: { id: Number(destinationId) } });
        if (!d) throw new Error('destination not found');
        destinationName = d.name;
      }
      if (workerId) {
        const w = await tx.worker.findUnique({ where: { id: Number(workerId) } });
        if (!w) throw new Error('worker not found');
      }

      // Compute and validate new quantities (support multiple adjustments that might target same product)
      const deltasPerProduct: Record<number, number> = {};
      parsedItems.forEach(it => {
        const sign = type === 'out' ? -Math.abs(it.delta) : Math.abs(it.delta);
        deltasPerProduct[it.productId] = (deltasPerProduct[it.productId] || 0) + sign;
      });

      for (const pidStr of Object.keys(deltasPerProduct)) {
        const pid = Number(pidStr);
        const p = prodMap[pid];
        const newQty = p.quantity + deltasPerProduct[pid];
        if (newQty < 0) throw new Error(`not enough stock for product ${pid}`);
        if (newQty > 65535) throw new Error(`exceeds max stock 65535 for product ${pid}`);
      }

      // Apply updates and create transactions
      const createdTxs: any[] = [];
      for (const it of parsedItems) {
        const product = prodMap[it.productId];
        const numericDelta = type === 'out' ? -Math.abs(it.delta) : Math.abs(it.delta);
        const tData: any = {
          productId: product.id,
          productName: product.name,
          delta: numericDelta,
          type,
          date: date ? new Date(date) : undefined,
          supplierName,
          destinationName,
          supplierId: supplierId ? Number(supplierId) : undefined,
          destinationId: destinationId ? Number(destinationId) : undefined,
          workerId: workerId ? Number(workerId) : undefined,
          note: note ?? undefined
        };
        const t = await tx.transaction.create({ data: tData });
        createdTxs.push(t);
        // update product quantity incrementally
        await tx.product.update({ where: { id: product.id }, data: { quantity: product.quantity + numericDelta } });
        // reflect change to product.quantity for subsequent updates targeting same product
        product.quantity = product.quantity + numericDelta;
      }

      return { transactions: createdTxs };
    });

    res.json(result);
  } catch (err: any) {
    console.error('bulk-adjust error', err);
    if (err.message && err.message.startsWith('not enough')) {
      return res.status(400).json({ error: err.message });
    }
    if (err.message && err.message.startsWith('exceeds')) {
      return res.status(400).json({ error: err.message });
    }
    if (err.message && err.message.startsWith('product not found')) {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: 'failed to perform bulk adjust' });
  }
});

const port = process.env.PORT ?? 3000
app.listen(port, () => console.log(`server started on http://localhost:${port}`))