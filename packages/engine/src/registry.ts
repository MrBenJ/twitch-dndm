import { type ChannelConfig, deepMerge, parseChannel, parseSettings, type Settings } from './channel';
import {
  type AbilityDef, type AdventureDef, type ClassDef, type EncounterDef, type ItemDef, type MonsterDef,
  type SlotDef, type StatDef, detectDocType, DOC_SCHEMAS,
} from './content';
import { type Issue, ValidationError } from './errors';
import { CHANNEL, CONTENT_TYPES, type ContentType, CORE, fullId, PACK_ID_PATTERN, type PluginType, splitId } from './ids';
import type {
  BehaviorDef, EffectDef, EncounterKindDef, PackApi, PackBundle, PackManifest, PassiveDef, StatusDef, TargetingDef,
} from './pack';
import { p } from './params';
import { isVersion, satisfies } from './semver';
import { normalizeAll } from './normalize';

export const CORE_HP = 'core:hp';
export const CORE_KO = 'core:knocked-out';
export const CORE_FIGHT = 'core:fight';

export interface Registered<T> { id: string; pack: string; def: T }
export interface KindEntry extends Registered<EncounterKindDef> { builtin: boolean }

export interface Registry {
  packs: PackManifest[];
  stats: Map<string, StatDef>;
  slots: Map<string, SlotDef>;
  classes: Map<string, ClassDef>;
  abilities: Map<string, AbilityDef>;
  items: Map<string, ItemDef>;
  monsters: Map<string, MonsterDef>;
  encounters: Map<string, EncounterDef>;
  adventures: Map<string, AdventureDef>;
  effects: Map<string, Registered<EffectDef>>;
  statuses: Map<string, Registered<StatusDef>>;
  passives: Map<string, Registered<PassiveDef>>;
  targeting: Map<string, Registered<TargetingDef>>;
  behaviors: Map<string, Registered<BehaviorDef>>;
  kinds: Map<string, KindEntry>;
  settings: Settings;
  dormant: Set<string>;
  warnings: Issue[];
}

export interface RawDoc {
  type: ContentType;
  full: string;
  pack: string;
  file: string;
  index: number;
  doc: Record<string, unknown>;
}

export interface BuildState {
  reg: Registry;
  issues: Issue[];
  channel: ChannelConfig;
  enabled: Set<string>;
  depends: Map<string, Set<string>>;
  raw: Map<ContentType, Map<string, RawDoc>>;
  deleted: Set<string>;
  classSlotRaw: string | null;
  startingItemsRaw: string[];
}

/** Built-in fight kind. The engine runs fights itself; these functions are never called. */
const FIGHT_KIND: EncounterKindDef = {
  name: 'Fight',
  params: p.ref('monster'),
  outcomes: () => ['won'],
  start: () => { throw new Error('fight is built in'); },
  respond: () => { throw new Error('fight is built in'); },
  wakeAt: () => null,
  advance: (_c, s) => s,
  endEarly: () => 'ended',
  panel: () => ({ type: 'none' }),
  overlay: () => null,
};

function emptyRegistry(): Registry {
  return {
    packs: [], stats: new Map(), slots: new Map(), classes: new Map(), abilities: new Map(), items: new Map(),
    monsters: new Map(), encounters: new Map(), adventures: new Map(), effects: new Map(), statuses: new Map(),
    passives: new Map(), targeting: new Map(), behaviors: new Map(), kinds: new Map(),
    settings: undefined as unknown as Settings, dormant: new Set(), warnings: [],
  };
}

const PLUGIN_MAPS: Record<PluginType, keyof Registry> = {
  effect: 'effects', status: 'statuses', passive: 'passives', targeting: 'targeting', behavior: 'behaviors', encounterKind: 'kinds',
};

