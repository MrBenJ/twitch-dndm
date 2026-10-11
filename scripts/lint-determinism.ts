import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BANNED = [/\bMath\.random\s*\(/, /\bDate\.now\s*\(/, /\bnew\s+Date\s*\(/];

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'test') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
}

/** Lines in .ts files under `roots` (tests excluded) that use banned nondeterministic calls. */
export function findDeterminismViolations(roots: string[]): string[] {
  const files: string[] = [];
  for (const root of roots) if (existsSync(root)) walk(root, files);
  const found: string[] = [];
  for (const file of files.sort()) {
    readFileSync(file, 'utf8').split('\n').forEach((text, i) => {
      if (BANNED.some((re) => re.test(text))) found.push(`${file}:${i + 1}: ${text.trim()}`);
    });
  }
  return found;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const found = findDeterminismViolations(['packages/engine/src', 'packs']);
  for (const line of found) console.error(line);
  if (found.length) {
    console.error(`\n${found.length} nondeterministic call(s). Use the engine's RNG and the 'now' passed in.`);
    process.exit(1);
  }
  console.log('Determinism check passed.');
}
