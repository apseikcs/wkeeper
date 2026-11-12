import { Router } from 'express'
import type { Request, Response } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../prisma'
import { authorizePermission } from '../middleware/permissions'

const router = Router()
router.get('/api/products', async (req: Request, res: Response) => {
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

router.post('/api/products', async (req: Request, res: Response) => {
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

router.post('/api/products/:id/adjust', authorizePermission('inventory:transact'), async (req: Request, res: Response) => {
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

router.delete('/api/products/:id', async (req: Request, res: Response) => {
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

router.patch('/api/products/:id', async (req: Request, res: Response) => {
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

export { router as productsRouter }