function orderPacks(st: BuildState, bundles: Map<string, PackBundle>): PackBundle[] {
  const err = (pack: string, message: string) => st.issues.push({ level: 'error', pack, path: '', message });
  const enabled = st.channel.packs;
  for (const id of enabled) {
    if (id === CORE || id === CHANNEL) { err(id, "'core' and 'channel' are reserved pack IDs"); continue; }
    const b = bundles.get(id);
    if (!b) { err(id, 'pack is enabled but not installed'); continue; }
    const m = b.manifest;
    if (!PACK_ID_PATTERN.test(m.id)) err(id, `invalid pack ID '${m.id}'`);
    if (!isVersion(m.version)) err(id, 'version must look like 1.2.3');
    if (typeof m.name !== 'string' || !m.name) err(id, 'manifest needs a name');
    st.depends.set(id, new Set(Object.keys(m.depends ?? {})));
    for (const [dep, range] of Object.entries(m.depends ?? {})) {
      const d = bundles.get(dep);
      if (!st.enabled.has(dep) || !d) err(id, `depends on ${dep}, which is not enabled`);
      else if (!satisfies(d.manifest.version, range)) err(id, `depends on ${dep} ${range} but ${d.manifest.version} is enabled`);
    }
  }
  // Topological order, otherwise list order.
  const ordered: PackBundle[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, trail: string[]): void => {
    const b = bundles.get(id);
    if (!b || !st.enabled.has(id) || id === CORE || id === CHANNEL) return;
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      const start = trail.indexOf(id);
      err(trail[start]!, `dependency cycle: ${[...trail.slice(start), id].join(' -> ')}`);
      return;
    }
    state.set(id, 'visiting');
    for (const dep of Object.keys(b.manifest.depends ?? {})) visit(dep, [...trail, id]);
    state.set(id, 'done');
    ordered.push(b);
  };
  for (const id of enabled) visit(id, []);
  return ordered;
}

function registerPlugins(st: BuildState, bundle: PackBundle): void {
  const pack = bundle.manifest.id;
  if (!bundle.official && (bundle.register || bundle.hasCode)) {
    st.issues.push({ level: 'error', pack, path: '', message: "this pack isn't official, so it can't contain code" });
    return;
  }
  if (!bundle.register) return;
  const add = (type: PluginType, id: string, def: unknown) => {
    const map = st.reg[PLUGIN_MAPS[type]] as Map<string, unknown>;
    const full = fullId(pack, id);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) { st.issues.push({ level: 'error', pack, path: '', message: `invalid ${type} ID '${id}'` }); return; }
    if (map.has(full)) { st.issues.push({ level: 'error', pack, path: '', message: `duplicate ${type} '${id}'` }); return; }
    map.set(full, type === 'encounterKind' ? { id: full, pack, def, builtin: false } : { id: full, pack, def });
  };
  const api: PackApi = {
    effect: (id, def) => add('effect', id, def),
    status: (id, def) => add('status', id, def),
    passive: (id, def) => add('passive', id, def),
    targeting: (id, def) => add('targeting', id, def),
    behavior: (id, def) => add('behavior', id, def),
    encounterKind: (id, def) => add('encounterKind', id, def),
  };
  try {
    bundle.register(api);
  } catch (e) {
    st.issues.push({ level: 'error', pack, path: '', message: `register() failed: ${(e as Error).message}` });
  }
}

function collectDocs(st: BuildState, pack: string, sources: { file: string; index: number; doc: unknown }[]): void {
  for (const src of sources) {
    const where = { pack, file: src.file, doc: src.index };
    const t = detectDocType(src.doc);
    if ('error' in t) { st.issues.push({ level: 'error', ...where, path: '', message: t.error }); continue; }
    const full = fullId(pack, t.id);
    const map = st.raw.get(t.type)!;
    if (map.has(full)) { st.issues.push({ level: 'error', ...where, path: '', message: `duplicate ${t.type} '${t.id}'` }); continue; }
    map.set(full, { type: t.type, full, pack, file: src.file, index: src.index, doc: src.doc as Record<string, unknown> });
  }
}

