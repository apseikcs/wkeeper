import { Router } from 'express'
import type { Request, Response } from 'express'
import { prisma } from '../prisma'

const router = Router()
router.get('/api/locations', async (req: Request, res: Response) => {
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

router.post('/api/locations', async (req: Request, res: Response) => {
  const { name, city, district, address } = req.body
  if (!name) return res.status(400).json({ error: 'name required' })
  const existing = await prisma.location.findUnique({ where: { name } })
  if (existing) return res.status(400).json({ error: 'location exists' })
  const l = await prisma.location.create({ data: { name, city: city || null, district: district || null, address: address || null } as any })
  res.json(l)
})

router.delete('/api/locations/:id', async (req: Request, res: Response) => {
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

router.patch('/api/locations/:id', async (req: Request, res: Response) => {
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

export { router as locationsRouter }
