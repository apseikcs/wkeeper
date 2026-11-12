import { describe, it, expect } from 'vitest'
import { JSDOM, VirtualConsole } from 'jsdom'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PAYLOAD = '<img src=x onerror="window.__xss=1">'

const mkRes = (data: any) => ({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json' },
  json: async () => data,
  text: async () => JSON.stringify(data),
})

// Loads a real frontend page, stubs the globals the inline script needs, and lets the
// page's own load()/render() run against stubbed API data (so we exercise the real templates).
function loadPage(file: string, route: (url: string) => any) {
  const html = readFileSync(resolve(process.cwd(), 'frontend', file), 'utf8')
  const vc = new VirtualConsole() // swallow unrelated script/binding errors from jsdom
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost/',
    virtualConsole: vc,
    beforeParse(window: any) {
      window.authFetch = async (url: string) => mkRes(route(String(url)))
      window.fetch = window.authFetch
      window.formUtils = {
        extractItems: (d: any) => (Array.isArray(d) ? d : (d && d.items) || []),
        createPaginationControls: () => window.document.createElement('div'),
        disable: () => () => {},
      }
      window.logout = () => {}
      window.getCurrentUser = async () => ({ id: 1, username: 'admin', role: 'admin' })
      window.getToken = () => null
      window.escapeHtml = (s: any) => (s == null ? '' : String(s))
    },
  })
  return dom
}

const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms))

const txRow = {
  id: 777, date: new Date().toISOString(), type: 'out',
  productName: PAYLOAD, product: { name: PAYLOAD },
  supplierName: PAYLOAD, supplier: { name: PAYLOAD },
  destinationName: PAYLOAD, destination: { name: PAYLOAD },
  worker: { fullName: PAYLOAD }, workerId: 1, authorUsername: null,
  delta: -1, note: PAYLOAD,
}

describe('frontend XSS (it.fails = desired: payload renders as text, not an element)', () => {
  it.fails('transactions.html row template escapes note/product/supplier/destination/worker names (C3)', async () => {
    const dom = loadPage('transactions.html', (url) => {
      if (url.includes('/api/transactions')) return { items: [txRow], page: 1, limit: 50, total: 1 }
      return { items: [], page: 1, limit: 50, total: 0 }
    })
    await tick()
    const tbody = (dom.window as any).document.querySelector('#transactionsTable tbody')
    // Desired: the payload is plain text. Today: unescaped innerHTML turns it into an <img> element.
    expect(tbody.querySelector('img')).toBeNull()
    expect(tbody.innerHTML).not.toContain('<img')
  })

  it.fails('index.html recent-transactions row escapes product/supplier names (C3)', async () => {
    const dom = loadPage('index.html', (url) => {
      if (url.includes('/api/transactions/recent')) return [txRow]
      if (url.includes('/api/stats')) return { totalProducts: 0, todayTransactions: 0, lastActivity: null }
      return { items: [], page: 1, limit: 50, total: 0 }
    })
    await tick()
    const tbody = (dom.window as any).document.querySelector('#recentTransactionsTable tbody')
    expect(tbody.querySelector('img')).toBeNull()
    expect(tbody.innerHTML).not.toContain('<img')
  })
})