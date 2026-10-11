import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ContentSource, PackBundle, PackDefinition, PackManifest } from '@dndm/engine';
import { parseAllDocuments, parse as parseYaml } from 'yaml';

export class LoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoadError';
  }
}

/** This repository's root (packages/pack-loader/src -> ../../..). */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

export function listPackDirs(root: string = join(repoRoot(), 'packs')): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((name) => join(root, name))
    .filter((dir) => statSync(dir).isDirectory() && existsSync(join(dir, 'pack.json')))
    .sort();
}

function isOfficial(dir: string): boolean {
  const root = join(repoRoot(), 'packs');
  if (!existsSync(root)) return false;
  const packsRoot = realpathSync(root);
  const real = realpathSync(dir);
  return dirname(real) === packsRoot;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ya?ml$/.test(name)) out.push(full);
  }
}

function readContent(dir: string): ContentSource[] {
  const root = join(dir, 'content');
  if (!existsSync(root)) return [];
  const files: string[] = [];
  walk(root, files);
  const out: ContentSource[] = [];
  for (const file of files.sort()) {
    const rel = relative(dir, file).split(sep).join('/');
    const docs = parseAllDocuments(readFileSync(file, 'utf8'), { prettyErrors: true });
    let index = 0;
    for (const doc of docs) {
      if (doc.errors.length) {
        const e = doc.errors[0]!;
        const line = e.linePos?.[0]?.line;
        throw new LoadError(`${rel}${line ? ` (line ${line})` : ''}: ${e.message}`);
      }
      const value = doc.toJS();
      if (value === null || value === undefined) continue;
      out.push({ file: rel, index: index++, doc: value });
    }
  }
  return out;
}

export async function loadPack(dir: string): Promise<PackBundle> {
  const manifestPath = join(dir, 'pack.json');
  let manifest: PackManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackManifest;
  } catch (e) {
    throw new LoadError(`${manifestPath}: can't read pack.json (${(e as Error).message})`);
  }
  manifest.depends ??= {};
  const official = isOfficial(dir);
  const content = readContent(dir);
  const entry = join(dir, 'src', 'index.ts');
  const hasCode = existsSync(entry);
  const bundle: PackBundle = { manifest, official, content, ...(hasCode ? { hasCode } : {}) };
  if (hasCode && official) {
    const mod = (await import(pathToFileURL(entry).href)) as { default?: PackDefinition };
    if (!mod.default || typeof mod.default.register !== 'function') {
      throw new LoadError(`${entry}: the default export must be definePack({ register(api) { ... } })`);
    }
    bundle.register = mod.default.register;
  }
  return bundle;
}

export async function loadPacks(dirs: string[]): Promise<PackBundle[]> {
  const out: PackBundle[] = [];
  for (const dir of dirs) out.push(await loadPack(dir));
  return out;
}

export function loadChannel(file: string): unknown {
  try {
    return parseYaml(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new LoadError(`${file}: ${(e as Error).message}`);
  }
}
