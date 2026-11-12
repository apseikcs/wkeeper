import { describe, it, expect } from 'vitest'
import { app } from '../src/app'

type Route = { method: string; path: string }

// Walks the Express app (recursing into mounted routers) and returns every
// (METHOD, full path) pair. Used to prove a refactor did not change the route set.
function collectRoutes(expressApp: any): Route[] {
  const out: Route[] = []
  const walk = (stack: any[]) => {
    for (const layer of stack) {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods || {}).filter((m) => layer.route.methods[m])
        for (const m of methods) out.push({ method: m.toUpperCase(), path: layer.route.path })
      } else if (layer.name === 'router' && layer.handle && Array.isArray(layer.handle.stack)) {
        walk(layer.handle.stack)
      }
    }
  }
  walk(expressApp._router.stack)
  return out
}

describe('route manifest (must stay identical across refactors)', () => {
  it('has the committed set of (method, path) pairs', () => {
    const routes = collectRoutes(app).sort((a, b) => (a.method + ' ' + a.path).localeCompare(b.method + ' ' + b.path))
    expect(routes.length).toBeGreaterThan(40)
    expect(routes).toMatchSnapshot()
  })
})