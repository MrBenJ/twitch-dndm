import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { pubsubJwt, signJwt, verifyExtensionJwt } from '../src/twitch/jwt';
import type { TwitchConfig } from '../src/config';

const b64 = (s: string) => Buffer.from(s).toString('base64');
const S = b64('test-ext-secret');
const OTHER = b64('other-secret');
const OLD = b64('old-secret');
const now = 1_800_000_000_000;
const claims = { channel_id: '1001', opaque_user_id: 'U123', user_id: '42', role: 'viewer', exp: now / 1000 + 600 };
const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('extension JWTs', () => {
  it('accepts a valid token', () => expect(verifyExtensionJwt(signJwt(claims, S), [S], now)).toMatchObject({ channel_id: '1001', user_id: '42' }));
  it('accepts an expired token within 60 s of leeway and refuses one past it', () => {
    expect(verifyExtensionJwt(signJwt({ ...claims, exp: now / 1000 - 59 }, S), [S], now)).not.toBeNull();
    expect(verifyExtensionJwt(signJwt({ ...claims, exp: now / 1000 - 61 }, S), [S], now)).toBeNull();
  });
  it('refuses the wrong secret', () => expect(verifyExtensionJwt(signJwt(claims, OTHER), [S], now)).toBeNull());
  it('accepts the previous secret', () => expect(verifyExtensionJwt(signJwt(claims, OLD), [S, OLD], now)).not.toBeNull());
  it('refuses alg other than HS256, even when the signature is a valid HMAC-SHA256 with the real secret', () => {
    // Signed exactly as an HS256 token would be, so only the header's alg can make verification fail.
    const signedAs = (header: Record<string, unknown>) => {
      const data = `${enc(header)}.${enc(claims)}`;
      return `${data}.${createHmac('sha256', Buffer.from(S, 'base64')).update(data).digest('base64url')}`;
    };
    expect(verifyExtensionJwt(signedAs({ alg: 'HS256', typ: 'JWT' }), [S], now)).not.toBeNull(); // the control
    expect(verifyExtensionJwt(signedAs({ alg: 'HS512', typ: 'JWT' }), [S], now)).toBeNull();
    expect(verifyExtensionJwt(signedAs({ alg: 'none', typ: 'JWT' }), [S], now)).toBeNull();
    expect(verifyExtensionJwt(signedAs({ typ: 'JWT' }), [S], now)).toBeNull();
    expect(verifyExtensionJwt(`${enc({ alg: 'none', typ: 'JWT' })}.${enc(claims)}.`, [S], now)).toBeNull();
  });
  it('refuses malformed tokens and payloads', () => {
    expect(verifyExtensionJwt('nope', [S], now)).toBeNull();
    expect(verifyExtensionJwt('a.b.c', [S], now)).toBeNull();
    expect(verifyExtensionJwt(signJwt({ ...claims, channel_id: undefined }, S), [S], now)).toBeNull();
    expect(verifyExtensionJwt(signJwt({ ...claims, opaque_user_id: 5 }, S), [S], now)).toBeNull();
    expect(verifyExtensionJwt(signJwt({ ...claims, exp: '9' }, S), [S], now)).toBeNull();
  });
  it('reads a token without user_id', () => expect(verifyExtensionJwt(signJwt({ ...claims, user_id: undefined }, S), [S], now)!.user_id).toBeUndefined());
  it('pubsubJwt carries the send permission', () => {
    const cfg = { ownerId: '77', extensionSecret: S } as TwitchConfig;
    const tok = pubsubJwt(cfg, '1001', now);
    const payload = JSON.parse(Buffer.from(tok.split('.')[1]!, 'base64url').toString());
    expect(payload).toMatchObject({ role: 'external', user_id: '77', channel_id: '1001', pubsub_perms: { send: ['broadcast'] }, exp: now / 1000 + 60 });
    expect(JSON.parse(Buffer.from(tok.split('.')[0]!, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' });
  });
});
