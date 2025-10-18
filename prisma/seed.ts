import { PrismaClient } from '@prisma/client'
import { hashPassword } from '../src/auth'
const prisma = new PrismaClient()

async function main() {
  await prisma.transaction.deleteMany()
  await prisma.product.deleteMany()
  await prisma.worker.deleteMany()
  await prisma.tool.deleteMany()
  await prisma.supplier.deleteMany()
  await prisma.location.deleteMany()
  await prisma.user.deleteMany()

  const passwordHash = await hashPassword('tNNzvoO44')
  await prisma.user.create({
    data: {
      username: 'axelerator',
      passwordHash
    }
  })

  await prisma.worker.createMany({
    data: [
      { fullName: 'работяга 1', phone: '+7-900-000-0001', position: 'дотер' },
      { fullName: 'работяга 2', phone: '+7-900-000-0002', position: 'долбаеб' },
      { fullName: 'работяга 3', phone: '+7-900-000-0003', position: 'электрик' }
    ]
  })

  await prisma.supplier.createMany({
    data: [
      { name: 'ооо "рога и копыта"', phone: '+7-495-111-1111', email: 'horns@hooves.com' },
      { name: 'ип сидоров', email: 'sidorov@vendor.net' }
    ]
  })

  await prisma.location.createMany({
    data: [
      { name: 'объект "юпитер"', city: 'воронеж', address: 'ул. ленина 1' },
      { name: 'объект "марс"', city: 'воронеж', address: 'ленинский пр. 10' }
    ]
  })

  const products = [
    { name: 'сиськи', nameNormalized: 'сиськи', unit: 'шт', quantity: 2 },
    { name: 'саморез', nameNormalized: 'саморез', unit: 'шт', quantity: 5000 },
    { name: 'проволока', nameNormalized: 'проволока', unit: 'м', quantity: 200 },
    { name: 'аркана на пуджа', nameNormalized: 'аркана на пуджа', unit: 'шт', quantity: 800 },
    { name: 'пиво', nameNormalized: 'пиво', unit: 'л', quantity: 20 }
  ]

  for (const p of products) {
    await prisma.product.create({ data: p })
  }

  console.log('seed done')
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(async () => { await prisma.$disconnect() })
