import { PrismaClient } from '@prisma/client'

// Test-support only: when WK_PRISMA_QUERY_LOG=1 (perf baseline runs) emit query events so
// the perf test can count queries. Unset in normal runs and production -> identical client.
const log =
  process.env.WK_PRISMA_QUERY_LOG === '1'
    ? [{ emit: 'event' as const, level: 'query' as const }]
    : undefined

export const prisma = new PrismaClient(log ? { log } : undefined)