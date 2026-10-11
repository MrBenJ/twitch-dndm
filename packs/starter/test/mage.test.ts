import { definePack, p, type PackBundle, Rejection } from '@dndm/engine';
import { describe, expect, it } from 'vitest';
import { starterHarness } from './helpers';

/** A pack outside the starter, written only against the public API. */
const mage: PackBundle = {
  manifest: { id: 'mage', version: '1.0.0', name: 'Mage', depends: { starter: '^1.0.0' } },
  official: true,
  content: [
    { stat: 'mana', name: 'Mana', default: 20 },
    { class: 'mage', name: 'Mage', stats: { 'starter:defense': 5 }, abilities: ['starter:attack', 'fireball'], passives: [{ thorns: { amount: 2 } }] },
    { item: 'wand', name: 'Wand', slot: 'starter:weapon', 'grants-class': 'mage' },
    { ability: 'fireball', name: 'Fireball', cooldown: '5s', target: 'starter:enemy', steps: [{ fireball: { power: '2 * starter:attack', cost: 10 } }] },
  ].map((doc, index) => ({ file: 'mage.yaml', index, doc })),
  register: definePack({
    register(api) {
      api.effect('fireball', {
        params: p.object({ power: p.formula(), cost: p.integer({ min: 0 }) }),
        apply(ctx, { source, target, params }) {
          if (!source) return;
          const store = ctx.store(source) as { mana?: number };
          const mana = store.mana ?? ctx.stat(source, 'mana');
          if (mana < params.cost) throw new Rejection('Not enough mana');
          ctx.setStore(source, { mana: mana - params.cost });
          ctx.dealDamage(source, target, ctx.formula(params.power, { source, target }), { tags: ['fire'] });
          ctx.applyStatus(target, 'burning', { duration: 6000, params: { per: 3 }, source });
        },
      });
      api.status('burning', {
        name: 'Burning',
        params: p.object({ per: p.integer({ min: 0 }) }),
        tick: { every: '2s', run: (ctx, { holder, params, source }) => { ctx.dealDamage(source, holder, params.per, { tags: ['fire'] }); } },
      });
      api.passive('thorns', {
        name: 'Thorns',
        params: p.object({ amount: p.integer({ min: 0 }) }),
        react: {
          damaged: ({ ctx, holder, role, event, params }) => {
            if (role === 'target' && event.source && event.source.kind !== holder.kind) ctx.dealDamage(holder, event.source, params.amount);
          },
        },
      });
    },
  }).register,
};

describe('a second pack alongside the starter (success criterion 3)', () => {
  it('adds a stat, status, effect, passive and class with no engine change', async () => {
    const h = await starterHarness({
      extraPacks: [mage], packs: ['starter', 'mage'],
      startingItems: ['starter:sword', 'starter:shield', 'starter:staff', 'mage:wand'],
      overrides: { 'starter:goblin-king': { behavior: { weighted: { abilities: { 'club-swing': 1, yawn: 0 }, 'targets-per': 5 } } } },
    });
    h.open();
    h.join('mo', 'mage:wand');
    expect(h.view('mo').character).toMatchObject({ class: 'mage:mage', stats: { 'mage:mana': 20, 'starter:defense': 5 } });
    h.spawn('starter:goblin-king');

    // New effect + new status: 20 mana -> 10, burning applied.
    h.use('mo', 'mage:fireball');
    expect(h.monster().statuses.map((s) => s.status)).toEqual(['mage:burning']);
    // Second cast after the cooldown: 10 -> 0. A third is refused by the effect itself.
    h.at(5000).use('mo', 'mage:fireball');
    expect(h.fail({ type: 'use', character: 'mo', ability: 'mage:fireball' }).code).toBe('on-cooldown');
    h.at(10000);
    expect(h.fail({ type: 'use', character: 'mo', ability: 'mage:fireball' })).toEqual({ code: 'rejected', message: 'Not enough mana' });

    // Burning ticks every 2s for 3 (from the caster).
    const ticks = h.wait(10000).filter((e) => e.type === 'core:damaged' && e.data.amount === 3);
    expect(ticks.length).toBeGreaterThan(0);

    // New passive: the goblin's swing at 20s is answered by thorns for 2.
    h.wait(1000);
    const thorns = h.log.filter((e) => e.type === 'core:damaged' && (e.data.target as { kind: string }).kind === 'monster' && e.data.amount === 2);
    expect(thorns).toHaveLength(1);
    expect(thorns[0]!.at).toBe(20000);
  });
});
