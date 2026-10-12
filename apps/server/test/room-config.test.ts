import { afterEach, describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto';
import { roomSetup } from './helpers/room';

let s: Awaited<ReturnType<typeof roomSetup>>;
afterEach(async () => { await s.done(); });

const get = async () => (await s.cmd(s.dock, { type: 'getConfig' })) as { ok: true; result: { config: Record<string, unknown>; configVersion: number } };

describe('config changes (spec 2a §6.5)', () => {
  it('reads and validates without saving or queueing', async () => {
    s = await roomSetup();
    const g = await get();
    expect(g.result.configVersion).toBe(1);
    expect(await s.cmd(s.dock, { type: 'validateConfig', config: { packs: ['nope'] } })).toMatchObject({ ok: true, result: { errors: [expect.any(String)] } });
    expect(await s.cmd(s.dock, { type: 'validateConfig', config: g.result.config })).toMatchObject({ ok: true, result: { errors: [] } });
    expect(await s.cmd(s.v('al'), { type: 'getConfig' })).toMatchObject({ ok: false, error: { code: 'streamer-only' } });
    expect((await s.store.room(s.made.id))!.recentRequests).toEqual([]);
  });

  it('refuses a stale or invalid config', async () => {
    s = await roomSetup();
    const { config } = (await get()).result;
    expect(await s.cmd(s.dock, { type: 'updateConfig', config, basedOn: 7 })).toMatchObject({ ok: false, error: { code: 'stale-config' } });
    expect(await s.cmd(s.dock, { type: 'updateConfig', config: { packs: 3 }, basedOn: 1 })).toMatchObject({ ok: false, error: { code: 'invalid-config' } });
    expect((await get()).result.configVersion).toBe(1);
  });

  it('refuses a change that breaks the running fight, mid-fight', async () => {
    s = await roomSetup();
    await s.cmd(s.dock, { type: 'openSession' });
    await s.cmd(s.v('al'), { type: 'join', name: 'Al', pick: 'starter:sword' });
    await s.cmd(s.dock, { type: 'spawnMonster', monster: 'starter:slime' });
    const { config } = (await get()).result;
    void config;
    expect(await s.cmd(s.dock, { type: 'updateConfig', config: { packs: [] }, basedOn: 1 })).toMatchObject({ ok: false, error: { code: 'content-in-use' } });
  });

  it('applies a good change mid-fight, saves it and tells everyone', async () => {
    s = await roomSetup();
    await s.cmd(s.dock, { type: 'openSession' });
    await s.cmd(s.v('al'), { type: 'join', name: 'Al', pick: 'starter:sword' });
    await s.cmd(s.dock, { type: 'spawnMonster', monster: 'starter:slime' });
    const { config } = (await get()).result;
    const next = { ...config, settings: { ...(config.settings as object), 'xp-multiplier': 2 } };
    expect(await s.cmd(s.dock, { type: 'updateConfig', config: next, basedOn: 1 })).toMatchObject({ ok: true, result: { configVersion: 2 } });
    expect(s.out).toContainEqual({ type: 'config-changed', configVersion: 2 });
    expect(s.room.engine.registry.settings.xpMultiplier).toBe(2);
    expect((await s.store.channel(s.made.id))!.configVersion).toBe(2);
  });

  it('turning streamer-removal-waits-for-rest on loads removed characters', async () => {
    s = await roomSetup({ settings: { 'streamer-removal-waits-for-rest': false } });
    await s.cmd(s.dock, { type: 'openSession' });
    for (const n of ['al', 'bo']) await s.cmd(s.v(n), { type: 'join', name: n, pick: 'starter:sword' });
    await s.cmd(s.dock, { type: 'spawnMonster', monster: 'starter:slime' });
    await s.cmd(s.dock, { type: 'removePlayer', character: 'dev:al' });
    await s.advance(11 * 60_000);
    await s.room.sweep();
    expect(s.room.game.characters['dev:al']).toBeUndefined();
    const { config } = (await get()).result;
    const on = { ...config, settings: { ...(config.settings as object), 'streamer-removal-waits-for-rest': true } };
    expect((await s.cmd(s.dock, { type: 'updateConfig', config: on, basedOn: 1 })).ok).toBe(true);
    expect(s.room.game.characters['dev:al']!.removedByStreamer).toBe(true);
  });
});

describe('tokens (spec 2a §4.1)', () => {
  it('regenerating replaces the token, revokes the old one and can be replayed with it', async () => {
    s = await roomSetup();
    const oldHash = hashToken(s.made.dockToken);
    const a = (await s.cmd(s.dock, { type: 'regenerateDockUrl' }, 'regen-1')) as { ok: true; result: { token: string } };
    expect(a.ok).toBe(true);
    expect(s.room.channel.dockTokenHash).toBe(hashToken(a.result.token));
    expect(s.out).toContainEqual({ type: 'token-revoked', role: 'dock', tokenHash: oldHash });
    expect(await s.room.replayRevoked(oldHash, 'regen-1')).toEqual(a);
    expect(await s.room.replayRevoked(oldHash, 'other')).toBeNull();
    expect(await s.cmd(s.dock, { type: 'regenerateDockUrl' }, 'regen-1')).toEqual(a);
    const stored = (await s.store.room(s.made.id))!.recentRequests.find((r) => r.key === 'dock:regen-1')!;
    expect(JSON.stringify(stored)).not.toContain(a.result.token);
    await s.advance(5 * 60_000);
    expect(await s.room.replayRevoked(oldHash, 'regen-1')).toBeNull();
  });
});
