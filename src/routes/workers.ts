import { Router } from 'express'
import type { Request, Response } from 'express'
import { prisma } from '../prisma'
import { authenticateToken } from '../middleware/auth'
import { authorizeRole } from '../middleware/permissions'

const router = Router()
router.get('/api/workers', async (req: Request, res: Response) => {
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

router.post('/api/workers', authenticateToken, authorizeRole(['admin']), async (req: Request, res: Response) => {
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

router.delete('/api/workers/:id', async (req: Request, res: Response) => {
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

router.patch('/api/workers/:id', async (req: Request, res: Response) => {
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

router.post('/api/workers/:workerId/assignTool/:toolId', async (req: Request, res: Response) => {
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

router.post('/api/workers/:workerId/unassignTool/:toolId', async (req: Request, res: Response) => {
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

export { router as workersRouter }
