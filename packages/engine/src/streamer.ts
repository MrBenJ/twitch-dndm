import { Rejection } from './errors';
import type { EntityRef } from './pack';
import type { Runtime } from './runtime';

export function healPlayer(_rt: Runtime, _id: string, _amount: number | 'full'): void { throw new Rejection('Not implemented yet', 'not-implemented'); }
export function healParty(_rt: Runtime): void { throw new Rejection('Not implemented yet', 'not-implemented'); }
export function revivePlayer(_rt: Runtime, _id: string): void { throw new Rejection('Not implemented yet', 'not-implemented'); }
export function reviveAll(_rt: Runtime): void { throw new Rejection('Not implemented yet', 'not-implemented'); }
export function applyStatusCommand(_rt: Runtime, _t: EntityRef, _s: string, _d: string | number | null, _p: unknown): void { throw new Rejection('Not implemented yet', 'not-implemented'); }
export function removeStatusCommand(_rt: Runtime, _t: EntityRef, _s: string): void { throw new Rejection('Not implemented yet', 'not-implemented'); }
export function knockOutCommand(_rt: Runtime, _id: string): void { throw new Rejection('Not implemented yet', 'not-implemented'); }
export function giveXpCommand(_rt: Runtime, _t: string, _n: number): void { throw new Rejection('Not implemented yet', 'not-implemented'); }
export function giveGoldCommand(_rt: Runtime, _t: string, _n: number): void { throw new Rejection('Not implemented yet', 'not-implemented'); }
export function giveItemCommand(_rt: Runtime, _t: string, _i: string): void { throw new Rejection('Not implemented yet', 'not-implemented'); }
export function postMessage(_rt: Runtime, _text: string): void { throw new Rejection('Not implemented yet', 'not-implemented'); }
