import { definePack, type PackBundle } from '@dndm/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { officialTestBundles, roomSetup } from './helpers/room';

let s: Awaited<ReturnType<typeof roomSetup>>;
afterEach(async () => { await s.done(); });

async function party(names: string[], pick = 'starter:sword') {
  await s.cmd(s.dock, { type: 'openSession' });
  for (const n of names) await s.cmd(s.v(n), { type: 'join', name: n, pick });
}

async function heldFight(names: string[]) {
  await party(names);
  await s.cmd(s.dock, { type: 'spawnMonster', monster: 'starter:slime' });
  await s.cmd(s.dock, { type: 'holdMonster' });
}

const attack = (name: string) => s.cmd(s.v(name), { type: 'use', ability: 'starter:attack' });

/** A pack whose sword can only be used once the monster is at half HP or below. */
const patientBundle: PackBundle = {
  manifest: { id: 'tb', version: '1.0.0', name: 'Test Bundle', depends: { starter: '^1.0.0' } },
  official: true,
  content: [
    { item: 'patient-sword', name: 'Patient Sword', slot: 'starter:weapon', 'grants-class': 'starter:fighter', passives: ['patient'] },
  ].map((doc, index) => ({ file: 'tb.yaml', index, doc })),
  register: definePack({
    register(api) {
      api.passive('patient', {
        name: 'Patient',
        modify: {
          canUse: (v, { ctx, holder }) => (ctx.enemiesOf(holder).some((m) => ctx.hp(m) * 2 > ctx.maxHp(m)) ? 'Too early' : v),
        },
      });
    },
  }).register,
};

