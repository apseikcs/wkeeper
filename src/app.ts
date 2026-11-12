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
import { authenticateToken, apiAuth } from './middleware/auth'
import { authorizeRole, authorizePermission } from './middleware/permissions'

import { authRouter } from './routes/auth'
import { searchStatsRouter } from './routes/search-stats'
import { productsRouter } from './routes/products'
import { suppliersRouter } from './routes/suppliers'
import { locationsRouter } from './routes/locations'
import { workersRouter } from './routes/workers'
export const app = express()
app.use(cors())
app.use(express.json())
app.use('/api', apiAuth)



app.use(express.static(path.join(__dirname, '..', 'frontend')))

app.use('/fonts', express.static(path.join(__dirname, '..', 'fonts'), {
  maxAge: '30d',
  setHeaders: (res: any, filePath: string) => {
    if (filePath.endsWith('.ttf')) res.setHeader('Content-Type', 'font/ttf')
    if (filePath.endsWith('.otf')) res.setHeader('Content-Type', 'font/otf')
    res.setHeader('Access-Control-Allow-Origin', '*')
  }
}))




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



// (Deprecated) product-history endpoint removed — transaction history is
// available via `/api/transactions` and the transaction search UI.


















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
app.use(authRouter)
app.use(searchStatsRouter)
app.use(productsRouter)
app.use(suppliersRouter)
app.use(locationsRouter)
app.use(workersRouter)
