import { describe, it, expect } from 'vitest';
import { FakeClock } from '../src/clock.js';
import { PacingGate } from '../src/twitch/gate.js';
import type { PubSubResult } from '../src/twitch/api.js';

const flush = () => new Promise<void>((r) => setImmediate(r));
const OK: PubSubResult = { ok: true };
const FAIL: PubSubResult = { ok: false, status: 500, retryAt: null };

function setup() {
  const clock = new FakeClock(0);
  const gate = new PacingGate(clock);
  const times: number[] = [];
  const attempt = (results: PubSubResult[] | PubSubResult = OK) => async () => {
    times.push(clock.now());
    return Array.isArray(results) ? (results.shift() ?? OK) : results;
  };
  return { clock, gate, times, attempt };
}

describe('PacingGate', () => {
  it('spaces sends for one channel at least 1 s apart, in order', async () => {
    const { clock, gate, times, attempt } = setup();
    const order: number[] = [];
    const sends = [0, 1, 2].map((i) => gate.send('1', async () => { order.push(i); return attempt()(); }));
    await clock.advance(5000, flush);
    expect(await Promise.all(sends)).toEqual([true, true, true]);
    expect(times).toEqual([0, 1000, 2000]);
    expect(order).toEqual([0, 1, 2]);
  });

  it('does not space different channels against each other', async () => {
    const { clock, gate, times, attempt } = setup();
    void gate.send('1', attempt());
    void gate.send('2', attempt());
    await clock.advance(0, flush);
    expect(times).toEqual([0, 0]);
  });

  it('a 429 waits until retryAt', async () => {
    const { clock, gate, times, attempt } = setup();
    const results: PubSubResult[] = [{ ok: false, status: 429, retryAt: 5000 }];
    const first = gate.send('1', attempt(results));
    const second = gate.send('1', attempt(results));
    await clock.advance(10_000, flush);
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(times).toEqual([0, 5000]);
  });

  it('failures back off 1 s, doubling, at most 30 s, and reset on success', async () => {
    const { clock, gate, times, attempt } = setup();
    const results: PubSubResult[] = Array(8).fill(FAIL);
    results.push(OK);
    const sends = Array.from({ length: 10 }, () => gate.send('1', attempt(results)));
    await clock.advance(200_000, flush);
    await Promise.all(sends);
    // gaps after failures: 1, 2, 4, 8, 16, 30, 30, 30 s; then success; then 1 s
    expect(times).toEqual([0, 1000, 3000, 7000, 15_000, 31_000, 61_000, 91_000, 121_000, 122_000]);
  });

  it('retryUntil retries until the deadline, then resolves false', async () => {
    const { clock, gate, times, attempt } = setup();
    const p = gate.send('1', attempt(FAIL), { retryUntil: 30_000 });
    await clock.advance(100_000, flush);
    expect(await p).toBe(false);
    expect(times).toEqual([0, 1000, 3000, 7000, 15_000]);
    expect(Math.max(...times)).toBeLessThanOrEqual(30_000);
  });

  it('retryUntil resolves true once an attempt succeeds', async () => {
    const { clock, gate, times, attempt } = setup();
    const p = gate.send('1', attempt([FAIL, FAIL]), { retryUntil: 30_000 });
    await clock.advance(10_000, flush);
    expect(await p).toBe(true);
    expect(times).toEqual([0, 1000, 3000]);
  });

  it('a throwing attempt counts as a failure', async () => {
    const { clock, gate } = setup();
    const p = gate.send('1', async () => { throw new Error('boom'); });
    await clock.advance(0, flush);
    expect(await p).toBe(false);
  });

  it('idle as the FakeClock settle does not deadlock on queued sends', async () => {
    const { clock, gate, times, attempt } = setup();
    for (let i = 0; i < 3; i++) void gate.send('1', attempt());
    await clock.advance(5000, () => gate.idle());
    expect(times).toEqual([0, 1000, 2000]);
  }, 2000);

  it('idle resolves immediately while a send is parked on a 30 s backoff', async () => {
    const { clock, gate, times, attempt } = setup();
    const results: PubSubResult[] = [{ ok: false, status: 429, retryAt: 30_000 }];
    const first = gate.send('1', attempt(results));
    const second = gate.send('1', attempt(results));
    await gate.idle();
    expect(times).toEqual([0]);
    await gate.idle();
    await clock.advance(30_000, () => gate.idle());
    expect(times).toEqual([0, 30_000]);
    expect(await first).toBe(false);
    expect(await second).toBe(true);
  }, 2000);

  it('idle stays pending while an attempt is unresolved', async () => {
    const { gate } = setup();
    let release!: (r: PubSubResult) => void;
    void gate.send('1', () => new Promise<PubSubResult>((r) => { release = r; }));
    let idle = false;
    void gate.idle().then(() => { idle = true; });
    await flush();
    expect(idle).toBe(false);
    release(OK);
    await flush();
    expect(idle).toBe(true);
  }, 2000);

  it('close() abandons sends parked on a timer and refuses new ones, without attempting them', async () => {
    const { clock, gate, times, attempt } = setup();
    const first = gate.send('1', attempt({ ok: false, status: 429, retryAt: 60_000 }));
    const parked = gate.send('1', attempt());
    await clock.advance(1000, flush);
    expect(times).toEqual([0]);
    gate.close();
    expect(await parked).toBe(false);
    expect(await gate.send('2', attempt())).toBe(false);
    await clock.advance(120_000, flush);
    expect(await first).toBe(false);
    expect(times).toEqual([0]);
    await gate.idle();
  });

  it('dropped keys are remembered until cleared', () => {
    const { gate } = setup();
    gate.markDropped('1');
    expect(gate.hasDropped('1')).toBe(true);
    expect(gate.hasDropped('2')).toBe(false);
    gate.clearDropped('1');
    expect(gate.hasDropped('1')).toBe(false);
  });
});
