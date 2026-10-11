import { describe, expect, it } from 'vitest';
import { createEngine } from '../src';
import { makeCtx } from '../src/ctx';
import { charRef, hp, monsterRef } from '../src/entities';
import { drainReactions } from '../src/hooks';
import {
  applyStatus, dealDamage, giveRewards, heal, knockOut, removeStatus, revive, spendGold, useAbility,
} from '../src/ops';
import type { PackApi } from '../src/pack';
import { Runtime } from '../src/runtime';
import { newCharacter, newGameState } from '../src/state';
import { withPlugins } from './helpers/harness';
import { tpBundle, tpChannel } from './helpers/tp-pack';

const EXTRA = (api: PackApi) => {
  api.passive('spiky', {
    name: 'Spiky',
    react: { damaged: ({ ctx, holder, role, event }) => { if (role === 'target' && event.source) ctx.dealDamage(holder, event.source, 1); } },
  });
  api.passive('ward', { name: 'Ward', modify: { damageTaken: (v) => v / 2 } });
  api.passive('lucky', { name: 'Lucky', modify: { rewardsReceived: (r) => ({ ...r, gold: r.gold + 10 }) } });
  api.status('mute', { name: 'Mute', modify: { canUse: () => 'You are muted' } });
};
const CONTENT = [
  { class: 'spiker', name: 'Spiker', abilities: ['whack'], passives: ['spiky'] },
  { item: 'thorn', name: 'Thorn', slot: 'hand', 'grants-class': 'spiker' },
  { item: 'charm', name: 'Charm', slot: 'body', passives: ['lucky'] },
  {
    monster: 'urchin', name: 'Urchin', hp: 500, abilities: ['slam'], passives: ['spiky'],
    behavior: { pile: { abilities: { slam: 1 }, 'targets-per': 5 } },
  },
  {
    monster: 'turtle', name: 'Turtle', hp: 100, abilities: ['slam'], passives: ['ward'],
    behavior: { pile: { abilities: { slam: 1 }, 'targets-per': 5 } },
  },
];

function fixture(monster = 'tp:blob') {
  const engine = createEngine({ packs: [withPlugins(tpBundle(CONTENT), EXTRA)], channel: tpChannel() });
  const game = newGameState(1);
  const rt = new Runtime(engine.registry, game);
  for (const [id, item] of [['al', 'tp:club'], ['mo', 'tp:rod']] as const) {
    const ch = newCharacter(id, id.toUpperCase());
    ch.equipped['tp:hand'] = item;
    ch.hp = 100;
    game.characters[id] = ch;
  }
  game.characters.mo!.hp = 90;
  const def = engine.registry.monsters.get(monster)!;
  game.session = {
    party: ['al', 'mo'], adventure: null,
    encounter: {
      kind: 'core:fight', startedAt: 0, origin: null, sub: 'fighting', held: false, heldRemaining: null,
      nextTurnAt: 15000, pausedTurnAt: null, acted: [], wasActive: ['al', 'mo'], joinedAt: { al: 0, mo: 0 },
      monsters: [{ id: 'm1', def, hp: def.hp, knockedOut: false, statuses: [], stores: {} }],
    },
  };
  return { rt, game, engine };
}
const al = charRef('al');
const mo = charRef('mo');
const m1 = monsterRef('m1');

describe('damage and healing', () => {
  it('deals rounded damage, emits an event, and knocks out at 0', () => {
    const { rt } = fixture();
    expect(dealDamage(rt, al, mo, 10.4, [])).toBe(10);
    expect(hp(rt, mo)).toBe(80);
    expect(rt.events.at(-1)).toMatchObject({ type: 'core:damaged', text: 'AL hits MO for 10', data: { amount: 10 } });
    dealDamage(rt, al, mo, 500, []);
    expect(rt.game.characters.mo!.knockedOutUntil).toBe(60000);
    expect(rt.events.map((e) => e.type)).toContain('core:knocked-out');
    expect(dealDamage(rt, al, mo, 5, [])).toBe(0);
  });

  it('runs damageTaken modifiers', () => {
    const { rt } = fixture('tp:turtle');
    expect(dealDamage(rt, al, m1, 10, [])).toBe(5);
  });

  it('heals up to max HP and not while knocked out', () => {
    const { rt } = fixture();
    rt.game.characters.al!.hp = 50;
    expect(heal(rt, mo, al, 30)).toBe(30);
    expect(heal(rt, mo, al, 999)).toBe(20);
    knockOut(rt, al, undefined, null);
    expect(heal(rt, mo, al, 10)).toBe(0);
  });

  it('revives and ends knockouts', () => {
    const { rt } = fixture();
    knockOut(rt, al, 5000, null);
    expect(rt.game.characters.al!.knockedOutUntil).toBe(5000);
    revive(rt, al, 30, null);
    expect(rt.game.characters.al!.knockedOutUntil).toBeNull();
    expect(hp(rt, al)).toBe(30);
  });

  it('skips source modifiers when there is no source', () => {
    const { rt } = fixture();
    expect(dealDamage(rt, null, mo, 7, [])).toBe(7);
    expect(rt.events.at(-1)!.text).toBe('MO takes 7 damage');
  });
});

