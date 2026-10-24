import { createHmac } from 'node:crypto';
import type { View } from '@dndm/engine';

export const MAX_BYTES = 5000;
export const BACKLOG_CAP = 3000;
export const RF_WINDOW = 30_000;

export interface SnapshotInput {
  e: string;
  t: number;
  publicView: View;
  keyOf: (characterId: string) => string;
  rv: number;
  cv: number;
  /** Keys waiting for an update, longest-waiting first. */
  waiting: string[];
  rf: boolean;
}

export interface Built {
  message: string;
  /** The message without `t` and `rw`, for comparing with the last one sent. */
  content: string;
  /** Keys this message accounts for; the caller removes them from its waiting set on success. */
  sentKeys: string[];
  rf: boolean;
  bare: boolean;
}

/** A character's anonymous per-channel key: 10 base64url characters of an HMAC (spec 2b §5.1). */
export function keyFor(k: Buffer, channelId: string, characterId: string): string {
  return createHmac('sha256', k).update(`${channelId}:${characterId}`).digest('base64url').slice(0, 10);
}

/** How long viewers spread their refreshes over, in ms: 10 ms per key sent, between 1 s and 30 s. */
export function refreshWindow(keys: number, rf: boolean): number {
  return rf ? RF_WINDOW : Math.min(RF_WINDOW, Math.max(1000, keys * 10));
}

const size = (o: object) => Buffer.byteLength(JSON.stringify(o), 'utf8');

/** The largest n in [0, max] with fits(n), assuming fits is monotone (true then false). */
function longestPrefix(max: number, fits: (n: number) => boolean): number {
  let lo = 0;
  let hi = max;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function buildSnapshot(i: SnapshotInput): Built {
  const { publicView: view } = i;
  const f = view.fight && {
    n: view.fight.monster.name, img: view.fight.monster.image, hp: view.fight.monster.hp, mx: view.fight.monster.maxHp,
    st: view.fight.monster.statuses.map((s) => s.status), sub: view.fight.sub === 'fighting' ? 'f' : 'w',
    held: view.fight.held, nt: view.fight.nextTurnAt,
  };
  const party = view.party.map((m) => [i.keyOf(m.id), m.class, m.maxHp > 0 ? Math.round((100 * m.hp) / m.maxHp) : 0, m.knockedOut ? 1 : 0]);

  const make = (p: unknown[], pt: number | null, ch: string[] | null): Record<string, unknown> => ({
    v: 1, e: i.e, t: i.t, ph: view.phase, adv: view.adventure ? { id: view.adventure.id, lined: view.adventure.lined } : null, f, p,
    ...(pt === null ? {} : { pt }),
    rv: i.rv,
    ...(ch === null ? { rf: true } : { ch }),
    rw: refreshWindow(ch?.length ?? 0, ch === null),
    cv: i.cv,
  });
  const finish = (m: Record<string, unknown>, sentKeys: string[], bare: boolean): Built => {
    const { t: _t, rw: _rw, ...rest } = m;
    return { message: JSON.stringify(m), content: JSON.stringify(rest), sentKeys, rf: m.rf === true, bare };
  };
  const fits = (m: Record<string, unknown>) => size(m) <= MAX_BYTES;

  const chAll = i.rf ? null : i.waiting;
  const sentAll = i.waiting;

  const full = make(party, null, chAll);
  if (fits(full)) return finish(full, sentAll, false);

  const n = longestPrefix(party.length, (k) => fits(make(party.slice(0, k), party.length, chAll)));
  if (n > 0) return finish(make(party.slice(0, n), party.length, chAll), sentAll, false);

  if (chAll !== null) {
    const c = longestPrefix(chAll.length, (k) => fits(make([], party.length, chAll.slice(0, k))));
    if (c > 0 || fits(make([], party.length, []))) {
      const ch = chAll.slice(0, c);
      return finish(make([], party.length, ch), ch, false);
    }
  } else if (fits(make([], party.length, null))) {
    return finish(make([], party.length, null), sentAll, false);
  }

  const bare = { v: 1, e: i.e, t: i.t, rf: true, rw: RF_WINDOW, cv: i.cv };
  return finish(bare, sentAll, true);
}
