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
  const products = await prisma.product.findMany({
    orderBy: { name: 'asc' }
  })

  const now = nowInMoscow();
  const monthStart = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1));
  const monthEnd = endOfDay(new Date(now.getFullYear(), now.getMonth() + 1, 0));

  const txStats = await prisma.transaction.groupBy({
    by: ['productId'],
    where: {
      productId: { in: products.map(p => p.id) },
      date: { gte: monthStart, lte: monthEnd }
    },
    _sum: { delta: true }
  })

  const lastMovements = await prisma.transaction.groupBy({
    by: ['productId'],
    where: { productId: { in: products.map(p => p.id) } },
    _max: { date: true }
  })
  const lastMoveMap = new Map(lastMovements.map(m => [m.productId, m._max.date]))

  const monthlyFlows = await prisma.transaction.groupBy({
    by: ['productId', 'type'],
    where: {
      productId: { in: products.map(p => p.id) },
      date: { gte: monthStart, lte: monthEnd }
    },
    _sum: { delta: true }
  })

  const flowMap = new Map<number, { in: number, out: number }>()
  monthlyFlows.forEach(f => {
    if (!f.productId) return;
    if (!flowMap.has(f.productId)) flowMap.set(f.productId, { in: 0, out: 0 });
    const current = flowMap.get(f.productId)!;
    if (f.type === 'in') current.in += f._sum.delta || 0;
    if (f.type === 'out') current.out += Math.abs(f._sum.delta || 0);
  });

  return products.map(p => {
    const flows = flowMap.get(p.id) || { in: 0, out: 0 };
    return {
      id: p.id,
      name: p.name,
      currentStock: p.quantity,
      unit: p.unit,
      monthlyInflow: flows.in,
      monthlyOutflow: flows.out,
      turnoverRate: p.quantity > 0 ? (flows.out / (p.quantity + flows.out)) : (flows.out > 0 ? 1 : 0),
      lastMovement: lastMoveMap.get(p.id) || null
    }
  })
}

