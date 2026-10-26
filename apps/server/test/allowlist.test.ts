import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store';
import { freshDb } from './helpers/db';

let t: Awaited<ReturnType<typeof freshDb>>;
let store: Store;
beforeAll(async () => { t = await freshDb(); store = new Store(t.db, t.sql); });
afterAll(async () => { await t.drop(); });

describe('allowlist (spec 2b §3)', () => {
  it('allow, isAllowed, allowlist and disallow by ID or login', async () => {
    await store.allow('42', 'streamer'); await store.allow('42', 'renamed');
    expect(await store.isAllowed('42')).toBe(true);
    expect(await store.allowlist()).toEqual([{ twitchId: '42', login: 'renamed', addedAt: expect.any(Date) }]);
    expect(await store.disallowByLogin('nobody')).toBe(false);
    expect(await store.disallowById('42')).toBe(true);
    expect(await store.isAllowed('42')).toBe(false);
    expect(await store.disallowById('42')).toBe(false);
    await store.allow('7', 'other');
    expect(await store.disallowByLogin('other')).toBe(true);
  });
});