describe('statuses', () => {
  it('applies with refresh stacking, ticks are scheduled, and removal emits', () => {
    const { rt } = fixture();
    rt.now = 1000;
    applyStatus(rt, al, 'tp:snooze', 30000, { factor: 1.5 }, null);
    applyStatus(rt, al, 'tp:snooze', 10000, { factor: 2 }, null);
    expect(rt.game.characters.al!.statuses).toEqual([
      expect.objectContaining({ status: 'tp:snooze', until: 11000, params: { factor: 2 } }),
    ]);
    removeStatus(rt, al, 'tp:snooze', 'removed');
    expect(rt.game.characters.al!.statuses).toEqual([]);
    expect(rt.events.map((e) => e.type)).toEqual(['core:status-applied', 'core:status-applied', 'core:status-ended']);
  });

  it('treats core:knocked-out as a knockout', () => {
    const { rt } = fixture();
    applyStatus(rt, al, 'core:knocked-out', 2000, {}, null);
    expect(rt.game.characters.al!.knockedOutUntil).toBe(2000);
  });
});

describe('abilities', () => {
  it('uses an ability: cooldown with modifiers, steps in order, acted', () => {
    const { rt } = fixture();
    applyStatus(rt, al, 'tp:snooze', null, { factor: 1.5 }, null);
    expect(useAbility(rt, al, 'tp:zap', null, {}, true)).toBe(true);
    expect(rt.game.characters.al!.cooldowns['tp:zap']).toBe(45000);
    expect(hp(rt, m1)).toBe(50 - 10 - 20);
    expect((rt.game.session!.encounter as { acted: string[] }).acted).toEqual(['al']);
  });

  it('requires a valid choice for needsChoice rules', () => {
    const { rt } = fixture();
    expect(() => useAbility(rt, mo, 'tp:mend', null, {}, true)).toThrow('Pick a target');
    expect(() => useAbility(rt, mo, 'tp:mend', m1, {}, true)).toThrow("That target isn't valid");
    rt.game.characters.al!.hp = 50;
    useAbility(rt, mo, 'tp:mend', al, {}, true);
    expect(hp(rt, al)).toBe(70);
  });

  it('a monster ability with hints targets that many enemies', () => {
    const { rt } = fixture();
    useAbility(rt, m1, 'tp:slam', null, { count: 2 }, false);
    expect(hp(rt, al)).toBe(94);
    expect(hp(rt, mo)).toBe(84);
  });
});

describe('reactions', () => {
  it('runs reactions after the operation and stops chains at depth 8', () => {
    const { rt } = fixture('tp:urchin');
    rt.game.characters.al!.equipped['tp:hand'] = 'tp:thorn';
    rt.game.characters.al!.inventory['tp:thorn'] = 1;
    useAbility(rt, al, 'tp:whack', null, {}, true);
    drainReactions(rt);
    const damaged = rt.events.filter((e) => e.type === 'core:damaged');
    expect(damaged).toHaveLength(9);
    expect(rt.events.filter((e) => e.type === 'core:reaction-limit')).toHaveLength(1);
  });
});

describe('rewards, gold and plugin ctx', () => {
  it('applies multipliers then rewardsReceived', () => {
    const engine = createEngine({ packs: [withPlugins(tpBundle(CONTENT), EXTRA)], channel: tpChannel({ settings: { 'gold-multiplier': 2 } }) });
    const rt = new Runtime(engine.registry, newGameState(1));
    const ch = newCharacter('al', 'AL');
    ch.equipped['tp:body'] = 'tp:charm';
    ch.inventory['tp:charm'] = 1;
    rt.game.characters.al = ch;
    giveRewards(rt, al, { xp: 90, gold: 5, items: ['tp:biscuit'] });
    expect(ch).toMatchObject({ xp: 90, gold: 20, level: 2, inventory: { 'tp:charm': 1, 'tp:biscuit': 1 } });
    expect(rt.events.map((e) => e.type)).toEqual(['core:rewarded', 'core:level-up', 'core:item-given']);
  });

  it('spendGold rejects when short', () => {
    const { rt } = fixture();
    rt.game.characters.al!.gold = 5;
    expect(() => spendGold(rt, al, 10)).toThrow('Not enough gold');
    spendGold(rt, al, 5);
    expect(rt.game.characters.al!.gold).toBe(0);
  });

  it('ctx resolves short IDs against its pack and guards custom events and stores', () => {
    const { rt } = fixture();
    const ctx = makeCtx(rt, 'tp');
    expect(ctx.stat(al, 'power')).toBe(10);
    expect(ctx.formula('power + target.power', { source: al, target: m1 })).toBe(16);
    expect(() => ctx.formula('power', { source: null, target: m1 })).toThrow(/uses the source/);
    expect(() => ctx.emit('other:x', {}, 'x')).toThrow(/must start with 'tp:'/);
    ctx.emit('tp:cheer', { n: 1 }, 'Cheer!');
    ctx.setStore(al, { mana: 3 });
    expect(ctx.store(al)).toEqual({ mana: 3 });
    expect(makeCtx(rt, 'other').store(al)).toEqual({});
    expect(rt.events.map((e) => e.type)).toEqual(['tp:cheer', 'core:store-changed']);
  });

  it('byPriority puts higher priority first', () => {
    const { rt } = fixture();
    applyStatus(rt, mo, 'tp:shielded', null, { cut: 0, priority: 1 }, null);
    const ctx = makeCtx(rt, 'tp');
    expect(ctx.byPriority(m1, 'tp:slam', [al, mo])).toEqual([mo, al]);
  });
});
