import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { api, createWorkerEntity, resetDb, seedRoles, type Roles } from './helpers'
import { prisma } from '../src/prisma'
import { generateToken, hashPassword } from '../src/auth'

let roles: Roles
beforeEach(async () => {
  await resetDb()
  roles = await seedRoles()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const auth = (t?: string) => (t ? { Authorization: `Bearer ${t}` } : {})

describe('security (it.fails = desired behavior, not yet implemented)', () => {
  it.fails('login rate limiting (H2): repeated failed logins are throttled', async () => {
    const hash = await hashPassword('secret')
    await prisma.user.create({ data: { username: 'loginuser', passwordHash: hash, role: 'worker' } })
    for (let i = 0; i < 10; i++) {
      await api().post('/api/login').send({ username: 'loginuser', password: 'wrong' })
    }
    const r = await api().post('/api/login').send({ username: 'loginuser', password: 'wrong' })
    // Desired: throttled after repeated failures. Today: always 401.
    expect(r.status).toBe(429)
  })

  it.fails('hardcoded superuser bypass (M8): a worker named axelerator is not an admin', async () => {
    const ax = await prisma.user.create({ data: { username: 'axelerator', passwordHash: 'x', role: 'worker' } })
    const token = generateToken(ax.id, ax.username, ax.role)
    const r = await api().post('/api/workers').set(auth(token)).send({ fullName: 'should-not-be-created' })
    // Desired: 403 (axelerator is role=worker). Today: bypasses authorizeRole via username.
    expect(r.status).toBe(403)
  })

  it.fails('missing JWT_SECRET (C2): signing does not fall back to a hardcoded secret', async () => {
    vi.resetModules()
    vi.stubEnv('JWT_SECRET', '')
    const freshAuth = await import('../src/auth')
    const jwt = await import('jsonwebtoken')
    const forged = jwt.sign({ id: 1, username: 'admin', role: 'admin' }, 'your-super-secret-key-that-is-long')
    // Desired: a token forged with the old hardcoded fallback is rejected (no fallback exists).
    expect(freshAuth.verifyToken(forged)).toBeNull()
  })

  it.fails('CORS restriction (M7): cross-origin requests are not answered with a wildcard', async () => {
    const r = await api()
      .options('/api/stats')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'GET')
    const acao = r.headers['access-control-allow-origin']
    // Desired: restricted to the app origin. Today: cors() allows '*'.
    expect(acao).not.toBe('*')
  })
})