import { makeCtx } from './ctx';
import { abilitiesOf, charRef, classOf, currentFight, hp, isKnockedOut, maxHp, monsterRef, partyRefs, stat, statusViews } from './entities';
import { modify } from './hooks';
import { CORE_HP } from './registry';
import type { EntityRef, Scene, Widget } from './pack';
import type { Runtime } from './runtime';
import { isFight } from './state';
import { formatDuration } from './units';

export interface AbilityOption {
  ability: string;
  name: string;
  from: 'class' | 'gear' | 'item';
  item: string | null;
  ready: boolean;
  readyAt: number | null;
  reason: string | null;
  needsChoice: boolean;
  targets: EntityRef[];
}

export interface View {
  phase: 'closed' | 'resting' | 'fight' | 'encounter';
  character: null | {
    id: string; name: string; level: number; xp: number; gold: number; hp: number; maxHp: number;
    knockedOut: boolean; knockedOutUntil: number | null; inParty: boolean; banned: boolean; class: string | null;
    stats: Record<string, number>;
    statuses: { status: string; until: number | null }[]; equipped: Record<string, string>;
    inventory: Record<string, { count: number; dormant: boolean }>;
  };
  abilities: AbilityOption[];
  panel: Widget;
  overlay: Scene | null;
  fight: null | {
    monster: { name: string; image: string | null; hp: number; maxHp: number; statuses: { status: string; until: number | null }[] };
    sub: 'fighting' | 'waiting'; held: boolean; nextTurnAt: number | null;
  };
  party: { id: string; name: string; hp: number; maxHp: number; knockedOut: boolean; class: string | null; level: number; statuses: { status: string; until: number | null }[] }[];
  adventure: null | { id: string; lined: string | null };
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

export function view(rt: Runtime, characterId: string | null): View {
  const s = rt.game.session;
  const enc = s?.encounter ?? null;
  const phase: View['phase'] = !s ? 'closed' : !enc ? 'resting' : isFight(enc) ? 'fight' : 'encounter';
  const ch = characterId ? rt.game.characters[characterId] ?? null : null;
  const inParty = !!ch && !!s?.party.includes(ch.id);

  let character: View['character'] = null;
  let abilities: AbilityOption[] = [];
  if (ch) {
    const me = charRef(ch.id);
    const inventory: Record<string, { count: number; dormant: boolean }> = {};
    for (const [item, count] of Object.entries(ch.inventory)) inventory[item] = { count, dormant: !rt.reg.items.has(item) };
    character = {
      id: ch.id, name: ch.name, level: ch.level, xp: ch.xp, gold: ch.gold, hp: hp(rt, me), maxHp: maxHp(rt, me),
      knockedOut: isKnockedOut(rt, me), knockedOutUntil: ch.knockedOutUntil, inParty, banned: ch.banned,
      class: classOf(rt, ch)?.id ?? null,
      stats: Object.fromEntries([...rt.reg.stats.keys()].filter((id) => id !== CORE_HP).map((id) => [id, stat(rt, me, id)])),
      statuses: statusViews(rt, me).map((x) => ({ status: x.status, until: x.until })),
      equipped: { ...ch.equipped }, inventory,
    };
    abilities = abilitiesOf(rt, ch).map((src) => {
      const ab = rt.reg.abilities.get(src.ability)!;
      const rule = rt.reg.targeting.get(ab.target.rule);
      const until = ch.cooldowns[src.ability];
      let reason: string | null = null;
      if (!inParty) reason = 'Not in the party';
      else if (isKnockedOut(rt, me)) reason = "You're knocked out";
      else if (ab.when === 'fight' && !currentFight(rt)) reason = 'You can only use that during a fight';
      else if (until !== undefined && until > rt.now) reason = `On cooldown (${formatDuration(until - rt.now)})`;
      else {
        const can = safe(() => modify(rt, me, 'canUse', true as true | string, { ability: src.ability }), true as true | string);
        if (can !== true) reason = can;
      }
      const targets = rule ? safe(() => rule.def.candidates(makeCtx(rt, rule.pack), { user: me, params: ab.target.params }), []) : [];
      return {
        ability: src.ability, name: ab.name, from: src.from, item: src.item ?? null, ready: reason === null,
        readyAt: until !== undefined && until > rt.now ? until : null, reason, needsChoice: !!rule?.def.needsChoice, targets,
      };
    });
  }

  let panel: Widget = { type: 'none' };
  let overlay: Scene | null = null;
  if (enc && !isFight(enc)) {
    const kind = rt.reg.kinds.get(enc.kind);
    if (kind) {
      overlay = safe(() => kind.def.overlay(enc.state, enc.params), null);
      if (ch && inParty) {
        panel = safe(() => kind.def.panel(enc.state, { id: ch.id, inParty, gold: ch.gold, knockedOut: isKnockedOut(rt, charRef(ch.id)) }, enc.params), { type: 'none' } as Widget);
      }
    }
  }

  const f = currentFight(rt);
  const m = f?.monsters[0];
  return {
    phase, character, abilities, panel, overlay,
    fight: f && m ? {
      monster: {
        name: m.def.name, image: m.def.image, hp: m.hp, maxHp: maxHp(rt, monsterRef(m.id)),
        statuses: statusViews(rt, monsterRef(m.id)).map((x) => ({ status: x.status, until: x.until })),
      },
      sub: f.sub, held: f.held, nextTurnAt: f.nextTurnAt,
    } : null,
    party: partyRefs(rt).map((ref) => {
      const c = rt.game.characters[ref.id]!;
      return { id: c.id, name: c.name, hp: hp(rt, ref), maxHp: maxHp(rt, ref), knockedOut: isKnockedOut(rt, ref), class: classOf(rt, c)?.id ?? null, level: c.level, statuses: statusViews(rt, ref).map((x) => ({ status: x.status, until: x.until })) };
    }),
    adventure: s?.adventure ? { ...s.adventure } : null,
  };
}
