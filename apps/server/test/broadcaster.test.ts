import { definePack, type PackBundle } from '@dndm/engine';
import { afterEach, describe, expect, it } from 'vitest';
import type { TwitchConfig } from '../src/config';
import { HttpTwitchClient } from '../src/twitch/api';
import { Broadcaster } from '../src/twitch/broadcaster';
import { PacingGate } from '../src/twitch/gate';
import { keyFor } from '../src/twitch/snapshot';
import { fakeTwitch, type FakeTwitch } from './helpers/fake-twitch';
import { officialTestBundles, roomSetup } from './helpers/room';

const K = Buffer.from('broadcaster-test-snapshot-key-32');
const TWITCH_ID = '1001';
const T = 15_000; // per-test timeout, so a hang fails fast

interface Msg {
  v: number; e: string; t: number; ph?: string; adv?: { id: string; lined: string | null } | null; f?: { n: string } | null; p?: [string, string | null, number, number][];
  pt?: number; rv?: number; ch?: string[]; rf?: true; rw: number; cv: number;
}

let s: Awaited<ReturnType<typeof roomSetup>> | null = null;
let fake: FakeTwitch | null = null;
let b: Broadcaster | null = null;
let gate: PacingGate;
let logs: { msg: string; extra?: Record<string, unknown> }[] = [];
/** While true, keyOf throws: a stand-in for any throw inside a tick's plan(). */
let boom = false;

afterEach(async () => {
  b?.stop();
  await s?.done();
  await fake?.close();
  b = null; s = null; fake = null;
  logs = []; boom = false;
});

async function setup(o: {
  first?: boolean; bundles?: PackBundle[]; settings?: Record<string, unknown>; timeoutMs?: number; backlogCap?: number;
  before?: () => Promise<void>;
} = {}) {
  s = await roomSetup({ broadcast: true, ...(o.bundles ? { bundles: o.bundles } : {}), ...(o.settings ? { settings: o.settings } : {}) });
  fake = await fakeTwitch();
  const cfg: TwitchConfig = {
    clientId: fake.clientId, clientSecret: 'shh', extensionSecret: Buffer.from('test-ext-secret').toString('base64'),
    extensionSecretPrevious: null, ownerId: '999', publicUrl: 'https://dndm.example', apiBase: fake.apiBase, authBase: fake.authBase,
  };
  const client = new HttpTwitchClient(cfg, s.clock, o.timeoutMs);
  gate = new PacingGate(s.clock);
  await o.before?.();
  const room = s.room;
  b = new Broadcaster({
    room, twitchId: TWITCH_ID, client, gate, clock: s.clock, keyOf: (id) => { if (boom) throw new Error('boom'); return keyFor(K, room.channel.id, id); },
    log: (msg, extra) => { logs.push({ msg, ...(extra ? { extra } : {}) }); },
    firstSinceStart: o.first ?? false, ...(o.backlogCap !== undefined ? { backlogCap: o.backlogCap } : {}),
  });
  await b.start();
}

const key = (name: string) => keyFor(K, s!.room.channel.id, `dev:${name}`);
const sent = (): Msg[] => fake!.pubsub().map((m) => m.message as Msg);
const settle = async () => { await s!.room.idle(); await b!.idle(); await s!.room.idle(); };
const advance = (ms: number) => s!.clock.advance(ms, settle);
const cmd = (name: string, command: Record<string, unknown> & { type: string }) => s!.cmd(s!.v(name), command);
const dock = (command: Record<string, unknown> & { type: string }) => s!.cmd(s!.dock, command);
const join = (name: string, pick = 'starter:sword') => cmd(name, { type: 'join', name, pick });

async function updateConfig() {
  const cfg = await dock({ type: 'getConfig' });
  const { config, configVersion } = (cfg as { result: { config: Record<string, unknown>; configVersion: number } }).result;
  expect((await dock({ type: 'updateConfig', config, basedOn: configVersion })).ok).toBe(true);
}

