export const CORE = 'core';
export const CHANNEL = 'channel';

export type ContentType = 'stat' | 'slot' | 'class' | 'ability' | 'item' | 'monster' | 'encounter' | 'adventure';
export type PluginType = 'effect' | 'status' | 'passive' | 'targeting' | 'behavior' | 'encounterKind';
export type RefType = ContentType | PluginType;

/** Content types in normalization order: later types may depend on earlier ones. */
export const CONTENT_TYPES: readonly ContentType[] = [
  'stat', 'slot', 'class', 'ability', 'item', 'monster', 'encounter', 'adventure',
];
export const PLUGIN_TYPES: readonly PluginType[] = [
  'effect', 'status', 'passive', 'targeting', 'behavior', 'encounterKind',
];

export const PACK_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
export const LOCAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function splitId(ref: string): { pack: string | null; id: string } {
  const i = ref.indexOf(':');
  return i === -1 ? { pack: null, id: ref } : { pack: ref.slice(0, i), id: ref.slice(i + 1) };
}

export function fullId(pack: string, id: string): string {
  return `${pack}:${id}`;
}

export function packOf(full: string): string {
  return splitId(full).pack ?? '';
}

export function localOf(full: string): string {
  return splitId(full).id;
}

export function refKey(type: RefType, full: string): string {
  return `${type} ${full}`;
}
