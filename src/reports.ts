import { prisma } from './prisma'
import { startOfDay, endOfDay, nowInMoscow } from './dateUtils'

export interface InventoryStatus {
  id: number;
  name: string;
  currentStock: number;
  unit: string;
  monthlyInflow: number;
  monthlyOutflow: number;
  turnoverRate: number;
  lastMovement: Date | null;
}

export interface TransactionSummary {
  total: number;
  incoming: number;
  outgoing: number;
  byProduct: Record<string, any[]>;
  byWorker: Record<string, any[]>;
  bySupplier: Record<string, any[]>;
  byDestination: Record<string, any[]>;
  daily: Array<{ date: string; in: number; out: number; total: number }>;
}

export interface WorkerPerformance {
  workerId: number;
  workerName: string;
  transactionCount: number;
  totalQuantity: number;
}

export interface ConsumptionForecast {
  productId: number;
  productName: string;
  currentStock: number;
  avgDailyConsumption: number;
  daysToStockout: number | null;
}

export interface DestinationStats {
  destinationId: number;
  destinationName: string;
  transactionCount: number;
  totalQuantity: number;
}

export interface SupplierStats {
  supplierId: number;
  supplierName: string;
  transactionCount: number;
  totalQuantity: number;
}

export async function getInventoryStatus(): Promise<InventoryStatus[]> {
  const products = await prisma.product.findMany({ orderBy: { name: 'asc' } })

  const now = nowInMoscow();
  const monthStart = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1));
  const monthEnd = endOfDay(new Date(now.getFullYear(), now.getMonth() + 1, 0));

  const monthlyByTypeIn = await prisma.transactionItem.groupBy({
    by: ['productId'],
    where: {
      productId: { in: products.map(p => p.id) },
      transaction: { date: { gte: monthStart, lte: monthEnd }, type: 'in' }
    },
    _sum: { delta: true }
  });
  const monthlyByTypeOut = await prisma.transactionItem.groupBy({
    by: ['productId'],
    where: {
      productId: { in: products.map(p => p.id) },
      transaction: { date: { gte: monthStart, lte: monthEnd }, type: 'out' }
    },
    _sum: { delta: true }
  });

  const flowIn = new Map(monthlyByTypeIn.map(f => [f.productId, ((f._sum as any)?.delta ?? 0)]));
  const flowOut = new Map(monthlyByTypeOut.map(f => [f.productId, Math.abs(((f._sum as any)?.delta ?? 0))]));

  const recentItems = await prisma.transactionItem.findMany({
    where: { productId: { in: products.map(p => p.id) } },
    include: { transaction: { select: { date: true } } },
    orderBy: { transaction: { date: 'desc' } }
  });
  const lastMoveMap = new Map<number, Date>();
  for (const it of recentItems) {
    if (it.productId != null && !lastMoveMap.has(it.productId)) {
      lastMoveMap.set(it.productId, it.transaction?.date || null as any);
    }
  }

  return products.map(p => {
    const inFlow = flowIn.get(p.id) || 0;
    const outFlow = flowOut.get(p.id) || 0;
    return {
      id: p.id,
      name: p.name,
      currentStock: p.quantity,
      unit: p.unit,
      monthlyInflow: inFlow,
      monthlyOutflow: outFlow,
      turnoverRate: p.quantity > 0 ? (outFlow / (p.quantity + outFlow)) : (outFlow > 0 ? 1 : 0),
      lastMovement: lastMoveMap.get(p.id) || null
    } as InventoryStatus;
  });
}

