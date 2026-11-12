// Seeds the test database with a fixed-size perf fixture (2000 products, 50k transactions,
// 150k items). Uses batched createMany to stay under Postgres bind-parameter limits.
export async function seedPerf(prisma: any) {
  const SUP = 20
  const LOC = 20
  const WRK = 20
  const PROD = 2000
  const TX = 50000
  const ITEMS = 150000

  await prisma.supplier.createMany({ data: Array.from({ length: SUP }, (_, i) => ({ name: `perf-sup-${i}` })) })
  await prisma.location.createMany({ data: Array.from({ length: LOC }, (_, i) => ({ name: `perf-loc-${i}`, city: 'Voronezh' })) })
  await prisma.worker.createMany({ data: Array.from({ length: WRK }, (_, i) => ({ fullName: `perf-worker-${i}` })) })

  const suppliers = await prisma.supplier.findMany({ select: { id: true } })
  const locations = await prisma.location.findMany({ select: { id: true } })
  const workers = await prisma.worker.findMany({ select: { id: true } })

  const productData = Array.from({ length: PROD }, (_, i) => ({
    name: `perf-prod-${i}`,
    nameNormalized: `perf-prod-${i}`,
    unit: 'шт',
    quantity: i % 500,
  }))
  for (let i = 0; i < productData.length; i += 1000) {
    await prisma.product.createMany({ data: productData.slice(i, i + 1000) })
  }
  const products = await prisma.product.findMany({ select: { id: true, name: true } })

  const now = Date.now()
  const txData = Array.from({ length: TX }, (_, i) => {
    const type = i % 2 === 0 ? 'in' : 'out'
    return {
      type,
      date: new Date(now - Math.floor(Math.random() * 365) * 86400000),
      supplierId: type === 'in' ? suppliers[i % SUP].id : null,
      destinationId: type === 'out' ? locations[i % LOC].id : null,
      workerId: type === 'out' ? workers[i % WRK].id : null,
      note: i % 10 === 0 ? 'perf note' : null,
    }
  })
  for (let i = 0; i < txData.length; i += 1000) {
    await prisma.transaction.createMany({ data: txData.slice(i, i + 1000) })
  }
  const txRows = await prisma.transaction.findMany({ select: { id: true, type: true } })

  const items = Array.from({ length: ITEMS }, () => {
    const tx = txRows[Math.floor(Math.random() * txRows.length)]
    const p = products[Math.floor(Math.random() * products.length)]
    const mag = 1 + Math.floor(Math.random() * 50)
    return {
      transactionId: tx.id,
      productId: p.id,
      productName: p.name,
      productSku: null,
      delta: tx.type === 'out' ? -mag : mag,
    }
  })
  for (let i = 0; i < items.length; i += 2000) {
    await prisma.transactionItem.createMany({ data: items.slice(i, i + 2000) })
  }

  return { suppliers: SUP, locations: LOC, workers: WRK, products: PROD, transactions: TX, items: ITEMS }
}