export const TWITCH_API_BASE = 'https://api.twitch.tv/helix';
export const TWITCH_AUTH_BASE = 'https://id.twitch.tv/oauth2';

export interface TwitchConfig {
  clientId: string; clientSecret: string;
  /** Base64, as Twitch shows it. */
  extensionSecret: string; extensionSecretPrevious: string | null;
  ownerId: string; publicUrl: string; apiBase: string; authBase: string;
}

// Spec §7.2 table order; this is also the order missing names are reported in.
const REQUIRED = ['DNDM_PUBLIC_URL', 'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'TWITCH_EXTENSION_SECRET', 'TWITCH_OWNER_ID'] as const;

const MIN_SECRET_BYTES = 32;

/** Throws naming `name` unless `value` is base64 (padding optional) that decodes to at least 32 bytes. */
function checkSecret(name: string, value: string): void {
  const bytes = Buffer.from(value, 'base64');
  const strip = (s: string) => s.replace(/=+$/, '');
  if (bytes.length < MIN_SECRET_BYTES || strip(bytes.toString('base64')) !== strip(value)) {
    throw new Error(`${name} must be base64 that decodes to at least ${MIN_SECRET_BYTES} bytes`);
  }
}

/** `null` when Twitch is not configured at all; throws when it is configured only in part or a secret is malformed. */
export function readTwitchConfig(env: NodeJS.ProcessEnv): TwitchConfig | null {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length === REQUIRED.length) return null;
  if (missing.length) throw new Error(`Twitch is partly configured; missing: ${missing.join(', ')}`);
  checkSecret('TWITCH_EXTENSION_SECRET', env.TWITCH_EXTENSION_SECRET!);
  if (env.TWITCH_EXTENSION_SECRET_PREVIOUS) checkSecret('TWITCH_EXTENSION_SECRET_PREVIOUS', env.TWITCH_EXTENSION_SECRET_PREVIOUS);
  return {
    clientId: env.TWITCH_CLIENT_ID!, clientSecret: env.TWITCH_CLIENT_SECRET!,
    extensionSecret: env.TWITCH_EXTENSION_SECRET!, extensionSecretPrevious: env.TWITCH_EXTENSION_SECRET_PREVIOUS || null,
    ownerId: env.TWITCH_OWNER_ID!, publicUrl: env.DNDM_PUBLIC_URL!.replace(/\/$/, ''),
    apiBase: TWITCH_API_BASE, authBase: TWITCH_AUTH_BASE,
  };
}
