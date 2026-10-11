import { Rejection } from './errors';
import type { EntityRef } from './pack';
import type { Runtime } from './runtime';

export function useCommand(_rt: Runtime, _id: string, _ability: string, _chosen: EntityRef | null): void { throw new Rejection('Not implemented yet', 'not-implemented'); }
