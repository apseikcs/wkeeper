import * as jwt from 'jsonwebtoken'
import * as bcrypt from 'bcryptjs'

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-that-is-long'
const SALT_ROUNDS = 10

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS)
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

export function generateToken(userId: number, username: string, role: string = 'worker') {
  return jwt.sign({ id: userId, username, role }, JWT_SECRET, { expiresIn: '24h' })
}

export function verifyToken(token?: string): { id: number, username: string, role?: string } | null {
  try {
    if (!token) return null
    const decoded = jwt.verify(token, JWT_SECRET)
    return decoded as { id: number, username: string, role?: string }
  } catch {
    return null
  }
}
