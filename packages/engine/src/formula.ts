export type FormulaFn = 'min' | 'max' | 'floor' | 'ceil' | 'round' | 'random';
export type FormulaVar = { side: 'source' | 'target'; what: 'hp' | 'hp.max' | 'level' | 'stat'; stat?: string };
export type FormulaNode =
  | { k: 'num'; v: number }
  | ({ k: 'var' } & FormulaVar)
  | { k: 'neg'; a: FormulaNode }
  | { k: 'bin'; op: '+' | '-' | '*' | '/'; a: FormulaNode; b: FormulaNode }
  | { k: 'call'; fn: FormulaFn; args: FormulaNode[] };

export class FormulaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormulaError';
  }
}

const ARITY: Record<FormulaFn, [number, number]> = {
  min: [1, Infinity], max: [1, Infinity], floor: [1, 1], ceil: [1, 1], round: [1, 1], random: [2, 2],
};

type Tok =
  | { t: 'num'; v: number; pos: number }
  | { t: 'name'; v: string; pos: number }
  | { t: 'op'; v: string; pos: number; spaceBefore: boolean; spaceAfter: boolean }
  | { t: 'end'; pos: number };

const isLetter = (c: string | undefined) => c !== undefined && /[A-Za-z]/.test(c);
const isWordChar = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_]/.test(c);
const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);

