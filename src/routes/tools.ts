import { Router } from 'express'
import type { Request, Response } from 'express'
import { prisma } from '../prisma'

const router = Router()
router.get('/api/tools', async (req: Request, res: Response) => {
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

router.post('/api/tools', async (req: Request, res: Response) => {
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

router.patch('/api/tools/:id', async (req: Request, res: Response) => {
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

router.delete('/api/tools/:id', async (req: Request, res: Response) => {
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

export { router as toolsRouter }
