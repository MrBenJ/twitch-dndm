import { Rejection } from './errors';
import type { Runtime } from './runtime';

export function startAdventure(_rt: Runtime, _id: string): void { throw new Rejection('Not implemented yet', 'not-implemented'); }
export function go(_rt: Runtime): void { throw new Rejection('Not implemented yet', 'not-implemented'); }
export function skipTo(_rt: Runtime, _node: string): void { throw new Rejection('Not implemented yet', 'not-implemented'); }
export function stopAdventure(_rt: Runtime): void { throw new Rejection('Not implemented yet', 'not-implemented'); }
