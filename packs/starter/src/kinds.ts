import { type AmountOrPercent, type Ctx, type EntityRef, p, type PackApi, Rejection, type Step } from '@dndm/engine';

const character = (id: string): EntityRef => ({ kind: 'character', id });
const closes = (at: number | null) => (at === null ? {} : { 'closes-at': at });

function counts(choices: Record<string, string>, votes: Record<string, string>): [string, number][] {
  return Object.keys(choices).map((k) => [k, Object.values(votes).filter((v) => v === k).length]);
}

function leaders(choices: Record<string, string>, votes: Record<string, string>): string[] {
  const c = counts(choices, votes);
  const top = Math.max(...c.map(([, n]) => n));
  return c.filter(([, n]) => n === top).map(([k]) => k);
}

interface VoteState { closesAt: number; votes: Record<string, string> }
interface TreasureState { closesAt: number; claimed: string[] }
interface TrapState { closesAt: number; taps: string[]; votes: Record<string, string> }
interface ShopState { closesAt: number | null; members: string[] }
interface StoryState { endsAt: number | null }

export function registerKinds(api: PackApi): void {
  api.encounterKind<StoryState>('story', {
    name: 'Story',
    params: p.object({
      text: p.string(),
      title: p.optional(p.string()),
      media: p.optional(p.list(p.object({ type: p.enum('image', 'video'), src: p.string() }))),
      'show-for': p.optional(p.duration()),
    }),
    input: p.object({}),
    outcomes: () => ['done'],
    start: (ctx, params) => ({ endsAt: params['show-for'] ? ctx.now + params['show-for'] : null }),
    respond: () => { throw new Rejection('There is nothing to answer here'); },
    wakeAt: (s) => s.endsAt,
    advance(ctx, s) { ctx.endEncounter('done'); return s; },
    endEarly: () => 'done',
    panel: (_s, _v, params) => ({ type: 'story-card', ...(params.title ? { title: params.title } : {}), text: params.text }),
    overlay: (s, params) => ({
      ...(params.title ? { title: params.title } : {}), text: params.text,
      ...(params.media ? { media: params.media } : {}), ...closes(s.endsAt),
    }),
  });

  api.encounterKind<VoteState>('vote', {
    name: 'Vote',
    params: p.object({
      prompt: p.string(),
      choices: p.record(p.string()),
      time: p.duration(),
      'tie-break': p.optional(p.enum('random', 'first'), 'random'),
    }),
    input: p.object({ choice: p.string() }),
    outcomes: (params) => Object.keys(params.choices),
    validate: (params) => (Object.keys(params.choices ?? {}).length === 0 ? ['a vote needs at least one choice'] : []),
    start: (ctx, params) => ({ closesAt: ctx.now + params.time, votes: {} }),
    respond(_ctx, s, ch, input, params) {
      if (!(input.choice in params.choices)) throw new Rejection("That isn't one of the choices");
      return { ...s, votes: { ...s.votes, [ch.id]: input.choice } };
    },
    wakeAt: (s) => s.closesAt,
    advance(ctx, s, params) {
      const tied = leaders(params.choices, s.votes);
      const winner = tied.length === 1 || params['tie-break'] === 'first' ? tied[0]! : tied[ctx.randomInt(0, tied.length - 1)]!;
      ctx.endEncounter(winner);
      return s;
    },
    endEarly: (s, params) => leaders(params.choices, s.votes)[0]!,
    panel: (s, viewer, params) => ({
      type: 'choices', prompt: params.prompt,
      options: Object.entries(params.choices as Record<string, string>).map(([key, label]) => ({ key, label })),
      ...(s.votes[viewer.id] ? { selected: s.votes[viewer.id] } : {}), ...closes(s.closesAt),
    }),
    overlay: (s, params) => ({
      title: params.prompt,
      tallies: counts(params.choices, s.votes).map(([k, count]) => ({ label: params.choices[k], count })),
      ...closes(s.closesAt),
    }),
  });

  api.encounterKind<TreasureState>('treasure', {
    name: 'Treasure',
    params: p.object({
      gold: p.optional(p.integer({ min: 0 }), 0),
      xp: p.optional(p.integer({ min: 0 }), 0),
      items: p.optional(p.list(p.ref('item')), []),
      heal: p.optional(p.amountOrPercent()),
      time: p.duration(),
    }),
    input: p.object({}),
    outcomes: () => ['done'],
    start: (ctx, params) => ({ closesAt: ctx.now + params.time, claimed: [] }),
    respond(_ctx, s, ch) {
      if (s.claimed.includes(ch.id)) throw new Rejection("You've already claimed this");
      return { ...s, claimed: [...s.claimed, ch.id] };
    },
    wakeAt: (s) => s.closesAt,
    advance(ctx, s) { ctx.endEncounter('done'); return s; },
    endEarly: () => 'done',
    onEnd(ctx, s, outcome, params) {
      if (outcome !== 'done') return;
      const party = new Set(ctx.party().map((e) => e.id));
      for (const id of s.claimed) {
        if (!party.has(id)) continue;
        const ch = character(id);
        ctx.giveRewards(ch, { xp: params.xp, gold: params.gold, items: params.items });
        const heal = params.heal as AmountOrPercent | undefined;
        if (heal && !ctx.isKnockedOut(ch)) {
          ctx.heal(null, ch, 'percent' in heal ? (ctx.maxHp(ch) * heal.percent) / 100 : heal.amount);
        }
      }
    },
    panel: (s, viewer) => ({ type: 'tap-button', label: 'Claim', tapped: s.claimed.includes(viewer.id), ...closes(s.closesAt) }),
    overlay: (s, params) => ({
      title: 'Treasure!',
      text: [params.gold ? `${params.gold} gold` : '', params.xp ? `${params.xp} XP` : '', ...(params.items as string[])].filter(Boolean).join(', '),
      tallies: [{ label: 'Claimed', count: s.claimed.length }], ...closes(s.closesAt),
    }),
  });

  api.encounterKind<TrapState>('trap', {
    name: 'Trap',
    params: p.object({
      prompt: p.string(),
      time: p.duration(),
      taps: p.optional(p.percent()),
      answer: p.optional(p.string()),
      choices: p.optional(p.record(p.string())),
      penalty: p.object({ target: p.enum('all', 'non-responders'), steps: p.steps({ noSource: true }) }),
    }),
    input: p.object({ choice: p.optional(p.string()) }),
    outcomes: () => ['disarmed', 'triggered'],
    validate(params) {
      const tapMode = params.taps !== undefined;
      const answerMode = params.answer !== undefined || params.choices !== undefined;
      if (tapMode === answerMode) return ['a trap needs either taps or answer + choices'];
      if (answerMode && !(params.choices && params.answer && params.answer in params.choices)) return ['answer must be one of the choices'];
      return [];
    },
    start: (ctx, params) => ({ closesAt: ctx.now + params.time, taps: [], votes: {} }),
    respond(_ctx, s, ch, input, params) {
      if (params.taps !== undefined) {
        if (s.taps.includes(ch.id)) throw new Rejection('Already tapped');
        return { ...s, taps: [...s.taps, ch.id] };
      }
      if (!input.choice || !(input.choice in params.choices)) throw new Rejection("That isn't one of the choices");
      return { ...s, votes: { ...s.votes, [ch.id]: input.choice } };
    },
    wakeAt: (s) => s.closesAt,
    advance(ctx, s, params) {
      const party = ctx.party().map((e) => e.id);
      let disarmed: boolean;
      if (params.taps !== undefined) {
        const tapped = s.taps.filter((id) => party.includes(id)).length;
        disarmed = party.length === 0 || (tapped / party.length) * 100 >= params.taps;
      } else {
        const tied = leaders(params.choices, s.votes);
        disarmed = tied.length === 1 && tied[0] === params.answer;
      }
      ctx.endEncounter(disarmed ? 'disarmed' : 'triggered');
      return s;
    },
    endEarly: () => 'disarmed',
    onEnd(ctx: Ctx, s, outcome, params) {
      if (outcome !== 'triggered') return;
      const responded = new Set([...s.taps, ...Object.keys(s.votes)]);
      const party = ctx.party();
      const targets = params.penalty.target === 'all' ? party : party.filter((e) => !responded.has(e.id));
      ctx.runSteps(params.penalty.steps as Step[], { source: null, targets });
    },
    panel: (s, viewer, params) =>
      params.taps !== undefined
        ? { type: 'tap-button', label: params.prompt, tapped: s.taps.includes(viewer.id), ...closes(s.closesAt) }
        : {
          type: 'choices', prompt: params.prompt,
          options: Object.entries(params.choices as Record<string, string>).map(([key, label]) => ({ key, label })),
          ...(s.votes[viewer.id] ? { selected: s.votes[viewer.id] } : {}), ...closes(s.closesAt),
        },
    overlay: (s, params) => ({ title: 'Trap!', text: params.prompt, ...closes(s.closesAt) }),
  });

  api.encounterKind<ShopState>('shop', {
    name: 'Shop',
    params: p.object({
      stock: p.list(p.object({ item: p.ref('item'), price: p.integer({ min: 0 }) })),
      time: p.optional(p.duration()),
      secret: p.optional(p.boolean(), false),
    }),
    input: p.object({ buy: p.ref('item') }),
    outcomes: () => ['closed'],
    start: (ctx, params) => ({ closesAt: params.time ? ctx.now + params.time : null, members: ctx.party().map((e) => e.id) }),
    respond(ctx, s, ch, input, params) {
      if (params.secret && !s.members.includes(ch.id)) throw new Rejection("This shop isn't open to you");
      const entry = (params.stock as { item: string; price: number }[]).find((x) => x.item === input.buy);
      if (!entry) throw new Rejection("That isn't for sale here");
      if (ctx.startingItems().includes(input.buy)) throw new Rejection('You already have that');
      ctx.spendGold(ch, entry.price);
      ctx.giveItem(ch, input.buy, 1);
      ctx.emit('starter:purchased', { character: ch.id, item: input.buy, price: entry.price }, `${ctx.name(ch)} buys ${input.buy}`);
      return s;
    },
    wakeAt: (s) => s.closesAt,
    advance(ctx, s) { ctx.endEncounter('closed'); return s; },
    endEarly: () => 'closed',
    panel(s, viewer, params) {
      if (params.secret && !s.members.includes(viewer.id)) return { type: 'none' };
      return {
        type: 'shop-list', gold: viewer.gold,
        entries: (params.stock as { item: string; price: number }[]).map((e) => ({ item: e.item, price: e.price, affordable: viewer.gold >= e.price })),
        ...closes(s.closesAt),
      };
    },
    overlay: (s, params) => (params.secret ? null : {
      title: 'A shop opens',
      list: (params.stock as { item: string; price: number }[]).map((e) => `${e.item}: ${e.price} gold`),
      ...closes(s.closesAt),
    }),
  });
}
