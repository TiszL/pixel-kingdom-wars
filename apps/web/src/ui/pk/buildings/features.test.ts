import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILDINGS_INFO_SOURCE } from '../../../lib/phaseEActivity/panelIds';

const effects = vi.hoisted(() => ({
  panelLoads: 0, registryLoads: 0, storeLoads: 0, accessLoads: 0,
  register: vi.fn(), readStore: vi.fn(), Panel: () => null,
}));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  effects.panelLoads = 0; effects.registryLoads = 0; effects.storeLoads = 0; effects.accessLoads = 0;
  vi.doMock('./BuildingInfoPanel', () => {
    effects.panelLoads++;
    return { default: effects.Panel };
  });
  vi.doMock('../featureRegistry', () => {
    effects.registryLoads++;
    return { createBaseFeatureRegistry: effects.register };
  });
  vi.doMock('../../../state/store', () => {
    effects.storeLoads++;
    return { configureBasePanels: effects.register, useApp: effects.readStore };
  });
  vi.doMock('../../../lib/phaseEActivity/access', () => {
    effects.accessLoads++;
    return {};
  });
});
afterEach(() => {
  vi.doUnmock('../../../lib/phaseEActivity/panelIds'); vi.doUnmock('./BuildingInfoPanel');
  vi.doUnmock('../featureRegistry'); vi.doUnmock('../../../state/store');
  vi.doUnmock('../../../lib/phaseEActivity/access');
});

describe('buildingFeatures', () => {
  it('defines exactly the shared INFO identity with HALF presentation and no mutation authority', async () => {
    const { buildingFeatures } = await import('./features');
    expect(buildingFeatures).toHaveLength(1);
    expect(buildingFeatures[0]).toMatchObject({
      id: BUILDINGS_INFO_SOURCE.featureId, kind: BUILDINGS_INFO_SOURCE.kind,
      label: 'Building', size: 'HALF', readOnly: false, dismissal: 'allow',
    });
    expect(buildingFeatures[0]!.canMutate).toBeUndefined();
    expect(buildingFeatures[0]!.canRecover).toBeUndefined();
  });

  it('pins the registry literals to the shared INFO source used by the lazy producer', async () => {
    const { buildingFeatures } = await import('./features');
    expect({ featureId: buildingFeatures[0]!.id, kind: buildingFeatures[0]!.kind }).toEqual(BUILDINGS_INFO_SOURCE);
  });

  it('keeps runtime lib imports out of the definition because the first-paint gate walks every features file', () => {
    // ebe7f763: shared identity belongs in this equality test, not the eager definition.
    const source = readFileSync(new URL('./features.ts', import.meta.url), 'utf8');
    const parsed = ts.createSourceFile('features.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const runtimeSpecifiers: string[] = [];
    const record = (node: ts.Expression | undefined) => {
      if (!node || !ts.isStringLiteralLike(node)) throw new Error('Feature module specifiers must be literal');
      runtimeSpecifiers.push(node.text);
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause, named = clause?.namedBindings;
        const typesOnly = clause?.isTypeOnly || clause && !clause.name && named && ts.isNamedImports(named)
          && named.elements.length > 0 && named.elements.every(element => element.isTypeOnly);
        if (!typesOnly) record(node.moduleSpecifier);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        const typesOnly = node.isTypeOnly || node.exportClause && ts.isNamedExports(node.exportClause)
          && node.exportClause.elements.length > 0 && node.exportClause.elements.every(element => element.isTypeOnly);
        if (!typesOnly) record(node.moduleSpecifier);
      } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
        record(node.moduleReference.expression);
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        record(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    expect(runtimeSpecifiers.filter(specifier => /(?:^|\/)lib\//.test(specifier))).toEqual([]);
  });

  it('imports as inert definitions without evaluating the panel, registry, store or crafting producer', async () => {
    await import('./features');
    expect(effects.panelLoads).toBe(0);
    expect(effects.registryLoads).toBe(0);
    expect(effects.storeLoads).toBe(0);
    expect(effects.accessLoads).toBe(0);
    expect(effects.register).not.toHaveBeenCalled();
    expect(effects.readStore).not.toHaveBeenCalled();
  });

  it('loads the default panel only when the host invokes the lazy loader and registers nothing', async () => {
    const { buildingFeatures } = await import('./features');
    expect(effects.panelLoads).toBe(0);
    const loaded = await buildingFeatures[0]!.load();
    expect(loaded.default).toBe(effects.Panel);
    expect(effects.panelLoads).toBe(1);
    expect(effects.registryLoads + effects.storeLoads + effects.accessLoads).toBe(0);
    expect(effects.register).not.toHaveBeenCalled();
  });
});