export async function getTransactionSummary(from?: Date, to?: Date): Promise<TransactionSummary> {
  const whereDate: { date?: { gte?: Date, lte?: Date } } = {}
  if (from || to) {
    whereDate.date = {
      ...(from ? { gte: startOfDay(from) } : {}),
      ...(to ? { lte: endOfDay(to) } : {})
    }
  }

  const transactions = await prisma.transaction.findMany({
    where: whereDate,
    include: {
      product: true,
      worker: true,
      supplier: true,
      destination: true
    },
    orderBy: { date: 'desc' }
  })

  const dailyTotals = transactions.reduce((acc, t) => {
    const day = startOfDay(new Date(t.date)).toISOString()
    if (!acc[day]) acc[day] = { in: 0, out: 0, total: 0 }
    if (t.type === 'in') acc[day].in++
    if (t.type === 'out') acc[day].out++
    acc[day].total++
    return acc
  }, {} as Record<string, { in: number, out: number, total: number }>)

  const sortedDaily = Object.entries(dailyTotals)
    .map(([date, stats]) => ({ date, ...stats }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    total: transactions.length,
    incoming: transactions.filter(t => t.type === 'in').length,
    outgoing: transactions.filter(t => t.type === 'out').length,
    byProduct: groupBy(transactions.filter(t => t.productId !== null), t => t.productId!),
    byWorker: groupBy(transactions.filter(t => t.workerId !== null), t => t.workerId!),
    bySupplier: groupBy(transactions.filter(t => t.supplierId !== null), t => t.supplierId!),
    byDestination: groupBy(transactions.filter(t => t.destinationId !== null), t => t.destinationId!),
    daily: sortedDaily
  }
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
  const whereDate: { date?: { gte?: Date, lte?: Date } } = {}
  if (from || to) {
    whereDate.date = {
      ...(from ? { gte: startOfDay(from) } : {}),
      ...(to ? { lte: endOfDay(to) } : {})
    }
  }

  const result = await prisma.transaction.groupBy({
    by: ['productId', 'productName'],
    where: {
      type: 'out',
      ...whereDate
    },
    _sum: { delta: true },
    orderBy: { _sum: { delta: 'asc' } },
    take: limit
  })

  return result.map(r => ({
    id: r.productId,
    name: r.productName,
    total: Math.abs(r._sum.delta || 0)
  }))
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
  const whereDate: { date?: { gte?: Date, lte?: Date } } = {}
  if (from || to) {
    whereDate.date = {
      ...(from ? { gte: startOfDay(from) } : {}),
      ...(to ? { lte: endOfDay(to) } : {})
    }
  }

  const stats = await prisma.transaction.groupBy({
    by: ['workerId'],
    where: {
      type: 'out',
      workerId: { not: null },
      ...whereDate
    },
    _count: { id: true },
    _sum: { delta: true },
  })

  const workers = await prisma.worker.findMany({ where: { deleted: false } })
  const workerMap = new Map(workers.map(w => [w.id, w.fullName]))

  const results = stats.map(s => ({
    workerId: s.workerId!,
    workerName: workerMap.get(s.workerId!) || `удаленный #${s.workerId}`,
    transactionCount: s._count.id,
    totalQuantity: Math.abs(s._sum.delta || 0)
  }))

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

  const consumption = await prisma.transaction.groupBy({
    by: ['productId'],
    where: {
      type: 'out',
      productId: { in: products.map(p => p.id) },
      date: { gte: periodStart }
    },
    _sum: { delta: true }
  })

  const consumptionMap = new Map(consumption.map(c => [c.productId, Math.abs(c._sum.delta || 0)]))

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
  const whereDate: { date?: { gte?: Date, lte?: Date } } = {}
  if (from || to) {
    whereDate.date = {
      ...(from ? { gte: startOfDay(from) } : {}),
      ...(to ? { lte: endOfDay(to) } : {})
    }
  }

  const stats = await prisma.transaction.groupBy({
    by: ['destinationId'],
    where: {
      type: 'out',
      destinationId: { not: null },
      ...whereDate
    },
    _count: { id: true },
    _sum: { delta: true },
  })

  const locations = await prisma.location.findMany({ where: { deleted: false } })
  const locationMap = new Map(locations.map(l => [l.id, l.name]))

  return stats
    .map(s => ({
      destinationId: s.destinationId!,
      destinationName: locationMap.get(s.destinationId!) || `удаленный #${s.destinationId}`,
      transactionCount: s._count.id,
      totalQuantity: Math.abs(s._sum.delta || 0)
    }))
    .sort((a, b) => b.totalQuantity - a.totalQuantity)
}

export async function getSupplierStats(from?: Date, to?: Date): Promise<SupplierStats[]> {
  const whereDate: { date?: { gte?: Date, lte?: Date } } = {}
  if (from || to) {
    whereDate.date = {
      ...(from ? { gte: startOfDay(from) } : {}),
      ...(to ? { lte: endOfDay(to) } : {})
    }
  }

  const stats = await prisma.transaction.groupBy({
    by: ['supplierId'],
    where: {
      type: 'in',
      supplierId: { not: null },
      ...whereDate
    },
    _count: { id: true },
    _sum: { delta: true },
  })

  const suppliers = await prisma.supplier.findMany({ where: { deleted: false } })
  const supplierMap = new Map(suppliers.map(s => [s.id, s.name]))

  return stats
    .map(s => ({
      supplierId: s.supplierId!,
      supplierName: supplierMap.get(s.supplierId!) || `удаленный #${s.supplierId}`,
      transactionCount: s._count.id,
      totalQuantity: s._sum.delta || 0
    }))
    .sort((a, b) => b.totalQuantity - a.totalQuantity)
}

export async function exportToCsv(type: string, from?: Date, to?: Date, extra: any = {}): Promise<{ csv: string, filename: string }> {
  const ts = new Date().toISOString().slice(0, 10)
  if (type === 'top-products') {
    const data = await getTopProducts(from, to, extra.limit || 100)
    const csv = toCsv(data, [
      { key: 'name', title: 'Product' },
      { key: 'total', title: 'Total Quantity' }
    ])
    return { csv, filename: `top-products-${ts}.csv` }
  }
  if (type === 'low-stock') {
    const data = await getLowStock(extra.threshold || 10)
    const csv = toCsv(data, [
      { key: 'id', title: 'ID' },
      { key: 'name', title: 'Product' },
      { key: 'quantity', title: 'Stock' }
    ])
    return { csv, filename: `low-stock-${ts}.csv` }
  }
  if (type === 'worker-performance') {
    const data = await getWorkerPerformance(from, to)
    const csv = toCsv(data, [
      { key: 'workerName', title: 'Worker' },
      { key: 'transactionCount', title: 'Transaction Count' },
      { key: 'totalQuantity', title: 'Total Quantity Moved' }
    ])
    return { csv, filename: `worker-performance-${ts}.csv` }
  }
  if (type === 'consumption-forecast') {
    const data = await getConsumptionForecast(extra.days || 30)
    const csv = toCsv(data.map(d => ({...d, daysToStockout: d.daysToStockout !== null ? Math.floor(d.daysToStockout) : ''})), [
      { key: 'productName', title: 'Product' },
      { key: 'currentStock', title: 'Current Stock' },
      { key: 'avgDailyConsumption', title: 'Avg Daily Consumption' },
      { key: 'daysToStockout', title: 'Days to Stockout' }
    ])
    return { csv, filename: `consumption-forecast-${ts}.csv` }
  }
  if (type === 'destination-stats') {
    const data = await getDestinationStats(from, to)
    const csv = toCsv(data, [
      { key: 'destinationName', title: 'Destination' },
      { key: 'transactionCount', title: 'Transaction Count' },
      { key: 'totalQuantity', title: 'Total Quantity Consumed' }
    ])
    return { csv, filename: `destination-stats-${ts}.csv` }
  }
  if (type === 'supplier-stats') {
    const data = await getSupplierStats(from, to)
    const csv = toCsv(data, [
      { key: 'supplierName', title: 'Supplier' },
      { key: 'transactionCount', title: 'Transaction Count' },
      { key: 'totalQuantity', title: 'Total Quantity Supplied' }
    ])
    return { csv, filename: `supplier-stats-${ts}.csv` }
  }
  if (type === 'transactions') {
    const whereDate: { date?: { gte?: Date, lte?: Date } } = {}
    if (from || to) {
      whereDate.date = {
        ...(from ? { gte: startOfDay(from) } : {}),
        ...(to ? { lte: endOfDay(to) } : {})
      }
    }
    const data = await prisma.transaction.findMany({
      where: whereDate,
      include: { worker: true, supplier: true, destination: true },
      orderBy: { date: 'desc' }
    })
    const csv = toCsv(data.map(t => ({
      ...t,
      date: new Date(t.date).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }),
      delta: Math.abs(t.delta),
      workerName: t.worker?.fullName || '',
      supplierName: t.supplier?.name || t.supplierName || '',
      destinationName: t.destination?.name || t.destinationName || ''
    })), [
      { key: 'id', title: 'ID' },
      { key: 'date', title: 'Date' },
      { key: 'productName', title: 'Product' },
      { key: 'delta', title: 'Quantity' },
      { key: 'type', title: 'Type' },
      { key: 'supplierName', title: 'Supplier' },
      { key: 'destinationName', title: 'Destination' },
      { key: 'workerName', title: 'Worker' },
      { key: 'note', title: 'Note' }
    ])
    return { csv, filename: `transactions-${ts}.csv` }
  }
  throw new Error('unknown export type')
}