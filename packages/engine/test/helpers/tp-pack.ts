import { definePack, type PackBundle } from '../../src/pack';
import { p } from '../../src/params';

/** Content for the test pack. Mirrors what YAML would hold. */
export const TP_CONTENT: unknown[] = [
  { stat: 'power', name: 'Power', default: 5, 'per-level': 1 },
  { stat: 'grit', name: 'Grit', default: 0 },
  { slot: 'hand', name: 'Hand' },
  { slot: 'body', name: 'Body' },
  { class: 'brute', name: 'Brute', stats: { power: 5 }, abilities: ['whack', 'zap'] },
  { class: 'mender', name: 'Mender', stats: { hp: -10 }, abilities: ['whack', 'mend', 'wake'] },
  { ability: 'whack', name: 'Whack', cooldown: '10s', target: 'foe', steps: [{ poke: { power: 'power' } }] },
  { ability: 'zap', name: 'Zap', cooldown: '30s', target: 'foe', steps: [{ poke: { power: 'power' } }, { poke: { power: '2 * power' } }] },
  { ability: 'mend', name: 'Mend', cooldown: '15s', target: 'pal', steps: [{ fix: { amount: 20 } }] },
  { ability: 'wake', name: 'Wake', cooldown: '60s', target: 'downed-pal', steps: [{ lift: { hp: '30%' } }] },
  { ability: 'snack', name: 'Snack', cooldown: '5s', when: 'anytime', target: 'me', steps: [{ fix: { amount: 15 } }] },
  { ability: 'slam', name: 'Slam', cooldown: '1s', target: { hunt: { count: 1 } }, steps: [{ poke: { power: 'power' } }] },
  { ability: 'lull', name: 'Lull', cooldown: '1s', target: { hunt: {} }, steps: [{ put: { status: 'snooze', duration: '30s', factor: 1.5 } }] },
  { item: 'club', name: 'Club', slot: 'hand', 'grants-class': 'brute' },
  { item: 'rod', name: 'Rod', slot: 'hand', 'grants-class': 'mender' },
  { item: 'mallet', name: 'Mallet', slot: 'hand', 'grants-class': 'brute', stats: { power: 2 }, price: 30 },
  { item: 'vest', name: 'Vest', slot: 'body', stats: { hp: 20, grit: 5 }, price: 40 },
  { item: 'biscuit', name: 'Biscuit', use: 'snack', uses: 2, price: 5 },
  {
    monster: 'blob', name: 'Blob', hp: 50, stats: { power: 6 }, abilities: ['slam'],
    behavior: { pile: { abilities: { slam: 1 }, 'targets-per': 5 } }, interval: '15s',
    rewards: { xp: 20, gold: 5 }, drops: [{ item: 'biscuit', chance: 0.5 }],
  },
  {
    monster: 'ogre', name: 'Ogre', hp: 300, stats: { power: 15, grit: 10 }, abilities: ['slam', 'lull'],
    behavior: { pile: { abilities: { slam: 2, lull: 1 }, 'targets-per': 5 } },
    rewards: { xp: 100, gold: 40 },
  },
  { encounter: 'chat', show: { text: 'Hello there', 'show-for': '10s' } },
  {
    adventure: 'trip', name: 'Trip', start: 'intro',
    nodes: {
      intro: { show: { text: 'Off we go' }, next: 'pick' },
      pick: { ballot: { choices: { a: 'Left', b: 'Right' }, time: '30s' }, next: { a: 'fight', b: 'talk' } },
      fight: { fight: 'blob', next: { won: 'end', default: 'end' } },
      talk: { use: 'chat', next: 'end' },
      end: { show: { text: 'Done' } },
    },
  },
];

