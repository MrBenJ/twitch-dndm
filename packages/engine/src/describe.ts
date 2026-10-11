import type { Settings } from './channel';
import type { Issue } from './errors';
import type { Registry } from './registry';

export interface Description {
  packs: { id: string; version: string; name: string }[];
  stats: { id: string; name: string; icon: string | null; default: number; perLevel: number }[];
  slots: { id: string; name: string }[];
  classes: { id: string; name: string; description: string; icon: string | null; abilities: string[] }[];
  abilities: { id: string; name: string; description: string; icon: string | null; cooldown: number; when: 'fight' | 'anytime'; rule: string; needsChoice: boolean }[];
  items: { id: string; name: string; description: string; icon: string | null; slot: string | null; grantsClass: string | null; use: string | null; uses: number; price: number; starting: boolean }[];
  monsters: { id: string; name: string; image: string | null; hp: number }[];
  statuses: { id: string; name: string; icon: string | null }[];
  kinds: { id: string; name: string }[];
  encounters: { id: string; name: string; kind: string }[];
  adventures: { id: string; name: string; start: string; nodes: string[] }[];
  settings: Settings;
  dormant: string[];
  warnings: Issue[];
}

export function describe(reg: Registry): Description {
  return {
    packs: reg.packs.map((m) => ({ id: m.id, version: m.version, name: m.name })),
    stats: [...reg.stats.values()].map((s) => ({ id: s.id, name: s.name, icon: s.icon, default: s.default, perLevel: s.perLevel })),
    slots: [...reg.slots.values()].map((s) => ({ id: s.id, name: s.name })),
    classes: [...reg.classes.values()].map((c) => ({ id: c.id, name: c.name, description: c.description, icon: c.icon, abilities: c.abilities })),
    abilities: [...reg.abilities.values()].map((a) => ({
      id: a.id, name: a.name, description: a.description, icon: a.icon, cooldown: a.cooldown, when: a.when,
      rule: a.target.rule, needsChoice: !!reg.targeting.get(a.target.rule)?.def.needsChoice,
    })),
    items: [...reg.items.values()].map((i) => ({
      id: i.id, name: i.name, description: i.description, icon: i.icon, slot: i.slot, grantsClass: i.grantsClass,
      use: i.use, uses: i.uses, price: i.price, starting: reg.settings.startingItems.includes(i.id),
    })),
    monsters: [...reg.monsters.values()].map((m) => ({ id: m.id, name: m.name, image: m.image, hp: m.hp })),
    statuses: [...reg.statuses.values()].map((s) => ({ id: s.id, name: s.def.name, icon: s.def.icon ?? null })),
    kinds: [...reg.kinds.values()].map((k) => ({ id: k.id, name: k.def.name })),
    encounters: [...reg.encounters.values()].map((e) => ({ id: e.id, name: e.name, kind: e.spec.kind })),
    adventures: [...reg.adventures.values()].map((a) => ({ id: a.id, name: a.name, start: a.start, nodes: Object.keys(a.nodes) })),
    settings: structuredClone(reg.settings),
    dormant: [...reg.dormant],
    warnings: reg.warnings,
  };
}
