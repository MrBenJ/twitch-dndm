import { describe, expect, it } from 'vitest';
import { starterHarness } from './helpers';

const shop = (secret: boolean) => ({
  type: 'startEncounter' as const,
  encounter: { 'starter:shop': { stock: [{ item: 'starter:health-potion', price: 5 }], secret } },
});

describe('secret shop audience (engine spec §9.6, spec 2a §7.2)', () => {
  it('every event of a secret shop goes only to its members', async () => {
    const h = await starterHarness();
    h.open(); h.join('al'); h.join('bo');
    h.do({ type: 'giveGold', target: 'al', amount: 10 });
    const opened = h.do(shop(true));
    h.join('cy');
    const bought = h.do({ type: 'respond', character: 'al', input: { buy: 'starter:health-potion' } });
    const closed = h.do({ type: 'endEncounter' });
    const all = [...opened, ...bought, ...closed];
    expect(bought.map((e) => e.type)).toContain('starter:purchased');
    expect(all.every((e) => JSON.stringify(e.audience) === '["al","bo"]')).toBe(true);
  });

  it("a public shop's events have no audience", async () => {
    const h = await starterHarness();
    h.open(); h.join('al');
    h.do({ type: 'giveGold', target: 'al', amount: 10 });
    const events = [...h.do(shop(false)), ...h.do({ type: 'respond', character: 'al', input: { buy: 'starter:health-potion' } })];
    expect(events.every((e) => e.audience === undefined)).toBe(true);
  });
});
