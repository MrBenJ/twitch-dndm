import { describe, expect, it } from 'vitest';
import {
  clientMessageSchema, commandRequestSchema, devLoginSchema, httpStatus, isServerCommand, serverCommandSchema,
} from '../src';

describe('protocol', () => {
  it('accepts a command request with a short request ID', () => {
    expect(commandRequestSchema.safeParse({ id: 'r1', command: { type: 'openSession' } }).success).toBe(true);
    expect(commandRequestSchema.safeParse({ id: '', command: { type: 'openSession' } }).success).toBe(false);
    expect(commandRequestSchema.safeParse({ id: 'x'.repeat(65), command: { type: 'openSession' } }).success).toBe(false);
    expect(commandRequestSchema.safeParse({ id: 'r1', command: {} }).success).toBe(false);
    expect(commandRequestSchema.safeParse({ id: 'r1', command: { type: 'go' }, extra: 1 }).success).toBe(false);
  });

  it('knows the server commands and their shapes', () => {
    expect(isServerCommand('updateConfig')).toBe(true);
    expect(isServerCommand('openSession')).toBe(false);
    expect(serverCommandSchema.safeParse({ type: 'updateConfig', config: { packs: [] }, basedOn: 1 }).success).toBe(true);
    expect(serverCommandSchema.safeParse({ type: 'updateConfig', config: { packs: [] } }).success).toBe(false);
    expect(serverCommandSchema.safeParse({ type: 'getConfig', extra: true }).success).toBe(false);
  });

  it('maps error codes to HTTP statuses (README decision 6)', () => {
    expect(httpStatus('bad-command')).toBe(400);
    expect(httpStatus('stale-config')).toBe(409);
    expect(httpStatus('rate-limited')).toBe(429);
    expect(httpStatus('save-failed')).toBe(503);
    expect(httpStatus('not-in-party')).toBe(200);
  });

  it('checks the WebSocket hello and dev login', () => {
    expect(clientMessageSchema.safeParse({ type: 'hello', token: 't' }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ type: 'hello' }).success).toBe(false);
    const channel = '6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
    expect(devLoginSchema.safeParse({ channel, viewer: 'alice_2' }).success).toBe(true);
    expect(devLoginSchema.safeParse({ channel, viewer: 'al ice' }).success).toBe(false);
    expect(devLoginSchema.safeParse({ channel: 'nope', viewer: 'alice' }).success).toBe(false);
  });
});
