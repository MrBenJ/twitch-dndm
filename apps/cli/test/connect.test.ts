import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { createChannel, defaultConfig, officialBundles, type RunningServer, Secrets, startServer, Store } from '@dndm/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConnectLine } from '../src/connect';
import { CliError } from '../src/ids';
import { main } from '../src/main';
import { freshDb } from '../../server/test/helpers/db';

const SECRET = 'cli-test-secret-0123456789';
let t: Awaited<ReturnType<typeof freshDb>>;
let srv: RunningServer;
let made: { id: string; dockToken: string };
beforeAll(async () => {
  t = await freshDb();
  const store = Store.open(t.url);
  made = await createChannel({ store, secrets: new Secrets(SECRET), bundles: await officialBundles(), name: 'c', config: defaultConfig(), seed: 1 });
  await store.close();
  srv = await startServer({ databaseUrl: t.url, secret: SECRET, dev: true, port: 0 });
});
afterAll(async () => { await srv.close(); await t.drop(); });

async function cli(argv: string[]) {
  const stdout = new PassThrough();
  let out = '';
  stdout.on('data', (c) => { out += String(c); });
  const code = await main(argv, { stdout, stdin: Readable.from([]) });
  return { code, out, get json() { return out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } };
}

const script = (lines: unknown[]) => {
  const file = join(tmpdir(), `dndm-connect-${process.pid}-${Math.random()}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
  return file;
};

describe('parseConnectLine (spec 2a §8.2)', () => {
  it('takes pauses and commands, and refuses stepped-clock lines', () => {
    expect(parseConnectLine('{"pause":"2s"}', 1)).toEqual({ pause: '2s' });
    expect(parseConnectLine('{"pause":"events"}', 1)).toEqual({ pause: 'events' });
    expect(parseConnectLine('{"as":"al","command":{"type":"leave"}}', 1)).toMatchObject({ as: 'al' });
    expect(() => parseConnectLine('{"wait":"5s"}', 3)).toThrow(/line 3: .*pause/);
    expect(() => parseConnectLine('{"next":true}', 4)).toThrow(CliError);
    expect(() => parseConnectLine('{"pause":"soon"}', 5)).toThrow(/line 5/);
  });
});

describe('dndm connect --script (spec 2a §1.1 criterion 1)', () => {
  it('plays a fight as the streamer and two viewers', async () => {
    const file = script([
      { as: 'streamer', command: { type: 'openSession' } },
      { as: 'al', command: { type: 'join', name: 'Al', pick: 'starter:sword' } },
      { as: 'bo', command: { type: 'join', name: 'Bo', pick: 'starter:shield' } },
      { as: 'streamer', command: { type: 'spawnMonster', monster: 'starter:slime' } },
      { as: 'al', command: { type: 'use', ability: 'starter:attack' } },
      { as: 'bo', command: { type: 'giveGold', target: 'party', amount: 1 } },
      { pause: '0.2s' },
    ]);
    const r = await cli(['connect', srv.url, '--channel', made.id, '--dock', made.dockToken, '--script', file, '--json']);
    expect(r.code).toBe(0);
    const types = r.json.filter((o) => o.kind === 'event').map((o) => o.type);
    expect(types).toEqual(expect.arrayContaining(['core:session-opened', 'core:joined', 'core:ability-used']));
    expect(r.json).toContainEqual(expect.objectContaining({ kind: 'rejected', as: 'bo', code: 'streamer-only' }));
  });

  it('gives up waiting for events after a timeout', async () => {
    const file = script([{ pause: 'events' }]);
    const r = await cli(['connect', srv.url, '--channel', made.id, '--dock', made.dockToken, '--script', file, '--json', '--timeout', '0.3s']);
    expect(r.code).toBe(0);
    expect(r.json).toContainEqual(expect.objectContaining({ kind: 'note', text: expect.stringMatching(/No events/) }));
  });

  it('stops with an error when the live connection drops (README decision 12)', async () => {
    const store = Store.open(t.url);
    const c = await createChannel({ store, secrets: new Secrets(SECRET), bundles: await officialBundles(), name: 'drop', config: defaultConfig(), seed: 1 });
    await store.close();
    const file = script([
      { as: 'streamer', command: { type: 'regenerateDockUrl' } },
      { pause: '0.3s' },
      { as: 'streamer', command: { type: 'postMessage', text: 'still here?' } },
    ]);
    const r = await cli(['connect', srv.url, '--channel', c.id, '--dock', c.dockToken, '--script', file]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/live connection closed \(4403/);
  });

  it("explains a server that isn't there", async () => {
    const file = script([{ as: 'streamer', command: { type: 'openSession' } }]);
    const r = await cli(['connect', 'http://127.0.0.1:1', '--channel', made.id, '--dock', made.dockToken, '--script', file]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/can't reach the server at http:\/\/127\.0\.0\.1:1/);
  });

  it('explains when dev login is off', async () => {
    const t2 = await freshDb();
    const store = Store.open(t2.url);
    const c2 = await createChannel({ store, secrets: new Secrets(SECRET), bundles: await officialBundles(), name: 'c2', config: defaultConfig(), seed: 1 });
    await store.close();
    const prod = await startServer({ databaseUrl: t2.url, secret: SECRET, dev: false, port: 0 });
    const file = script([{ as: 'al', command: { type: 'leave' } }]);
    const r = await cli(['connect', prod.url, '--channel', c2.id, '--dock', c2.dockToken, '--script', file]);
    await prod.close();
    await t2.drop();
    expect({ code: r.code, out: r.out }).toMatchObject({ code: 1, out: expect.stringMatching(/dev login is off on this server/) });
  });
});
