import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { main } from '../src/main';

async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  const stdout = new PassThrough();
  let out = '';
  stdout.on('data', (c) => { out += String(c); });
  const code = await main(argv, { stdout, stdin: Readable.from([]) });
  return { code, out };
}

describe('dndm main', () => {
  it('a missing run script is a clean error, not a stack trace', async () => {
    const r = await cli(['run', '/tmp/does-not-exist-dndm.jsonl']);
    expect(r.code).toBe(1);
    expect(r.out.trim()).toBe("error: can't read /tmp/does-not-exist-dndm.jsonl (no such file)");
  });

  it.each(['nope', 'Infinity', '1.5', '-1'])('rejects --seed=%s', async (seed) => {
    const r = await cli(['run', '/tmp/x.jsonl', `--seed=${seed}`]);
    expect(r.code).toBe(2);
    expect(r.out.trim()).toBe('error: --seed must be a whole number of 0 or more');
  });

  it('accepts a generated dock token that starts with a dash', async () => {
    const token = `-${'A'.repeat(42)}`;
    const r = await cli(['connect', 'http://127.0.0.1:1', '--channel', '00000000-0000-0000-0000-000000000000', '--dock', token]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/can't reach the server/);
  });
});
