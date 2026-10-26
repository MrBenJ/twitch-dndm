import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface ViewerClaim { channel: string; character: string }

export const newToken = (): string => randomBytes(32).toString('base64url');
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
export const isViewerToken = (token: string): boolean => token.startsWith('v1.');

const derive = (label: string, secret: string) => createHash('sha256').update(`${label}:${secret}`).digest();

/** Encryption for stored tokens and signing for viewer tokens, both keyed by DNDM_SECRET (README decision 5). */
export class Secrets {
  private readonly key: Buffer;
  private readonly mac: Buffer;
  private readonly secret: string;

  constructor(secret: string) {
    if (secret.length < 16) throw new Error('DNDM_SECRET must be at least 16 characters');
    this.secret = secret;
    this.key = derive('encrypt', secret);
    this.mac = derive('viewer', secret);
  }

  /** A key for another purpose, derived from DNDM_SECRET under its own label. */
  derive(label: string): Buffer {
    return derive(label, this.secret);
  }

  encrypt(text: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
  }

  decrypt(box: string): string {
    const [iv, tag, ct] = box.split('.').map((p) => Buffer.from(p, 'base64url'));
    if (!iv || !tag || !ct) throw new Error('Not an encrypted value');
    const d = createDecipheriv('aes-256-gcm', this.key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  }

  signViewer(claim: ViewerClaim): string {
    const body = Buffer.from(JSON.stringify({ channel: claim.channel, character: claim.character })).toString('base64url');
    return `v1.${body}.${this.sign(body)}`;
  }

  verifyViewer(token: string): ViewerClaim | null {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1' || !parts[1] || !parts[2]) return null;
    const want = Buffer.from(this.sign(parts[1]), 'base64url');
    const got = Buffer.from(parts[2], 'base64url');
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    try {
      const v = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Partial<ViewerClaim>;
      return typeof v.channel === 'string' && typeof v.character === 'string' ? { channel: v.channel, character: v.character } : null;
    } catch {
      return null;
    }
  }

  private sign(body: string): string {
    return createHmac('sha256', this.mac).update(body).digest('base64url');
  }
}
