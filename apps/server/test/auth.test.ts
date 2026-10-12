import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/auth';
import { FakeClock } from '../src/clock';

describe('RateLimiter', () => {
  it('releases expired sender buckets after many distinct viewers', async () => {
    const clock = new FakeClock(0);
    const limiter = new RateLimiter(clock);
    for (let i = 0; i < 1000; i++) {
      expect(limiter.take('viewer', `viewer:channel:${i}`)).toBe(true);
    }
    expect(limiter['hits'].size).toBe(1000);

    await clock.advance(1000);
    expect(limiter.take('viewer', 'viewer:channel:new')).toBe(true);
    expect(limiter['hits'].size).toBe(1);
    expect(limiter.take('viewer', 'viewer:channel:0')).toBe(true);
  });
});
