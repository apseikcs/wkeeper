import { PrismaClient } from '@prisma/client'
import { WK_PRISMA_QUERY_LOG } from './config'

// Test-support only: when WK_PRISMA_QUERY_LOG=1 (perf baseline runs) emit query events so
// the perf test can count queries. Unset in normal runs and production -> identical client.
const log = WK_PRISMA_QUERY_LOG
  ? [{ emit: 'event' as const, level: 'query' as const }]
  : undefined

export const prisma = new PrismaClient(log ? { log } : undefined)