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

/** `null` when Twitch is not configured at all; throws when it is configured only in part. */
export function readTwitchConfig(env: NodeJS.ProcessEnv): TwitchConfig | null {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length === REQUIRED.length) return null;
  if (missing.length) throw new Error(`Twitch is partly configured; missing: ${missing.join(', ')}`);
  return {
    clientId: env.TWITCH_CLIENT_ID!, clientSecret: env.TWITCH_CLIENT_SECRET!,
    extensionSecret: env.TWITCH_EXTENSION_SECRET!, extensionSecretPrevious: env.TWITCH_EXTENSION_SECRET_PREVIOUS || null,
    ownerId: env.TWITCH_OWNER_ID!, publicUrl: env.DNDM_PUBLIC_URL!.replace(/\/$/, ''),
    apiBase: TWITCH_API_BASE, authBase: TWITCH_AUTH_BASE,
  };
}
