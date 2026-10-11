import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Web World v2 first-paint guard (PLAN §3 L7, risk R18).
 *
 * The fantasy world — the CPU globe today, the lazy WorldV2 chunks next — is
 * reached only through dynamic imports: Overlay → map → FantasyWorldLayer →
 * WorldV2. One static import of anything under ui/fantasy/, or of the
 * @shardkeep/shared/fantasyWorld catalogue, from the entry graph drags that
 * whole world into the bytes every new player downloads before the title
 * screen (size-check's 1000 KB wall; the 3D world alone is ~300 KB gzip). The
 * existing Overlay.lazyScreens test pins one file's text; this walks the real
 * static graph from every <script type="module"> entry in index.html, through
 * re-exports and workspace subpaths, so a leak three files deep still fails.
 */

const WEB = fileURLToPath(new URL('..', import.meta.url));
const REPO = resolve(WEB, '..', '..');
const CODE = /\.(?:[cm]?[jt]sx?)$/;
const EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js'];

type Edge = { from: string; to: string };

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

function resolveRelative(fromFile: string, spec: string): string | undefined {
  const base = resolve(dirname(fromFile), spec);
  const tries = [...EXTENSIONS.map((ext) => base + ext)];
  // TS sources import './x.js' and mean './x.ts'.
  if (/\.[cm]?js$/.test(base)) tries.push(base.replace(/\.([cm]?)js$/, '.$1ts'), base.replace(/\.js$/, '.tsx'));
  return tries.find(isFile);
}

/** Workspace packages resolve through their package.json `exports`, exactly as Vite does. */
function resolveWorkspace(spec: string): string | undefined | null {
  const match = /^@shardkeep\/([^/]+)(\/.*)?$/.exec(spec);
  if (!match) return null; // npm dependency: a leaf; its own bytes are size-check's business
  const pkgDir = join(REPO, 'packages', match[1]!);
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { exports?: Record<string, string>; main?: string };
  const target = pkg.exports?.[`.${match[2] ?? ''}`] ?? (match[2] ? undefined : pkg.main);
  return target === undefined ? undefined : join(pkgDir, target);
}

function allTypeOnly(elements: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>): boolean {
  return elements.length > 0 && elements.every((e) => e.isTypeOnly);
}

/** Specifiers whose code runs at import time: value imports, bare imports, value re-exports, eager globs. */
function staticSpecifiers(file: string, source: string): { specs: string[]; eagerGlobs: string[] } {
  const kind = file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, kind);
  const specs: string[] = [];
  const eagerGlobs: string[] = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const clause = st.importClause;
      if (clause?.isTypeOnly) continue;
      const named = clause?.namedBindings;
      if (clause && !clause.name && named && ts.isNamedImports(named) && allTypeOnly(named.elements)) continue;
      specs.push(st.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      if (st.isTypeOnly) continue;
      if (st.exportClause && ts.isNamedExports(st.exportClause) && allTypeOnly(st.exportClause.elements)) continue;
      specs.push(st.moduleSpecifier.text);
    }
  }
  // import.meta.glob(..., { eager: true }) is a static import in disguise.
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(sf) === 'import.meta.glob') {
      const [patterns, options] = node.arguments;
      const eager = options && ts.isObjectLiteralExpression(options) && options.properties.some((p) =>
        ts.isPropertyAssignment(p) && p.name.getText(sf) === 'eager' && p.initializer.kind === ts.SyntaxKind.TrueKeyword);
      if (eager && patterns) {
        const literals = ts.isArrayLiteralExpression(patterns) ? [...patterns.elements] : [patterns];
        for (const l of literals) if (ts.isStringLiteralLike(l)) eagerGlobs.push(l.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { specs, eagerGlobs };
}

type Leak = { file: string; chain: string[] };

/** Breadth-first walk of the static graph; reports every forbidden file with the chain that reaches it. */
function walkStaticGraph(entries: string[], forbidden: (file: string) => boolean) {
  const parent = new Map<string, string | null>(entries.map((e) => [e, null]));
  const queue = [...entries];
  const leaks: Leak[] = [];
  const unresolved: Edge[] = [];
  const chainOf = (file: string) => {
    const chain: string[] = [];
    for (let f: string | null | undefined = file; f; f = parent.get(f)) chain.unshift(f);
    return chain;
  };
  while (queue.length) {
    const file = queue.shift()!;
    if (forbidden(file)) { leaks.push({ file, chain: chainOf(file) }); continue; }
    if (!CODE.test(file)) continue; // css, json, assets: leaves
    const { specs, eagerGlobs } = staticSpecifiers(file, readFileSync(file, 'utf8'));
    for (const glob of eagerGlobs) {
      const target = resolve(dirname(file), glob.replace(/^!/, ''));
      if (!glob.startsWith('!') && forbidden(target)) leaks.push({ file: `${target} (eager glob)`, chain: chainOf(file) });
    }
    for (const spec of specs) {
      if (spec.includes('?')) continue; // ?url / ?raw / ?worker: an asset or a separate chunk, never inlined code
      const target = spec.startsWith('.') ? resolveRelative(file, spec) : resolveWorkspace(spec);
      if (target === null) continue;
      if (target === undefined) { unresolved.push({ from: file, to: spec }); continue; }
      if (parent.has(target)) continue;
      parent.set(target, file);
      queue.push(target);
    }
  }
  return { reached: new Set(parent.keys()), leaks, unresolved };
}

const FANTASY_DIR = join(WEB, 'src', 'ui', 'fantasy') + '/';
const FANTASY_CATALOGUE = resolveWorkspace('@shardkeep/shared/fantasyWorld');
const forbiddenInApp = (file: string) => file.startsWith(FANTASY_DIR) || file === FANTASY_CATALOGUE;

/** index.html is the build input: every module script there is a first-paint entry. */
function htmlEntries(): string[] {
  const html = readFileSync(join(WEB, 'index.html'), 'utf8');
  return [...html.matchAll(/<script[^>]*type="module"[^>]*src="\/([^"]+)"/g)].map((m) => join(WEB, m[1]!));
}

const rel = (f: string) => relative(REPO, f);

describe('Web World v2 first-paint guard', () => {
  it('no static import from any first-paint entry reaches ui/fantasy/** or @shardkeep/shared/fantasyWorld', () => {
    const entries = htmlEntries();
    expect(entries.map(rel)).toContain('apps/web/src/main.tsx');
    expect(FANTASY_CATALOGUE && rel(FANTASY_CATALOGUE)).toBe('packages/shared/src/fantasyWorld.ts');

    const { reached, leaks, unresolved } = walkStaticGraph(entries, forbiddenInApp);

    // A specifier the walker cannot follow is a blind spot, not a pass.
    expect(unresolved.map((e) => `${rel(e.from)} → ${e.to}`)).toEqual([]);
    // Calibration both ways: the walk really covers the eager HUD, and really
    // stops at lazy() boundaries (map is loaded on demand by Overlay).
    expect(reached.has(join(WEB, 'src', 'ui', 'Overlay.tsx'))).toBe(true);
    expect(reached.has(join(WEB, 'src', 'state', 'store.ts'))).toBe(true);
    expect(reached.has(join(WEB, 'src', 'ui', 'screens', 'map.tsx'))).toBe(false);
    expect(reached.size).toBeGreaterThan(100);

    expect(leaks.map((l) => l.chain.map(rel).join(' → '))).toEqual([]);
  });

  it('Phase E data and registration remain lazy so recovery features cannot cross the first-paint budget', () => {
    const directories = ['skrFaucet', 'solanaReach', 'leagueV2', 'carriedDeed', 'vehicleCraft', 'seekerAuctions', 'keepEquipmentMarket', 'phaseEActivity']
      .map(name => join(WEB, 'src', 'lib', name) + '/');
    const files = ['lib/skrIdentity.ts', 'lib/phaseERefusals.ts', 'ui/phaseE/SkrFaucetEntry.tsx',
      'ui/phaseE/SolanaReachEntry.tsx', 'ui/phaseE/PhaseERegistration.tsx'].map(name => join(WEB, 'src', name));
    const shared = ['leagueV2', 'solanaReachUnlock', 'vehicleCraftClientApi', 'vehicleCraftAttemptApi']
      .map(name => join(REPO, 'packages', 'shared', 'src', name + '.ts'));
    const { reached, leaks, unresolved } = walkStaticGraph(htmlEntries(), file =>
      directories.some(path => file.startsWith(path)) || files.includes(file) || shared.includes(file));
    // PhaseEBattleHost is intentionally first-paint today: never forbid all phaseE/**.
    expect(reached.has(join(WEB, 'src', 'ui', 'phaseE', 'PhaseEBattleHost.tsx'))).toBe(true);
    expect(unresolved.map(edge => `${rel(edge.from)} → ${edge.to}`)).toEqual([]);
    expect(leaks.map(leak => leak.chain.map(rel).join(' → '))).toEqual([]);
  });

  it('the walker catches a leak through a re-export and ignores type-only and dynamic imports', () => {
    // Rule 9: prove the guard can fail. A synthetic tree reproduces the three
    // ways a real leak hides (re-export chain, bare side-effect import, eager
    // glob) next to the two forms that must NOT count (type-only, import()).
    const root = mkdtempSync(join(tmpdir(), 'wv2-guard-'));
    try {
      const put = (path: string, body: string) => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), body);
      };
      put('main.tsx', [
        "import type { Tile } from './ui/fantasy/types';",
        "import { type Other } from './ui/fantasy/other';",
        "import { hud } from './hud';",
        "const lazyWorld = () => import('./ui/fantasy/worldv2/WorldV2');",
        'export { hud, lazyWorld }; export type { Tile, Other };',
      ].join('\n'));
      put('hud.ts', "export * from './barrel';\nimport './side';\nexport const hud = 1;");
      put('barrel.ts', "export { data } from './ui/fantasy/data';");
      put('side.ts', "const art = import.meta.glob('./ui/fantasy/art/*.ts', { eager: true });\nexport { art };");
      put('ui/fantasy/types.ts', 'export type Tile = 1;');
      put('ui/fantasy/other.ts', 'export type Other = 1;');
      put('ui/fantasy/data.ts', 'export const data = 1;');
      put('ui/fantasy/worldv2/WorldV2.tsx', 'export default 1;');

      const fantasy = join(root, 'ui', 'fantasy') + '/';
      const { leaks, unresolved } = walkStaticGraph([join(root, 'main.tsx')], (f) => f.startsWith(fantasy));
      const local = (f: string) => relative(root, f);

      expect(unresolved).toEqual([]);
      expect(leaks.map((l) => [local(l.file), l.chain.map(local).join(' → ')])).toEqual([
        ['ui/fantasy/art/*.ts (eager glob)', 'main.tsx → hud.ts → side.ts'],
        ['ui/fantasy/data.ts', 'main.tsx → hud.ts → barrel.ts → ui/fantasy/data.ts'],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
