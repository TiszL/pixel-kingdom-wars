// Chunk B, built the way the web ships it (the port of the concept's build-realm.mjs checks, patches.md P1/P10):
//   * the realm engine + adapter + avatar queue built by Vite (minified, code-split: the three lanes, ui and the adapter's
//     engine import are their own chunks), with @shardkeep/shared left out as first paint and the host chunk already
//     carry it (the constants barrel is in first paint; fantasyWorld is in the host's FantasyWorldLayer chunk);
//   * loader.mjs's PNG decode worker runs the MINIFIED pngCore/imgCore source text in a blob: Worker, so neither may refer
//     to anything outside its own body after the minifier ran (build-realm.mjs checkPngWorker, verbatim logic);
//   * the size: everything the dive loads, gzip -9, against the plan's budget (chunk B ≤ 240 KB gzip).
//   node src/ui/fantasy/worldv2/realm/build-check.support.mjs   → prints the chunks and sizes; exit 1 on a failure
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

export const CHUNK_B_BUDGET_KB = 240; // plan §1 "Lazy-chunk budget" (a presentation budget, not a game number)
const web = fileURLToPath(new URL('../../../../../', import.meta.url));

/** build-realm.mjs checkPngWorker at 8acdf059, unchanged but for the search over this build's files. */
export async function checkPngWorker(files) {
  const vm = await import('node:vm');
  const fnAt = (s, name) => { const at = s.indexOf(`async function ${name}(`); if (at < 0) return null;
    let j = s.indexOf('{', s.indexOf(')', at)), depth = 0; for (; j < s.length; j++) { if (s[j] === '{') depth++; else if (s[j] === '}' && --depth === 0) break; }
    return s.slice(at, j + 1); };
  for (const f of files) {
    const s = readFileSync(f, 'utf8'), m = s.match(/const pngCore=\$\{([\w$]+)\}/); if (!m) continue;
    const src = fnAt(s, m[1]); if (!src) return `no function ${m[1]} in ${f}`;
    try {
      const core = vm.runInContext(`(${src})`, vm.createContext({ Blob, Response, DecompressionStream }));
      const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4z8Dwn+E/QwMAEHkDfj8t7ugAAAAASUVORK5CYII=', 'base64'));
      const r = await core(png, Infinity, () => 0, null);
      if (!(r && r.width === 2 && r.data.length === 8)) return 'it decoded nothing';
      const mi = s.match(/const imgCore=\$\{([\w$]+)\}/); if (!mi) return 'no image core (imgCore) in the worker source';
      const isrc = fnAt(s, mi[1]); if (!isrc) return `no function ${mi[1]} in ${f}`;
      const img = vm.runInContext(`(${isrc})`, vm.createContext({ Blob }));
      return (await img(png)) === null ? null : 'the image core did not answer null without createImageBitmap';
    } catch (e) { return String(e.message || e); }
  }
  return 'no PNG worker core found in the engine';
}

/** Build chunk B into a temp dir → { chunks: [{ file, kb, gzKb, eager }], eagerGzKb, allGzKb, worker }. */
export async function buildChunkB() {
  const { build } = await import(createRequire(join(web, 'package.json')).resolve('vite'));
  const outDir = mkdtempSync(join(tmpdir(), 'wv2-chunk-b-'));
  try {
    const res = await build({
      configFile: false, root: web, logLevel: 'silent', publicDir: false,
      build: {
        outDir, emptyOutDir: true, write: true, minify: true, target: 'es2022', sourcemap: false, copyPublicDir: false,
        lib: { entry: fileURLToPath(new URL('./adapter.ts', import.meta.url)), formats: ['es'], fileName: 'realm-view' },
        rollupOptions: { external: id => id === '@shardkeep/shared' || id.startsWith('@shardkeep/shared/') },
      },
    });
    const out = (Array.isArray(res) ? res : [res]).flatMap(r => r.output ?? []).filter(o => o.type === 'chunk');
    const byName = new Map(out.map(o => [o.fileName, o]));
    const eager = new Set(); const walk = f => { if (eager.has(f)) return; eager.add(f); for (const i of byName.get(f)?.imports ?? []) walk(i); };
    walk(out.find(o => o.isEntry).fileName);
    const files = readdirSync(outDir, { recursive: true }).filter(f => f.endsWith('.js')).map(f => join(outDir, f));
    const gz = f => zlib.gzipSync(readFileSync(f), { level: 9 }).length / 1024, kb = f => readFileSync(f).length / 1024;
    const chunks = out.map(o => ({ file: o.fileName, kb: +kb(join(outDir, o.fileName)).toFixed(1), gzKb: +gz(join(outDir, o.fileName)).toFixed(1), eager: eager.has(o.fileName),
      shared: o.imports.filter(i => i.startsWith('@shardkeep/')).concat(o.dynamicImports.filter(i => i.startsWith('@shardkeep/'))) }));
    const sum = l => +l.reduce((s, c) => s + c.gzKb, 0).toFixed(1);
    return { chunks, eagerGzKb: sum(chunks.filter(c => c.eager)), allGzKb: sum(chunks), worker: await checkPngWorker(files) };
  } finally { rmSync(outDir, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = await buildChunkB();
  for (const c of r.chunks.sort((a, b) => b.gzKb - a.gzKb)) console.log(`${c.eager ? 'eager' : 'lazy '} ${c.file.padEnd(34)} ${String(c.kb).padStart(7)} KB min  ${String(c.gzKb).padStart(6)} KB gz`);
  console.log(`chunk B: ${r.eagerGzKb} KB gz at the import, ${r.allGzKb} KB gz with everything the dive loads (budget ${CHUNK_B_BUDGET_KB}); PNG worker: ${r.worker ?? 'self-contained'}`);
  if (r.worker || r.allGzKb > CHUNK_B_BUDGET_KB) process.exitCode = 1;
}