/** A held fight against a monster whose name is too long for any snapshot to fit. */
const long: PackBundle = {
  manifest: { id: 'tb', version: '1.0.0', name: 'Test Bundle', depends: { starter: '^1.0.0' } },
  official: true,
  content: [{
    monster: 'long', name: 'L'.repeat(6000), hp: 1000, stats: { 'starter:attack': 1 }, abilities: ['starter:club-swing'],
    behavior: { 'starter:weighted': { abilities: { 'starter:club-swing': 1 }, 'targets-per': 1 } }, interval: '15s',
  }].map((doc, index) => ({ file: 'tb.yaml', index, doc })),
  register: definePack({ register() {} }).register,
};

async function setupLong() {
  await setup({
    bundles: [...(await officialTestBundles()), long],
    before: async () => {
      await dock({ type: 'openSession' });
      await join('al');
      await dock({ type: 'spawnMonster', monster: 'tb:long' });
      await dock({ type: 'holdMonster' });
    },
  });
}

describe('Broadcaster (spec 2b §5.3–§5.5)', () => {
  it('first since start: an rf goes out on the first tick even though nothing changed', async () => {
    await setup({ first: true });
    await advance(1000);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ rf: true, rw: 30_000, e: b!.epoch, rv: 1, cv: 1 });
    expect(fake!.pubsub()[0]!.broadcasterId).toBe(TWITCH_ID);
    await advance(5000);
    expect(sent()).toHaveLength(1);
  }, T);

  it('an ordinary load sends nothing until something changes, then a join is sent', async () => {
    await setup({ before: async () => { await dock({ type: 'openSession' }); } });
    expect(b!.epoch).toMatch(/^[A-Za-z0-9_-]{6}$/);
    await advance(5000);
    expect(sent()).toEqual([]);
    await join('al');
    await advance(1000);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.ch).toEqual([key('al')]);
    expect(sent()[0]!.e).toBe(b!.epoch);
    expect(sent()[0]!.rf).toBeUndefined();
  }, T);

  it('lining up the next adventure node changes adv.lined and sends', async () => {
    await setup({ before: async () => { await dock({ type: 'openSession' }); await join('al'); } });
    expect((await dock({ type: 'startAdventure', adventure: 'starter:the-cave' })).ok).toBe(true);
    await advance(1000);
    expect(sent().at(-1)!.adv).toEqual({ id: 'starter:the-cave', lined: 'entrance' });
    const n = sent().length;
    expect((await dock({ type: 'skipTo', node: 'fork' })).ok).toBe(true);
    await advance(1000);
    expect(sent()).toHaveLength(n + 1);
    expect(sent().at(-1)!.adv).toEqual({ id: 'starter:the-cave', lined: 'fork' });
    expect(sent().at(-1)!.ch).toEqual([]);
  }, T);

  it('logs every failed send with status and retryAt, the first delivery, and every delivered rf', async () => {
    await setup({ before: async () => { await dock({ type: 'openSession' }); } });
    const pubsubLogs = () => logs.filter((l) => l.msg.startsWith('pubsub'));
    fake!.failNext('pubsub');
    await join('al');
    await advance(1000);
    expect(pubsubLogs()).toEqual([{ msg: 'pubsub send failed', extra: { twitchId: TWITCH_ID, status: 500, retryAt: null } }]);
    fake!.rateLimitNext(Math.ceil((s!.clock.now() + 5000) / 1000));
    await advance(1000);
    expect(pubsubLogs()).toHaveLength(2);
    expect(pubsubLogs()[1]).toMatchObject({ msg: 'pubsub send failed', extra: { twitchId: TWITCH_ID, status: 429 } });
    expect(pubsubLogs()[1]!.extra!.retryAt).toBeGreaterThan(s!.clock.now());
    await advance(10_000);
    expect(sent()).toHaveLength(1);
    expect(pubsubLogs()).toHaveLength(3);
    expect(pubsubLogs()[2]).toEqual({ msg: 'pubsub send delivered', extra: { twitchId: TWITCH_ID, status: 204, rf: false } });
    // An ordinary later send isn't logged; an rf is.
    await join('bo');
    await advance(1000);
    expect(sent()).toHaveLength(2);
    expect(pubsubLogs()).toHaveLength(3);
    gate.markDropped(TWITCH_ID);
    await advance(1000);
    expect(sent()).toHaveLength(3);
    expect(pubsubLogs()).toHaveLength(4);
    expect(pubsubLogs()[3]).toEqual({ msg: 'pubsub send delivered', extra: { twitchId: TWITCH_ID, status: 204, rf: true } });
    expect(JSON.stringify(logs)).not.toMatch(/Bearer|eyJ|"ch"/);
  }, T);

  it('a tick that throws is logged, rejects nothing, and the next tick sends an rf', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    try {
      await setup({ before: async () => { await dock({ type: 'openSession' }); } });
      boom = true;
      await join('al');
      await advance(1000);
      expect(sent()).toEqual([]);
      expect(logs.find((l) => l.msg === 'broadcast tick failed')).toMatchObject({ extra: { twitchId: TWITCH_ID, error: 'Error: boom' } });
      boom = false;
      await advance(1000);
      // The failed read's keys may be lost, so they count as dropped: the next send is an rf carrying al.
      expect(sent()).toHaveLength(1);
      expect(sent()[0]).toMatchObject({ rf: true, rw: 30_000 });
      expect(sent()[0]!.p!.map((m) => m[0])).toEqual([key('al')]);
      expect(gate.hasDropped(TWITCH_ID)).toBe(false);
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }, T);

  it('at most one send per second', async () => {
    await setup({ before: async () => { await dock({ type: 'openSession' }); } });
    const names = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10'];
    for (const n of names) {
      await join(n);
      await advance(200);
    }
    await advance(3000);
    const ts = sent().map((m) => m.t);
    expect(ts.length).toBeGreaterThan(1);
    for (let i = 1; i < ts.length; i++) expect(ts[i]! - ts[i - 1]!).toBeGreaterThanOrEqual(1000);
    expect(new Set(sent().flatMap((m) => m.ch ?? []))).toEqual(new Set(names.map(key)));
  }, T);

  it('no send when nothing changed', async () => {
    await setup({ before: async () => { await dock({ type: 'openSession' }); } });
    await join('al');
    await advance(1000);
    expect(sent()).toHaveLength(1);
    await advance(10_000);
    expect(sent()).toHaveLength(1);
  }, T);

  it('failed sends and 429s keep their keys', async () => {
    await setup({ before: async () => { await dock({ type: 'openSession' }); } });
    fake!.failNext('pubsub');
    await join('al');
    await advance(1000);
    expect(sent()).toEqual([]);
    await join('bo');
    await advance(1000);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.ch!.sort()).toEqual([key('al'), key('bo')].sort());

    fake!.rateLimitNext(Math.ceil((s!.clock.now() + 5000) / 1000));
    await join('cy');
    await advance(1000);
    expect(sent()).toHaveLength(1);
    await join('di');
    await advance(10_000);
    expect(sent()).toHaveLength(2);
    expect(sent()[1]!.ch!.sort()).toEqual([key('cy'), key('di')].sort());
  }, T);

  it('a hung send is given up after the client timeout and its keys carried', async () => {
    await setup({ timeoutMs: 50, before: async () => { await dock({ type: 'openSession' }); } });
    fake!.hangNext('pubsub');
    await join('al');
    await advance(1000);
    expect(sent()).toEqual([]);
    await advance(2000);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.ch).toEqual([key('al')]);
  }, T);

  it('dropped keys make the next send an rf, even with nothing changed', async () => {
    await setup({ before: async () => { gate.markDropped(TWITCH_ID); } });
    await advance(1000);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.rf).toBe(true);
    expect(gate.hasDropped(TWITCH_ID)).toBe(false);
    await advance(5000);
    expect(sent()).toHaveLength(1);
    gate.markDropped(TWITCH_ID); // a dropped send while this Broadcaster runs
    await advance(1000);
    expect(sent()).toHaveLength(2);
    expect(sent()[1]!.rf).toBe(true);
  }, T);

  it('a config change moves cv and sends an rf', async () => {
    await setup();
    await advance(2000);
    expect(sent()).toEqual([]);
    await updateConfig();
    await advance(1000);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ cv: 2, rf: true, rw: 30_000 });
    await advance(5000);
    expect(sent()).toHaveLength(1);
  }, T);

  it('rv bumps on roster changes only', async () => {
    await setup({ before: async () => { await dock({ type: 'openSession' }); } });
    expect(b!.rv).toBe(1);
    await join('al');
    await advance(1000);
    expect(sent().at(-1)!.rv).toBe(2);
    expect(b!.roster).toEqual([{ id: 'dev:al', key: key('al'), name: 'al', class: 'starter:fighter', level: 1 }]);
    await dock({ type: 'spawnMonster', monster: 'starter:slime' });
    await dock({ type: 'holdMonster' });
    expect((await cmd('al', { type: 'use', ability: 'starter:attack' })).ok).toBe(true);
    await advance(1000);
    expect(sent().at(-1)!.rv).toBe(2);
    expect(b!.rv).toBe(2);
    await dock({ type: 'endEncounter' }); // gear is locked during fights
    await advance(1000);
    expect(b!.rv).toBe(2);
    expect((await cmd('al', { type: 'equip', item: 'starter:shield' })).ok).toBe(true);
    await advance(1000);
    expect(sent().at(-1)!.rv).toBe(3);
    expect(b!.roster[0]!.class).toBe('starter:tank');
    await dock({ type: 'giveXp', target: 'dev:al', amount: 10_000 });
    await advance(1000);
    expect(b!.roster[0]!.level).toBeGreaterThan(1);
    expect(sent().at(-1)!.rv).toBe(4);
  }, T);

  it('a public change puts nobody in ch', async () => {
    await setup({ before: async () => { await dock({ type: 'openSession' }); } });
    await join('al');
    await join('bo');
    await dock({ type: 'spawnMonster', monster: 'starter:slime' });
    await dock({ type: 'holdMonster' });
    await advance(1000);
    const before = sent().length;
    expect((await cmd('al', { type: 'use', ability: 'starter:attack' })).ok).toBe(true);
    await advance(5000);
    const after = sent().slice(before);
    expect(after).toHaveLength(1);
    expect(after[0]!.ch).toEqual([key('al')]);
    expect(after.flatMap((m) => m.ch ?? [])).not.toContain(key('bo'));
  }, T);

  it('a fight starting puts members whose readiness flips in ch, a cooldown ending alone does not', async () => {
    await setup({ before: async () => { await dock({ type: 'openSession' }); } });
    await join('al');
    await join('bo');
    await advance(1000);
    const n0 = sent().length;
    await dock({ type: 'spawnMonster', monster: 'starter:slime' });
    await dock({ type: 'holdMonster' });
    await advance(1000);
    expect(sent()).toHaveLength(n0 + 1);
    expect(sent().at(-1)!.ch!.sort()).toEqual([key('al'), key('bo')].sort());
    expect((await cmd('al', { type: 'use', ability: 'starter:attack' })).ok).toBe(true);
    await advance(1000);
    expect(sent()).toHaveLength(n0 + 2);
    expect(sent().at(-1)!.ch).toEqual([key('al')]);
    await advance(30_000); // the attack's cooldown ends; the monster is held
    expect(sent()).toHaveLength(n0 + 2);
  }, T);

  it('more waiting keys than the cap makes the send an rf, and an rf clears waiting keys', async () => {
    await setup({ backlogCap: 3, before: async () => { await dock({ type: 'openSession' }); } });
    fake!.failNext('pubsub', 4);
    for (const n of ['a1', 'a2', 'a3', 'a4']) {
      await join(n);
      await advance(1000);
    }
    expect(sent()).toEqual([]);
    await advance(30_000);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ rf: true, rw: 30_000 });
    expect(sent()[0]!.ch).toBeUndefined();
    await join('a5');
    await advance(1000);
    expect(sent()).toHaveLength(2);
    expect(sent()[1]!.ch).toEqual([key('a5')]);
  }, T);

  it('while snapshots never fit, the bare rf goes out at most once per 30 s and only after a change; a config change still goes out', async () => {
    await setupLong();
    await advance(5000);
    expect(sent()).toEqual([]); // nothing changed since the load
    for (let i = 0; i < 60; i++) {
      await dock({ type: 'giveGold', target: 'dev:al', amount: 1 });
      await advance(1000);
    }
    // Wait for the bare rf that carries the changes since the last one.
    const n0 = sent().length;
    for (let i = 0; i < 31 && sent().length === n0; i++) await advance(1000);
    expect(sent().length).toBe(n0 + 1);
    const bare = sent();
    expect(bare.length).toBeGreaterThanOrEqual(3);
    for (const m of bare) expect(Object.keys(m).sort()).toEqual(['cv', 'e', 'rf', 'rw', 't', 'v']);
    for (let i = 1; i < bare.length; i++) expect(bare[i]!.t - bare[i - 1]!.t).toBeGreaterThanOrEqual(30_000);
    const last = bare.at(-1)!.t;
    const n = bare.length;
    // No change: nothing, even past the window.
    await advance(40_000);
    expect(sent()).toHaveLength(n);
    // A change goes out in the next bare rf; inside its window, another change waits, but a config change goes out at once.
    await dock({ type: 'giveGold', target: 'dev:al', amount: 1 });
    await advance(1000);
    expect(sent()).toHaveLength(n + 1);
    const lastBare = sent().at(-1)!.t;
    expect(lastBare - last).toBeGreaterThanOrEqual(30_000);
    await dock({ type: 'giveGold', target: 'dev:al', amount: 1 });
    await advance(5000);
    expect(sent()).toHaveLength(n + 1);
    expect(s!.clock.now() - lastBare).toBeLessThan(30_000);
    await updateConfig();
    await advance(1000);
    expect(sent()).toHaveLength(n + 2);
    expect(sent().at(-1)).toMatchObject({ rf: true, cv: 2, rw: 30_000 });
    expect(sent().at(-1)!.p).toBeUndefined();
  }, 30_000);

  it('a secret shop never puts its content in a snapshot', async () => {
    await setup({
      settings: { 'starting-items': ['starter:sword'] },
      before: async () => {
        await dock({ type: 'openSession' });
        await join('al');
        await join('bo');
        await dock({ type: 'giveGold', target: 'dev:al', amount: 50 });
      },
    });
    const rv0 = b!.rv;
    expect(b!.roster[0]!.class).toBe('starter:fighter');
    const startShop = await dock({
      type: 'startEncounter',
      encounter: { 'starter:shop': { stock: [{ item: 'starter:shield', price: 20 }], time: '2m', secret: true } },
    });
    expect(startShop.ok).toBe(true);
    await advance(1000);
    const evBuy = s!.events().length;
    expect((await cmd('al', { type: 'respond', input: { buy: 'starter:shield' } })).ok).toBe(true);
    await advance(1000);
    const evEquip = s!.events().length;
    expect((await cmd('al', { type: 'equip', item: 'starter:shield' })).ok).toBe(true);
    await advance(1000);
    expect(s!.room.game.session!.encounter).toBeTruthy(); // the shop is still open

    expect(sent().length).toBeGreaterThan(0);
    for (const m of sent()) expect(JSON.stringify(m)).not.toMatch(/shop-list|price|entries|events|shield|purchased/);
    const lastMsg = sent().at(-1)!;
    expect(lastMsg.p!.find((e) => e[0] === key('al'))![1]).toBe('starter:tank');
    expect(lastMsg.rv).toBeGreaterThan(rv0);

    const shopEvents = s!.events().slice(0, evEquip).filter((e) => e.type === 'starter:purchased' || e.type === 'core:encounter-started');
    expect(shopEvents.length).toBeGreaterThan(0);
    for (const e of s!.events().slice(evBuy, evEquip)) expect(e.audience?.sort()).toEqual(['dev:al', 'dev:bo']);
    const equipEvents = s!.events().slice(evEquip);
    expect(equipEvents.length).toBeGreaterThan(0);
    for (const e of equipEvents) expect(e.audience).toBeUndefined();
  }, T);

  it('a restricted encounter that heals keeps its events restricted while p shows the new HP', async () => {
    const hush: PackBundle = {
      manifest: { id: 'tb', version: '1.0.0', name: 'Test Bundle', depends: { starter: '^1.0.0' } },
      official: true,
      content: [],
      register: definePack({
        register(api) {
          api.encounterKind<{ members: string[] }>('hush', {
            name: 'Hush',
            outcomes: () => ['done'],
            start: (ctx) => {
              for (const m of ctx.party()) ctx.dealDamage(null, m, 30);
              return { members: ctx.party().map((e) => e.id) };
            },
            respond: (ctx, st, ch) => { ctx.heal(null, ch, 20); return st; },
            wakeAt: () => null,
            advance: (_ctx, st) => st,
            endEarly: () => 'done',
            panel: () => ({ type: 'none' }),
            overlay: () => null,
            audience: (st) => st.members,
          });
        },
      }).register,
    };
    await setup({
      bundles: [...(await officialTestBundles()), hush],
      before: async () => {
        await dock({ type: 'openSession' });
        await join('al');
        await join('bo');
      },
    });
    // The encounter's start hurts the party (restricted events, public party state).
    expect((await dock({ type: 'startEncounter', encounter: { 'tb:hush': {} } })).ok).toBe(true);
    await advance(1000);
    const hpOf = (m: Msg) => m.p!.find((e) => e[0] === key('al'))![2];
    const hurt = hpOf(sent().at(-1)!);
    expect(hurt).toBeLessThan(100);
    const ev = s!.events().length;
    expect((await cmd('al', { type: 'respond', input: {} })).ok).toBe(true);
    await advance(1000);
    const heal = s!.events().slice(ev);
    expect(heal.some((e) => e.type === 'core:healed')).toBe(true);
    for (const e of heal) expect(e.audience?.sort()).toEqual(['dev:al', 'dev:bo']);
    expect(hpOf(sent().at(-1)!)).toBeGreaterThan(hurt);
    expect(sent().at(-1)!.ch).toContain(key('al'));
  }, T);

  it('final() runs the last broadcastState through the queue before the Room closes', async () => {
    await setup({ before: async () => { await dock({ type: 'openSession' }); } });
    await join('al');
    const send = await b!.final();
    s!.room.close();
    expect(await send(null)).toBe(true);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.ch).toEqual([key('al')]);
    expect(sent()[0]!.p![0]![0]).toBe(key('al'));
    // The timer is stopped: nothing more goes out.
    await s!.clock.advance(5000, () => b!.idle());
    expect(sent()).toHaveLength(1);
  }, T);

  it('a public-only change held back by the bare throttle goes out once the 30 s window passes', async () => {
    await setupLong();
    await dock({ type: 'giveGold', target: 'dev:al', amount: 1 });
    await advance(1000);
    expect(sent()).toHaveLength(1);
    const first = sent()[0]!.t;
    await advance(5000);
    await dock({ type: 'setMonsterHp', value: 900 }); // public only: no key waits
    await advance(40_000);
    expect(sent()).toHaveLength(2);
    expect(sent()[1]!.rf).toBe(true);
    expect(sent()[1]!.t - first).toBeGreaterThanOrEqual(30_000);
    expect(sent()[1]!.t - first).toBeLessThanOrEqual(31_000);
  }, T);

  it('a public-only change whose send failed is sent again on a later tick', async () => {
    await setup({ before: async () => { await dock({ type: 'openSession' }); await join('al'); await dock({ type: 'spawnMonster', monster: 'starter:slime' }); await dock({ type: 'holdMonster' }); } });
    fake!.failNext('pubsub');
    await dock({ type: 'setMonsterHp', value: 50 });
    await advance(1000);
    expect(sent()).toEqual([]);
    await advance(5000);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.f).toMatchObject({ hp: 50 });
    expect(sent()[0]!.ch).toEqual([]);
  }, T);

  it('final() skips the bare throttle and sends the waiting keys', async () => {
    await setupLong();
    await dock({ type: 'giveGold', target: 'dev:al', amount: 1 });
    await advance(1000);
    expect(sent()).toHaveLength(1);
    await dock({ type: 'giveGold', target: 'dev:al', amount: 1 }); // al's key waits, inside the window
    await advance(5000);
    expect(sent()).toHaveLength(1);
    const send = await b!.final();
    s!.room.close();
    expect(await send(null)).toBe(true);
    expect(sent()).toHaveLength(2);
    expect(sent()[1]).toMatchObject({ rf: true, rw: 30_000 });
  }, T);

  it('final() carries the keys of a tick whose read was still queued', async () => {
    await setup({ before: async () => { await dock({ type: 'openSession' }); } });
    await join('al');
    void b!.tick(); // its broadcastState() is queued; final() stops the Broadcaster before it resolves
    const send = await b!.final();
    s!.room.close();
    expect(await send(null)).toBe(true);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.ch).toEqual([key('al')]);
  }, T);

  it('final() with nothing to send resolves true without sending', async () => {
    await setup();
    const send = await b!.final();
    s!.room.close();
    expect(await send(null)).toBe(true);
    expect(sent()).toEqual([]);
  }, T);
});
