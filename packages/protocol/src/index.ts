import type { GameEvent, View } from '@dndm/engine';
import { z } from 'zod';

export type Role = 'dock' | 'overlay' | 'viewer';
export type ConfigDoc = Record<string, unknown>;
export interface ErrorBody { code: string; message: string }
export type Answer = { ok: true; events: GameEvent[]; result?: unknown } | { ok: false; error: ErrorBody };

/** Spec 2a §4.1. Engine rejections are normal answers (200); these codes are the server's own. */
const STATUS: Record<string, number> = {
  'bad-command': 400,
  unauthorized: 401,
  forbidden: 403,
  'identity-required': 403,
  'streamer-only': 403,
  'unknown-channel': 404,
  'stale-config': 409,
  'content-in-use': 409,
  'invalid-config': 422,
  'rate-limited': 429,
  internal: 500,
  'save-failed': 503,
  'twitch-unavailable': 503,
};
export function httpStatus(code: string): number {
  return STATUS[code] ?? 200;
}

export const requestIdSchema = z.string().min(1).max(64);

export const commandRequestSchema = z.object({
  id: requestIdSchema,
  command: z.looseObject({ type: z.string().min(1) }),
}).strict();
export type CommandRequest = z.infer<typeof commandRequestSchema>;

const configDoc = z.record(z.string(), z.unknown());
export const serverCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('getConfig') }).strict(),
  z.object({ type: z.literal('validateConfig'), config: configDoc }).strict(),
  z.object({ type: z.literal('updateConfig'), config: configDoc, basedOn: z.number().int().min(1) }).strict(),
  z.object({ type: z.literal('regenerateDockUrl') }).strict(),
  z.object({ type: z.literal('regenerateOverlayUrl') }).strict(),
]);
export type ServerCommand = z.infer<typeof serverCommandSchema>;
export const SERVER_COMMANDS = ['getConfig', 'validateConfig', 'updateConfig', 'regenerateDockUrl', 'regenerateOverlayUrl'] as const;
export const READ_ONLY_COMMANDS = ['getConfig', 'validateConfig'] as const;
export const isServerCommand = (type: string): boolean => (SERVER_COMMANDS as readonly string[]).includes(type);
export const isReadOnlyCommand = (type: string): boolean => (READ_ONLY_COMMANDS as readonly string[]).includes(type);

export const clientMessageSchema = z.object({ type: z.literal('hello'), token: z.string().min(1) }).strict();
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type ServerMessage =
  | { type: 'welcome'; role: Role; character: string | null; view: View }
  | { type: 'events'; events: GameEvent[] }
  | { type: 'view'; view: View }
  | { type: 'config-changed'; configVersion: number }
  | { type: 'error'; code: string; message: string };

export const WS_CLOSE = { unauthorized: 4401, revoked: 4403, rateLimited: 4429 } as const;

export const devLoginSchema = z.object({
  channel: z.uuid(),
  viewer: z.string().regex(/^[a-z0-9_]{1,25}$/i),
}).strict();
export type DevLogin = z.infer<typeof devLoginSchema>;
