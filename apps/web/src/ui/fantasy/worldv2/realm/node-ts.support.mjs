// Node test support for the realm engine (worldv2/realm/patches.md P5). The engine imports game numbers from
// @shardkeep/shared (hard rule: every game number lives in packages/shared/src/constants.ts). Vite compiles that
// TypeScript for the browser; `node --test` alone cannot (types.ts declares enums, which Node's strip-only mode
// rejects, and shared uses extensionless relative imports). The concept ran its tests under tsx for the same reason.
// Each *.test.mjs imports this file first and then its cases, so the tests need no loader flag. Test-only: nothing
// the engine ships imports this file.
import { register } from 'node:module';

const hooks = `
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
let esbuild = null;
const load_esbuild = () => {
  if (esbuild) return esbuild;
  const web = createRequire(${JSON.stringify(new URL('../../../../../package.json', import.meta.url).pathname)});
  return (esbuild = createRequire(web.resolve('vite'))('esbuild'));
};
export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); } catch (e) {
    if (e?.code !== 'ERR_MODULE_NOT_FOUND' || !ctx.parentURL?.endsWith('.ts') || !/^\\.{1,2}\\//.test(spec)) throw e;
    for (const ext of ['.ts', '/index.ts']) { try { return await next(spec + ext, ctx); } catch { /* next candidate */ } }
    throw e;
  }
}
export async function load(url, ctx, next) {
  if (!url.startsWith('file:') || !url.endsWith('.ts')) return next(url, ctx);
  const src = await readFile(fileURLToPath(url), 'utf8');
  const out = load_esbuild().transformSync(src, { loader: 'ts', format: 'esm', target: 'es2022', sourcefile: fileURLToPath(url) });
  return { format: 'module', source: out.code, shortCircuit: true };
}
`;
register('data:text/javascript,' + encodeURIComponent(hooks));
