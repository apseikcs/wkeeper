import { PrismaClient } from '@prisma/client'
import { hashPassword } from '../src/auth'
const prisma = new PrismaClient()

async function main() {
  await prisma.transaction.deleteMany()
  await prisma.transactionItem.deleteMany()
  await prisma.product.deleteMany()
  await prisma.toolAssignment.deleteMany()
  await prisma.tool.deleteMany()
  await prisma.worker.deleteMany()
  await prisma.supplier.deleteMany()
  await prisma.location.deleteMany()
  await prisma.user.deleteMany()

  const axPass = await hashPassword('tNNzvoO44')
  const adminPass = await hashPassword('admin123')
  const workerPass = await hashPassword('worker123')

  await prisma.user.createMany({
    data: [
      { username: 'axelerator', passwordHash: axPass, role: 'admin' },
      { username: 'admin', passwordHash: adminPass, role: 'admin' },
      { username: 'worker1', passwordHash: workerPass, role: 'worker' }
    ]
  })

  await prisma.worker.createMany({
    data: [
      { fullName: 'Работяга 1', phone: '+7-900-000-0001', position: 'Монтажник' },
      { fullName: 'Работяга 2', phone: '+7-900-000-0002', position: 'Слесарь' },
      { fullName: 'Работяга 3', phone: '+7-900-000-0003', position: 'Электрик' }
    ]
  })

  await prisma.supplier.createMany({
    data: [
      { name: 'ООО Рога и Копыта', phone: '+7-495-111-1111', email: 'horns@hooves.com' },
      { name: 'ИП Сидоров', email: 'sidorov@vendor.net' }
    ]
  })

  await prisma.location.createMany({
    data: [
      { name: 'Объект Юпитер', city: 'Воронеж', address: 'ул. Ленина 1' },
      { name: 'Объект Марс', city: 'Воронеж', address: 'Ленинский пр. 10' }
    ]
  })

  const products = [
    { name: 'Отвертка', nameNormalized: 'отвертка', unit: 'шт', quantity: 50 },
    { name: 'Саморез', nameNormalized: 'саморез', unit: 'шт', quantity: 5000 },
    { name: 'Проволока', nameNormalized: 'проволока', unit: 'м', quantity: 200 },
    { name: 'Лист 2мм', nameNormalized: 'лист 2мм', unit: 'шт', quantity: 800 },
    { name: 'Пиво', nameNormalized: 'пиво', unit: 'л', quantity: 20 }
  ]

  for (const p of products) {
    await prisma.product.create({ data: p })
  }

  console.log('seed done')
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(async () => { await prisma.$disconnect() })
