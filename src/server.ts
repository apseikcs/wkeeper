import * as dotenv from 'dotenv'
dotenv.config()

import { prisma } from './prisma'
import { Prisma } from '@prisma/client'
import type { Request, Response, NextFunction } from 'express'
import express from 'express'
import path from 'path'
import cors from 'cors'
import { startOfDay } from './dateUtils'
import { comparePassword, generateToken, verifyToken } from './auth'
import * as ExcelJS from 'exceljs'
import * as fs from 'fs'

const app = express()
app.use(cors())
app.use(express.json())

const authenticateToken = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization']
  const token = authHeader && (authHeader as string).split(' ')[1]

  if (token == null) return res.sendStatus(401)

  const payload = verifyToken(token as string) 
  if (!payload) return res.sendStatus(403);

  (req as any).authUser = payload 
  next()
}

// allow public endpoints (e.g. /api/login) to bypass auth; protect all other /api routes
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  const publicPaths = ['/login'] // add more public API paths here if needed
  if (publicPaths.includes(req.path)) return next()
  return authenticateToken(req, res, next)
})

async function getDbUserFromReq(req: Request) {
  const authUser = (req as any).authUser
  if (!authUser || !authUser.id) return null
  const dbUser = await prisma.user.findUnique({ where: { id: Number(authUser.id) } })
  return dbUser
}

const authorizePermission = (permission: string) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const dbUser = await getDbUserFromReq(req)
    if (!dbUser) return res.sendStatus(403)

    if (dbUser.username === 'axelerator') return next()
    if (dbUser.role === 'admin') return next()

    const perms: any = dbUser.permissions || {}
    if (permission === 'inventory:transact') {
      if (dbUser.role === 'worker') {
        if (perms && perms['inventory:transact'] === false) {
          return res.status(403).json({ error: 'Forbidden: permission denied' })
        } else {
          return next()
        }
      }
    }

    if (perms && perms[permission]) return next()

    return res.status(403).json({ error: 'Forbidden: insufficient permissions' })
  }
}

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

  const token = generateToken(user.id, user.username, user.role)
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

const authorizeRole = (allowedRoles: string[]) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers['authorization']
    const token = authHeader && (authHeader as string).split(' ')[1]
    
    if (!token) return res.sendStatus(401)
    
    const user = verifyToken(token as string)
    if (!user) return res.sendStatus(403)
    
    const dbUser = await prisma.user.findUnique({ where: { id: user.id } })
    if (!dbUser) return res.sendStatus(403)
    
    if (dbUser.username === 'axelerator') {
      return next()
    }
    
    if (!allowedRoles.includes(dbUser.role)) {
      return res.status(403).json({ error: 'Forbidden: insufficient role' })
    }
    
    next()
  }
}

app.get('/api/me', authenticateToken, async (req: Request, res: Response) => {
  // use attached authUser instead of re-parsing token
  const authUser = (req as any).authUser
  if (!authUser) return res.sendStatus(403)

  const dbUser = await prisma.user.findUnique({ where: { id: Number(authUser.id) } })
  if (!dbUser) return res.sendStatus(404)
  
  res.json({
    id: dbUser.id,
    username: dbUser.username,
    role: dbUser.role,
    permissions: dbUser.permissions
  })
})

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
  try {
    const transactions = await prisma.transaction.findMany({
      take: 5,
      orderBy: { date: 'desc' },
      include: {
        items: {
          include: { product: { select: { id: true, name: true } } }
        },
        worker: { select: { id: true, fullName: true } },
        supplier: { select: { id: true, name: true } },
        destination: { select: { id: true, name: true } },
        author: { select: { id: true, username: true } }
      }
    })

    const items = transactions.flatMap(t => 
      t.items.map(item => ({
        id: t.id,
        date: t.date,
        type: t.type,
        productId: item.productId,
        productName: item.productName,
        delta: item.delta,
        supplierId: t.supplierId,
        supplierName: t.supplierName || t.supplier?.name,
        destinationId: t.destinationId,
        destinationName: t.destinationName || t.destination?.name,
        workerId: t.workerId,
        workerUsername: null,
        workerName: t.worker?.fullName || null,
        authorUsername: t.author?.username || null,
        note: t.note,
        product: item.product,
        worker: t.worker,
        supplier: t.supplier,
        destination: t.destination
      }))
    )

    res.json(items)
  } catch (e) {
    console.error('failed to fetch recent transactions', e)
    res.status(500).json({ error: 'failed to fetch recent transactions' })
  }
})

