import type {
  AbilityDef, AdventureDef, AdventureNode, ClassDef, EncounterDef, EncounterSpec, ItemDef, MonsterDef, PassiveUse, SlotDef, StatDef, TargetUse,
} from './content';
import { CHANNEL, CONTENT_TYPES, type ContentType, refKey } from './ids';
import { type NormalizeCtx, normalizeParams, p } from './params';
import type { BuildState, RawDoc } from './registry';
import { makeNormalizeCtx } from './resolve';
import { parseDuration } from './units';

type Ctx = NormalizeCtx & { hitDormant: boolean; dormantRefs: string[] };

function statMap(raw: Record<string, number>, ctx: Ctx, path: string, allowHp: boolean): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    const id = ctx.ref('stat', k, `${path}.${k}`);
    if (!id) continue;
    if (id === 'core:hp' && !allowHp) { ctx.issue(`${path}.${k}`, "a monster's HP is set with 'hp:', not in stats"); continue; }
    out[id] = v;
  }
  return out;
}

function passives(st: BuildState, raw: unknown[], ctx: Ctx, path: string): PassiveUse[] {
  const out: PassiveUse[] = [];
  raw.forEach((entry, i) => {
    const pth = `${path}[${i}]`;
    const [key, params] = typeof entry === 'string' ? [entry, {}] : (Object.entries(entry as object)[0] ?? ['', {}]);
    const id = ctx.ref('passive', key as string, pth);
    if (!id) return;
    out.push({ passive: id, params: normalizeParams(st.reg.passives.get(id)!.def.params ?? p.object({}), params ?? {}, ctx, pth) });
  });
  return out;
}

function single(v: Record<string, unknown>, ctx: Ctx, path: string, what: string): [string, unknown] | null {
  const entries = Object.entries(v);
  if (entries.length !== 1) { ctx.issue(path, `${what} must be one ID with its params`); return null; }
  return entries[0]!;
}

function duration(v: unknown, ctx: Ctx, path: string): number | null {
  try { return parseDuration(v as string | number); } catch (e) { ctx.issue(path, (e as Error).message); return null; }
}

const NODE_KEYS = new Set(['next', 'use']);

/** Parses `{ <kind>: params }` (plus excluded keys) into a spec. */
function encounterSpec(st: BuildState, obj: Record<string, unknown>, exclude: Set<string>, ctx: Ctx, path: string, label: string): EncounterSpec | null {
  const keys = Object.keys(obj).filter((k) => !exclude.has(k));
  if (keys.length !== 1) {
    ctx.issue(path, `${label} needs exactly one encounter kind${label === 'a node' ? ' or use' : ''} (found: ${keys.join(', ') || 'none'})`);
    return null;
  }
  const key = keys[0]!;
  const kind = ctx.ref('encounterKind', key, path ? `${path}.${key}` : key);
  if (!kind) return null;
  const entry = st.reg.kinds.get(kind)!;
  const params = normalizeParams(entry.def.params ?? p.object({}), obj[key] ?? {}, ctx, path ? `${path}.${key}` : key);
  if (!entry.builtin && entry.def.validate) {
    try {
      for (const message of entry.def.validate(params)) ctx.issue(path ? `${path}.${key}` : key, message);
    } catch (e) {
      ctx.issue(path ? `${path}.${key}` : key, `validate() failed: ${(e as Error).message}`);
    }
  }
  return { kind, params };
}

