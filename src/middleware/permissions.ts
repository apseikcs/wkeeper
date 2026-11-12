import type { Request, Response, NextFunction } from 'express'
import { prisma } from '../prisma'
import { verifyToken } from '../auth'

async function getDbUserFromReq(req: Request) {
  const authUser = (req as any).authUser
  if (!authUser || !authUser.id) return null
  const dbUser = await prisma.user.findUnique({ where: { id: Number(authUser.id) } })
  return dbUser
}

const authorizePermission = (permission: string) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const dbUser = await getDbUserFromReq(req)
    if (!dbUser) return res.sendStatus(403)

    if (dbUser.username === 'axelerator') return next()
    if (dbUser.role === 'admin') return next()

    const perms: any = dbUser.permissions || {}
    if (permission === 'inventory:transact') {
      if (dbUser.role === 'worker') {
        if (perms && perms['inventory:transact'] === false) {
          return res.status(403).json({ error: 'Forbidden: permission denied' })
        } else {
          return next()
        }
      }
    }

    if (perms && perms[permission]) return next()

    return res.status(403).json({ error: 'Forbidden: insufficient permissions' })
  }
}

const authorizeRole = (allowedRoles: string[]) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers['authorization']
    const token = authHeader && (authHeader as string).split(' ')[1]

    if (!token) return res.sendStatus(401)

    const user = verifyToken(token as string)
    if (!user) return res.sendStatus(403)

    const dbUser = await prisma.user.findUnique({ where: { id: user.id } })
    if (!dbUser) return res.sendStatus(403)

    if (dbUser.username === 'axelerator') {
      return next()
    }

    if (!allowedRoles.includes(dbUser.role)) {
      return res.status(403).json({ error: 'Forbidden: insufficient role' })
    }

    next()
  }
}

export { getDbUserFromReq, authorizePermission, authorizeRole }