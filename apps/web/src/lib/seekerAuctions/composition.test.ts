import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../..');
const exists = (path: string): boolean => ['', '.ts', '.tsx', '.json', '/index.ts'].some(ext => existsSync(path + ext));

describe('SA-4 composition keeps the map adapter tied to the accepted client', () => {
  it('resolves the map state import and the complete accepted client dependency graph', () => {
    const consumer = readFileSync(resolve(here, '../../ui/pk/map/seekerSpotBid.ts'), 'utf8');
    expect(consumer).toMatch(/import type\s*\{[^}]*SeekerAuctionState[^}]*\}\s*from\s*['"]\.\.\/\.\.\/\.\.\/lib\/seekerAuctions\/controller['"]/);
    const shared = JSON.parse(readFileSync(resolve(root, 'packages/shared/package.json'), 'utf8')) as { exports: Record<string, unknown> };
    for (const name of ['controller', 'transport', 'signing']) {
      const path = resolve(here, `${name}.ts`);
      expect(existsSync(path), `${name} must be composed; a type-only UI stub is insufficient`).toBe(true);
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      for (const node of source.statements) {
        if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
        const specifier = node.moduleSpecifier.text;
        if (specifier.startsWith('.')) expect(exists(resolve(here, specifier)), `${name}: ${specifier}`).toBe(true);
        if (specifier.startsWith('@shardkeep/shared/')) {
          const key = specifier.replace('@shardkeep/shared/', './');
          expect(Object.hasOwn(shared.exports, key), `${name}: shared export ${key}`).toBe(true);
        }
      }
    }
    const controller = readFileSync(resolve(here, 'controller.ts'), 'utf8');
    expect(controller).toContain('export interface SeekerAuctionState');
    expect(controller).toContain('export class SeekerAuctionController');
  });
});
