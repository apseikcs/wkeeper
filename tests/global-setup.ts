import { execSync } from 'node:child_process'
import path from 'node:path'
import { getTestDatabaseUrl } from './guard'

// Applies the committed migrations to the test database only (never any other database).
// `migrate deploy` does not create the database itself, so the `*_test` DB must already exist.
export default function globalSetup() {
  const url = getTestDatabaseUrl()
  process.env.DATABASE_URL = url
  const prismaCli = path.join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js')
  execSync(`node "${prismaCli}" migrate deploy`, {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  })
}