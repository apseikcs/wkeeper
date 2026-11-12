import type { Request, Response, NextFunction } from 'express'
import { verifyToken } from '../auth'

const authenticateToken = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization']
  const token = authHeader && (authHeader as string).split(' ')[1]

  if (token == null) return res.sendStatus(401)

  const payload = verifyToken(token as string) 
  if (!payload) return res.sendStatus(403);

  (req as any).authUser = payload 
  next()
}

// allow public endpoints (e.g. /api/login) to bypass auth; protect all other /api routes
const apiAuth = (req: Request, res: Response, next: NextFunction) => {
  const publicPaths = ['/login'] // add more public API paths here if needed
  if (publicPaths.includes(req.path)) return next()
  return authenticateToken(req, res, next)
}

export { authenticateToken, apiAuth }