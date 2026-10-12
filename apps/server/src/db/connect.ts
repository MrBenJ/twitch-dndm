import { join } from 'node:path';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate as runMigrations } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;
export type Sql = postgres.Sql;

export const MIGRATIONS = join(import.meta.dirname, '..', '..', 'drizzle');

export function connect(url: string, opts: { max?: number } = {}): { db: Db; sql: Sql } {
  const sql = postgres(url, { max: opts.max ?? 10, onnotice: () => {} });
  return { db: drizzle(sql, { schema }), sql };
}

export async function migrate(url: string): Promise<void> {
  const { db, sql } = connect(url, { max: 1 });
  try {
    await runMigrations(db, { migrationsFolder: MIGRATIONS });
  } finally {
    await sql.end();
  }
}
