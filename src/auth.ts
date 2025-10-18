import * as jwt from 'jsonwebtoken'
import * as bcrypt from 'bcryptjs'

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-that-is-long'
if (JWT_SECRET === 'your-super-secret-key-that-is-long') {
  console.warn('WARNING: Using default JWT_SECRET. Please set a secure secret in your environment variables.')
}

const SALT_ROUNDS = 10

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS)
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

export function generateToken(userId: number, username: string): string {
  return jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '1d' })
}

export function verifyToken(token: string): { userId: number, username: string } | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    return decoded as { userId: number, username: string }
  } catch (e) {
    return null
  }
}
