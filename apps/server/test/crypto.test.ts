import { describe, expect, it } from 'vitest';
import { hashToken, isViewerToken, newToken, Secrets } from '../src/crypto';

const s = new Secrets('a-long-enough-test-secret');

describe('tokens and secrets (spec 2a §4.3)', () => {
  it('makes 32-byte tokens and stable hashes', () => {
    const t = newToken();
    expect(Buffer.from(t, 'base64url')).toHaveLength(32);
    expect(newToken()).not.toBe(t);
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('derives stable keys per label', () => {
    expect(s.derive('snapshot-key')).toEqual(s.derive('snapshot-key'));
    expect(s.derive('snapshot-key')).toHaveLength(32);
    expect(s.derive('snapshot-key').equals(s.derive('session'))).toBe(false);
    expect(new Secrets('another-long-enough-secret').derive('snapshot-key').equals(s.derive('snapshot-key'))).toBe(false);
  });

  it('encrypts so a token can be shown again', () => {
    const box = s.encrypt('hello');
    expect(box).not.toContain('hello');
    expect(s.decrypt(box)).toBe('hello');
    expect(s.encrypt('hello')).not.toBe(box);
  });

  it('refuses to decrypt with another secret or a changed box', () => {
    const box = s.encrypt('hello');
    expect(() => new Secrets('another-long-enough-secret').decrypt(box)).toThrow();
    const [iv, tag, ct] = box.split('.');
    expect(() => s.decrypt([iv, tag, `${ct}A`].join('.'))).toThrow();
  });

  it('signs and checks viewer tokens', () => {
    const t = s.signViewer({ channel: 'c1', character: 'dev:alice' });
    expect(isViewerToken(t)).toBe(true);
    expect(isViewerToken(newToken())).toBe(false);
    expect(s.verifyViewer(t)).toEqual({ channel: 'c1', character: 'dev:alice' });
  });

  it('refuses tampered or foreign viewer tokens', () => {
    const t = s.signViewer({ channel: 'c1', character: 'dev:alice' });
    const [v, body, mac] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ channel: 'c1', character: 'dev:bob' })).toString('base64url');
    expect(s.verifyViewer([v, forged, mac].join('.'))).toBeNull();
    expect(new Secrets('another-long-enough-secret').verifyViewer(t)).toBeNull();
    expect(s.verifyViewer('v1.nope')).toBeNull();
    expect(s.verifyViewer(`v1.${body}.`)).toBeNull();
  });

  it('needs a secret of at least 16 characters', () => {
    expect(() => new Secrets('short')).toThrow(/DNDM_SECRET/);
  });
});
