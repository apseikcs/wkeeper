import { Router } from 'express'
import type { Request, Response } from 'express'
import { prisma } from '../prisma'

const router = Router()
router.get('/api/suppliers', async (req: Request, res: Response) => {
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

router.post('/api/suppliers', async (req: Request, res: Response) => {
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

router.delete('/api/suppliers/:id', async (req: Request, res: Response) => {
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

router.patch('/api/suppliers/:id', async (req: Request, res: Response) => {
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

export { router as suppliersRouter }
