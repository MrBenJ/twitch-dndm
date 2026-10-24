import { describe, expect, it } from 'vitest';
import { readTwitchConfig, TWITCH_API_BASE, TWITCH_AUTH_BASE } from '../src/config';

const FULL = {
  TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csec', TWITCH_EXTENSION_SECRET: 'ZXh0', TWITCH_OWNER_ID: '9', DNDM_PUBLIC_URL: 'https://dndm.example.com/',
};

describe('readTwitchConfig', () => {
  it('none set is null', () => expect(readTwitchConfig({})).toBeNull());
  it('partial names what is missing', () => expect(() => readTwitchConfig({ TWITCH_CLIENT_ID: 'x' }))
    .toThrow('Twitch is partly configured; missing: DNDM_PUBLIC_URL, TWITCH_CLIENT_SECRET, TWITCH_EXTENSION_SECRET, TWITCH_OWNER_ID'));
  it('the previous secret is optional and not part of the check', () => {
    expect(readTwitchConfig(FULL)!.extensionSecretPrevious).toBeNull();
    expect(readTwitchConfig({ TWITCH_EXTENSION_SECRET_PREVIOUS: 'x' })).toBeNull();
    expect(readTwitchConfig({ ...FULL, TWITCH_EXTENSION_SECRET_PREVIOUS: 'b2xk' })!.extensionSecretPrevious).toBe('b2xk');
  });
  it('strips the trailing slash and fixes the base URLs', () => {
    expect(readTwitchConfig({ ...FULL, TWITCH_API_BASE: 'http://evil' })).toMatchObject({
      publicUrl: 'https://dndm.example.com', apiBase: TWITCH_API_BASE, authBase: TWITCH_AUTH_BASE, clientId: 'cid', ownerId: '9',
    });
  });
});
