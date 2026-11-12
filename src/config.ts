// Centralized environment reads (single place). Values and defaults are exactly as
// before this refactor — including the insecure JWT fallback — intentionally NOT fixed here.
export const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-that-is-long'
export const PORT = process.env.PORT ?? 3000
export const WK_PRISMA_QUERY_LOG = process.env.WK_PRISMA_QUERY_LOG === '1'