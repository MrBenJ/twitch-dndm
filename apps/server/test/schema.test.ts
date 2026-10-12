import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb } from './helpers/db';

let t: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => { t = await freshDb(); });
afterAll(async () => { await t.drop(); });

describe('migrations (spec 2a §3)', () => {
  it('create the three tables with json game data', async () => {
    const cols = await t.sql<{ table_name: string; column_name: string; data_type: string }[]>`
      select table_name, column_name, data_type from information_schema.columns
      where table_schema = 'public' and table_name in ('channels', 'rooms', 'characters')`;
    const type = (table: string, col: string) => cols.find((c) => c.table_name === table && c.column_name === col)?.data_type;
    expect(type('channels', 'config')).toBe('json');
    expect(type('rooms', 'session')).toBe('json');
    expect(type('characters', 'data')).toBe('json');
    expect(type('characters', 'wake_at')).toBe('bigint');
  });

  it('lets several channels have no Twitch ID', async () => {
    const row = (n: number) => ({ name: `c${n}`, config: '{}', dock: `d${n}`, overlay: `o${n}` });
    for (const r of [row(1), row(2)]) {
      await t.sql`insert into channels (name, config, dock_token_hash, dock_token_enc, overlay_token_hash, overlay_token_enc)
        values (${r.name}, ${r.config}::json, ${r.dock}, ${r.dock}, ${r.overlay}, ${r.overlay})`;
    }
    const [counted] = await t.sql<{ count: string }[]>`select count(*) from channels where twitch_id is null`;
    expect(Number(counted!.count)).toBe(2);
  });
});
