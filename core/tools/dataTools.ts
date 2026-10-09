/**
 * core/tools/dataTools.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * data_tools: calculations and small analyses for the Data & Problem-Solving
 * agent. Pure functions over the arguments given; it reads no files, runs no
 * commands and never evaluates code (the arithmetic parser below accepts
 * numbers, operators, parentheses and a fixed list of functions, nothing else).
 *
 *   calculate    expression → number           "(12.5 * 4) / 3 + sqrt(16)"
 *   stats        numbers → count, sum, mean, median, min, max, standard deviation
 *   compare      items with numeric fields → ranked list, with differences
 *   log_summary  log text → counts by level, the most frequent error lines
 *
 * Log text comes from read_file or another tool, so file access stays under
 * the file policy.
 */

import type { AgentTool } from '../toolRegistryV2.js';

const MAX_EXPRESSION = 500;
const MAX_NUMBERS = 10_000;
const MAX_LOG_CHARS = 400_000;

// ─── Arithmetic parser (recursive descent, no eval) ──────────────────────────

const FUNCTIONS: Record<string, { arity: [number, number]; fn: (...a: number[]) => number }> = {
  sqrt: { arity: [1, 1], fn: Math.sqrt },
  abs: { arity: [1, 1], fn: Math.abs },
  round: { arity: [1, 2], fn: (x, d = 0) => { const f = 10 ** d; return Math.round(x * f) / f; } },
  floor: { arity: [1, 1], fn: Math.floor },
  ceil: { arity: [1, 1], fn: Math.ceil },
  min: { arity: [1, 50], fn: Math.min },
  max: { arity: [1, 50], fn: Math.max },
  pow: { arity: [2, 2], fn: Math.pow },
  exp: { arity: [1, 1], fn: Math.exp },
  ln: { arity: [1, 1], fn: Math.log },
  log: { arity: [1, 1], fn: Math.log10 },
  log2: { arity: [1, 1], fn: Math.log2 },
  sin: { arity: [1, 1], fn: Math.sin },
  cos: { arity: [1, 1], fn: Math.cos },
  tan: { arity: [1, 1], fn: Math.tan },
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

type Token = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    const num = /^(\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(src.slice(i));
    if (num) { out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    const id = /^[a-z][a-z0-9]*/i.exec(src.slice(i));
    if (id) { out.push({ t: 'id', v: id[0].toLowerCase() }); i += id[0].length; continue; }
    if ('+-*/%^(),'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    if (c === '×') { out.push({ t: 'op', v: '*' }); i++; continue; }
    if (c === '÷') { out.push({ t: 'op', v: '/' }); i++; continue; }
    throw new Error(`unexpected character "${c}"`);
  }
  return out;
}

/** Evaluates an arithmetic expression. Throws with a plain reason on anything else. */
export function calculate(expression: string): number {
  const src = expression.replace(/,(?=\d{3}\b)/g, ''); // 1,000 → 1000
  if (!src.trim()) throw new Error('empty expression');
  if (src.length > MAX_EXPRESSION) throw new Error(`expression longer than ${MAX_EXPRESSION} characters`);
  const tokens = tokenize(src);
  let pos = 0;
  let depth = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => { const t = peek(); return t?.t === 'op' && t.v === v; };
  const expect = (v: string) => { if (!isOp(v)) throw new Error(`expected "${v}"`); pos++; };

  const expr = (): number => {
    let v = term();
    while (isOp('+') || isOp('-')) { const op = (tokens[pos++] as { v: string }).v; const r = term(); v = op === '+' ? v + r : v - r; }
    return v;
  };
  const term = (): number => {
    let v = unary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = (tokens[pos++] as { v: string }).v;
      const r = unary();
      if ((op === '/' || op === '%') && r === 0) throw new Error('division by zero');
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  };
  const unary = (): number => {
    if (isOp('-')) { pos++; return -unary(); }
    if (isOp('+')) { pos++; return unary(); }
    return power();
  };
  const power = (): number => {
    const base = primary();
    if (isOp('^')) { pos++; return base ** unary(); } // right-associative
    return base;
  };
  const primary = (): number => {
    const t = peek();
    if (!t) throw new Error('expression ends too early');
    if (++depth > 100) throw new Error('expression nested too deeply');
    try {
      if (t.t === 'num') { pos++; return t.v; }
      if (t.t === 'op' && t.v === '(') { pos++; const v = expr(); expect(')'); return v; }
      if (t.t === 'id') {
        pos++;
        if (t.v in CONSTANTS && !isOp('(')) return CONSTANTS[t.v]!;
        const f = FUNCTIONS[t.v];
        if (!f) throw new Error(`unknown name "${t.v}"`);
        expect('(');
        const args: number[] = [];
        if (!isOp(')')) { args.push(expr()); while (isOp(',')) { pos++; args.push(expr()); } }
        expect(')');
        if (args.length < f.arity[0] || args.length > f.arity[1]) throw new Error(`${t.v} takes ${f.arity[0]}–${f.arity[1]} arguments`);
        return f.fn(...args);
      }
      throw new Error(`unexpected "${t.v}"`);
    } finally {
      depth--;
    }
  };

  const value = expr();
  if (pos < tokens.length) throw new Error(`unexpected "${String((tokens[pos] as { v: unknown }).v)}"`);
  if (!Number.isFinite(value)) throw new Error('the result is not a finite number');
  return value;
}

// ─── Statistics, comparison, logs ────────────────────────────────────────────

export function parseNumbers(input: unknown): number[] {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[\s,;]+/);
  const nums = raw
    .filter((x) => typeof x === 'number' || String(x ?? '').trim() !== '')
    .map((x) => (typeof x === 'number' ? x : Number(String(x).trim())))
    .filter((n) => Number.isFinite(n));
  if (nums.length > MAX_NUMBERS) throw new Error(`more than ${MAX_NUMBERS} numbers`);
  return nums;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function stats(nums: number[]): Record<string, number> {
  if (!nums.length) throw new Error('no numbers given');
  const sorted = [...nums].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((s, x) => s + x, 0);
  const mean = sum / n;
  const median = n % 2 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
  const variance = n > 1 ? sorted.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : 0;
  return { count: n, sum: r6(sum), mean: r6(mean), median: r6(median), min: sorted[0]!, max: sorted[n - 1]!, stdDev: r6(Math.sqrt(variance)) };
}

export interface CompareRow { name: string; value: number; rank: number; diffFromBest: number; percentOfBest: number | null }

/** Ranks items by one numeric field; `higherIsBetter` decides the order. */
export function compare(items: Record<string, unknown>[], field: string, higherIsBetter = true): CompareRow[] {
  const rows = items
    .map((it, i) => ({ name: String(it['name'] ?? it['id'] ?? `item ${i + 1}`), value: Number(it[field]) }))
    .filter((r) => Number.isFinite(r.value));
  if (!rows.length) throw new Error(`no item has a numeric "${field}"`);
  rows.sort((a, b) => (higherIsBetter ? b.value - a.value : a.value - b.value));
  const best = rows[0]!.value;
  return rows.map((r, i) => ({
    name: r.name, value: r.value, rank: i + 1,
    diffFromBest: r6(r.value - best),
    percentOfBest: best === 0 ? null : r6((r.value / best) * 100),
  }));
}

const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug'] as const;

export function logSummary(text: string, top = 5): { lines: number; byLevel: Record<string, number>; topErrors: { line: string; count: number }[] } {
  const lines = text.slice(0, MAX_LOG_CHARS).split(/\r?\n/).filter((l) => l.trim());
  const byLevel: Record<string, number> = Object.fromEntries(LEVELS.map((l) => [l, 0]));
  const errors = new Map<string, number>();
  for (const line of lines) {
    const low = line.toLowerCase();
    const level = /\bfatal\b/.test(low) ? 'fatal'
      : /\b(error|err|exception|failed|✗)\b/.test(low) ? 'error'
      : /\b(warn|warning|⚠)/.test(low) ? 'warn'
      : /\bdebug\b/.test(low) ? 'debug' : 'info';
    byLevel[level] = (byLevel[level] ?? 0) + 1;
    if (level === 'error' || level === 'fatal') {
      // Same error with different numbers/timestamps counts as one.
      const key = line.replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g, '<time>').replace(/\b\d+\b/g, '<n>').trim().slice(0, 200);
      errors.set(key, (errors.get(key) ?? 0) + 1);
    }
  }
  const topErrors = [...errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([line, count]) => ({ line, count }));
  return { lines: lines.length, byLevel, topErrors };
}

// ─── The tool ────────────────────────────────────────────────────────────────

export const dataTool: AgentTool = {
  name: 'data_tools',
  description:
    'Exact calculations and small data analyses (no code is run). Parameter action: '
    + '"calculate" (expression, e.g. "(12.5*4)/3 + sqrt(16)"; + - * / % ^, parentheses, sqrt abs round floor ceil min max pow exp ln log log2 sin cos tan, pi, e), '
    + '"stats" (numbers: list or comma-separated text), '
    + '"compare" (items: JSON list of objects with a name, field: the numeric field, higher_is_better: true/false), '
    + '"log_summary" (text: log lines, e.g. from read_file). Returns JSON.',
  riskLevel: 'low',
  inputSchema: {
    action: { type: 'string', description: 'calculate, stats, compare or log_summary', required: true, enum: ['calculate', 'stats', 'compare', 'log_summary'] },
    expression: { type: 'string', description: 'calculate: the expression', required: false },
    numbers: { type: 'string', description: 'stats: numbers, comma-separated (or a JSON list)', required: false },
    items: { type: 'string', description: 'compare: JSON list of objects', required: false },
    field: { type: 'string', description: 'compare: numeric field to rank by', required: false },
    higher_is_better: { type: 'boolean', description: 'compare: true when a higher value is better (default true)', required: false },
    text: { type: 'string', description: 'log_summary: the log text', required: false },
  },
  fallbacks: [],
  async execute(args) {
    const action = String(args['action'] ?? '');
    try {
      switch (action) {
        case 'calculate': {
          const expression = String(args['expression'] ?? '');
          return JSON.stringify({ success: true, action, expression, result: r6(calculate(expression)) });
        }
        case 'stats': {
          const raw = typeof args['numbers'] === 'string' && args['numbers'].trim().startsWith('[') ? JSON.parse(args['numbers']) : args['numbers'];
          return JSON.stringify({ success: true, action, ...stats(parseNumbers(raw)) });
        }
        case 'compare': {
          const items = typeof args['items'] === 'string' ? JSON.parse(args['items']) : args['items'];
          if (!Array.isArray(items)) throw new Error('items must be a JSON list of objects');
          const field = String(args['field'] ?? 'value');
          return JSON.stringify({ success: true, action, field, ranking: compare(items, field, args['higher_is_better'] !== false) });
        }
        case 'log_summary':
          return JSON.stringify({ success: true, action, ...logSummary(String(args['text'] ?? '')) });
        default:
          return JSON.stringify({ success: false, error: `unknown action "${action}"; use calculate, stats, compare or log_summary` });
      }
    } catch (err) {
      return JSON.stringify({ success: false, action, error: (err as Error).message });
    }
  },
};
