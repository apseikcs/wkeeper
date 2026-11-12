import { Router } from 'express'
import type { Request, Response } from 'express'
import { comparePassword, generateToken } from '../auth'
import { prisma } from '../prisma'
import { authenticateToken } from '../middleware/auth'

const router = Router()
router.post('/api/login', async (req: Request, res: Response) => {
  const { username, password } = req.body
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' })
  }

  const user = await prisma.user.findUnique({ where: { username } })
  if (!user) {
    return res.status(401).json({ error: 'invalid credentials' })
  }

  const passwordValid = await comparePassword(password, user.passwordHash)
  if (!passwordValid) {
    return res.status(401).json({ error: 'invalid credentials' })
  }

  const token = generateToken(user.id, user.username, user.role)
  res.json({ token })
})

router.get('/api/me', authenticateToken, async (req: Request, res: Response) => {
  // use attached authUser instead of re-parsing token
  const authUser = (req as any).authUser
  if (!authUser) return res.sendStatus(403)

  const dbUser = await prisma.user.findUnique({ where: { id: Number(authUser.id) } })
  if (!dbUser) return res.sendStatus(404)
  
  res.json({
    id: dbUser.id,
    username: dbUser.username,
    role: dbUser.role,
    permissions: dbUser.permissions
  })
})

export { router as authRouter }