function applyOverrides(st: BuildState): void {
  for (const [key, patch] of Object.entries(st.channel.overrides)) {
    const issue = (level: 'error' | 'warning', message: string) =>
      st.issues.push({ level, pack: CHANNEL, path: `overrides.${key}`, message });
    const m = /^(?:([a-z]+) )?(.+)$/.exec(key)!;
    const typeWord = m[1] as ContentType | undefined;
    const target = m[2]!;
    const { pack } = splitId(target);
    if (typeWord && !CONTENT_TYPES.includes(typeWord)) { issue('error', `unknown content type '${typeWord}'`); continue; }
    if (!pack) { issue('error', `write the full ID, like tp:${target}`); continue; }
    const types = typeWord ? [typeWord] : CONTENT_TYPES;
    const matches = types.map((t) => st.raw.get(t)!.get(target)).filter((d): d is RawDoc => !!d);
    if (matches.length === 0) {
      const dormant = (pack !== CHANNEL && pack !== CORE && !st.enabled.has(pack)) || (pack === CHANNEL && st.deleted.has(target));
      if (dormant) issue('warning', `override for ${target} is kept but ignored: it's dormant`);
      else issue('error', `nothing called '${target}' to override`);
      continue;
    }
    if (matches.length > 1) {
      issue('error', `'${target}' names more than one thing (${matches.map((d) => d.type).join(', ')}); write it as ${matches.map((d) => `'${d.type} ${target}'`).join(' or ')}`);
      continue;
    }
    const doc = matches[0]!;
    if (doc.type in patch) { issue('error', `an override can't change the '${doc.type}' key`); continue; }
    doc.doc = deepMerge(doc.doc, patch) as Record<string, unknown>;
  }
}

function parseDocs(st: BuildState): void {
  for (const type of CONTENT_TYPES) {
    for (const raw of st.raw.get(type)!.values()) {
      const r = DOC_SCHEMAS[type].safeParse(raw.doc);
      if (!r.success) {
        for (const i of r.error.issues) {
          st.issues.push({ level: 'error', pack: raw.pack, file: raw.file, doc: raw.index, path: i.path.join('.'), message: i.message });
        }
        st.raw.get(type)!.delete(raw.full);
      } else {
        raw.doc = r.data as Record<string, unknown>;
      }
    }
  }
}

export function buildRegistry(bundles: PackBundle[], channelRaw: unknown): Registry {
  const parsed = parseChannel(channelRaw);
  if ('errors' in parsed) {
    throw new ValidationError(parsed.errors.map((message) => ({ level: 'error' as const, pack: CHANNEL, path: '', message })));
  }
  const channel = parsed.channel;
  const st: BuildState = {
    reg: emptyRegistry(),
    issues: [],
    channel,
    enabled: new Set(channel.packs),
    depends: new Map(),
    raw: new Map(CONTENT_TYPES.map((t) => [t, new Map()])),
    deleted: new Set(channel.channelPack.deleted.map((d) => (d.includes(':') ? d : fullId(CHANNEL, d)))),
    classSlotRaw: null,
    startingItemsRaw: [],
  };

  // Core entries.
  st.reg.stats.set(CORE_HP, { id: CORE_HP, name: 'HP', icon: null, default: 0, perLevel: 0 });
  st.reg.statuses.set(CORE_KO, { id: CORE_KO, pack: CORE, def: { name: 'Knocked out', stacking: 'keep' } });
  st.reg.kinds.set(CORE_FIGHT, { id: CORE_FIGHT, pack: CORE, def: FIGHT_KIND, builtin: true });

  const byId = new Map<string, PackBundle>();
  for (const b of bundles) {
    if (byId.has(b.manifest.id)) st.issues.push({ level: 'error', pack: b.manifest.id, path: '', message: 'installed twice' });
    byId.set(b.manifest.id, b);
  }
  const ordered = orderPacks(st, byId);
  st.reg.packs = ordered.map((b) => b.manifest);

  for (const b of ordered) registerPlugins(st, b);
  for (const b of ordered) collectDocs(st, b.manifest.id, b.content);
  collectDocs(st, CHANNEL, channel.channelPack.content.map((doc, index) => ({ file: 'channel-pack', index, doc })));
  applyOverrides(st);
  parseDocs(st);

  const s = parseSettings(channel.settings);
  for (const message of s.errors) st.issues.push({ level: 'error', pack: CHANNEL, path: 'settings', message });
  st.reg.settings = { ...s.settings, classSlot: null, startingItems: [] };
  st.classSlotRaw = s.classSlot;
  st.startingItemsRaw = s.startingItems;

  normalizeAll(st);

  const errors = st.issues.filter((i) => i.level === 'error');
  st.reg.warnings = st.issues.filter((i) => i.level === 'warning');
  if (errors.length) throw new ValidationError(st.issues);
  return st.reg;
}
