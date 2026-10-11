import { join, resolve } from 'node:path';
import { createEngine, type Engine } from '@dndm/engine';
import { listPackDirs, loadChannel, loadPacks, repoRoot } from '@dndm/pack-loader';

export interface SetupOpts { packs?: string[]; channel?: string }

export function packDirs(opts: SetupOpts): string[] {
  const given = (opts.packs ?? []).flatMap((p) => p.split(',')).filter(Boolean);
  return given.length ? given.map((p) => resolve(p)) : listPackDirs();
}

export function channelFile(opts: SetupOpts): string {
  return opts.channel ? resolve(opts.channel) : join(repoRoot(), 'channels', 'default.yaml');
}

export async function setup(opts: SetupOpts): Promise<Engine> {
  const bundles = await loadPacks(packDirs(opts));
  return createEngine({ packs: bundles, channel: loadChannel(channelFile(opts)) });
}