function lex(text: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      const m = /^(\d*\.\d+|\d+)/.exec(text.slice(i))!;
      toks.push({ t: 'num', v: Number(m[1]), pos: i });
      i += m[1]!.length;
      if (isLetter(text[i])) throw new FormulaError(`Unexpected '${text[i]}' after a number at ${i + 1}`);
      continue;
    }
    if (isLetter(c)) {
      let j = i;
      const readWord = (start: number) => {
        while (
          j < text.length &&
          (isWordChar(text[j]) || (text[j] === '-' && j > start && isWordChar(text[j - 1]) && isWordChar(text[j + 1])))
        ) j++;
      };
      readWord(i);
      while ((text[j] === ':' || text[j] === '.') && isLetter(text[j + 1])) {
        j++;
        readWord(j);
      }
      toks.push({ t: 'name', v: text.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if ('+-*/(),'.includes(c)) {
      toks.push({ t: 'op', v: c, pos: i, spaceBefore: isSpace(text[i - 1]) || i === 0, spaceAfter: isSpace(text[i + 1]) });
      i++;
      continue;
    }
    throw new FormulaError(`Unexpected '${c}' at ${i + 1}`);
  }
  toks.push({ t: 'end', pos: text.length });
  return toks;
}

function varFromName(name: string): FormulaVar {
  let side: 'source' | 'target' = 'source';
  let rest = name;
  if (rest.startsWith('target.')) {
    side = 'target';
    rest = rest.slice('target.'.length);
  }
  if (rest === 'hp') return { side, what: 'hp' };
  if (rest === 'hp.max') return { side, what: 'hp.max' };
  if (rest === 'level') return { side, what: 'level' };
  if (rest.includes('.') || rest === '') throw new FormulaError(`Unknown name '${name}'`);
  return { side, what: 'stat', stat: rest };
}

export function parseFormula(text: string): FormulaNode {
  const toks = lex(text);
  let k = 0;
  const peek = () => toks[k]!;
  const isOp = (v: string) => { const t = peek(); return t.t === 'op' && t.v === v; };
  const expectOp = (v: string) => {
    if (!isOp(v)) throw new FormulaError(`Expected '${v}' at ${peek().pos + 1}`);
    k++;
  };

  const expr = (): FormulaNode => {
    let left = term();
    while (isOp('+') || isOp('-')) {
      const op = peek() as Extract<Tok, { t: 'op' }>;
      if (op.v === '-' && !(op.spaceBefore && op.spaceAfter)) {
        throw new FormulaError(`Put a space on both sides of '-' for subtraction (at ${op.pos + 1})`);
      }
      k++;
      left = { k: 'bin', op: op.v as '+' | '-', a: left, b: term() };
    }
    return left;
  };
  const term = (): FormulaNode => {
    let left = unary();
    while (isOp('*') || isOp('/')) {
      const op = (peek() as Extract<Tok, { t: 'op' }>).v as '*' | '/';
      k++;
      left = { k: 'bin', op, a: left, b: unary() };
    }
    return left;
  };
  const unary = (): FormulaNode => {
    if (isOp('-')) { k++; return { k: 'neg', a: unary() }; }
    if (isOp('+')) { k++; return unary(); }
    return primary();
  };
  const primary = (): FormulaNode => {
    const t = peek();
    if (t.t === 'end') throw new FormulaError('Unexpected end of formula');
    if (t.t === 'num') { k++; return { k: 'num', v: t.v }; }
    if (t.t === 'op' && t.v === '(') { k++; const e = expr(); expectOp(')'); return e; }
    if (t.t === 'name') {
      k++;
      if (isOp('(')) {
        if (!(t.v in ARITY)) throw new FormulaError(`Unknown function '${t.v}'`);
        const fn = t.v as FormulaFn;
        k++;
        const args: FormulaNode[] = [];
        if (!isOp(')')) {
          args.push(expr());
          while (isOp(',')) { k++; args.push(expr()); }
        }
        expectOp(')');
        const [lo, hi] = ARITY[fn];
        if (args.length < lo || args.length > hi) {
          throw new FormulaError(`${fn} takes ${lo === hi ? lo : `at least ${lo}`} argument${lo === 1 && hi === 1 ? '' : 's'}`);
        }
        return { k: 'call', fn, args };
      }
      return { k: 'var', ...varFromName(t.v) };
    }
    throw new FormulaError(`Unexpected '${(t as { v: string }).v}' at ${t.pos + 1}`);
  };

  const node = expr();
  if (peek().t !== 'end') {
    const t = peek() as Exclude<Tok, { t: 'end' }>;
    throw new FormulaError(`Unexpected '${t.v}' at ${t.pos + 1}`);
  }
  return node;
}

export function printFormula(node: FormulaNode): string {
  switch (node.k) {
    case 'num': return String(node.v);
    case 'var': {
      const name = node.what === 'stat' ? node.stat! : node.what;
      return node.side === 'target' ? `target.${name}` : name;
    }
    case 'neg': return `-(${printFormula(node.a)})`;
    case 'bin': return `(${printFormula(node.a)} ${node.op} ${printFormula(node.b)})`;
    case 'call': return `${node.fn}(${node.args.map(printFormula).join(', ')})`;
  }
}

export function formulaVars(node: FormulaNode): FormulaVar[] {
  switch (node.k) {
    case 'num': return [];
    case 'var': return [node.what === 'stat' ? { side: node.side, what: 'stat', stat: node.stat } : { side: node.side, what: node.what }];
    case 'neg': return formulaVars(node.a);
    case 'bin': return [...formulaVars(node.a), ...formulaVars(node.b)];
    case 'call': return node.args.flatMap(formulaVars);
  }
}

export function mapFormulaStats(node: FormulaNode, fn: (stat: string) => string): FormulaNode {
  switch (node.k) {
    case 'num': return node;
    case 'var': return node.what === 'stat' ? { ...node, stat: fn(node.stat!) } : node;
    case 'neg': return { k: 'neg', a: mapFormulaStats(node.a, fn) };
    case 'bin': return { ...node, a: mapFormulaStats(node.a, fn), b: mapFormulaStats(node.b, fn) };
    case 'call': return { ...node, args: node.args.map((a) => mapFormulaStats(a, fn)) };
  }
}

export interface FormulaEnv {
  value(v: FormulaVar): number;
  random(a: number, b: number): number;
}

const finite = (n: number) => (Number.isFinite(n) ? n : 0);

export function evaluateFormula(node: FormulaNode, env: FormulaEnv): number {
  switch (node.k) {
    case 'num': return node.v;
    case 'var': return finite(env.value(node));
    case 'neg': return -evaluateFormula(node.a, env);
    case 'bin': {
      const a = evaluateFormula(node.a, env);
      const b = evaluateFormula(node.b, env);
      if (node.op === '+') return finite(a + b);
      if (node.op === '-') return finite(a - b);
      if (node.op === '*') return finite(a * b);
      return b === 0 ? 0 : finite(a / b);
    }
    case 'call': {
      const args = node.args.map((a) => evaluateFormula(a, env));
      switch (node.fn) {
        case 'min': return Math.min(...args);
        case 'max': return Math.max(...args);
        case 'floor': return Math.floor(args[0]!);
        case 'ceil': return Math.ceil(args[0]!);
        case 'round': return Math.round(args[0]!);
        case 'random': return finite(env.random(args[0]!, args[1]!));
      }
    }
  }
}
