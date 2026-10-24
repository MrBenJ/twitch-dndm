import { describe, expect, it } from 'vitest';
import { readTwitchConfig, TWITCH_API_BASE, TWITCH_AUTH_BASE } from '../src/config';

const SECRET32 = Buffer.alloc(32, 7).toString('base64');
const OLD32 = Buffer.alloc(40, 9).toString('base64');
const FULL = {
  TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csec', TWITCH_EXTENSION_SECRET: SECRET32, TWITCH_OWNER_ID: '9', DNDM_PUBLIC_URL: 'https://dndm.example.com/',
};

describe('readTwitchConfig', () => {
  it('none set is null', () => expect(readTwitchConfig({})).toBeNull());
  it('partial names what is missing', () => expect(() => readTwitchConfig({ TWITCH_CLIENT_ID: 'x' }))
    .toThrow('Twitch is partly configured; missing: DNDM_PUBLIC_URL, TWITCH_CLIENT_SECRET, TWITCH_EXTENSION_SECRET, TWITCH_OWNER_ID'));
  it('the previous secret is optional and not part of the check', () => {
    expect(readTwitchConfig(FULL)!.extensionSecretPrevious).toBeNull();
    expect(readTwitchConfig({ TWITCH_EXTENSION_SECRET_PREVIOUS: 'x' })).toBeNull();
    expect(readTwitchConfig({ ...FULL, TWITCH_EXTENSION_SECRET_PREVIOUS: OLD32 })!.extensionSecretPrevious).toBe(OLD32);
  });
  it('the extension secrets must be base64 of at least 32 bytes', () => {
    const bad = ['ZXh0', Buffer.alloc(31, 1).toString('base64'), 'not base64!!', `${SECRET32}x`, SECRET32.replace(/^./, '-')];
    for (const v of bad) {
      expect(() => readTwitchConfig({ ...FULL, TWITCH_EXTENSION_SECRET: v }), v).toThrow(/TWITCH_EXTENSION_SECRET\b/);
      expect(() => readTwitchConfig({ ...FULL, TWITCH_EXTENSION_SECRET_PREVIOUS: v }), v).toThrow(/TWITCH_EXTENSION_SECRET_PREVIOUS/);
    }
    // Missing padding is the same secret.
    const unpadded = Buffer.alloc(32, 7).toString('base64').replace(/=+$/, '');
    expect(readTwitchConfig({ ...FULL, TWITCH_EXTENSION_SECRET: unpadded })!.extensionSecret).toBe(unpadded);
    expect(readTwitchConfig({ ...FULL, TWITCH_EXTENSION_SECRET: Buffer.alloc(33, 2).toString('base64') })).not.toBeNull();
  });
  it('strips the trailing slash and fixes the base URLs', () => {
    expect(readTwitchConfig({ ...FULL, TWITCH_API_BASE: 'http://evil' })).toMatchObject({
      publicUrl: 'https://dndm.example.com', apiBase: TWITCH_API_BASE, authBase: TWITCH_AUTH_BASE, clientId: 'cid', ownerId: '9',
    });
  });
});
