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
import { toolsRouter } from './routes/tools'
import { transactionsRouter } from './routes/transactions'
import { reportsRouter } from './routes/reports'
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







// (Deprecated) product-history endpoint removed — transaction history is
// available via `/api/transactions` and the transaction search UI.





































{
  const repoFonts = path.join(__dirname, '..', 'fonts')
  const normal = fs.existsSync(path.join(repoFonts, 'NotoSans-Regular.ttf'))
  const bold = fs.existsSync(path.join(repoFonts, 'NotoSans-Bold.ttf'))
  console.info(`Fonts: NotoSans-Regular=${normal}, NotoSans-Bold=${bold}`)
}





app.use(authRouter)
app.use(searchStatsRouter)
app.use(productsRouter)
app.use(suppliersRouter)
app.use(locationsRouter)
app.use(workersRouter)
app.use(toolsRouter)
app.use(transactionsRouter)
app.use(reportsRouter)
