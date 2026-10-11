import type { Scene, View, Widget } from '@dndm/engine';

const bar = (hp: number, max: number, width = 20) => {
  const filled = max > 0 ? Math.round((hp / max) * width) : 0;
  return `[${'#'.repeat(filled)}${'.'.repeat(width - filled)}] ${hp}/${max}`;
};
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export function renderWidget(w: Widget): string[] {
  switch (w.type) {
    case 'none': return [];
    case 'story-card': return [`  ┌ ${w.title ?? 'Story'}`, `  │ ${w.text}`];
    case 'choices': return [`  ? ${w.prompt}`, ...w.options.map((o) => `    ${o.key === w.selected ? '●' : '○'} ${o.key}: ${o.label}`)];
    case 'shop-list': return [`  $ Shop (you have ${w.gold} gold)`, ...w.entries.map((e) => `    ${e.affordable ? ' ' : '✗'} ${e.item}: ${e.price} gold`)];
    case 'tap-button': return [`  [${w.tapped ? 'x' : ' '}] ${w.label}`];
  }
}

export function renderScene(s: Scene | null): string[] {
  if (!s) return [];
  const out = [`  ▶ ${s.title ?? 'Scene'}${s['closes-at'] !== undefined ? ` (until ${secs(s['closes-at'])})` : ''}`];
  if (s.text) out.push(`    ${s.text}`);
  for (const m of s.media ?? []) out.push(`    [${m.type}] ${m.src}`);
  for (const t of s.tallies ?? []) out.push(`    ${t.label}: ${t.count}`);
  for (const l of s.list ?? []) out.push(`    - ${l}`);
  return out;
}

export function renderState(v: View): string[] {
  const out = [`Phase: ${v.phase}${v.adventure ? `   Adventure: ${v.adventure.id} (next: ${v.adventure.lined ?? '—'})` : ''}`];
  if (v.fight) {
    const f = v.fight;
    out.push(`Monster: ${f.monster.name} ${bar(f.monster.hp, f.monster.maxHp)} ${f.sub}${f.held ? ', held' : ''}${f.nextTurnAt !== null ? `, acts at ${secs(f.nextTurnAt)}` : ''}`);
  }
  for (const m of v.party) out.push(`  ${m.name.padEnd(12)} ${bar(m.hp, m.maxHp)} ${m.class ?? 'no class'}${m.knockedOut ? '  KNOCKED OUT' : ''}`);
  out.push(...renderScene(v.overlay));
  return out;
}

export function renderView(v: View): string[] {
  if (!v.character) return ['No such character'];
  const c = v.character;
  const out = [
    `${c.name} — level ${c.level}, ${c.xp} XP, ${c.gold} gold, ${c.class ?? 'no class'}${c.inParty ? '' : ' (not in the party)'}`,
    `  HP ${bar(c.hp, c.maxHp)}${c.knockedOut ? '  KNOCKED OUT' : ''}`,
    `  Stats: ${Object.entries(c.stats).map(([k, n]) => `${k} ${n}`).join(', ')}`,
  ];
  if (c.statuses.length) out.push(`  Statuses: ${c.statuses.map((s) => s.status).join(', ')}`);
  for (const a of v.abilities) out.push(`  ${a.ready ? '✓' : '·'} ${a.name} (${a.ability})${a.reason ? ` — ${a.reason}` : ''}`);
  out.push(...renderWidget(v.panel));
  return out;
}