function normalizeDoc(st: BuildState, raw: RawDoc, ctx: Ctx): unknown {
  const d = raw.doc as Record<string, any>;
  switch (raw.type) {
    case 'stat': return { id: raw.full, name: d.name, icon: d.icon, default: d.default, perLevel: d['per-level'] } satisfies StatDef;
    case 'slot': return { id: raw.full, name: d.name, order: 0 } satisfies SlotDef;
    case 'class': return {
      id: raw.full, name: d.name, description: d.description, icon: d.icon, tags: d.tags,
      stats: statMap(d.stats, ctx, 'stats', true),
      abilities: (d.abilities as string[]).map((a, i) => ctx.ref('ability', a, `abilities[${i}]`)).filter((a): a is string => !!a),
      passives: passives(st, d.passives, ctx, 'passives'),
    } satisfies ClassDef;
    case 'ability': {
      let target: TargetUse | null = null;
      const t = typeof d.target === 'string' ? [d.target, {}] as [string, unknown] : single(d.target, ctx, 'target', 'target');
      if (t) {
        const rule = ctx.ref('targeting', t[0], 'target');
        if (rule) target = { rule, params: normalizeParams(st.reg.targeting.get(rule)!.def.params ?? p.object({}), t[1] ?? {}, ctx, `target.${t[0]}`) };
      }
      return {
        id: raw.full, name: d.name, description: d.description, icon: d.icon,
        cooldown: duration(d.cooldown, ctx, 'cooldown') ?? 0, when: d.when,
        target: target ?? { rule: '', params: {} }, steps: ctx.steps(d.steps, 'steps', false) ?? [],
      } satisfies AbilityDef;
    }
    case 'item': {
      const slot = d.slot ? ctx.ref('slot', d.slot, 'slot') : null;
      let grantsClass: string | null = null;
      if (d['grants-class']) {
        if (!d.slot) ctx.issue('grants-class', 'an item that grants a class needs a slot');
        else grantsClass = ctx.ref('class', d['grants-class'], 'grants-class');
      }
      return {
        id: raw.full, name: d.name, description: d.description, icon: d.icon, slot, grantsClass,
        stats: statMap(d.stats, ctx, 'stats', true), passives: passives(st, d.passives, ctx, 'passives'),
        abilities: (d.abilities as string[]).map((a, i) => ctx.ref('ability', a, `abilities[${i}]`)).filter((a): a is string => !!a),
        use: d.use ? ctx.ref('ability', d.use, 'use') : null, uses: d.uses, price: d.price,
      } satisfies ItemDef;
    }
    case 'monster': {
      const b = single(d.behavior, ctx, 'behavior', 'behavior');
      let behavior = { behavior: '', params: {} as unknown };
      if (b) {
        const id = ctx.ref('behavior', b[0], 'behavior');
        if (id) behavior = { behavior: id, params: normalizeParams(st.reg.behaviors.get(id)!.def.params ?? p.object({}), b[1] ?? {}, ctx, `behavior.${b[0]}`) };
      }
      return {
        id: raw.full, name: d.name, description: d.description, image: d.image, tags: d.tags, hp: d.hp,
        stats: statMap(d.stats, ctx, 'stats', false),
        abilities: (d.abilities as string[]).map((a, i) => ctx.ref('ability', a, `abilities[${i}]`)).filter((a): a is string => !!a),
        passives: passives(st, d.passives, ctx, 'passives'), behavior,
        interval: d.interval === undefined ? null : duration(d.interval, ctx, 'interval'),
        rewards: d.rewards,
        drops: (d.drops as { item: string; chance: number }[]).map((x, i) => ({ item: ctx.ref('item', x.item, `drops[${i}].item`) ?? '', chance: x.chance })),
      } satisfies MonsterDef;
    }
    case 'encounter': {
      const spec = encounterSpec(st, d, new Set(['encounter', 'name']), ctx, '', 'an encounter');
      return { id: raw.full, name: d.name ?? raw.full, spec: spec ?? { kind: '', params: null } } satisfies EncounterDef;
    }
    case 'adventure': {
      const nodes: Record<string, AdventureNode> = {};
      for (const [name, node] of Object.entries(d.nodes as Record<string, Record<string, unknown>>)) {
        const path = `nodes.${name}`;
        let spec: EncounterSpec | null = null;
        let use: string | null = null;
        const kinds = Object.keys(node).filter((k) => !NODE_KEYS.has(k));
        if (typeof node.use === 'string') {
          if (kinds.length) ctx.issue(path, `a node needs exactly one encounter kind or use (found: use, ${kinds.join(', ')})`);
          use = ctx.ref('encounter', node.use, `${path}.use`);
        } else {
          spec = encounterSpec(st, node, NODE_KEYS, ctx, path, 'a node');
        }
        nodes[name] = { spec, use, next: (node.next as AdventureNode['next']) ?? null };
      }
      return { id: raw.full, name: d.name, description: d.description, start: d.start, nodes } satisfies AdventureDef;
    }
  }
}

const MAPS: Record<ContentType, keyof BuildState['reg']> = {
  stat: 'stats', slot: 'slots', class: 'classes', ability: 'abilities', item: 'items',
  monster: 'monsters', encounter: 'encounters', adventure: 'adventures',
};