export function tpBundle(extraContent: unknown[] = []): PackBundle {
  return {
    manifest: { id: 'tp', version: '1.0.0', name: 'Test Pack', depends: {} },
    official: true,
    content: [...TP_CONTENT, ...extraContent].map((doc, index) => ({ file: 'tp.yaml', index, doc })),
    register: definePack({
      register(api) {
        api.effect('poke', {
          params: p.object({ power: p.formula() }),
          apply(ctx, { source, target, params }) {
            const raw = ctx.formula(params.power, { source, target });
            ctx.dealDamage(source, target, raw * (1 - ctx.stat(target, 'grit') / 100));
          },
        });
        api.effect('fix', {
          params: p.object({ amount: p.formula() }),
          apply(ctx, { source, target, params }) {
            ctx.heal(source, target, ctx.formula(params.amount, { source, target }));
          },
        });
        api.effect('lift', {
          params: p.object({ hp: p.percent() }),
          apply(ctx, { target, params }) {
            if (ctx.isKnockedOut(target)) ctx.revive(target, Math.max(1, Math.round((ctx.maxHp(target) * params.hp) / 100)));
          },
        });
        api.effect('put', {
          params: p.statusApplication(),
          apply(ctx, { source, target, params }) {
            ctx.applyStatus(target, params.status, { duration: params.duration, params: params.params, source });
          },
        });
        api.status('snooze', {
          name: 'Snooze',
          params: p.object({ factor: p.number({ min: 0 }) }),
          modify: { cooldown: (ms, { params }) => ms * params.factor },
        });
        api.status('shielded', {
          name: 'Shielded',
          params: p.object({ cut: p.number({ min: 0, max: 100 }), priority: p.number() }),
          modify: {
            damageTaken: (v, { params }) => v * (1 - params.cut / 100),
            targetPriority: (v, { params }) => v + params.priority,
          },
        });
        api.targeting('me', { candidates: (_ctx, { user }) => [user], select: (_ctx, { user }) => [user] });
        api.targeting('foe', {
          candidates: (ctx, { user }) => ctx.enemiesOf(user).filter((e) => !ctx.isKnockedOut(e)),
          select(ctx, { user, chosen }) {
            const list = ctx.enemiesOf(user).filter((e) => !ctx.isKnockedOut(e));
            if (chosen) return [chosen];
            return list.length ? [list[ctx.randomInt(0, list.length - 1)]!] : [];
          },
        });
        api.targeting('pal', {
          needsChoice: true,
          candidates: (ctx, { user }) => ctx.alliesOf(user).filter((e) => !ctx.isKnockedOut(e)),
          select: (_ctx, { chosen }) => (chosen ? [chosen] : []),
        });
        api.targeting('downed-pal', {
          needsChoice: true,
          candidates: (ctx, { user }) => ctx.alliesOf(user).filter((e) => ctx.isKnockedOut(e)),
          select: (_ctx, { chosen }) => (chosen ? [chosen] : []),
        });
        api.targeting('hunt', {
          params: p.object({ count: p.optional(p.integer({ min: 1 })) }),
          candidates: (ctx, { user }) => ctx.enemiesOf(user).filter((e) => !ctx.isKnockedOut(e)),
          select(ctx, { user, ability, params, hints }) {
            const n = (hints.count as number | undefined) ?? params.count ?? 1;
            const list = ctx.enemiesOf(user).filter((e) => !ctx.isKnockedOut(e));
            return ctx.byPriority(user, ability, list).slice(0, n);
          },
        });
        api.behavior('pile', {
          params: p.object({ abilities: p.refMap('ability', p.number({ min: 0 })), 'targets-per': p.integer({ min: 1 }) }),
          act(ctx, { monster, params }) {
            const entries = Object.entries(params.abilities as Record<string, number>).filter(([, w]) => w > 0);
            const total = entries.reduce((s, [, w]) => s + w, 0);
            if (total === 0) return;
            let roll = ctx.random() * total;
            const pick = entries.find(([, w]) => (roll -= w) < 0)?.[0] ?? entries[entries.length - 1]![0];
            const count = Math.max(1, Math.ceil(ctx.active().length / params['targets-per']));
            ctx.useAbility(monster, pick, { hints: { count } });
          },
        });
        api.encounterKind('show', {
          name: 'Show',
          params: p.object({ text: p.string(), 'show-for': p.optional(p.duration()) }),
          input: p.object({}),
          outcomes: () => ['done'],
          start: (ctx, params) => ({ endsAt: params['show-for'] ? ctx.now + params['show-for'] : null }),
          respond: () => { throw new Error('nothing to respond to'); },
          wakeAt: (s) => s.endsAt,
          advance(ctx, s) { ctx.endEncounter('done'); return s; },
          endEarly: () => 'done',
          panel: (_s, _v, params) => ({ type: 'story-card', text: params.text }),
          overlay: (s, params) => ({ text: params.text, ...(s.endsAt ? { 'closes-at': s.endsAt } : {}) }),
        });
        api.encounterKind('ballot', {
          name: 'Ballot',
          params: p.object({ choices: p.record(p.string()), time: p.duration() }),
          input: p.object({ choice: p.string() }),
          outcomes: (params) => Object.keys(params.choices),
          start: (ctx, params) => ({ closesAt: ctx.now + params.time, votes: {} as Record<string, string> }),
          respond(_ctx, s, character, input, params) {
            if (!(input.choice in params.choices)) throw new Error(`no such choice ${input.choice}`);
            return { ...s, votes: { ...s.votes, [character.id]: input.choice } };
          },
          wakeAt: (s) => s.closesAt,
          advance(ctx, s, params) {
            const keys = Object.keys(params.choices);
            const count = (k: string) => Object.values(s.votes).filter((v) => v === k).length;
            const best = keys.reduce((a, b) => (count(b) > count(a) ? b : a));
            ctx.endEncounter(best);
            return s;
          },
          endEarly: (s, params) => Object.keys(params.choices)[0]!,
          panel: (s, viewer, params) => ({
            type: 'choices', prompt: 'Pick', options: Object.entries(params.choices as Record<string, string>).map(([key, label]) => ({ key, label })),
            ...(s.votes[viewer.id] ? { selected: s.votes[viewer.id] } : {}), 'closes-at': s.closesAt,
          }),
          overlay: () => null,
        });
      },
    }).register,
  };
}

export function tpChannel(over: Record<string, unknown> = {}): unknown {
  const { settings, ...rest } = over as { settings?: Record<string, unknown> };
  return {
    packs: ['tp'],
    ...rest,
    settings: { 'class-slot': 'tp:hand', 'starting-items': ['tp:club', 'tp:rod'], ...(settings ?? {}) },
  };
}
