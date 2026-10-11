import { join, resolve } from 'node:path';
import { createEngine, type Engine, type PackBundle } from '@dndm/engine';
import { listPackDirs, loadChannel, loadPacks, repoRoot } from '@dndm/pack-loader';

export interface SetupOpts { packs?: string[]; channel?: string }

export function packDirs(opts: SetupOpts): string[] {
  const given = (opts.packs ?? []).flatMap((p) => p.split(',')).filter(Boolean);
  return given.length ? given.map((p) => resolve(p)) : listPackDirs();
}

export function channelFile(opts: SetupOpts): string {
  return opts.channel ? resolve(opts.channel) : join(repoRoot(), 'channels', 'default.yaml');
}

/** Reads every pack, but imports code only for the packs the channel enables. */
export async function setupBundles(opts: SetupOpts): Promise<PackBundle[]> {
  const channel = loadChannel(channelFile(opts)) as { packs?: unknown } | null;
  const enabled = Array.isArray(channel?.packs) ? channel.packs.filter((p): p is string => typeof p === 'string') : [];
  return loadPacks(packDirs(opts), { enabled });
}

export async function setup(opts: SetupOpts): Promise<Engine> {
  return createEngine({ packs: await setupBundles(opts), channel: loadChannel(channelFile(opts)) });
}
