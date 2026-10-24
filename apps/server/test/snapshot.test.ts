import type { View } from '@dndm/engine';
import { describe, expect, it } from 'vitest';
import { Secrets } from '../src/crypto';
import { BACKLOG_CAP, buildSnapshot, keyFor, MAX_BYTES, refreshWindow, RF_WINDOW, type SnapshotInput } from '../src/twitch/snapshot';

const k = new Secrets('a-long-enough-test-secret').derive('snapshot-key');
const K = (id: string) => keyFor(k, 'c1', id);
const keyOf = (id: string) => K(id);

const member = (id: string, hp: number, maxHp: number, knockedOut: boolean, cls: string) =>
  ({ id, name: id, hp, maxHp, knockedOut, class: cls, level: 1, statuses: [] });

const view = (party: View['party'], name = 'Slime'): View => ({
  phase: 'fight', character: null, abilities: [], panel: { type: 'none' }, overlay: null,
  fight: { monster: { name, image: null, hp: 140, maxHp: 200, statuses: [] }, sub: 'fighting', held: false, nextTurnAt: 9000 },
  party, adventure: null,
});

const baseParty = [member('twitch:1', 80, 100, false, 'starter:fighter'), member('twitch:2', 0, 50, true, 'starter:healer')];
const input: SnapshotInput = { e: 'q7Lw2k', t: 5, publicView: view(baseParty), keyOf, rv: 7, cv: 3, waiting: [K('twitch:1')], rf: false };
const bytes = (m: string) => Buffer.byteLength(m, 'utf8');

