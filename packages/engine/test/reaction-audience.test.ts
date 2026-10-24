import { describe, expect, it } from 'vitest';
import type { PackApi } from '../src/pack';
import { p } from '../src/params';
import { harness } from './helpers/harness';

const kindDef = (audience: boolean, extra: Record<string, boolean> = {}) => ({
  name: 'Kind',
  outcomes: () => ['done'],
  start: (ctx: any) => {
    if (extra.heals) ctx.heal(null, { kind: 'character', id: 'al' }, 1);
    return { members: ctx.party().map((e: any) => e.id) as string[], woke: false };
  },
  respond: (ctx: any, s: any, ch: unknown, input: any) => {
    ctx.heal(null, ch, 1);
    if (extra.heals && input.end) ctx.endEncounter('done');
    return s;
  },
  wakeAt: (s: any) => (extra.heals && !s.woke ? 1000 : null),
  advance: (ctx: any, s: any) => { if (extra.heals) ctx.heal(null, { kind: 'character', id: 'al' }, 1); return { ...s, woke: true }; },
  endEarly: () => 'done',
  onEnd: (ctx: any) => { if (extra.heals) ctx.heal(null, { kind: 'character', id: 'al' }, 1); },
  input: p.object({ end: p.optional(p.boolean(), false) }),
  panel: () => ({ type: 'none' }),
  overlay: () => null,
  ...(audience ? { audience: (s: { members: string[] }) => s.members } : {}),
});

const plugins = (api: PackApi) => {
  api.encounterKind<{ members: string[] }>('hush', kindDef(true) as never);
  api.encounterKind<{ members: string[] }>('plain', kindDef(false) as never);
  api.encounterKind<{ members: string[] }>('hushheal', kindDef(true, { heals: true }) as never);
  api.passive('echo', {
    name: 'Echo',
    react: { healed: ({ ctx, holder }) => { ctx.emit('tp:echo', {}, 'echo'); ctx.heal(null, holder, 1); } },
  });
  api.passive('back', {
    name: 'Back',
    react: { healed: ({ ctx, holder }) => { ctx.emit('tp:back', {}, 'back', { audience: [holder] }); } },
  });
};
const content = [
  { class: 'echoer', name: 'Echoer', passives: ['echo'] },
  { item: 'echoring', name: 'Echo Ring', slot: 'hand', 'grants-class': 'echoer' },
  { class: 'backer', name: 'Backer', passives: ['back'] },
  { item: 'backring', name: 'Back Ring', slot: 'hand', 'grants-class': 'backer' },
];

function give(h: ReturnType<typeof harness>, item: string) {
  const al = h.game.characters.al!;
  al.inventory[item] = 1;
  al.equipped['tp:hand'] = item;
}

function setup(passive: 'tp:echo' | 'tp:back', kind = 'tp:hush') {
  const h = harness({ plugins, content });
  h.open(); h.join('al'); h.join('bo');
  give(h, passive === 'tp:echo' ? 'tp:echoring' : 'tp:backring');
  h.do({ type: 'startEncounter', encounter: { [kind]: {} } });
  return h;
}

const AB = '["al","bo"]';
const echoesOk = (evs: { type: string; audience?: string[] }[]) => {
  const echoes = evs.filter((e) => e.type === 'tp:echo');
  expect(echoes.length).toBeGreaterThan(0);
  expect(echoes.every((e) => JSON.stringify(e.audience) === AB)).toBe(true);
};

describe('reaction audiences (spec 2b §5.7)', () => {
  it('a reaction to respond, and every reaction it queues, takes the encounter audience', () => {
    const h = setup('tp:echo');
    const evs = h.do({ type: 'respond', character: 'al', input: {} });
    const echoes = evs.filter((e) => e.type === 'tp:echo');
    expect(echoes.length).toBeGreaterThan(1);
    expect(echoes.every((e) => JSON.stringify(e.audience) === AB)).toBe(true);
    expect(evs.filter((e) => e.type === 'core:healed').every((e) => JSON.stringify(e.audience) === AB)).toBe(true);
    expect(evs.find((e) => e.type === 'core:reaction-limit')!.audience).toEqual(['al', 'bo']);
  });

  it('reactions queued by start, a wake-up and the end take it too', () => {
    const h = harness({ plugins, content });
    h.open(); h.join('al'); h.join('bo');
    give(h, 'tp:echoring');
    echoesOk(h.do({ type: 'startEncounter', encounter: { 'tp:hushheal': {} } }));
    echoesOk(h.wait(1000));
    echoesOk(h.do({ type: 'endEncounter' }));
    // respond that ends the encounter
    h.do({ type: 'startEncounter', encounter: { 'tp:hushheal': {} } });
    echoesOk(h.do({ type: 'respond', character: 'al', input: { end: true } }));
    expect(h.game.session!.encounter).toBeNull();
  });

  it('an emit inside such a reaction that sets its own audience keeps it', () => {
    const h = setup('tp:back');
    const evs = h.do({ type: 'respond', character: 'al', input: {} });
    expect(evs.find((e) => e.type === 'tp:back')!.audience).toEqual(['al']);
  });

  it('a reaction queued outside a restricted encounter stays public', () => {
    const h = setup('tp:echo', 'tp:plain');
    const evs = h.do({ type: 'respond', character: 'al', input: {} });
    expect(evs.filter((e) => e.type === 'tp:echo').every((e) => e.audience === undefined)).toBe(true);
  });
});
