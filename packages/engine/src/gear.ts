import { Rejection } from './errors';
import type { Runtime } from './runtime';
import type { Character } from './state';

export function capHp(_rt: Runtime, _ch: Character): void {}
export function equip(_rt: Runtime, _id: string, _item: string): void { throw new Rejection('Not implemented yet', 'not-implemented'); }
export function unequip(_rt: Runtime, _id: string, _slot: string): void { throw new Rejection('Not implemented yet', 'not-implemented'); }
