import { getTestDatabaseUrl } from './guard'

// Runs in each worker before any test file is imported. It must NOT statically
// import the app or prisma here, otherwise import hoisting would construct the
// PrismaClient before DATABASE_URL is set.
process.env.DATABASE_URL = getTestDatabaseUrl()
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'wk-test-secret'