function checkAdventure(st: BuildState, adv: AdventureDef, raw: RawDoc): void {
  const issue = (path: string, message: string) => st.issues.push({ level: 'error', pack: raw.pack, file: raw.file, doc: raw.index, path, message });
  if (!(adv.start in adv.nodes)) issue('start', `no node called '${adv.start}'`);
  for (const [name, node] of Object.entries(adv.nodes)) {
    const spec = node.spec ?? (node.use ? st.reg.encounters.get(node.use)?.spec : undefined);
    let outcomes: string[] = [];
    if (spec?.kind) {
      const entry = st.reg.kinds.get(spec.kind);
      try { outcomes = entry?.builtin ? ['won'] : entry?.def.outcomes(spec.params) ?? []; }
      catch (e) { issue(`nodes.${name}`, `outcomes() failed: ${(e as Error).message}`); }
    }
    const next = node.next;
    if (typeof next === 'string') {
      if (!(next in adv.nodes)) issue(`nodes.${name}.next`, `no node called '${next}'`);
    } else if (next) {
      for (const [key, target] of Object.entries(next)) {
        if (key !== 'default' && key !== 'ended' && !outcomes.includes(key)) {
          issue(`nodes.${name}.next.${key}`, `'${key}' isn't an outcome of this node (outcomes: ${[...outcomes, 'ended'].join(', ')})`);
        }
        if (!(target in adv.nodes)) issue(`nodes.${name}.next.${key}`, `no node called '${target}'`);
      }
    }
  }
  if (adv.start in adv.nodes) {
    const seen = new Set<string>();
    const queue = [adv.start];
    while (queue.length) {
      const n = queue.shift()!;
      if (seen.has(n) || !(n in adv.nodes)) continue;
      seen.add(n);
      const next = adv.nodes[n]!.next;
      if (typeof next === 'string') queue.push(next);
      else if (next) queue.push(...Object.values(next));
    }
    for (const n of Object.keys(adv.nodes)) if (!seen.has(n)) issue(`nodes.${n}`, `node '${n}' can't be reached from '${adv.start}'`);
  }
}

export function normalizeAll(st: BuildState): void {
  const all = CONTENT_TYPES.flatMap((t) => [...st.raw.get(t)!.values()]);
  const channelDocs = all.filter((d) => d.pack === CHANNEL);

  // 1. Dormancy fixed point over channel content (probe mode swallows issues).
  const dormant = new Set<string>();
  const why = new Map<string, string[]>();
  for (let changed = true; changed;) {
    changed = false;
    for (const raw of channelDocs) {
      const key = refKey(raw.type, raw.full);
      if (dormant.has(key)) continue;
      const ctx = makeNormalizeCtx(st, CHANNEL, {}, { dormant, probe: true });
      normalizeDoc(st, raw, ctx);
      if (ctx.hitDormant) { dormant.add(key); why.set(key, ctx.dormantRefs); changed = true; }
    }
  }
  st.reg.dormant = dormant;
  for (const key of dormant) {
    const raw = channelDocs.find((d) => refKey(d.type, d.full) === key)!;
    st.issues.push({ level: 'warning', pack: CHANNEL, file: raw.file, doc: raw.index, path: '', message: `${key} is dormant (needs ${why.get(key)!.join(', ')})` });
  }

  // 2. Real pass, in type order, filling the registry maps.
  let slotOrder = 0;
  for (const type of CONTENT_TYPES) {
    for (const raw of st.raw.get(type)!.values()) {
      if (dormant.has(refKey(type, raw.full))) continue;
      const ctx = makeNormalizeCtx(st, raw.pack, { file: raw.file, doc: raw.index }, { dormant, probe: false });
      const def = normalizeDoc(st, raw, ctx) as { id: string; order?: number };
      if (type === 'slot') def.order = slotOrder++;
      (st.reg[MAPS[type]] as Map<string, unknown>).set(raw.full, def);
    }
  }
  for (const adv of st.reg.adventures.values()) checkAdventure(st, adv, st.raw.get('adventure')!.get(adv.id)!);

  // 3. Settings references (resolved from the channel's point of view).
  const sctx = makeNormalizeCtx(st, CHANNEL, {}, { dormant, probe: false });
  if (st.classSlotRaw) {
    const id = sctx.ref('slot', st.classSlotRaw, 'settings.class-slot');
    if (sctx.hitDormant) st.issues.push({ level: 'warning', pack: CHANNEL, path: 'settings.class-slot', message: `class slot ${st.classSlotRaw} is dormant, so it counts as unset` });
    st.reg.settings.classSlot = id;
  }
  st.reg.settings.startingItems = st.startingItemsRaw.flatMap((raw, i) => {
    const c = makeNormalizeCtx(st, CHANNEL, {}, { dormant, probe: false });
    const id = c.ref('item', raw, `settings.starting-items[${i}]`);
    if (c.hitDormant) st.issues.push({ level: 'warning', pack: CHANNEL, path: `settings.starting-items[${i}]`, message: `starting item ${raw} is dormant and skipped` });
    return id ? [id] : [];
  });

  // 4. grants-class only counts in the class slot.
  for (const item of st.reg.items.values()) {
    if (item.grantsClass && item.slot !== st.reg.settings.classSlot) {
      st.issues.push({ level: 'warning', pack: item.id.split(':')[0]!, path: 'grants-class', message: `grants-class is ignored: ${item.id} isn't in the class slot` });
      item.grantsClass = null;
    }
  }
}
