import { describe, expect, it } from 'vitest';
import { me, starterHarness } from './helpers';

describe('starter classes (spec §9.3)', () => {
  it('fighter, tank and healer have the right stats and HP', async () => {
    const h = await starterHarness();
    h.open();
    h.join('fi', 'starter:sword'); h.join('ta', 'starter:shield'); h.join('he', 'starter:staff');
    expect(h.view('fi').character).toMatchObject({ class: 'starter:fighter', maxHp: 100, stats: { 'starter:attack': 10, 'starter:defense': 0 } });
    expect(h.view('ta').character).toMatchObject({ class: 'starter:tank', maxHp: 160, stats: { 'starter:attack': 5, 'starter:defense': 10 } });
    expect(h.view('he').character).toMatchObject({ class: 'starter:healer', maxHp: 90, stats: { 'starter:attack': 4, 'starter:healing': 30 } });
    expect(h.view('he').abilities.map((a) => a.ability)).toEqual(['starter:attack', 'starter:heal', 'starter:revive', 'starter:cure']);
  });

  it('attack does attack × 1.0–1.2, or double on a crit', async () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const h = await starterHarness({ seed });
      h.open(); h.join('fi'); h.spawn();
      h.use('fi', 'starter:attack');
      const dmg = h.log.find((e) => e.type === 'core:damaged')!.data.amount as number;
      expect(dmg >= 10 && dmg <= 12 || dmg >= 20 && dmg <= 24).toBe(true);
    }
  });

  it('power strike hits twice', async () => {
    const h = await starterHarness();
    h.open(); h.join('fi'); h.spawn('starter:goblin-king');
    h.use('fi', 'starter:power-strike');
    expect(h.log.filter((e) => e.type === 'core:damaged')).toHaveLength(2);
    expect(h.char('fi').cooldowns['starter:power-strike']).toBe(45000);
  });

  it('guard halves damage and draws the attack; with more targets the tank is hit first and once', async () => {
    const overrides = { 'starter:goblin-king': { behavior: { weighted: { abilities: { 'club-swing': 1, yawn: 0 }, 'targets-per': 1 } } } };
    const h = await starterHarness({ overrides });
    h.open(); h.join('ta', 'starter:shield'); h.join('fi');
    h.spawn('starter:goblin-king');
    h.at(15000).use('ta', 'starter:guard');
    h.wait(5000);
    // goblin attack 12 × (1 - 10% defense) = 10.8, × 50% guarding = 5.4 -> 5. targets-per 1 with 2 active -> 2 targets.
    expect(h.char('ta').hp).toBe(155);
    expect(h.char('fi').hp).toBe(88);
    const hits = h.log.filter((e) => e.type === 'core:damaged' && e.at === 20000);
    expect(hits.map((e) => (e.data.target as { id: string }).id)).toEqual(['ta', 'fi']);
  });

  it('heal, revive and cure', async () => {
    const h = await starterHarness();
    h.open(); h.join('he', 'starter:staff'); h.join('fi'); h.spawn('starter:dozing-ogre');
    h.do({ type: 'knockOut', character: 'fi' });
    h.use('he', 'starter:revive', 'fi');
    expect(h.char('fi')).toMatchObject({ knockedOutUntil: null, hp: 30 });
    h.use('he', 'starter:heal', 'fi');
    expect(h.char('fi').hp).toBe(60);
    h.do({ type: 'applyStatus', target: me('fi'), status: 'starter:drowsy', duration: '30s', params: { multiplier: 1.5 } });
    h.use('he', 'starter:cure', 'fi');
    expect(h.char('fi').statuses).toEqual([]);
  });

  it('drowsy makes new cooldowns longer', async () => {
    const h = await starterHarness();
    h.open(); h.join('fi'); h.spawn();
    h.do({ type: 'applyStatus', target: me('fi'), status: 'starter:drowsy', duration: '30s', params: { multiplier: 1.5 } });
    h.use('fi', 'starter:attack');
    expect(h.char('fi').cooldowns['starter:attack']).toBe(15000);
  });

  it('crushing blow can knock out', async () => {
    const overrides = {
      'ability starter:crushing-blow': { steps: [{ 'knock-out': { chance: 1 } }] },
      'starter:dozing-ogre': { behavior: { weighted: { abilities: { 'club-swing': 0, yawn: 0, 'crushing-blow': 1 }, 'targets-per': 5 } } },
    };
    const h = await starterHarness({ overrides });
    h.open(); h.join('fi'); h.spawn('starter:dozing-ogre');
    h.wait(25000);
    expect(h.char('fi').knockedOutUntil).not.toBeNull();
  });

  it('potions and smelling salts work outside fights', async () => {
    const h = await starterHarness();
    h.open(); h.join('fi');
    h.do({ type: 'giveItem', target: 'fi', item: 'starter:health-potion' });
    h.do({ type: 'giveItem', target: 'fi', item: 'starter:smelling-salts' });
    h.do({ type: 'applyStatus', target: me('fi'), status: 'starter:drowsy', duration: '30s', params: { multiplier: 1.5 } });
    h.use('fi', 'starter:smelling-salts');
    expect(h.char('fi').statuses).toEqual([]);
    expect(h.char('fi').inventory).toEqual({ 'starter:health-potion': 1 });
  });
});
