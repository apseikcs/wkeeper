// Hard safety guard: tests may only run against a throwaway database whose
// name ends with `_test`. This file never reads any .env file.
export function assertTestDatabaseUrl(raw?: string): URL {
  if (!raw || !raw.trim()) {
    throw new Error(
      'TEST_DATABASE_URL is required. Set it to a throwaway Postgres URL whose ' +
      'database name ends with "_test", e.g. postgresql://user:pass@localhost:5432/wkeeper_test'
    )
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch (e) {
    throw new Error(`TEST_DATABASE_URL is not a valid URL: ${raw}`)
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(`TEST_DATABASE_URL must be a postgres:// URL, got ${parsed.protocol}`)
  }
  const dbName = (parsed.pathname || '').replace(/^\//, '')
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `Refusing to run tests: database "${dbName}" does not end with "_test". ` +
      'Create a throwaway DB (e.g. "createdb wkeeper_test") and point TEST_DATABASE_URL at it.'
    )
  }
  return parsed
}

export function getTestDatabaseUrl(): string {
  try {
    return assertTestDatabaseUrl(process.env.TEST_DATABASE_URL).toString()
  } catch (e) {
    console.error('\n' + (e as Error).message + '\n')
    throw e
  }
}