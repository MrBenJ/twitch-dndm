import { type Description, describe } from './describe';
import type { Issue } from './errors';
import type { PackBundle } from './pack';
import { buildRegistry, type Registry } from './registry';

export interface Engine {
  registry: Registry;
  warnings: Issue[];
  describe(): Description;
}

export function createEngine(opts: { packs: PackBundle[]; channel: unknown }): Engine {
  const registry = buildRegistry(opts.packs, opts.channel);
  return {
    registry,
    warnings: registry.warnings,
    describe: () => describe(registry),
  };
}
