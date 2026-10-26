import { describe, expect, it } from 'vitest';
import { Secrets } from '../src/crypto';
import { Cookies, parseCookies, SESSION_MS, type SignInSession } from '../src/session';

const c = new Cookies(new Secrets('a-long-enough-test-secret'));
const s: SignInSession = { channelId: '123', twitchId: '456', expiresAt: 1_000_000 + SESSION_MS };
const val = (setCookie: string) => setCookie.split(';')[0]!; // "name=value"
const flip = (v: string) => v.slice(0, -1) + (v.endsWith('A') ? 'B' : 'A');

describe('signed cookies and CSRF (spec 2b §4.3, §4.4)', () => {
  it('a session round-trips and expires after 7 days', () => {
    const h = val(c.session(s));
    expect(c.readSession(h, 1_000_000)).toEqual(s);
    expect(c.readSession(h, s.expiresAt)).toEqual(s);
    expect(c.readSession(h, s.expiresAt + 1)).toBeNull();
  });

  it('a tampered or foreign-secret session is refused', () => {
    const h = val(c.session(s));
    expect(c.readSession(flip(h), 1_000_000)).toBeNull();
    expect(new Cookies(new Secrets('another-long-enough-secret')).readSession(h, 1_000_000)).toBeNull();
    expect(c.readSession(undefined, 0)).toBeNull();
    expect(c.readSession('dndm_session=garbage', 0)).toBeNull();
  });

  it('the state cookie round-trips and is refused when tampered', () => {
    const h = val(c.state('abc123'));
    expect(c.readState(h)).toBe('abc123');
    expect(c.readState(flip(h))).toBeNull();
    expect(c.readState(undefined)).toBeNull();
  });

  it('session and state keys differ', () => {
    const v = val(c.state('abc123')).replace('dndm_state=', 'dndm_session=');
    expect(c.readSession(v, 0)).toBeNull();
  });

  it('cookie attributes', () => {
    expect(c.session(s)).toMatch(/^dndm_session=[^;]+; Path=\/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax$/);
    expect(c.state('x')).toMatch(/^dndm_state=[^;]+; Path=\/signup; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/);
    expect(c.clearSession()).toMatch(/^dndm_session=; Path=\/; Max-Age=0; HttpOnly; Secure; SameSite=Lax$/);
    expect(c.clearState()).toMatch(/^dndm_state=; Path=\/signup; Max-Age=0; HttpOnly; Secure; SameSite=Lax$/);
  });

  it('CSRF is tied to the session', () => {
    const a = val(c.session(s));
    const b = val(c.session({ ...s, channelId: '999' }));
    const token = c.csrf(a)!;
    expect(token).toBeTruthy();
    expect(c.checkCsrf(a, token)).toBe(true);
    expect(c.checkCsrf(b, token)).toBe(false);
    expect(c.checkCsrf(a, undefined)).toBe(false);
    expect(c.checkCsrf(a, 42)).toBe(false);
    expect(c.checkCsrf(a, '')).toBe(false);
    expect(c.csrf(undefined)).toBeNull();
    expect(c.checkCsrf(undefined, token)).toBe(false);
  });

  it('parseCookies handles several cookies and a missing header', () => {
    expect(parseCookies('a=1; b=2=3;  c=4')).toEqual({ a: '1', b: '2=3', c: '4' });
    expect(parseCookies(undefined)).toEqual({});
  });
});