app.get('/api/products', async (req: Request, res: Response) => {
  const search = String(req.query.search || '').trim()
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100))
  const offset = (page - 1) * limit

  // We'll return lightweight product metadata plus the most-recent
  // incoming supplier name (if any) to allow the UI to show a supplier
  // column without fetching full transaction lists per product.
  const qParam = search ? `%${search.replace(/%/g, '\%')}%` : null

  // Use a single DB query that left-joins the latest incoming transaction
  // (type='in') per product and reads the supplier name.
  // Postgres-specific SQL is used here (double quotes, DISTINCT ON).
  let rows: Array<any>
  let totalCount: number
  
  if (qParam) {
    const countResult = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) as count FROM product p WHERE lower(p.name) LIKE lower(${qParam})
    `
    totalCount = Number(countResult[0]?.count || 0)
    
    rows = await prisma.$queryRaw`
      SELECT p.id, p.name, p.unit, p.quantity, p.sku, p."updatedAt",
        COALESCE(ti_last."supplierName", s.name) as "supplierName"
      FROM product p
      LEFT JOIN (
        SELECT DISTINCT ON (ti."productId") ti."productId", t."supplierId", t."supplierName"
        FROM "TransactionItem" ti
        JOIN "transaction" t ON ti."transactionId" = t.id
        WHERE t.type = 'in' AND t."supplierId" IS NOT NULL
        ORDER BY ti."productId", t.date DESC
      ) ti_last ON ti_last."productId" = p.id
      LEFT JOIN supplier s ON s.id = ti_last."supplierId"
      WHERE lower(p.name) LIKE lower(${qParam})
      ORDER BY p."updatedAt" DESC
      LIMIT ${limit} OFFSET ${offset}
    `
  } else {
    const countResult = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) as count FROM product
    `
    totalCount = Number(countResult[0]?.count || 0)
    
    rows = await prisma.$queryRaw`
      SELECT p.id, p.name, p.unit, p.quantity, p.sku, p."updatedAt",
        COALESCE(ti_last."supplierName", s.name) as "supplierName"
      FROM product p
      LEFT JOIN (
        SELECT DISTINCT ON (ti."productId") ti."productId", t."supplierId", t."supplierName"
        FROM "TransactionItem" ti
        JOIN "transaction" t ON ti."transactionId" = t.id
        WHERE t.type = 'in' AND t."supplierId" IS NOT NULL
        ORDER BY ti."productId", t.date DESC
      ) ti_last ON ti_last."productId" = p.id
      LEFT JOIN supplier s ON s.id = ti_last."supplierId"
      ORDER BY p."updatedAt" DESC
      LIMIT ${limit} OFFSET ${offset}
    `
  }

  // Aggregate suppliers per product (so we don't silently overwrite many suppliers
  // with a single latest supplier). This returns for each product a list of
  // suppliers with totals and last supply date.
  const productIds = Array.isArray(rows) ? rows.map(r => r.id) : []
  if (productIds.length > 0) {
    // Build a safe, parameterized list of ids using Prisma.sql + Prisma.join
    const idSql = Prisma.join(productIds.map(id => Prisma.sql`${id}`))
    const supplyRows: Array<{ supplierId: number, productId: number, supplierName: string, total: number, lastDate: string }> = await prisma.$queryRaw(Prisma.sql`
      SELECT t."supplierId" as "supplierId", ti."productId" as "productId", s.name as "supplierName", SUM(ABS(ti.delta)) as total, MAX(t.date) as "lastDate"
      FROM "TransactionItem" ti
      JOIN "transaction" t ON ti."transactionId" = t.id
      JOIN "supplier" s ON s.id = t."supplierId"
      WHERE t.type = 'in' AND t."supplierId" IS NOT NULL AND ti."productId" IN (${idSql})
      GROUP BY t."supplierId", ti."productId", s.name
    `)

    const supMap: Record<number, Array<{ supplierId: number, name: string, total: number, lastDate: string }>> = {}
    supplyRows.forEach(r => {
      if (!supMap[r.productId]) supMap[r.productId] = []
      supMap[r.productId].push({ supplierId: r.supplierId, name: r.supplierName, total: Number(r.total), lastDate: String(r.lastDate) })
    })

    // Attach sorted `supplied` array to each product row
    rows = rows.map(p => {
      const supplied = (supMap[p.id] || []).sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate))
      return { ...p, supplied }
    })
  }

  // Return paginated response
  res.json({
    page,
    limit,
    total: totalCount,
    items: Array.isArray(rows) ? rows : []
  })
})