export async function getTransactionSummary(from?: Date, to?: Date): Promise<TransactionSummary> {
  const whereDate: any = {}
  if (from || to) {
    whereDate.date = {
      ...(from ? { gte: startOfDay(from) } : {}),
      ...(to ? { lte: endOfDay(to) } : {})
    }
  }

  const transactions: any[] = await prisma.transaction.findMany({
    where: whereDate,
    include: { items: true, worker: true, supplier: true, destination: true, product: true },
    orderBy: { date: 'desc' }
  });
   
  const dailyTotals = transactions.reduce((acc: Record<string, { in: number, out: number, total: number }>, t: any) => {
    const day = startOfDay(new Date(t.date)).toISOString();
    if (!acc[day]) acc[day] = { in: 0, out: 0, total: 0 };
    const countItems = Array.isArray(t.items) ? t.items.length : 1;
    if (t.type === 'in') acc[day].in += countItems;
    if (t.type === 'out') acc[day].out += countItems;
    acc[day].total += countItems;
    return acc;
  }, {});
 
  const sortedDaily = Object.entries(dailyTotals)
    .map(([date, stats]) => ({ date, ...stats }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const flatItems = transactions.flatMap((t: any) => {
    if (Array.isArray(t.items) && t.items.length) {
      return t.items.map((item: any) => ({
        productId: item.productId,
        productName: item.productName || (item.product && item.product.name),
        delta: item.delta,
        type: t.type,
        workerId: t.workerId,
        supplierId: t.supplierId,
        destinationId: t.destinationId
      }));
    }
    return [{
      productId: t.productId,
      productName: t.productName || (t.product && t.product.name),
      delta: t.delta,
      type: t.type,
      workerId: t.workerId,
      supplierId: t.supplierId,
      destinationId: t.destinationId
    }];
  });

  return {
    total: flatItems.length,
    incoming: flatItems.filter(i => i.type === 'in').length,
    outgoing: flatItems.filter(i => i.type === 'out').length,
    byProduct: groupBy(flatItems.filter(i => i.productId !== null && i.productId !== undefined), i => i.productId!),
    byWorker: groupBy(flatItems.filter(i => i.workerId !== null && i.workerId !== undefined), i => i.workerId!),
    bySupplier: groupBy(flatItems.filter(i => i.supplierId !== null && i.supplierId !== undefined), i => i.supplierId!),
    byDestination: groupBy(flatItems.filter(i => i.destinationId !== null && i.destinationId !== undefined), i => i.destinationId!),
    daily: sortedDaily
  } as TransactionSummary;
}

function groupBy<T, K extends string | number | symbol>(array: T[], keySelector: (item: T) => K): Record<K, T[]> {
  return array.reduce((result, item) => {
    const key = keySelector(item);
    if (!result[key]) {
      result[key] = [];
    }
    result[key].push(item);
    return result;
  }, {} as Record<K, T[]>);
}

export async function getTopProducts(from?: Date, to?: Date, limit: number = 20) {
  const whereDate: any = {}
  if (from || to) {
    whereDate.date = {
      ...(from ? { gte: startOfDay(from) } : {}),
      ...(to ? { lte: endOfDay(to) } : {})
    }
  }

  const result = await prisma.transactionItem.groupBy({
    by: ['productId', 'productName'],
    where: {
      transaction: { type: 'out', ...whereDate }
    },
    _sum: { delta: true },
    orderBy: { _sum: { delta: 'desc' } as any },
    take: limit
  });
  
  return result.map(r => ({
    id: r.productId,
    name: r.productName,
    total: Math.abs(((r._sum as any)?.delta ?? 0))
  }));
}

export async function getLowStock(threshold: number = 10) {
  return prisma.product.findMany({
    where: {
      quantity: { lte: threshold }
    },
    orderBy: { quantity: 'asc' }
  })
}

function toCsv(data: any[], columns: { key: string, title: string }[]): string {
  const header = columns.map(c => c.title).join(',') + '\n'
  const rows = data.map(row => {
    return columns.map(c => {
      let val = row[c.key]
      if (val === null || val === undefined) val = ''
      const s = String(val)
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s
    }).join(',')
  }).join('\n')
  return '\uFEFF' + header + rows
}

export async function getWorkerPerformance(from?: Date, to?: Date): Promise<WorkerPerformance[]> {
  const whereDate: any = {}
  if (from || to) {
    whereDate.date = {
      ...(from ? { gte: startOfDay(from) } : {}),
      ...(to ? { lte: endOfDay(to) } : {})
    }
  }

  const workerRows = await prisma.transaction.findMany({
    where: { type: 'out', workerId: { not: null }, ...whereDate },
    select: { workerId: true },
    distinct: ['workerId']
  });
  const workerIds = workerRows.map(t => t.workerId).filter(Boolean) as number[];

  const results = await Promise.all(workerIds.map(async wid => {
    const count = await prisma.transactionItem.count({
      where: { transaction: { type: 'out', workerId: wid, ...whereDate } }
    });
    const sum = await prisma.transactionItem.aggregate({
      where: { transaction: { type: 'out', workerId: wid, ...whereDate } },
      _sum: { delta: true }
    });
    const worker = await prisma.worker.findUnique({ where: { id: wid } });
    return {
      workerId: wid,
      workerName: worker?.fullName || `удаленный #${wid}`,
      transactionCount: count,
      totalQuantity: Math.abs(((sum._sum as any)?.delta ?? 0))
    } as WorkerPerformance;
  }));

  const workers = await prisma.worker.findMany({ where: { deleted: false } })
  workers.forEach(w => {
    if (!results.some(r => r.workerId === w.id)) {
      results.push({
        workerId: w.id,
        workerName: w.fullName,
        transactionCount: 0,
        totalQuantity: 0
      })
    }
  })

  return results.sort((a, b) => b.totalQuantity - a.totalQuantity)
}

export async function getConsumptionForecast(periodDays: number = 30): Promise<ConsumptionForecast[]> {
  const products = await prisma.product.findMany({ where: { quantity: { gt: 0 } } })
  if (!products.length) return []

  const periodStart = new Date()
  periodStart.setDate(periodStart.getDate() - periodDays)

  const consumption = await prisma.transactionItem.groupBy({
    by: ['productId'],
    where: {
      transaction: { type: 'out', date: { gte: periodStart } }
    },
    _sum: { delta: true }
  });
  
  const consumptionMap = new Map(consumption.map(c => [c.productId, Math.abs(((c._sum as any)?.delta ?? 0))]));

  const forecast = products.map(p => {
    const totalConsumed = consumptionMap.get(p.id) || 0
    const avgDailyConsumption = totalConsumed / periodDays
    const daysToStockout = avgDailyConsumption > 0 ? p.quantity / avgDailyConsumption : null

    return {
      productId: p.id,
      productName: p.name,
      currentStock: p.quantity,
      avgDailyConsumption,
      daysToStockout
    }
  })

  return forecast
    .filter(f => f.daysToStockout !== null && f.daysToStockout <= 30)
    .sort((a, b) => a.daysToStockout! - b.daysToStockout!)
}

export async function getDestinationStats(from?: Date, to?: Date): Promise<DestinationStats[]> {
  const whereDate: any = {}
  if (from || to) {
    whereDate.date = {
      ...(from ? { gte: startOfDay(from) } : {}),
      ...(to ? { lte: endOfDay(to) } : {})
    }
  }

  const destRows = await prisma.transaction.findMany({
    where: { type: 'out', destinationId: { not: null }, ...whereDate },
    select: { destinationId: true },
    distinct: ['destinationId']
  })
  const destIds = destRows.map(t => t.destinationId).filter(Boolean) as number[]

  const results = await Promise.all(destIds.map(async did => {
    const count = await prisma.transactionItem.count({
      where: { transaction: { type: 'out', destinationId: did, ...whereDate } }
    });
    const sum = await prisma.transactionItem.aggregate({
      where: { transaction: { type: 'out', destinationId: did, ...whereDate } },
      _sum: { delta: true }
    });
    const dest = await prisma.location.findUnique({ where: { id: did } })
    return {
      destinationId: did,
      destinationName: dest?.name || `удаленный #${did}`,
      transactionCount: count,
      totalQuantity: Math.abs(((sum._sum as any)?.delta ?? 0))
    }
  }))

  return results.sort((a, b) => b.totalQuantity - a.totalQuantity)
}

export async function getSupplierStats(from?: Date, to?: Date): Promise<SupplierStats[]> {
  const whereDate: any = {}
  if (from || to) {
    whereDate.date = {
      ...(from ? { gte: startOfDay(from) } : {}),
      ...(to ? { lte: endOfDay(to) } : {})
    }
  }

  const supRows = await prisma.transaction.findMany({
    where: { type: 'in', supplierId: { not: null }, ...whereDate },
    select: { supplierId: true },
    distinct: ['supplierId']
  })
  const supIds = supRows.map(t => t.supplierId).filter(Boolean) as number[]

  const results = await Promise.all(supIds.map(async sid => {
    const count = await prisma.transactionItem.count({
      where: { transaction: { type: 'in', supplierId: sid, ...whereDate } }
    });
    const sum = await prisma.transactionItem.aggregate({
      where: { transaction: { type: 'in', supplierId: sid, ...whereDate } },
      _sum: { delta: true }
    });
    const sup = await prisma.supplier.findUnique({ where: { id: sid } })
    return {
      supplierId: sid,
      supplierName: sup?.name || `удаленный #${sid}`,
      transactionCount: count,
      totalQuantity: ((sum._sum as any)?.delta ?? 0)
    }
  }))

  return results.sort((a, b) => b.totalQuantity - a.totalQuantity)
}

export async function exportToCsv(type: string, from?: Date, to?: Date, extra: any = {}): Promise<{ csv: string, filename: string }> {
  const ts = new Date().toISOString().slice(0, 10)
  if (type === 'top-products') {
    const data = await getTopProducts(from, to, extra.limit || 100)
    const csv = toCsv(data, [
      { key: 'name', title: 'Товар' },
      { key: 'total', title: 'Расход' }
    ])
    return { csv, filename: `Топ-Товары-${ts}.csv` }
  }
  if (type === 'low-stock') {
    const data = await getLowStock(extra.threshold || 10)
    const csv = toCsv(data, [
      { key: 'id', title: 'ID' },
      { key: 'name', title: 'Товар' },
      { key: 'quantity', title: 'Остаток' }
    ])
    return { csv, filename: `Низкий остаток-${ts}.csv` }
  }
  if (type === 'worker-performance') {
    const data = await getWorkerPerformance(from, to)
    const csv = toCsv(data, [
      { key: 'workerName', title: 'Работник' },
      { key: 'transactionCount', title: 'Кол-во операций' },
      { key: 'totalQuantity', title: 'Всего товара в проводках' }
    ])
    return { csv, filename: `Статистика-Сотрудники-${ts}.csv` }
  }
  if (type === 'consumption-forecast') {
    const data = await getConsumptionForecast(extra.days || 30)
    const csv = toCsv(data.map(d => ({...d, daysToStockout: d.daysToStockout !== null ? Math.floor(d.daysToStockout) : ''})), [
      { key: 'productName', title: 'Товар' },
      { key: 'currentStock', title: 'Остаток' },
      { key: 'avgDailyConsumption', title: 'Сред. расход в день' },
      { key: 'daysToStockout', title: 'Дней до израсходования' }
    ])
    return { csv, filename: `Прогноз-Расхода-${ts}.csv` }
  }
  if (type === 'destination-stats') {
    const data = await getDestinationStats(from, to)
    const csv = toCsv(data, [
      { key: 'destinationName', title: 'Объект' },
      { key: 'transactionCount', title: 'Кол-во операций' },
      { key: 'totalQuantity', title: 'Всего товара поставлено' }
    ])
    return { csv, filename: `Статистика-Объекты-${ts}.csv` }
  }
  if (type === 'supplier-stats') {
    const data = await getSupplierStats(from, to)
    const csv = toCsv(data, [
      { key: 'supplierName', title: 'Поставщик' },
      { key: 'transactionCount', title: 'Кол-во операций' },
      { key: 'totalQuantity', title: 'Всего товара поставлено' }
    ])
    return { csv, filename: `Статистика-Поставщики-${ts}.csv` }
  }
  if (type === 'transactions') {
    const whereDate: { date?: { gte?: Date, lte?: Date } } = {}
    if (from || to) {
      whereDate.date = {
        ...(from ? { gte: startOfDay(from) } : {}),
        ...(to ? { lte: endOfDay(to) } : {})
      }
    }
    const data: any[] = await prisma.transaction.findMany({
      where: whereDate,
      include: {
        items: { include: { product: true } },
        worker: true,
        supplier: true,
        destination: true,
        product: true
      },
      orderBy: { date: 'desc' }
    });

    const rows = data.map(t => {
      const items = Array.isArray(t.items) && t.items.length ? t.items : (t.items || []);
      const map = new Map<string, number>();
      let total = 0;
      items.forEach((it: any) => {
        const name = it.productName || (it.product && it.product.name) || '—';
        const qty = Math.abs(it.delta || 0);
        total += qty;
        map.set(name, (map.get(name) || 0) + qty);
      });

      if (items.length === 0 && (t.productName || t.product)) {
        const name = t.productName || (t.product && t.product.name) || '—';
        const qty = Math.abs(t.delta || 0);
        total = qty;
        map.set(name, (map.get(name) || 0) + qty);
      }

      const itemsStr = Array.from(map.entries()).map(([n, q]) => `${n}(${q})`).join(', ');

      return {
        id: t.id,
        date: new Date(t.date).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }),
        productName: itemsStr,
        delta: total,
        type: t.type,
        supplierName: t.supplier?.name || t.supplierName || '',
        destinationName: t.destination?.name || t.destinationName || '',
        workerName: t.worker?.fullName || '',
        note: t.note || ''
      };
    });
     const csv = toCsv(rows, [
       { key: 'id', title: 'ID' },
       { key: 'date', title: 'Дата' },
       { key: 'productName', title: 'Товар' },
       { key: 'delta', title: 'Количество' },
       { key: 'type', title: 'Тип' },
       { key: 'supplierName', title: 'Поставщик' },
       { key: 'destinationName', title: 'Объект' },
       { key: 'workerName', title: 'Работник' },
       { key: 'note', title: 'Примечание' }
     ])
     return { csv, filename: `Проводки-${ts}.csv` }
   }
   throw new Error('unknown export type')
}