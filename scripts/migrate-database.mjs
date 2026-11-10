import { readdir, readFile } from 'node:fs/promises'
import { neon, neonConfig } from '@neondatabase/serverless'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
// A local Postgres behind a Neon HTTP proxy (docker-compose.yml).
if (process.env.FX0_NEON_HTTP_ENDPOINT) neonConfig.fetchEndpoint = process.env.FX0_NEON_HTTP_ENDPOINT
const directory = new URL('../migrations/', import.meta.url)
const files = (await readdir(directory)).filter((name) => /^\d{3}_.+\.sql$/.test(name)).sort()
const sql = neon(process.env.DATABASE_URL)
for (const file of files) {
  try {
    const migration = await readFile(new URL(file, directory), 'utf8')
    // Every statement is idempotent, so reapplying earlier files is safe.
    const statements = migration.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n')
      .split(';').map((text) => text.trim()).filter(Boolean)
    // One Neon HTTP transaction per file; never BEGIN/COMMIT on separate connections.
    await sql.transaction(statements.map((text) => sql.query(text)))
    console.log(`${file} applied`)
  } catch {
    // Driver errors may contain connection details; never print them.
    console.error(`${file} failed; verify DATABASE_URL and database permissions`)
    process.exitCode = 1
    break
  }
}