describe('snapshot (spec 2b §5)', () => {
  it('has the agreed constants', () => {
    expect([MAX_BYTES, BACKLOG_CAP, RF_WINDOW]).toEqual([5120, 3000, 30_000]);
  });

  it('keys are 10 base64url characters, stable, and differ by channel', () => {
    expect(keyFor(k, 'c1', 'twitch:1')).toBe(keyFor(k, 'c1', 'twitch:1'));
    expect(keyFor(k, 'c1', 'twitch:1')).toMatch(/^[A-Za-z0-9_-]{10}$/);
    expect(keyFor(k, 'c2', 'twitch:1')).not.toBe(keyFor(k, 'c1', 'twitch:1'));
    expect(keyFor(k, 'c1', 'dev:al')).toMatch(/^[A-Za-z0-9_-]{10}$/);
  });

  it('rw', () => {
    expect(refreshWindow(0, false)).toBe(1000);
    expect(refreshWindow(250, false)).toBe(2500);
    expect(refreshWindow(5000, false)).toBe(30000);
    expect(refreshWindow(3, true)).toBe(30000);
  });

  it('maps the public view, with no events, panel or overlay', () => {
    const b = buildSnapshot(input);
    const m = JSON.parse(b.message);
    expect(m).toEqual({ v: 1, e: 'q7Lw2k', t: 5, ph: 'fight', adv: null, f: { n: 'Slime', img: null, hp: 140, mx: 200, st: [], sub: 'f', held: false, nt: 9000 },
      p: [[K('twitch:1'), 'starter:fighter', 80, 0], [K('twitch:2'), 'starter:healer', 0, 1]], rv: 7, ch: [K('twitch:1')], rw: 1000, cv: 3 });
    expect(JSON.parse(b.content)).not.toHaveProperty('t');
    expect(JSON.parse(b.content)).not.toHaveProperty('rw');
    expect(b.sentKeys).toEqual([K('twitch:1')]);
    expect(b.rf).toBe(false);
    expect(b.bare).toBe(false);
    expect(bytes(b.message)).toBeLessThanOrEqual(MAX_BYTES);
  });

  it('sends no fight as null and statuses as ids', () => {
    const v = view(baseParty);
    v.fight = null;
    v.adventure = { id: 'a1', lined: null };
    const m = JSON.parse(buildSnapshot({ ...input, publicView: v }).message);
    expect(m.f).toBeNull();
    expect(m.adv).toBe('a1');
    const v2 = view(baseParty);
    v2.fight!.monster.statuses = [{ status: 'burn', until: 5 }];
    v2.fight!.sub = 'waiting';
    expect(JSON.parse(buildSnapshot({ ...input, publicView: v2 }).message).f).toMatchObject({ st: ['burn'], sub: 'w' });
  });

  const bigParty = (n: number) => Array.from({ length: n }, (_, i) => member(`twitch:${i}`, 10, 10, false, 'starter:fighter'));

  it('a party too big for 5 KB is trimmed by join order and pt gives the full size', () => {
    const party = bigParty(3000);
    const b = buildSnapshot({ ...input, publicView: view(party) });
    const m = JSON.parse(b.message);
    expect(bytes(b.message)).toBeLessThanOrEqual(MAX_BYTES);
    expect(m.pt).toBe(3000);
    expect(m.p.length).toBeGreaterThan(0);
    expect(m.p.length).toBeLessThan(3000);
    expect(m.p.map((r: unknown[]) => r[0])).toEqual(party.slice(0, m.p.length).map((x) => K(x.id)));
    expect(m.ch).toEqual([K('twitch:1')]);
  });

  it('does not add pt when the party fits', () => {
    expect(JSON.parse(buildSnapshot(input).message)).not.toHaveProperty('pt');
  });

  it('keys that do not fit after p is empty are held back, longest-waiting first', () => {
    const waiting = Array.from({ length: 400 }, (_, i) => K(`twitch:w${i}`));
    const b = buildSnapshot({ ...input, publicView: view(baseParty, 'x'.repeat(2500)), waiting });
    const m = JSON.parse(b.message);
    expect(bytes(b.message)).toBeLessThanOrEqual(MAX_BYTES);
    expect(m.p).toEqual([]);
    expect(m.pt).toBe(2);
    expect(m.ch.length).toBeGreaterThan(0);
    expect(m.ch.length).toBeLessThan(400);
    expect(m.ch).toEqual(waiting.slice(0, m.ch.length));
    expect(b.sentKeys).toEqual(m.ch);
    expect(m.rw).toBe(refreshWindow(m.ch.length, false));
  });

  it('an rf sends rf: true with no ch and claims every waiting key', () => {
    const waiting = [K('twitch:1'), K('twitch:2'), K('twitch:3')];
    const b = buildSnapshot({ ...input, waiting, rf: true });
    const m = JSON.parse(b.message);
    expect(m.rf).toBe(true);
    expect(m.ch).toBeUndefined();
    expect(m.rw).toBe(30000);
    expect(b.sentKeys).toEqual(waiting);
    expect(b.rf).toBe(true);
    expect(b.bare).toBe(false);
  });

  it('a snapshot that does not fit with p and ch empty becomes the bare form', () => {
    const b = buildSnapshot({ ...input, publicView: view(baseParty, 'x'.repeat(6000)) });
    const m = JSON.parse(b.message);
    expect(Object.keys(m).sort()).toEqual(['cv', 'e', 'rf', 'rw', 't', 'v']);
    expect(m.rw).toBe(30000);
    expect(b.bare).toBe(true);
    expect(b.rf).toBe(true);
    expect(b.sentKeys).toEqual(input.waiting);
    expect(bytes(b.message)).toBeLessThanOrEqual(MAX_BYTES);
  });

  it('an oversize rf also becomes the bare form', () => {
    const b = buildSnapshot({ ...input, rf: true, publicView: view(baseParty, 'x'.repeat(6000)) });
    expect(b.bare).toBe(true);
  });

  it('every built message is at most 5 KB', () => {
    const cases: SnapshotInput[] = [
      input,
      { ...input, publicView: view(bigParty(3000)) },
      { ...input, publicView: view(baseParty, 'x'.repeat(2500)), waiting: Array.from({ length: 400 }, (_, i) => K(`w${i}`)) },
      { ...input, rf: true },
      { ...input, publicView: view(baseParty, 'x'.repeat(6000)) },
    ];
    for (const c of cases) expect(bytes(buildSnapshot(c).message)).toBeLessThanOrEqual(MAX_BYTES);
  });
});
