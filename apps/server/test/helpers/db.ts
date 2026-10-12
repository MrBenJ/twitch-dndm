import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { connect, type Db, migrate, type Sql } from '../../src/db/connect';

export const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://dndm:dndm@localhost:5455/dndm';

/** A brand-new, migrated database for one test file. */
export async function freshDb(): Promise<{ url: string; db: Db; sql: Sql; drop(): Promise<void> }> {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  const name = `dndm_t_${randomBytes(6).toString('hex')}`;
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } catch (e) {
    await admin.end();
    throw new Error(`Postgres isn't reachable at ${ADMIN_URL}. Run: docker compose up -d postgres (${(e as Error).message})`);
  }
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  await migrate(url.toString());
  const { db, sql } = connect(url.toString(), { max: 5 });
  return {
    url: url.toString(), db, sql,
    async drop() {
      await sql.end();
      await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}
