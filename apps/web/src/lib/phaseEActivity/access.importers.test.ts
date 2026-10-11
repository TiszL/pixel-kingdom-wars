import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const src = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const access = resolve(src, 'lib/phaseEActivity/access.ts');
const door = resolve(src, 'ui/phaseE/OrdinaryCraftingDoor.tsx');
const producer = 'requestOrdinaryCraftingPanel';
function isAccess(file: string, specifier: string): boolean {
  if (!specifier.startsWith('.')) return /(?:^|\/)phaseEActivity\/access(?:\.[cm]?[jt]s)?$/.test(specifier);
  return resolve(dirname(file), specifier).replace(/\.(?:[cm]?js|[cm]?ts)$/, '') + '.ts' === access;
}
function violations(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const localProducerNames = new Set<string>();
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteralLike(node.moduleSpecifier) || !isAccess(file, node.moduleSpecifier.text)) continue;
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
      if ((item.propertyName ?? item.name).text === producer) localProducerNames.add(item.name.text);
    }
  }
  const check = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && isAccess(file, node.moduleSpecifier.text)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) found.push('namespace import');
      if (node.importClause?.name) found.push('default import');
      if (bindings && ts.isNamedImports(bindings) && file !== door && bindings.elements.some(e => (e.propertyName ?? e.name).text === producer)) found.push('producer import');
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) && isAccess(file, node.moduleSpecifier.text)) {
      const clause = node.exportClause;
      if (!clause || ts.isNamespaceExport(clause)) found.push('star re-export');
      else if (clause.elements.some(e => (e.propertyName ?? e.name).text === producer)) found.push('producer re-export');
    }
    if (ts.isExportDeclaration(node) && !node.moduleSpecifier && node.exportClause && ts.isNamedExports(node.exportClause)
      && node.exportClause.elements.some(e => localProducerNames.has((e.propertyName ?? e.name).text))) found.push('local producer re-export');
    if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression) && localProducerNames.has(node.expression.text)) found.push('default producer re-export');
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg) && isAccess(file, arg.text)) found.push('dynamic module access');
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const arg = node.moduleReference.expression;
      if (arg && ts.isStringLiteralLike(arg) && isAccess(file, arg.text)) found.push('import equals');
    }
    ts.forEachChild(node, check);
  };
  check(source); return found;
}
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? files(path) : /\.[cm]?[jt]sx?$/.test(path) && !/\.(?:test|spec|test-support)\.[cm]?[jt]sx?$/.test(path) ? [path] : [];
  });
}
describe('H-1 producer has exactly one permitted production caller', () => {
  it('rejects imports, aliases, re-exports and namespace/dynamic access outside the existing door', () => {
    const forbidden = resolve(src, 'route.ts');
    for (const statement of [
      "import { requestOrdinaryCraftingPanel } from './lib/phaseEActivity/access';",
      "import { requestOrdinaryCraftingPanel as mint } from './lib/phaseEActivity/access.ts';",
      "export { requestOrdinaryCraftingPanel as mint } from './lib/phaseEActivity/access';",
      "export * from './lib/phaseEActivity/access';",
      "export * as grants from './lib/phaseEActivity/access';",
      "import * as grants from './lib/phaseEActivity/access';",
      "const grants = import('./lib/phaseEActivity/access');",
      "const grants = import(`./lib/phaseEActivity/access`);",
      "const grants = require('./lib/phaseEActivity/access');",
      "import grants = require('./lib/phaseEActivity/access');",
    ]) expect(violations(forbidden, statement), statement).not.toEqual([]);
  });
  it('permits only named producer import by the exact door and existing read-only/legacy named imports elsewhere', () => {
    expect(violations(door, "import { requestOrdinaryCraftingPanel as open } from '../../lib/phaseEActivity/access';")).toEqual([]);
    expect(violations(door, "import { requestOrdinaryCraftingPanel as open } from '../../lib/phaseEActivity/access'; export { open };")).toEqual(['local producer re-export']);
    expect(violations(door, "import { requestOrdinaryCraftingPanel as open } from '../../lib/phaseEActivity/access'; export default open;")).toEqual(['default producer re-export']);
    expect(violations(resolve(src, 'route.ts'), "import { hasBuildingActivityAccess, launchHistoryActivity } from './lib/phaseEActivity/access';")).toEqual([]);
  });
  // 2026-10-10 (release/phase-e-20261010): this case reads and scans every source file under src. It took ~4.4 s on the
  // CI runner (CI run 38043546234) and timed out at the default 5 s on a loaded dev Mac; its sibling whole-tree scan in
  // armyReadImporters.proposal.test.ts failed CI the same way. The budget is explicit for this case only (global timeouts
  // unchanged); the assertions are untouched and a genuine hang still fails.
  const TREE_SCAN_BUDGET_MS = 30_000;
  it('finds no forbidden production importer, barrel, route or restored-state caller in the composed source tree', () => {
    const found = files(src).flatMap(file => violations(file, readFileSync(file, 'utf8')).map(reason => ({ file, reason })));
    expect(found).toEqual([]);
    // The existing door is the only permitted production caller; its tests guard click-only invocation.
    const source = readFileSync(access, 'utf8');
    expect(source).toContain('export function requestOrdinaryCraftingPanel');
  }, TREE_SCAN_BUDGET_MS);
});
