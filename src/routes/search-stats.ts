import { Router } from 'express'
import type { Request, Response } from 'express'
import { prisma } from '../prisma'
import { startOfDay } from '../dateUtils'

const router = Router()
router.get('/api/stats', async (req: Request, res: Response) => {
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

router.get('/api/search', async (req: Request, res: Response) => {
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

export { router as searchStatsRouter }
