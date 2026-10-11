import { type Ctx, definePack, type EntityRef, p, type PackApi } from '@dndm/engine';
import { registerKinds } from './kinds';

const alive = (ctx: Ctx, list: EntityRef[]) => list.filter((e) => !ctx.isKnockedOut(e));

function registerCombat(api: PackApi): void {
  api.effect('damage', {
    params: p.object({ power: p.formula() }),
    apply(ctx, { source, target, params }) {
      let amount = ctx.formula(params.power, { source, target });
      if (source && ctx.random() * 100 < ctx.stat(source, 'crit-chance')) {
        amount *= ctx.stat(source, 'crit-multiplier');
        ctx.emit('starter:crit', { source, target }, `${ctx.name(source)} lands a critical hit!`);
      }
      amount *= 1 - Math.min(100, Math.max(0, ctx.stat(target, 'defense'))) / 100;
      ctx.dealDamage(source, target, amount);
    },
  });

  api.effect('heal', {
    params: p.object({ amount: p.formula() }),
    apply(ctx, { source, target, params }) {
      ctx.heal(source, target, ctx.formula(params.amount, { source, target }));
    },
  });

  api.effect('revive', {
    params: p.object({ hp: p.percent() }),
    apply(ctx, { target, params }) {
      if (ctx.isKnockedOut(target)) ctx.revive(target, Math.max(1, Math.round((ctx.maxHp(target) * params.hp) / 100)));
    },
  });

  api.effect('apply-status', {
    params: p.statusApplication(),
    apply(ctx, { source, target, params }) {
      ctx.applyStatus(target, params.status, { duration: params.duration, params: params.params, source });
    },
  });

  api.effect('remove-status', {
    params: p.object({ status: p.ref('status') }),
    apply(ctx, { target, params }) {
      ctx.removeStatus(target, params.status);
    },
  });

  api.effect('knock-out', {
    params: p.object({ chance: p.number({ min: 0, max: 1 }) }),
    apply(ctx, { target, params }) {
      if (ctx.random() < params.chance) ctx.knockOut(target);
    },
  });

  api.status('drowsy', {
    name: 'Drowsy',
    params: p.object({ multiplier: p.number({ min: 0 }) }),
    stacking: 'refresh',
    modify: { cooldown: (ms, { params }) => ms * params.multiplier },
  });

  api.status('guarding', {
    name: 'Guarding',
    params: p.object({ reduction: p.number({ min: 0, max: 100 }), priority: p.number() }),
    stacking: 'refresh',
    modify: {
      damageTaken: (v, { params }) => v * (1 - params.reduction / 100),
      targetPriority: (v, { params }) => v + params.priority,
    },
  });

  api.targeting('self', {
    candidates: (_ctx, { user }) => [user],
    select: (_ctx, { user }) => [user],
  });

  api.targeting('enemy', {
    candidates: (ctx, { user }) => alive(ctx, ctx.enemiesOf(user)),
    select(ctx, { user, chosen }) {
      if (chosen) return [chosen];
      const list = alive(ctx, ctx.enemiesOf(user));
      return list.length ? [list[ctx.randomInt(0, list.length - 1)]!] : [];
    },
  });

  api.targeting('ally', {
    needsChoice: true,
    candidates: (ctx, { user }) => alive(ctx, ctx.alliesOf(user)),
    select: (_ctx, { chosen }) => (chosen ? [chosen] : []),
  });

  api.targeting('knocked-out-ally', {
    needsChoice: true,
    candidates: (ctx, { user }) => ctx.alliesOf(user).filter((e) => ctx.isKnockedOut(e)),
    select: (_ctx, { chosen }) => (chosen ? [chosen] : []),
  });

  api.targeting('random-enemies', {
    params: p.object({ count: p.optional(p.integer({ min: 1 })) }),
    candidates: (ctx, { user }) => alive(ctx, ctx.enemiesOf(user)),
    select(ctx, { user, ability, params, hints }) {
      const n = (hints.count as number | undefined) ?? params.count ?? 1;
      return ctx.byPriority(user, ability, alive(ctx, ctx.enemiesOf(user))).slice(0, n);
    },
  });

  api.behavior('weighted', {
    params: p.object({ abilities: p.refMap('ability', p.number({ min: 0 })), 'targets-per': p.integer({ min: 1 }) }),
    act(ctx, { monster, params }) {
      const entries = Object.entries(params.abilities as Record<string, number>).filter(([, w]) => w > 0);
      const total = entries.reduce((sum, [, w]) => sum + w, 0);
      if (total === 0) return;
      let roll = ctx.random() * total;
      const pick = entries.find(([, w]) => (roll -= w) < 0)?.[0] ?? entries[entries.length - 1]![0];
      const count = Math.max(1, Math.ceil(ctx.active().length / params['targets-per']));
      ctx.useAbility(monster, pick, { hints: { count } });
    },
  });
}

export default definePack({
  register(api) {
    registerCombat(api);
    registerKinds(api);
  },
});