// (Deprecated) product-history endpoint removed — transaction history is
// available via `/api/transactions` and the transaction search UI.

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

  if (qRaw > 0) {
    try {
      const t = await prisma.transaction.create({
        data: {
          type: 'in',
          supplierName: supplierId ? (await prisma.supplier.findUnique({ where: { id: Number(supplierId) } }))?.name : null,
          supplierId: supplierId ? Number(supplierId) : null
        }
      })
      
      await prisma.transactionItem.create({
        data: {
          transactionId: t.id,
          productId: p.id,
          productName: p.name,
          productSku: p.sku,
          delta: qRaw
        }
      })
    } catch (e) {
      console.error('failed to create initial transaction', e)
    }
  }

  res.json(p)
})

app.post('/api/products/:id/adjust', authorizePermission('inventory:transact'), async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const { delta, type, supplierId, destinationId, workerId, date, note } = req.body
  if (!['in', 'out'].includes(type)) return res.status(400).json({ error: 'type must be in|out' })
  const rawDelta = Number(delta)
  if (!Number.isInteger(rawDelta) || rawDelta <= 0) {
    return res.status(400).json({ error: 'delta must be a positive integer' })
  }
  const numericDelta = type === 'out' ? -Math.abs(rawDelta) : Math.abs(rawDelta)

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

      const authUser = (req as any).authUser
      const tData: any = {
        type,
        date: date ? new Date(date) : undefined,
        supplierName,
        destinationName,
        supplierId: supplierId ? Number(supplierId) : undefined,
        destinationId: destinationId ? Number(destinationId) : undefined,
        workerId: workerId ? Number(workerId) : undefined,
        note,
        authorId: authUser?.id ? Number(authUser.id) : undefined
      }

      // create transaction and item, then apply atomic increment to product quantity
      const t = await tx.transaction.create({ data: tData })

      await tx.transactionItem.create({
        data: {
          transactionId: t.id,
          productId: id,
          productName: (await tx.product.findUnique({ where: { id }, select: { name: true } }))?.name || '',
          productSku: (await tx.product.findUnique({ where: { id }, select: { sku: true } }))?.sku,
          delta: numericDelta
        }
      })

      const updatedProduct = await tx.product.update({
        where: { id },
        data: { quantity: { increment: numericDelta } },
        select: { quantity: true }
      })

      if (updatedProduct.quantity < 0) throw new Error('not enough stock')
      if (updatedProduct.quantity > 65535) throw new Error('exceeds max stock 65535')

      return { transaction: t, newQty: updatedProduct.quantity }
    })

    res.json(updated)
  } catch (err: any) {
    console.error(err)
    if (err.message === 'not enough stock') return res.status(400).json({ error: 'not enough stock' })
    if (err.message && err.message.startsWith('exceeds')) return res.status(400).json({ error: 'exceeds max stock 65535' })
    if (err.message && err.message.includes('not found')) return res.status(404).json({ error: err.message })
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
      await prisma.$transaction(async (tx) => {
        const transactionIds = await tx.transactionItem.findMany({
          where: { productId: id },
          select: { transactionId: true },
          distinct: ['transactionId']
        })
        const ids = transactionIds.map(t => t.transactionId)
        
        await tx.transactionItem.deleteMany({ where: { productId: id } })
        
        for (const tid of ids) {
          const remainingItems = await tx.transactionItem.count({ where: { transactionId: tid } })
          if (remainingItems === 0) {
            await tx.transaction.delete({ where: { id: tid } })
          }
        }
        
        await tx.product.delete({ where: { id } })
      })
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

app.post('/api/workers', authenticateToken, authorizeRole(['admin']), async (req: Request, res: Response) => {
  const { fullName, phone, position, role } = req.body;
  
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

  const rows: Array<{ supplierId: number, productId: number, productName: string, total: number }> = await prisma.$queryRaw`
    SELECT t."supplierId" as "supplierId", ti."productId" as "productId", p.name as "productName", SUM(ABS(ti.delta)) as total
    FROM "TransactionItem" ti
    JOIN "transaction" t ON ti."transactionId" = t.id
    JOIN "product" p ON ti."productId" = p.id
    WHERE t."supplierId" IS NOT NULL AND t.type = 'in'
    GROUP BY t."supplierId", ti."productId", p.name
  `

  const map: Record<number, Array<{ productId: number, name: string, total: number }>> = {}
  rows.forEach(r => {
    if (!map[r.supplierId]) map[r.supplierId] = []
    map[r.supplierId].push({ productId: r.productId, name: r.productName, total: Number(r.total) })
  })

  const result = suppliers.map(s => ({ ...s, supplied: map[s.id] || [] }))
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
  const search = String(req.query.search || '').trim()
  const sortField = String(req.query.sort || 'id').trim()
  const sortDir = String(req.query.sortDir || 'asc').trim().toLowerCase() as 'asc' | 'desc'
  
  // Whitelist sort fields to prevent injection
  const validSortFields = ['id', 'name', 'city', 'district', 'address']
  const sort = validSortFields.includes(sortField) ? sortField : 'id'
  
  const where: any = showDeleted ? undefined : { deleted: false }
  
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { city: { contains: search, mode: 'insensitive' } },
      { district: { contains: search, mode: 'insensitive' } },
      { address: { contains: search, mode: 'insensitive' } }
    ]
  }
  
  const l = await prisma.location.findMany({
    where: where,
    orderBy: { [sort]: sortDir }
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
  let productFilter: number[] | undefined = undefined

  if (productId) {
    productFilter = [productId]
  } else if (searchProduct) {
    const q = `%${String(searchProduct).replace(/%/g, '\\%')}%`
    const rows: Array<{ id: number }> = await prisma.$queryRaw`
      SELECT id FROM product
      WHERE lower(name) LIKE lower(${q})
    `
    productFilter = rows.map(r => r.id)
    if (productFilter.length === 0) {
      return res.json({ page, limit, items: [] })
    }
  }

  if (entityType && entityId) {
    if (entityType === 'product') productFilter = [entityId]
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
    if (prodIds.length) productFilter = prodIds.map(r => r.id)
    if (supIds.length) anyFilter.push({ supplierId: { in: supIds.map(r=>r.id) } })
    if (locIds.length) anyFilter.push({ destinationId: { in: locIds.map(r=>r.id) } })
    if (workerIds.length) anyFilter.push({ workerId: { in: workerIds.map(r=>r.id) } })
    if (anyFilter.length) {
      where.OR = anyFilter
    } else if (!productFilter || productFilter.length === 0) {
      return res.json({ page, limit, items: [] })
    }
  }

  let transactionIds: number[] | undefined = undefined
  if (productFilter && productFilter.length > 0) {
    const items = await prisma.transactionItem.findMany({
      where: { productId: { in: productFilter } },
      select: { transactionId: true },
      distinct: ['transactionId']
    })
    transactionIds = items.map(i => i.transactionId)
    if (transactionIds.length === 0) {
      return res.json({ page, limit, items: [] })
    }
    where.id = { in: transactionIds }
  }

  let orderBy: any = {}
  switch (sort) {
    case 'date_asc': orderBy = { date: 'asc' }; break
    case 'date_desc': orderBy = { date: 'desc' }; break
    case 'worker_asc': orderBy = { worker: { fullName: 'asc' } }; break
    case 'worker_desc': orderBy = { worker: { fullName: 'desc' } }; break
    case 'type_asc': orderBy = { type: 'asc' }; break
    case 'type_desc': orderBy = { type: 'desc' }; break
    default: orderBy = { date: 'desc' }
  }

  // Count total transactions matching filter for pagination
  const totalTransactions = await prisma.transaction.count({ where })

  const transactions = await prisma.transaction.findMany({
    where,
    include: {
      items: {
        include: { product: { select: { id: true, name: true } } }
      },
      worker: { select: { id: true, fullName: true } },
      supplier: { select: { id: true, name: true } },
      destination: { select: { id: true, name: true } },
      author: { select: { id: true, username: true } }
    },
    orderBy,
    skip: (page - 1) * limit,
    take: limit
  })

  const flattenedItems = transactions.flatMap(t => 
    t.items.map(item => ({
      id: t.id,
      date: t.date,
      type: t.type,
      productId: item.productId,
      productName: item.productName,
      delta: item.delta,
      supplierId: t.supplierId,
      supplierName: t.supplierName || t.supplier?.name,
      destinationId: t.destinationId,
      destinationName: t.destinationName || t.destination?.name,
      workerId: t.workerId,
      workerUsername: null,
      workerName: t.worker?.fullName || null,
      authorUsername: t.author?.username || null,
      note: t.note,
      product: item.product,
      worker: t.worker
    }))
  )

  let sortedItems = flattenedItems
  if (sort === 'product_asc') {
    sortedItems = flattenedItems.sort((a, b) => (a.productName || '').localeCompare(b.productName || ''))
  } else if (sort === 'product_desc') {
    sortedItems = flattenedItems.sort((a, b) => (b.productName || '').localeCompare(a.productName || ''))
  } else if (sort === 'quantity_asc') {
    sortedItems = flattenedItems.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta))
  } else if (sort === 'quantity_desc') {
    sortedItems = flattenedItems.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  }

  res.json({ page, limit, total: totalTransactions, items: sortedItems })
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
  const { name, totalQuantity = 1 } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }
  if (totalQuantity < 1) {
    return res.status(400).json({ error: 'Total quantity must be at least 1' });
  }

  try {
    const tool = await prisma.tool.create({
      data: {
        name: String(name).trim(),
        totalQuantity: Number(totalQuantity),
        availableQuantity: Number(totalQuantity)
      }
    });
    res.json(tool);
  } catch (error) {
    console.error('Error creating tool:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/api/tools/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { name, totalQuantity } = req.body;
  try {
    if (!name || String(name).trim() === '') {
      return res.status(400).json({ error: 'Name is required' });
    }
    const updateData: any = { name: String(name).trim() };
    
    if (totalQuantity !== undefined) {
      const newTotal = Number(totalQuantity);
      if (newTotal < 1) {
        return res.status(400).json({ error: 'Total quantity must be at least 1' });
      }
      
      // Get current tool state to calculate issued quantity
      const currentTool = await prisma.tool.findUnique({ where: { id } });
      if (!currentTool) {
        return res.status(404).json({ error: 'Tool not found' });
      }
      
      // Calculate how many are currently issued
      const issued = currentTool.totalQuantity - currentTool.availableQuantity;
      
      // New total cannot be less than what's already issued
      if (newTotal < issued) {
        return res.status(400).json({ 
          error: `Cannot reduce total quantity below ${issued}. Currently ${issued} units are issued to workers.` 
        });
      }
      
      updateData.totalQuantity = newTotal;
      updateData.availableQuantity = newTotal - issued; // Preserve issued quantity
    }
    
    const tool = await prisma.tool.update({
      where: { id },
      data: updateData
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
  const { quantity = 1 } = req.body;

  try {
    const worker = await prisma.worker.findUnique({ where: { id: workerId } });
    const tool = await prisma.tool.findUnique({ where: { id: toolId } });

    if (!worker) {
      return res.status(404).json({ error: 'Worker not found' });
    }

    if (!tool) {
      return res.status(404).json({ error: 'Tool not found' });
    }

    const assignQty = Number(quantity);
    if (assignQty < 1) {
      return res.status(400).json({ error: 'Quantity must be at least 1' });
    }
    if (assignQty > tool.availableQuantity) {
      return res.status(400).json({ 
        error: `Not enough tools available. Available: ${tool.availableQuantity}, Requested: ${assignQty}` 
      });
    }

    // Use transaction to ensure consistency
    const [assignment] = await prisma.$transaction([
      prisma.toolAssignment.create({
        data: {
          toolId: toolId,
          workerId: workerId,
          quantity: assignQty
        },
        include: { worker: true }
      }),
      prisma.tool.update({
        where: { id: toolId },
        data: { availableQuantity: { decrement: assignQty } }
      })
    ]);

    res.json(assignment);
  } catch (error) {
    console.error('Error assigning tool:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/workers/:workerId/unassignTool/:toolId', async (req: Request, res: Response) => {
  const workerId = Number(req.params.workerId);
  const toolId = Number(req.params.toolId);
  const { quantity: returnQuantity } = req.body;

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

    // If no quantity specified, return all
    const qtyToReturn = returnQuantity ? Number(returnQuantity) : assignment.quantity;
    
    if (qtyToReturn < 1) {
      return res.status(400).json({ error: 'Return quantity must be at least 1' });
    }
    
    if (qtyToReturn > assignment.quantity) {
      return res.status(400).json({ 
        error: `Cannot return more than assigned. Assigned: ${assignment.quantity}, Requested: ${qtyToReturn}` 
      });
    }

    // Use transaction to ensure consistency
    if (qtyToReturn === assignment.quantity) {
      // Return all - mark as returned
      await prisma.$transaction([
        prisma.toolAssignment.update({
          where: { id: assignment.id },
          data: { returnedAt: new Date() }
        }),
        prisma.tool.update({
          where: { id: toolId },
          data: { availableQuantity: { increment: qtyToReturn } }
        })
      ]);
    } else {
      // Partial return - reduce quantity, don't mark as returned
      await prisma.$transaction([
        prisma.toolAssignment.update({
          where: { id: assignment.id },
          data: { quantity: { decrement: qtyToReturn } }
        }),
        prisma.tool.update({
          where: { id: toolId },
          data: { availableQuantity: { increment: qtyToReturn } }
        })
      ]);
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('Error unassigning tool:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

{
  const repoFonts = path.join(__dirname, '..', 'fonts')
  const normal = fs.existsSync(path.join(repoFonts, 'NotoSans-Regular.ttf'))
  const bold = fs.existsSync(path.join(repoFonts, 'NotoSans-Bold.ttf'))
  console.info(`Fonts: NotoSans-Regular=${normal}, NotoSans-Bold=${bold}`)
}

app.post('/api/transactions/bulk-adjust', authorizePermission('inventory:transact'), async (req: Request, res: Response) => {
  const { type, items, supplierId, destinationId, workerId, date, note } = req.body;
  if (!['in', 'out'].includes(type)) return res.status(400).json({ error: 'type must be in|out' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items required' });

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
      const productIds = Array.from(new Set(parsedItems.map(p => p.productId)));
      const products = await tx.product.findMany({ where: { id: { in: productIds } } });
      const prodMap: Record<number, any> = {};
      products.forEach(p => prodMap[p.id] = p);

      for (const id of productIds) {
        if (!prodMap[id]) throw new Error(`product not found: ${id}`);
      }

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

      const deltasPerProduct: Record<number, number> = {};
      parsedItems.forEach(it => {
        const sign = type === 'out' ? -Math.abs(it.delta) : Math.abs(it.delta);
        deltasPerProduct[it.productId] = (deltasPerProduct[it.productId] || 0) + sign;
      });

      // We'll rely on atomic increments when applying changes below; initial checks were done

      const authUser = (req as any).authUser
      const tData: any = {
        type,
        date: date ? new Date(date) : undefined,
        supplierName,
        destinationName,
        supplierId: supplierId ? Number(supplierId) : undefined,
        destinationId: destinationId ? Number(destinationId) : undefined,
        workerId: workerId ? Number(workerId) : undefined,
        note: note ? String(note).trim() : undefined,
        authorId: authUser?.id ? Number(authUser.id) : undefined
      };
      const t = await tx.transaction.create({ data: tData });

      const createdItems: any[] = [];
      for (const it of parsedItems) {
        const product = prodMap[it.productId];
        const numericDelta = type === 'out' ? -Math.abs(it.delta) : Math.abs(it.delta);
        
        const item = await tx.transactionItem.create({
          data: {
            transactionId: t.id,
            productId: product.id,
            productName: product.name,
            productSku: product.sku,
            delta: numericDelta
          }
        });
        createdItems.push(item);
      }

      for (const pidStr of Object.keys(deltasPerProduct)) {
        const pid = Number(pidStr);
        const totalDelta = deltasPerProduct[pid];
        const updated = await tx.product.update({
          where: { id: pid },
          data: { quantity: { increment: totalDelta } },
          select: { quantity: true, name: true }
        });
        if (updated.quantity < 0) throw new Error(`not enough stock for product ${updated.name} (ID: ${pid})`);
        if (updated.quantity > 65535) throw new Error(`exceeds max stock 65535 for product ${updated.name} (ID: ${pid})`);
      }

      return { transaction: t, items: createdItems };
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
    if (err.message && (err.message.includes('supplier not found') || err.message.includes('destination not found') || err.message.includes('worker not found'))) {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: 'failed to perform bulk adjust' });
  }
});

app.post('/api/transactions', authorizePermission('inventory:transact'), async (req: Request, res: Response) => {
  const { type, items, supplierId, destinationId, workerId, date, note } = req.body;
  if (!['in', 'out'].includes(type)) return res.status(400).json({ error: 'type must be in|out' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items required' });

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
      const productIds = Array.from(new Set(parsedItems.map(p => p.productId)));
      const products = await tx.product.findMany({ where: { id: { in: productIds } } });
      const prodMap: Record<number, any> = {};
      products.forEach(p => prodMap[p.id] = p);

      for (const id of productIds) {
        if (!prodMap[id]) throw new Error(`product not found: ${id}`);
      }

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

      const deltasPerProduct: Record<number, number> = {};
      parsedItems.forEach(it => {
        const sign = type === 'out' ? -Math.abs(it.delta) : Math.abs(it.delta);
        deltasPerProduct[it.productId] = (deltasPerProduct[it.productId] || 0) + sign;
      });

      for (const pidStr of Object.keys(deltasPerProduct)) {
        const pid = Number(pidStr);
        const p = prodMap[pid];
        const newQty = p.quantity + deltasPerProduct[pid];
        if (newQty < 0) throw new Error(`not enough stock for product ${p.name} (ID: ${pid})`);
        if (newQty > 65535) throw new Error(`exceeds max stock 65535 for product ${p.name} (ID: ${pid})`);
      }

      const authUser = (req as any).authUser
      const tData: any = {
        type,
        date: date ? new Date(date) : undefined,
        supplierName,
        destinationName,
        supplierId: supplierId ? Number(supplierId) : undefined,
        destinationId: destinationId ? Number(destinationId) : undefined,
        workerId: workerId ? Number(workerId) : undefined,
        note: note ? String(note).trim() : undefined,
        authorId: authUser?.id ? Number(authUser.id) : undefined
      };
      const t = await tx.transaction.create({ data: tData });

      const createdItems: any[] = [];
      for (const it of parsedItems) {
        const product = prodMap[it.productId];
        const numericDelta = type === 'out' ? -Math.abs(it.delta) : Math.abs(it.delta);
        
        const item = await tx.transactionItem.create({
          data: {
            transactionId: t.id,
            productId: product.id,
            productName: product.name,
            productSku: product.sku,
            delta: numericDelta
          }
        });
        createdItems.push(item);
      }

      for (const pidStr of Object.keys(deltasPerProduct)) {
        const pid = Number(pidStr);
        const totalDelta = deltasPerProduct[pid];
        const updated = await tx.product.update({
          where: { id: pid },
          data: { quantity: { increment: totalDelta } },
          select: { quantity: true, name: true }
        });
        if (updated.quantity < 0) throw new Error(`not enough stock for product ${updated.name} (ID: ${pid})`);
        if (updated.quantity > 65535) throw new Error(`exceeds max stock 65535 for product ${updated.name} (ID: ${pid})`);
      }

      return { transaction: t, items: createdItems };
    });

    res.json(result);
  } catch (err: any) {
    console.error('create transaction error', err);
    if (err.message && err.message.startsWith('not enough')) {
      return res.status(400).json({ error: err.message });
    }
    if (err.message && err.message.startsWith('exceeds')) {
      return res.status(400).json({ error: err.message });
    }
    if (err.message && err.message.startsWith('product not found')) {
      return res.status(404).json({ error: err.message });
    }
    if (err.message && (err.message.includes('supplier not found') || err.message.includes('destination not found') || err.message.includes('worker not found'))) {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: 'failed to create transaction' });
  }
});

app.post('/api/transactions/:id/items', async (req: Request, res: Response) => {
  const transactionId = Number(req.params.id);
  const { productId, delta } = req.body;

  try {
    const t = await prisma.transaction.findUnique({ where: { id: transactionId } });
    if (!t) return res.status(404).json({ error: 'transaction not found' });

    const product = await prisma.product.findUnique({ where: { id: Number(productId) } });
    if (!product) return res.status(404).json({ error: 'product not found' });

    const rawDelta = Number(delta);
    if (!Number.isInteger(rawDelta) || rawDelta <= 0) {
      return res.status(400).json({ error: 'delta must be positive integer' });
    }

    const numericDelta = t.type === 'out' ? -Math.abs(rawDelta) : Math.abs(rawDelta);
    
    if (t.type === 'out' && product.quantity + numericDelta < 0) {
      return res.status(400).json({ error: 'not enough stock' });
    }
    if (t.type === 'in' && product.quantity + numericDelta > 65535) {
      return res.status(400).json({ error: 'exceeds max stock 65535' });
    }

    const result = await prisma.$transaction(async (tx) => {
      const item = await tx.transactionItem.create({
        data: {
          transactionId,
          productId: product.id,
          productName: product.name,
          productSku: product.sku,
          delta: numericDelta
        }
      });

      const updated = await tx.product.update({
        where: { id: product.id },
        data: { quantity: { increment: numericDelta } },
        select: { quantity: true, name: true }
      });

      if (updated.quantity < 0) throw new Error('not enough stock')
      if (updated.quantity > 65535) throw new Error('exceeds max stock 65535')

      return item;
    });

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.delete('/api/transactions/:id/items/:itemId', async (req: Request, res: Response) => {
  const transactionId = Number(req.params.id);
  const itemId = Number(req.params.itemId);

  try {
    const item = await prisma.transactionItem.findUnique({
      where: { id: itemId },
      include: { transaction: true, product: true }
    });

    if (!item) return res.status(404).json({ error: 'item not found' });
    if (item.transactionId !== transactionId) {
      return res.status(400).json({ error: 'item does not belong to this transaction' });
    }

    const result = await prisma.$transaction(async (tx) => {
      if (item.product && item.delta !== 0) {
        const updated = await tx.product.update({
          where: { id: item.product.id },
          data: { quantity: { increment: -item.delta } },
          select: { quantity: true, name: true }
        });
        if (updated.quantity < 0) throw new Error('resulting quantity negative')
        if (updated.quantity > 65535) throw new Error('exceeds max stock 65535')
      }

      const deleted = await tx.transactionItem.delete({ where: { id: itemId } });

      return deleted;
    });

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.patch('/api/transactions/:id/items/:itemId', async (req: Request, res: Response) => {
  const transactionId = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  const { delta } = req.body;

  try {
    const item = await prisma.transactionItem.findUnique({
      where: { id: itemId },
      include: { transaction: true, product: true }
    });

    if (!item) return res.status(404).json({ error: 'item not found' });
    if (item.transactionId !== transactionId) {
      return res.status(400).json({ error: 'item does not belong to this transaction' });
    }

    const rawDelta = Number(delta);
    if (!Number.isInteger(rawDelta) || rawDelta <= 0) {
      return res.status(400).json({ error: 'delta must be positive integer' });
    }

    const numericDelta = item.transaction.type === 'out' ? -Math.abs(rawDelta) : Math.abs(rawDelta);
    const oldDelta = item.delta;
    const diff = numericDelta - oldDelta;

    if (item.product) {
      const newQty = item.product.quantity + diff;
      if (newQty < 0) return res.status(400).json({ error: 'not enough stock' });
      if (newQty > 65535) return res.status(400).json({ error: 'exceeds max stock' });
    }

    const result = await prisma.$transaction(async (tx) => {
      // re-load the transaction item inside the transaction to avoid races
      const cur = await tx.transactionItem.findUnique({ where: { id: itemId }, include: { product: true, transaction: true } });
      if (!cur) throw new Error('item not found')

      const actualDiff = numericDelta - cur.delta;
      if (cur.product) {
        const updated = await tx.product.update({
          where: { id: cur.product.id },
          data: { quantity: { increment: actualDiff } },
          select: { quantity: true, name: true }
        });
        if (updated.quantity < 0) throw new Error('not enough stock')
        if (updated.quantity > 65535) throw new Error('exceeds max stock 65535')
      }

      const updatedItem = await tx.transactionItem.update({ where: { id: itemId }, data: { delta: numericDelta } });
      return updatedItem;
    });

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

const port = process.env.PORT ?? 3000
app.listen(port, () => console.log(`server started on http://localhost:${port}`))