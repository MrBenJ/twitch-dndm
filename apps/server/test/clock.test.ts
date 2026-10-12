import { describe, expect, it } from 'vitest';
import { FakeClock, realClock } from '../src/clock';

describe('FakeClock', () => {
  it('fires due timers in time order, then stops at the target', async () => {
    const c = new FakeClock(100);
    const seen: string[] = [];
    c.setTimer(300, () => seen.push(`b@${c.now()}`));
    c.setTimer(200, () => seen.push(`a@${c.now()}`));
    c.setTimer(900, () => seen.push('late'));
    await c.advanceTo(500);
    expect(seen).toEqual(['a@200', 'b@300']);
    expect(c.now()).toBe(500);
  });

  it('fires timers set by timers, and waits for settle between them', async () => {
    const c = new FakeClock(0);
    const seen: number[] = [];
    let pending = Promise.resolve();
    const tick = () => { pending = (async () => { await Promise.resolve(); seen.push(c.now()); if (c.now() < 30) c.setTimer(c.now() + 10, tick); })(); };
    c.setTimer(10, tick);
    await c.advance(100, () => pending);
    expect(seen).toEqual([10, 20, 30]);
  });

  it('cancels', async () => {
    const c = new FakeClock(0);
    let fired = false;
    const cancel = c.setTimer(10, () => { fired = true; });
    cancel();
    await c.advance(20);
    expect(fired).toBe(false);
  });
});

describe('realClock', () => {
  it('fires a near timer and can cancel a far one', async () => {
    const fired = await new Promise<boolean>((resolve) => {
      realClock.setTimer(realClock.now() + 5, () => resolve(true));
    });
    expect(fired).toBe(true);
    const cancel = realClock.setTimer(realClock.now() + 40 * 24 * 3600 * 1000, () => { throw new Error('must not fire'); });
    cancel();
  });
});