describe('room.broadcastState() (spec 2b §5.2)', () => {
  it('loading a character with a view read does not put them in changed', async () => {
    s = await roomSetup({ broadcast: true });
    await party(['al']);
    await s.cmd(s.dock, { type: 'closeSession' });
    await s.reload();
    expect(s.room.game.characters['dev:al']).toBeUndefined();
    await s.room.broadcastState();
    await s.room.view(s.v('al'));
    expect(s.room.game.characters['dev:al']).toBeDefined();
    expect((await s.room.broadcastState()).changed).toEqual([]);
  });

  it('a join that loads and changes a character does', async () => {
    s = await roomSetup({ broadcast: true });
    await s.cmd(s.dock, { type: 'openSession' });
    await s.room.broadcastState();
    await s.cmd(s.v('al'), { type: 'join', name: 'Al', pick: 'starter:sword' });
    expect((await s.room.broadcastState()).changed).toEqual(['dev:al']);
  });

  it('a loaded character with no connection whose state changed is included, an unchanged one is not', async () => {
    s = await roomSetup({ broadcast: true });
    await party(['al', 'bo']);
    await s.room.broadcastState();
    await s.cmd(s.dock, { type: 'giveGold', target: 'dev:al', amount: 10 });
    expect((await s.room.broadcastState()).changed).toEqual(['dev:al']);
    expect((await s.room.broadcastState()).changed).toEqual([]);
  });

  it('a cooldown running out alone changes nothing', async () => {
    s = await roomSetup({ broadcast: true });
    await heldFight(['al']);
    expect((await attack('al')).ok).toBe(true);
    expect((await s.room.broadcastState()).changed).toEqual(['dev:al']);
    const end = s.room.game.characters['dev:al']!.cooldowns['starter:attack']!;
    await s.advance(end - s.clock.now() + 1);
    expect((await s.room.view(s.v('al'))).abilities[0]!.ready).toBe(true);
    expect((await s.room.broadcastState()).changed).not.toContain('dev:al');
  });

  it('a fight starting puts members whose readiness flips in changed', async () => {
    s = await roomSetup({ broadcast: true });
    await party(['al', 'bo']);
    await s.room.broadcastState();
    await s.cmd(s.dock, { type: 'spawnMonster', monster: 'starter:slime' });
    expect((await s.room.broadcastState()).changed.sort()).toEqual(['dev:al', 'dev:bo']);
  });

  it('a public change puts nobody but the actor in changed (starter pack)', async () => {
    s = await roomSetup({ broadcast: true });
    await heldFight(['al', 'bo']);
    await s.room.broadcastState();
    const hp = (await s.room.view(s.overlay)).fight!.monster.hp;
    expect((await attack('al')).ok).toBe(true);
    expect((await s.room.view(s.overlay)).fight!.monster.hp).toBeLessThan(hp);
    expect((await s.room.broadcastState()).changed).toEqual(['dev:al']);
  });

  it('with a pack whose canUse reads monster HP, a monster HP change puts the affected members in changed', async () => {
    const official = await officialTestBundles();
    s = await roomSetup({
      broadcast: true,
      bundles: [...official, patientBundle],
      settings: { 'starting-items': ['starter:sword', 'starter:shield', 'starter:staff', 'tb:patient-sword'] },
    });
    await party(['al']);
    await s.cmd(s.v('bo'), { type: 'join', name: 'bo', pick: 'tb:patient-sword' });
    await s.cmd(s.dock, { type: 'spawnMonster', monster: 'starter:slime' });
    await s.cmd(s.dock, { type: 'holdMonster' });
    // Just above half: bo still has to wait.
    await s.cmd(s.dock, { type: 'setMonsterHp', value: 41 });
    expect((await s.room.view(s.v('bo'))).abilities[0]!.reason).toBe('Too early');
    await s.room.broadcastState();
    expect((await attack('al')).ok).toBe(true);
    expect((await s.room.view(s.overlay)).fight!.monster.hp).toBeLessThanOrEqual(40);
    expect((await s.room.view(s.v('bo'))).abilities[0]!.ready).toBe(true);
    expect((await s.room.broadcastState()).changed).toContain('dev:bo');
  });

  it('inputs counts saved inputs only', async () => {
    s = await roomSetup({ broadcast: true });
    const before = s.room.inputs;
    await s.cmd(s.v('al'), { type: 'leave' }); // rejected: not in party
    expect(s.room.inputs).toBe(before);
    await s.cmd(s.dock, { type: 'openSession' });
    expect(s.room.inputs).toBe(before + 1);
    expect((await s.room.broadcastState()).inputs).toBe(before + 1);
  });

  it('inputs counts timer ticks and config changes', async () => {
    s = await roomSetup({ broadcast: true });
    await party(['al']);
    await s.cmd(s.dock, { type: 'spawnMonster', monster: 'starter:slime' });
    const before = s.room.inputs;
    await s.advance(15_000); // a monster turn
    expect(s.room.inputs).toBeGreaterThan(before);
    const ticked = s.room.inputs;
    const cfg = await s.cmd(s.dock, { type: 'getConfig' });
    const { config, configVersion } = (cfg as { result: { config: Record<string, unknown>; configVersion: number } }).result;
    expect((await s.cmd(s.dock, { type: 'updateConfig', config, basedOn: configVersion })).ok).toBe(true);
    expect(s.room.inputs).toBe(ticked + 1);
  });

  it('broadcastState does not keep a Room loaded', async () => {
    s = await roomSetup({ broadcast: true });
    s.unsubscribe();
    await s.room.broadcastState();
    await s.clock.advance(31 * 60_000, () => s.room.idle());
    await s.room.broadcastState();
    expect(s.room.canUnload(s.clock.now())).toBe(true);
  });

  it('one broadcastState pass over 300 party members in a fight stays fast', async () => {
    s = await roomSetup({ broadcast: true });
    const names = Array.from({ length: 300 }, (_, i) => `c${i}`);
    await heldFight(names);
    await s.room.broadcastState();
    await s.cmd(s.dock, { type: 'giveGold', target: 'dev:c7', amount: 1 });
    const t0 = performance.now();
    const { changed } = await s.room.broadcastState();
    const ms = performance.now() - t0;
    expect(changed).toEqual(['dev:c7']);
    // Measured ~5 ms on the dev machine (~820 ms before the batched engine.ownViews); the bound leaves a wide margin.
    expect(ms).toBeLessThan(100);
  }, 60_000);

  it('a Room without a Broadcaster refuses broadcastState', async () => {
    s = await roomSetup();
    expect(s.room.broadcasting).toBe(false);
    await expect(s.room.broadcastState()).rejects.toThrow('broadcastState needs a Room with a Broadcaster');
  });
  it('the sweep keeps a character with an unbroadcast change, and drops them after broadcastState', async () => {
    s = await roomSetup({ broadcast: true });
    await s.cmd(s.dock, { type: 'openSession' });
    await s.cmd(s.v('al'), { type: 'join', name: 'Al', pick: 'starter:sword' });
    await s.cmd(s.v('al'), { type: 'leave' });
    await s.clock.advance(11 * 60_000, () => s.room.idle());
    await s.room.sweep();
    expect(s.room.game.characters['dev:al']).toBeDefined();
    expect((await s.room.broadcastState()).changed).toContain('dev:al');
    await s.room.sweep();
    expect(s.room.game.characters['dev:al']).toBeUndefined();
  });
});
