// World GLSL export for the native globe port (GLOBE-NATIVE-PLAN §4, D-168.2): the realm-map engine and the globe.
//
//   node tools/world-shaders.mjs --source <SHARDKEEP-globe repo> --pin <commit> --chosen "<why>"   export a chosen pin
//   node tools/world-shaders.mjs --source <SHARDKEEP-globe repo> --pin <commit>                    export a PROVISIONAL pin
//   node tools/world-shaders.mjs --source <SHARDKEEP-globe repo> --check          re-export the locked pin; byte-compare
//   node tools/world-shaders.mjs --verify                                          source-free: committed files vs lock
//
// Every byte comes from the pinned COMMIT (git archive), never from the source working tree: the web workflows are
// still committing there. Realm stages are produced by the pin's own core.js preprocessGLSL (PREAMBLE + REALM_<kind> +
// defines + #include resolution), so they are byte-identical to what core.program() hands the driver. Programs and
// includes are read from the engine's own call sites (the same reader as the web core.test.mjs engineGLSL()); a call
// that cannot be read fails the export. Globe stages are the concept's src/shaders.js strings exactly as main.js hands
// them to compile() (the module is imported, so ${COMMON}/${SEL_GLSL} resolve as in the browser); main.js is read as
// text only, and an inline FS may interpolate nothing but main.js's own numeric constants. The shared flat globe
// (src/globe/*.glsl.js, plan §4.6) lists its programs in GLOBE_PROGRAMS and its includes in GLOBE_INCLUDES; its stages go
// through the same pinned preprocessGLSL as the realm engine. The web's loop-bound and
// shader-budget rules are re-implemented below and run on every exported stage, plus the native §4.5 rules (no
// #extension, <= 16 samplers per stage).
//
// A PROVISIONAL pin (N0) writes only into test resources, so nothing it exports can reach an APK. A CHOSEN pin (N1/N2
// lead decision, recorded with its reason in the lock) writes the runtime copy into renderer/src/main/resources, loaded
// from the classpath as world/shaders/<file>. The lock also records the pack manifest at the pin (plan §6.1).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CONCEPT = 'concepts/globe3d-2026-09-23';
export const ENGINE = `${CONCEPT}/src/realm`;
export const GLOBE = `${CONCEPT}/src/globe`;
/** The concept globe's shader module and the file whose compile() calls define its programs (read as text only). */
export const GLOBE_SHADERS = `${CONCEPT}/src/shaders.js`, GLOBE_MAIN = `${CONCEPT}/src/main.js`;
export const PACK_MANIFEST = `${CONCEPT}/pack-manifest.json`;
export const SHARED = ['packages/shared/package.json', 'packages/shared/src'];
export const LOCK_FILE = 'world-shaders.lock.json';
export const OUT_DIR = 'renderer/src/test/resources/world/shaders';
/** Where a chosen pin's stages live: packaged from the renderer's classpath (like ui/counter-vt323). */
export const MAIN_OUT_DIR = 'renderer/src/main/resources/world/shaders';
/** A chosen pin's generated Kotlin table over those resources (name → stages + sha256, verified on load). */
export const KOTLIN_FILE = 'renderer/src/main/kotlin/gg/pixelkingdomwars/nativeclient/renderer/generated/WorldShaders.kt';
export const LOOP_MAX = 64;
export const SAMPLER_MAX = 16;
export const PROVISIONAL_REASON = 'Web P0 not re-gated green and RM_PAUSED not lifted (GLOBE-NATIVE-PLAN §4.1, D-168.2): '
  + 'this pin exists to build and test the exporter only. It must not be used for rendering; re-pin before N1 renderer work.';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (repo, args, options = {}) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 1 << 28, ...options });

// ---- pinned source -------------------------------------------------------------------------------------------------
export function resolvePin(repo, pin) {
  if (!/^[0-9a-f]{7,40}$/.test(pin ?? '')) throw new Error('Pass --pin as a commit sha');
  const full = git(repo, ['rev-parse', '--verify', '--quiet', `${pin}^{commit}`]).toString().trim();
  if (!/^[0-9a-f]{40}$/.test(full)) throw new Error(`Pin ${pin} is not a commit in ${repo}`);
  return full;
}
const pinnedPathExists = (repo, pin, relative) => {
  try { git(repo, ['cat-file', '-e', `${pin}:${relative}`], { stdio: 'ignore' }); return true; } catch { return false; }
};
/** Extract `paths` at `pin` into `dest` (a commit's tree only; the working tree and index are never read). */
export function extractPinned(repo, pin, paths, dest) {
  const tar = git(repo, ['archive', '--format=tar', pin, '--', ...paths]);
  execFileSync('tar', ['-x', '-C', dest], { input: tar, maxBuffer: 1 << 28 });
}
export async function moduleLoader(repo) {
  // The pinned contracts.js imports packages/shared TypeScript; the source repo's own tsx transpiles it (tooling only).
  const tsx = path.join(repo, 'scripts/node_modules/tsx/dist/esm/api/index.mjs');
  if (fs.existsSync(tsx)) {
    const { tsImport } = await import(pathToFileURL(tsx).href);
    return file => tsImport(pathToFileURL(file).href, import.meta.url);
  }
  return file => import(pathToFileURL(file).href);
}

// ---- the engine's GLSL, read from its own modules (port of core.test.mjs engineGLSL) --------------------------------
const IS_GLSL = /\b(?:void|float|u?int|bool|[iu]?vec[234]|mat[234])\s+\w+\s*\([^)]*\)\s*\{/;
export async function readEngine(dir, load) {
  const gdir = path.join(dir, 'glsl'), modules = new Map(), sources = new Map();
  for (const f of fs.readdirSync(gdir).filter(f => f.endsWith('.glsl.js')).sort()) {
    sources.set(`glsl/${f}`, fs.readFileSync(path.join(gdir, f)));
    modules.set(f, await load(path.join(gdir, f)));
  }
  const strings = [];
  for (const [f, m] of modules) for (const [k, v] of Object.entries(m)) if (typeof v === 'string') strings.push({ where: `glsl/${f} ${k}`, src: v });
  const includes = new Map(), fallbacks = new Map(), programs = new Map(), problems = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()) {
    const bytes = fs.readFileSync(path.join(dir, f)), text = bytes.toString('utf8'), ids = new Map();
    sources.set(f, bytes);
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/glsl\/([\w.-]+\.glsl\.js)'/g)) {
      for (const part of m[1].split(',').map(s => s.trim()).filter(Boolean)) { const [a, b = a] = part.split(/\s+as\s+/); ids.set(b.trim(), { mod: m[2], name: a.trim() }); }
    }
    for (const m of text.matchAll(/const\s+(\w+)\s*=\s*`([^`]*)`/g)) {
      if (!IS_GLSL.test(m[2])) continue;
      if (m[2].includes('${')) { problems.push(`${f} ${m[1]}: inline GLSL with a \${} interpolation`); continue; }
      ids.set(m[1], { local: m[2] }); strings.push({ where: `${f} ${m[1]}`, src: m[2] });
    }
    const val = id => { const r = ids.get(id); if (!r) return null; if (r.local !== undefined) return r.local; const v = modules.get(r.mod)?.[r.name]; return typeof v === 'string' ? v : null; };
    const seed = text.match(/const includes = new Map\(\[([^;]*)\]\)/);
    if (seed) for (const m of seed[1].matchAll(/\[\s*'([\w.-]+)'\s*,\s*(\w+)\s*\]/g)) { const v = val(m[2]); if (v == null) problems.push(`${f}: include ${m[1]} = ${m[2]} unresolved`); else includes.set(m[1], v); }
    for (const m of text.matchAll(/\binclude\(\s*'([\w.-]+)'\s*,\s*(\w+)\s*\)/g)) {
      const v = val(m[2]); if (v == null) { problems.push(`${f}: include('${m[1]}', ${m[2]}) unresolved`); continue; }
      (f === 'map.js' ? fallbacks : includes).set(m[1], v); // map.js registers stand-ins only when a lane module is missing
    }
    const calls = [...text.matchAll(/\bprogram\(\s*'/g)].length; let parsed = 0;
    for (const m of text.matchAll(/\bprogram\(\s*'([\w-]+)'\s*,\s*\{\s*vs:\s*(\w+)\s*,\s*fs:\s*(\w+)\s*(?:,\s*defines:\s*(\{[^{}]*\}|\w+)\s*)?\}\s*\)/g)) {
      parsed++;
      const vs = val(m[2]), fs_ = val(m[3]);
      if (vs == null || fs_ == null) { problems.push(`${f}: program('${m[1]}') sources ${m[2]}/${m[3]} unresolved`); continue; }
      // a defines identifier holds ?gdbg debug switches, empty in production; a production define it sets (ground.js
      // gd.RM_LAVA for Cinderfall) is exported only as a lane-listed variant (laneVariants below)
      const defines = {}, definesVar = m[4] && !m[4].startsWith('{') ? m[4] : null;
      if (m[4]?.startsWith('{')) for (const d of m[4].matchAll(/(\w+)\s*:\s*(true|-?\d+(?:\.\d+)?)/g)) defines[d[1]] = d[2] === 'true' ? true : d[2];
      const bake = ids.get(m[3])?.mod === 'resolve.glsl.js';
      const key = m[1] + '|' + JSON.stringify(defines);
      if (programs.has(key)) problems.push(`${f}: program ${key} defined twice`);
      else programs.set(key, { name: m[1], file: f, vs, fs: fs_, defines, bake, vsId: m[2], fsId: m[3], definesVar });
    }
    if (parsed !== calls) problems.push(`${f}: ${calls - parsed} program() call(s) this reader cannot parse`);
  }
  for (const [k, v] of fallbacks) if (!includes.has(k)) includes.set(k, v);
  return { strings, includes, programs, problems, sources };
}

// ---- the lanes' program lists (N3: GROUND = NR, LIFE + BASES = NL) --------------------------------------------------------
/** The realm lanes' own lists of the programs they draw, merged into every export (and recorded in the lock). */
export const LANE_LISTS = ['tools/world-shaders-ground.json', 'tools/world-shaders-lifebases.json'];
export function readLaneLists(root, lists = LANE_LISTS) {
  return lists.map(rel => { const bytes = fs.readFileSync(path.join(root, rel)); return { path: rel, sha256: sha256(bytes), doc: JSON.parse(bytes.toString('utf8')) }; });
}
/** Define sets are equal by name and GLSL text (the call-site reader keeps a number as its source text, a list as JSON). */
const sameDefines = (a, b) => JSON.stringify(Object.keys(a).sort().map(k => [k, String(a[k])])) === JSON.stringify(Object.keys(b).sort().map(k => [k, String(b[k])]));
/**
 * Checks the lane lists against the engine read at the pin, and adds the production define variants the engine sets
 * through a variable (ground.js `gd.RM_LAVA = true` for Cinderfall: `defines: gd`, which the call-site reader cannot see).
 * A listed program must be a program() call of the pin with the same vs/fs identifiers; a listed variant must extend a
 * call whose defines are a variable, and the module must assign every listed define to that variable, or it fails. Every
 * program() call of a module a list covers must be listed (a new web program cannot slip past its lane), and every entry
 * must say exported: true (the export now carries each one; a false flag is a stale list). Mutates `programs`.
 */
export function laneVariants(programs, sources, lanes, commit) {
  const problems = [], covered = new Map();
  for (const { path: rel, doc } of lanes) {
    if (doc.pin !== commit) { problems.push(`${rel} names pin ${doc.pin}, the export is ${commit}`); continue; }
    if (!Array.isArray(doc.programs) || !doc.programs.length) { problems.push(`${rel}: no programs`); continue; }
    for (const p of doc.programs) {
      const defines = p.defines ?? {}, key = `${p.name}${definesSuffix(defines)}`, where = `${rel} ${p.key}`;
      if (p.key !== key) { problems.push(`${where}: key is not name + defines (${key})`); continue; }
      if (p.exported !== true) problems.push(`${where}: "exported" is not true, yet the exporter exports every listed program`);
      const calls = [...programs].filter(([, e]) => e.name === p.name);
      if (!calls.length) { problems.push(`${where}: no program('${p.name}') at the pin`); continue; }
      let [hitKey, hit] = calls.find(([, e]) => sameDefines(e.defines, defines)) ?? [];
      if (!hit) {
        const base = calls.map(([, e]) => e).find(e => e.definesVar);
        const text = base && sources.get(base.file)?.toString('utf8');
        const unset = base ? Object.entries(defines).filter(([k, v]) => !new RegExp(`\\b${base.definesVar}\\.${k}\\s*=\\s*${v === true ? 'true' : String(v).replace('.', '\\.')}\\b`).test(text)) : [];
        if (!base || !Object.keys(defines).length || unset.length) { problems.push(`${where}: the pin ${base ? `never sets ${unset.map(([k]) => `${base.definesVar}.${k}`).join(', ')}` : 'has no program() with variable defines'} for this variant`); continue; }
        hitKey = `${p.name}|${JSON.stringify(defines)}`;
        hit = { ...base, defines: { ...defines }, definesVar: null, variant: `${base.file} ${base.definesVar}.${Object.keys(defines).sort().join('/')} (${rel})` };
        programs.set(hitKey, hit);
      }
      if (hit.vsId !== p.vs || hit.fsId !== p.fs) problems.push(`${where}: listed as ${p.vs}/${p.fs}, the pin compiles ${hit.vsId}/${hit.fsId}`);
      if (!covered.has(hit.file)) covered.set(hit.file, new Set());
      covered.get(hit.file).add(hitKey);
    }
  }
  for (const [key, e] of programs) if (covered.has(e.file) && !covered.get(e.file).has(key)) problems.push(`${e.file} program('${e.name}') ${JSON.stringify(e.defines)} is in no lane list`);
  return problems;
}

// ---- rules (ports of the web core.test.mjs budget and loop rules, plus native §4.5) ---------------------------------
/** Lines that survive #ifdef/#ifndef/#else/#endif, given the #defines seen so far (the web reader's semantics). */
function liveText(src) {
  const defd = new Set(), keep = [], on = [];
  for (const line of src.split('\n')) {
    const m = line.match(/^\s*#\s*(ifdef|ifndef|else|endif|define|undef|if|elif)\b\s*(\w+)?/), live = on.every(Boolean);
    if (!m) { if (live) keep.push(line); continue; }
    if (m[1] === 'ifdef') on.push(defd.has(m[2])); else if (m[1] === 'ifndef') on.push(!defd.has(m[2]));
    else if (m[1] === 'else') on.push(!on.pop()); else if (m[1] === 'endif') on.pop();
    else if (m[1] === 'if' || m[1] === 'elif') throw Error('the budget reads #ifdef/#ifndef only: ' + line);
    else if (live && m[1] === 'define') defd.add(m[2]); else if (live && m[1] === 'undef') defd.delete(m[2]);
  }
  return keep.join('\n').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
}
export function glslFunctions(src) {
  const s = liveText(src), fns = new Map(), re = /\b(\w+)\s+(\w+)\s*\(([^()]*)\)\s*\{/y;
  for (let i = 0, depth = 0; i < s.length;) {
    if (depth === 0) { re.lastIndex = i; const m = re.exec(s); if (m && !['if', 'for', 'while', 'switch', 'return', 'else'].includes(m[2])) {
      let j = re.lastIndex, d = 1; while (j < s.length && d) { if (s[j] === '{') d++; else if (s[j] === '}') d--; j++; }
      if (!fns.has(m[2])) fns.set(m[2], []); fns.get(m[2]).push(s.slice(re.lastIndex, j - 1)); i = j; continue; } }
    if (s[i] === '{') depth++; else if (s[i] === '}') depth--; i++;
  }
  return fns;
}
/** What main() costs once every reachable call is inlined: copies of `target` and the inlined size (spaces folded). */
export function inlineCost(src, target) {
  const fns = glslFunctions(src), memo = new Map();
  const walk = f => { if (memo.has(f)) return memo.get(f); memo.set(f, { n: 0, chars: 0 }); let best = { n: 0, chars: 0 };
    for (const body of fns.get(f)) { const r = { n: f === target ? 1 : 0, chars: body.replace(/\s+/g, ' ').length };
      if (f !== target) for (const m of body.matchAll(/\b(\w+)\s*\(/g)) if (fns.has(m[1]) && m[1] !== f) { const c = walk(m[1]); r.n += c.n; r.chars += c.chars; }
      if (r.n > best.n || (r.n === best.n && r.chars > best.chars)) best = r; }
    memo.set(f, best); return best; };
  return fns.has('main') ? walk('main') : { n: 0, chars: 0 };
}
/** Every `for` has an int variable, a literal or #define bound <= 64, a literal step and no write in its body; no while/do. */
export function loopViolations(src, defs) {
  const s = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ''), out = [];
  if (/\bwhile\b/.test(s)) out.push('while loop');
  if (/\bdo\s*\{/.test(s)) out.push('do loop');
  const heads = [...s.matchAll(/\bfor\s*\(([^;()]*);([^;()]*);([^;()]*)\)/g)], all = [...s.matchAll(/\bfor\s*\(/g)].length;
  if (heads.length !== all) out.push(`${all - heads.length} loop header(s) with a call or nested parentheses`);
  for (const h of heads) {
    const text = h[0].replace(/\s+/g, ' '), v = h[1].match(/^\s*(?:int|uint)\s+(\w+)\s*=/)?.[1];
    if (!v) { out.push(`${text}: no int loop variable`); continue; }
    const c = h[2].match(new RegExp(`^\\s*${v}\\s*(<=?)\\s*(\\w+)\\s*$`));
    const bound = !c ? NaN : /^\d+u?$/.test(c[2]) ? parseInt(c[2], 10) : defs.has(c[2]) ? defs.get(c[2]) : NaN;
    if (!c || !Number.isFinite(bound)) out.push(`${text}: bound is not a literal or #define constant`);
    else if (bound > LOOP_MAX) out.push(`${text}: bound ${bound} > ${LOOP_MAX}`);
    if (!new RegExp(`^\\s*(?:${v}\\s*\\+\\+|\\+\\+\\s*${v}|${v}\\s*\\+=\\s*[1-9]\\d*u?)\\s*$`).test(h[3])) out.push(`${text}: step is not ${v}++ / ${v} += literal`);
    let i = h.index + h[0].length, p = 0; while (/\s/.test(s[i])) i++;
    const start = i;
    for (; i < s.length; i++) {
      const ch = s[i];
      if (ch === '(') p++; else if (ch === ')') p--;
      else if (ch === '{' && p === 0) { let d = 1; i++; while (i < s.length && d) { if (s[i] === '{') d++; else if (s[i] === '}') d--; i++; } break; }
      else if (ch === ';' && p === 0) { i++; break; }
    }
    if (new RegExp(`\\b${v}\\s*(?:[-+*/%]?=(?!=)|\\+\\+|--)|(?:\\+\\+|--)\\s*${v}\\b`).test(s.slice(start, i))) out.push(`${text}: the body writes ${v}`);
  }
  return out;
}
export const defineTable = src => {
  const defs = new Map();
  for (const m of src.matchAll(/^[ \t]*#define[ \t]+(\w+)[ \t]+(\d+)u?[ \t]*$/gm)) defs.set(m[1], Math.max(defs.get(m[1]) ?? 0, +m[2]));
  return defs;
};
/** Sampler units a stage declares in its live (#ifdef-resolved) text; arrays count every element. */
export function samplerCount(src) {
  let n = 0;
  for (const m of liveText(src).matchAll(/\buniform\s+(?:(?:lowp|mediump|highp)\s+)?[iu]?sampler\w*\s+\w+\s*(?:\[\s*(\d+)\s*\])?/g)) n += m[1] ? +m[1] : 1;
  return n;
}
/** Every rule a preprocessed stage must pass. caps = the pin's GPU_SAFE.shader. */
export function stageViolations(stage, { bake, caps }) {
  const out = [];
  if (!stage.startsWith('#version 300 es\n')) out.push('does not start with #version 300 es');
  if (/^[ \t]*#[ \t]*extension\b/m.test(stage)) out.push('#extension directive');
  if (/^[ \t]*#[ \t]*include\b/m.test(stage)) out.push('unresolved #include');
  const c = inlineCost(stage, 'rmClassCore'), allowed = bake ? caps.classifierBake : caps.classifierDisplay;
  if (c.n > allowed) out.push(`${c.n} classifier copies (allowed ${allowed})`);
  if (!bake && glslFunctions(stage).has('rmClassCore')) out.push('display program carries the classifier');
  if (stage.length > caps.stageChars) out.push(`${stage.length} chars > ${caps.stageChars}`);
  if (c.chars > caps.inlinedChars) out.push(`${c.chars} inlined chars > ${caps.inlinedChars}`);
  const samplers = samplerCount(stage);
  if (samplers > SAMPLER_MAX) out.push(`${samplers} samplers > ${SAMPLER_MAX}`);
  for (const v of loopViolations(stage, defineTable(stage))) out.push(v);
  return out;
}

// ---- the concept globe: src/shaders.js strings, paired as main.js pairs them ------------------------------------------
const camelKebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const stringName = s => s.replace(/_(?:VS|FS)$/, '').toLowerCase().replace(/_/g, '-');
/** Numeric constants main.js declares with UPPER_CASE names (`const HMW = 1024, HMH = 512;`); a name bound twice to
 * different values is ambiguous and never used. */
function numericConsts(text) {
  const out = new Map(), bad = new Set();
  for (const m of text.matchAll(/(?:\b(?:const|let)\s+|,\s*)([A-Z][A-Z0-9_]*)\s*=\s*(-?\d+(?:\.\d+)?)\s*(?=[,;])/g)) {
    if (out.has(m[1]) && out.get(m[1]) !== m[2]) bad.add(m[1]); out.set(m[1], m[2]);
  }
  for (const b of bad) out.delete(b);
  return out;
}
/**
 * Every compile(vs, fs) call in main.js → a program. vs is always S.<NAME>; fs is S.<NAME> or an inline template whose
 * only interpolations are main.js numeric constants (cooked exactly as the browser cooks them). Names: globe-<fs name>
 * for module strings (TERRAIN2_FS → globe-terrain2), globe-<variable> for an inline FS (pBlit → globe-blit), or
 * globe-<enclosing function> when the variable is a bare local (readHeights → globe-read-heights). Anything else is a
 * problem, so a new shape of call fails the export instead of dropping a program.
 */
export function readGlobe(mainText, S) {
  const problems = [], programs = new Map(), consts = numericConsts(mainText);
  const sites = [...mainText.matchAll(/\bcompile\(/g)].filter(m => !/function\s+$/.test(mainText.slice(Math.max(0, m.index - 16), m.index)));
  for (const m of sites) {
    let i = m.index + m[0].length;
    const ws = () => { while (/\s/.test(mainText[i])) i++; };
    ws(); const a = /^S\.(\w+)\s*,/.exec(mainText.slice(i, i + 80));
    if (!a) { problems.push(`main.js: compile() at offset ${m.index} has no S.<NAME> vertex stage`); continue; }
    i += a[0].length; ws();
    let fsName = null, fsSrc = null;
    const b = /^S\.(\w+)\s*\)/.exec(mainText.slice(i, i + 80));
    if (b) { fsName = b[1]; fsSrc = S[fsName]; }
    else if (mainText[i] === '`') {
      const end = mainText.indexOf('`', i + 1), raw = end > 0 ? mainText.slice(i + 1, end) : null;
      if (raw == null || !/^\s*\)/.test(mainText.slice(end + 1))) { problems.push(`main.js: compile() at offset ${m.index}: unreadable inline stage`); continue; }
      if (raw.includes('\\')) { problems.push(`main.js: compile() at offset ${m.index}: an inline stage with an escape sequence`); continue; }
      let bad = null;
      fsSrc = raw.replace(/\$\{\s*([^}]*?)\s*\}/g, (_, id) => { if (!consts.has(id)) bad = id; return consts.get(id) ?? ''; });
      if (bad != null) { problems.push(`main.js: compile() at offset ${m.index}: inline stage interpolates \${${bad}}, not a numeric constant`); continue; }
    } else { problems.push(`main.js: compile() at offset ${m.index}: the fragment stage is neither S.<NAME> nor an inline template`); continue; }
    const vsSrc = S[a[1]];
    if (typeof vsSrc !== 'string' || typeof fsSrc !== 'string') { problems.push(`main.js: compile(S.${a[1]}, ${fsName ? 'S.' + fsName : 'inline'}) names no string export`); continue; }
    let name, site;
    if (fsName) { name = `globe-${stringName(fsName)}`; site = `S.${fsName}`; }
    else {
      const v = /(?:const|let)\s+(\w+)\s*=\s*$/.exec(mainText.slice(Math.max(0, m.index - 64), m.index))?.[1];
      if (v && /^p[A-Z]\w*$/.test(v)) { name = `globe-${camelKebab(v.slice(1))}`; site = v; }
      else {
        const fn = [...mainText.slice(0, m.index).matchAll(/\bfunction\s+(\w+)\s*\(/g)].pop()?.[1];
        if (!fn) { problems.push(`main.js: inline compile() at offset ${m.index} has no program variable or enclosing function`); continue; }
        name = `globe-${camelKebab(fn)}`; site = `${fn}()`;
      }
    }
    if (programs.has(name)) { problems.push(`main.js: two programs named ${name}`); continue; }
    programs.set(name, { name, site, vsName: a[1], fsName, use: fsName?.startsWith('BAKE_') ? 'bake' : 'draw', vs: vsSrc, fs: fsSrc });
  }
  if (!sites.length) problems.push('main.js: no compile() call found');
  return { programs, problems };
}

// ---- the generated Kotlin table (a pure function of index.json, so --verify can recompute it without the source) --------
const kq = v => JSON.stringify(String(v)); // names, paths and hex only: no $ or backslash can occur
function ktProgram(key, name, defines, bake, use, vs, fs) {
  const d = Object.keys(defines).sort().map(k => `${kq(k)} to ${kq(defines[k] === true ? '' : defines[k])}`);
  const st = s => `Stage(${kq(s.path)}, ${kq(s.sha256)}, ${s.chars})`;
  return `        ${kq(key)} to Program(${kq(key)}, ${kq(name)}, ${d.length ? `mapOf(${d.join(', ')})` : 'emptyMap()'}, ${bake}, ${kq(use)}, ${st(vs)}, ${st(fs)}),`;
}
/** WorldShaders.kt for a chosen pin's index.json. */
export function kotlinOf(index) {
  const realm = index.programs.map(p => ktProgram(p.vs.path.replace(/\.vs\.glsl$/, ''), p.name, p.defines, p.bake, p.bake ? 'bake' : 'draw', p.vs, p.fs));
  const globe = (index.globe ?? []).map(p => ktProgram(p.name, p.name, {}, p.use === 'bake', p.use, p.vs, p.fs));
  return Buffer.from(`// GENERATED by tools/world-shaders.mjs from world/shaders/index.json. Do not edit: re-run the exporter.
// Pin: globe-realms ${index.source.commit}. The stages ship as classpath resources
// (renderer/src/main/resources/world/shaders); drift: \`node tools/world-shaders.mjs --source <globe repo> --check\`.
package gg.pixelkingdomwars.nativeclient.renderer.generated

import java.security.MessageDigest

object WorldShaders {
    const val PIN: String = ${kq(index.source.commit)}
    const val RESOURCE_DIR: String = "world/shaders/"

    class Stage(val path: String, val sha256: String, val chars: Int)

    /**
     * key = the exported base name (name plus "+DEFINE" / "+DEFINE=value" suffixes). defines: a flag define maps to "".
     * use: "draw" or "bake" (bake = an offscreen pass: realm resolve bakes, the globe's prototype export bakes).
     */
    class Program(
        val key: String,
        val name: String,
        val defines: Map<String, String>,
        val bake: Boolean,
        val use: String,
        val vs: Stage,
        val fs: Stage,
    )

    /** The realm-map engine's programs (src/realm), preprocessed by the pin's own core.js preprocessGLSL. */
    val realm: Map<String, Program> = linkedMapOf(
${realm.join('\n')}
    )

    /**
     * The globe's programs: the shared flat globe (src/globe: globe-flat, globe-isles, globe-fx, through the realm
     * engine's own preprocessGLSL) and the concept's relief path (src/shaders.js, verbatim as main.js compiles it).
     */
    val globe: Map<String, Program> = linkedMapOf(
${globe.join('\n')}
    )

    /** The stage's exact UTF-8 text from the classpath, checked against its pinned sha256 (throws on any mismatch). */
    fun source(stage: Stage): String {
        val bytes = WorldShaders::class.java.classLoader?.getResourceAsStream(RESOURCE_DIR + stage.path)?.use { it.readBytes() }
            ?: error("world shader \${stage.path} is not on the classpath")
        val hex = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        check(hex == stage.sha256) { "world shader \${stage.path} does not match pin \$PIN" }
        return String(bytes, Charsets.UTF_8)
    }
}
`);
}

// ---- export ----------------------------------------------------------------------------------------------------------
const definesSuffix = defines => Object.keys(defines).sort().map(k => (defines[k] === true ? `+${k}` : `+${k}=${defines[k]}`)).join('');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const stageEntry = (rel, bytes, stage) => ({ path: rel, sha256: sha256(bytes), chars: stage.length, inlinedChars: inlineCost(stage, 'rmClassCore').chars });

/**
 * Export the pin. Returns { files: Map<relative path under the out dir, Buffer>, lock: object } without writing.
 * chosen = the lead's recorded reason for a final pin; without it the pin is provisional (test resources only).
 */
export async function exportShaders({ repo, pin, load, chosen = null, lanes = [] }) {
  const commit = resolvePin(repo, pin), provisional = !chosen;
  if (!pinnedPathExists(repo, commit, ENGINE)) throw new Error(`${ENGINE} is not in ${commit}`);
  const hasGlobe = pinnedPathExists(repo, commit, GLOBE_SHADERS) && pinnedPathExists(repo, commit, GLOBE_MAIN);
  const hasFlat = pinnedPathExists(repo, commit, GLOBE); // the shared flat globe (plan §4.6), src/globe/*.glsl.js
  if (!provisional && !hasGlobe) throw new Error(`A chosen pin exports the globe too, and ${GLOBE_SHADERS} or ${GLOBE_MAIN} is not in ${commit}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'world-shaders-'));
  try {
    // packages/shared/package.json carries "type": "module" for the TypeScript contracts.js imports.
    const globePaths = [...(hasGlobe ? [GLOBE_SHADERS, GLOBE_MAIN] : []), ...(hasFlat ? [GLOBE] : [])];
    extractPinned(repo, commit, [ENGINE, ...globePaths, ...SHARED.filter(p => pinnedPathExists(repo, commit, p))], tmp);
    // Its runtime dependencies (zod) resolve through the source repo's install: tooling, never GLSL bytes.
    const deps = path.join(repo, 'packages/shared/node_modules');
    if (fs.existsSync(deps) && fs.existsSync(path.join(tmp, 'packages/shared'))) fs.symlinkSync(deps, path.join(tmp, 'packages/shared/node_modules'), 'dir');
    const dir = path.join(tmp, ENGINE);
    load ??= await moduleLoader(repo);
    const core = await load(path.join(dir, 'core.js'));
    const contracts = await load(path.join(dir, 'contracts.js'));
    const { PREAMBLE } = await load(path.join(dir, 'glsl/common.glsl.js'));
    if (typeof core.preprocessGLSL !== 'function' || typeof PREAMBLE !== 'string') throw new Error('The pin exports no preprocessGLSL/PREAMBLE');
    const caps = contracts.GPU_SAFE?.shader;
    for (const k of ['stageChars', 'inlinedChars', 'classifierDisplay', 'classifierBake']) if (!Number.isFinite(caps?.[k])) throw new Error(`GPU_SAFE.shader.${k} missing at the pin`);
    const { includes, programs, problems, sources } = await readEngine(dir, load);
    if (problems.length) throw new Error(`The engine sources cannot be read:\n  ${problems.join('\n  ')}`);
    if (!programs.size) throw new Error('No program() call found at the pin');
    const laneProblems = laneVariants(programs, sources, lanes, commit);
    if (laneProblems.length) throw new Error(`The lane program lists disagree with the pin:\n  ${laneProblems.join('\n  ')}`);
    const files = new Map(), index = [], violations = [];
    for (const key of [...programs.keys()].sort()) {
      const { name, file, vs, fs: fsSrc, defines, bake, variant } = programs.get(key), base = name + definesSuffix(defines), entry = { name, defines, bake, module: file, ...(variant ? { variant } : {}) };
      if (name.startsWith('globe-')) throw new Error(`Realm program ${name} collides with the globe- prefix`);
      for (const [kind, src] of [['VS', vs], ['FS', fsSrc]]) {
        const stage = core.preprocessGLSL(src, { kind, defines, includes, name });
        for (const v of stageViolations(stage, { bake, caps })) violations.push(`${name} ${kind}: ${v}`);
        const rel = `${base}.${kind.toLowerCase()}.glsl`, bytes = Buffer.from(stage, 'utf8');
        if (files.has(rel)) throw new Error(`Two programs export ${rel}`);
        files.set(rel, bytes);
        entry[kind.toLowerCase()] = stageEntry(rel, bytes, stage);
      }
      index.push(entry);
    }
    // the globe: stages are the strings main.js hands to compile(), verbatim (no preprocess exists on that path)
    const globeIndex = [], globeSources = new Map();
    if (hasGlobe) {
      const S = await load(path.join(tmp, GLOBE_SHADERS));
      const mainBytes = fs.readFileSync(path.join(tmp, GLOBE_MAIN));
      globeSources.set(GLOBE_SHADERS, fs.readFileSync(path.join(tmp, GLOBE_SHADERS))).set(GLOBE_MAIN, mainBytes);
      const g = readGlobe(mainBytes.toString('utf8'), S);
      if (g.problems.length) throw new Error(`The globe sources cannot be read:\n  ${g.problems.join('\n  ')}`);
      for (const name of [...g.programs.keys()].sort()) {
        const p = g.programs.get(name), entry = { name, module: 'src/shaders.js', site: p.site, use: p.use, vsName: p.vsName, fsName: p.fsName };
        for (const [kind, stage] of [['VS', p.vs], ['FS', p.fs]]) {
          for (const v of stageViolations(stage, { bake: false, caps })) violations.push(`${name} ${kind}: ${v}`);
          const rel = `${name}.${kind.toLowerCase()}.glsl`, bytes = Buffer.from(stage, 'utf8');
          files.set(rel, bytes);
          entry[kind.toLowerCase()] = stageEntry(rel, bytes, stage);
        }
        globeIndex.push(entry);
      }
    }
    // the shared flat globe: GLOBE_PROGRAMS through the realm engine's own preprocessGLSL, with GLOBE_INCLUDES as includes
    const flatModules = [];
    if (hasFlat) {
      const gdir = path.join(tmp, GLOBE), found = [];
      for (const f of fs.readdirSync(gdir).filter(f => f.endsWith('.glsl.js')).sort()) {
        const bytes = fs.readFileSync(path.join(gdir, f)), m = await load(path.join(gdir, f));
        globeSources.set(`${GLOBE}/${f}`, bytes);
        if (m.GLOBE_PROGRAMS !== undefined || m.GLOBE_INCLUDES !== undefined) found.push([f, m]);
      }
      if (!found.length) throw new Error(`${GLOBE} has no module exporting GLOBE_PROGRAMS: the exporter cannot tell its programs`);
      for (const [f, m] of found) {
        if (!Array.isArray(m.GLOBE_PROGRAMS) || !m.GLOBE_PROGRAMS.length) throw new Error(`${GLOBE}/${f}: GLOBE_PROGRAMS is not a non-empty list`);
        const inc = new Map(Object.entries(m.GLOBE_INCLUDES ?? {}).map(([k, id]) => {
          if (typeof m[id] !== 'string') throw new Error(`${GLOBE}/${f}: include ${k} names ${id}, not a string export`);
          return [k, m[id]];
        }));
        flatModules.push(`src/globe/${f}`);
        for (const { name, vs, fs: fsName, ...rest } of m.GLOBE_PROGRAMS) {
          if (!/^globe-[\w-]+$/.test(name ?? '') || Object.keys(rest).length) throw new Error(`${GLOBE}/${f}: program ${JSON.stringify(name)} is not { name: 'globe-…', vs, fs }`);
          if (globeIndex.some(e => e.name === name)) throw new Error(`Two globe programs named ${name}`);
          const entry = { name, module: `src/globe/${f}`, site: 'GLOBE_PROGRAMS', use: 'draw', vsName: vs, fsName };
          for (const [kind, id] of [['VS', vs], ['FS', fsName]]) {
            if (typeof m[id] !== 'string') throw new Error(`${GLOBE}/${f}: ${name} ${kind} names ${id}, not a string export`);
            const stage = core.preprocessGLSL(m[id], { kind, defines: {}, includes: inc, name });
            for (const v of stageViolations(stage, { bake: false, caps })) violations.push(`${name} ${kind}: ${v}`);
            const rel = `${name}.${kind.toLowerCase()}.glsl`, bytes = Buffer.from(stage, 'utf8');
            if (files.has(rel)) throw new Error(`Two programs export ${rel}`);
            files.set(rel, bytes);
            entry[kind.toLowerCase()] = stageEntry(rel, bytes, stage);
          }
          globeIndex.push(entry);
        }
      }
      globeIndex.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }
    if (violations.length) throw new Error(`Shader rules failed:\n  ${violations.join('\n  ')}`);
    // the pack manifest committed AT the pin ties the content bytes to this pin (plan §6.1)
    let contentManifest = null;
    if (pinnedPathExists(repo, commit, PACK_MANIFEST)) {
      const bytes = git(repo, ['show', `${commit}:${PACK_MANIFEST}`]), m = JSON.parse(bytes.toString('utf8'));
      contentManifest = { path: PACK_MANIFEST, sha256: sha256(bytes), packVersion: m.packVersion, files: m.totals?.files, bytes: m.totals?.bytes };
    }
    const rules = { ...caps, loopMax: LOOP_MAX, samplerMax: SAMPLER_MAX };
    const source = { commit, engine: ENGINE, globe: hasGlobe || hasFlat ? { module: hasGlobe ? GLOBE_SHADERS : null, programsFrom: hasGlobe ? GLOBE_MAIN : null, flat: flatModules, status: 'exported' } : { path: GLOBE, status: 'absent-at-pin' } };
    files.set('index.json', json({ schema: 2, provisional, source, preambleSha256: sha256(PREAMBLE), rules, programs: index, globe: globeIndex }));
    const allSources = [...[...sources].map(([k, v]) => [`${ENGINE}/${k}`, v]), ...globeSources];
    const lock = {
      schema: 2,
      provisional,
      ...(provisional ? { provisionalReason: PROVISIONAL_REASON } : { chosenReason: chosen }),
      source: { ...source, repository: 'SHARDKEEP globe-realms' },
      contentManifest,
      ...(contentManifest ? {} : { contentManifestNote: `No ${PACK_MANIFEST} at the pin (plan §6.1): content export stays blocked.` }),
      preprocess: 'realm: preprocessGLSL imported from the pinned core.js (PREAMBLE + REALM_<kind> + defines + #include); globe: the src/shaders.js strings main.js passes to compile(), verbatim',
      preambleSha256: sha256(PREAMBLE),
      rules,
      ...(lanes.length ? { laneLists: Object.fromEntries(lanes.map(l => [l.path, l.sha256])) } : {}),
      out: provisional ? OUT_DIR : MAIN_OUT_DIR,
      sources: Object.fromEntries(allSources.sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sha256(v)])),
      stages: Object.fromEntries([...files].filter(([k]) => k !== 'index.json').sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sha256(v)])),
    };
    return { files, lock, kotlin: provisional ? null : kotlinOf(JSON.parse(files.get('index.json'))) };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** A provisional pin writes only into a src/test/resources path; a chosen pin into src/main or src/test resources. */
function checkedOut(root, out, provisional) {
  const rel = path.relative(root, path.resolve(root, out)).split(path.sep).join('/');
  if (rel.startsWith('..')) throw new Error(`The export directory ${rel} is outside the repository`);
  if (provisional && !/(^|\/)src\/test\/resources(\/|$)/.test(rel)) throw new Error(`A provisional pin exports only into a src/test/resources path, not ${rel}`);
  if (!provisional && !/(^|\/)src\/(?:main|test)\/resources(\/|$)/.test(rel)) throw new Error(`A chosen pin exports only into a src/{main,test}/resources path, not ${rel}`);
  return path.resolve(root, out);
}
const lockBytes = (root, dir, lock) => json({ ...lock, out: path.relative(root, dir).split(path.sep).join('/') });
/** Write the export; a previous export in another directory (the lock's old out) is removed, so one copy exists. */
export function writeExport(root, out, { files, lock, kotlin = null }) {
  const dir = checkedOut(root, out, lock.provisional);
  const lockPath = path.join(root, LOCK_FILE);
  if (fs.existsSync(lockPath)) {
    try {
      const old = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      const oldDir = old.out ? checkedOut(root, old.out, old.provisional !== false) : null;
      if (oldDir && oldDir !== dir) fs.rmSync(oldDir, { recursive: true, force: true });
    } catch { /* an unreadable old lock names nothing to remove */ }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, bytes] of files) fs.writeFileSync(path.join(dir, rel), bytes);
  const kt = path.join(root, KOTLIN_FILE);
  if (kotlin) { fs.mkdirSync(path.dirname(kt), { recursive: true }); fs.writeFileSync(kt, kotlin); } else fs.rmSync(kt, { force: true });
  fs.writeFileSync(lockPath, lockBytes(root, dir, lock));
}
/** Drift between a fresh export and the committed files (empty = no drift). */
export function compareExport(root, out, { files, lock, kotlin = null }) {
  const dir = checkedOut(root, out, lock.provisional), drift = [];
  const present = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  for (const [rel, bytes] of files) {
    const p = path.join(dir, rel);
    if (!fs.existsSync(p)) drift.push(`missing ${rel}`); else if (!fs.readFileSync(p).equals(bytes)) drift.push(`changed ${rel}`);
  }
  for (const f of present) if (!files.has(f)) drift.push(`extra ${f}`);
  const kt = path.join(root, KOTLIN_FILE);
  if (kotlin && !fs.existsSync(kt)) drift.push(`missing ${KOTLIN_FILE}`);
  else if (kotlin && !fs.readFileSync(kt).equals(kotlin)) drift.push(`changed ${KOTLIN_FILE}`);
  else if (!kotlin && fs.existsSync(kt)) drift.push(`extra ${KOTLIN_FILE} (a provisional pin generates no Kotlin)`);
  const lockPath = path.join(root, LOCK_FILE);
  if (!fs.existsSync(lockPath)) drift.push(`missing ${LOCK_FILE}`); else if (!fs.readFileSync(lockPath).equals(lockBytes(root, dir, lock))) drift.push(`changed ${LOCK_FILE}`);
  return drift;
}
/** Source-free integrity: every committed stage matches the lock and the index, and nothing is unlisted. */
export function verifyCommitted(root) {
  const lockPath = path.join(root, LOCK_FILE), problems = [];
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const provisional = lock.provisional !== false;
  const dir = checkedOut(root, lock.out, provisional);
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  if (index.provisional !== lock.provisional) problems.push('index and lock disagree on provisional');
  if (!provisional && !(typeof lock.chosenReason === 'string' && lock.chosenReason.trim())) problems.push('a chosen pin records no chosenReason');
  if (index.source?.commit !== lock.source?.commit || !/^[0-9a-f]{40}$/.test(lock.source?.commit ?? '')) problems.push('index and lock name different pins');
  const listed = new Set(['index.json']);
  for (const p of [...index.programs, ...(index.globe ?? [])]) for (const kind of ['vs', 'fs']) {
    const { path: rel, sha256: want } = p[kind]; listed.add(rel);
    const file = path.join(dir, rel);
    if (!fs.existsSync(file)) { problems.push(`missing ${rel}`); continue; }
    const got = sha256(fs.readFileSync(file));
    if (got !== want || lock.stages[rel] !== want) problems.push(`hash mismatch ${rel}`);
  }
  for (const rel of Object.keys(lock.stages)) if (!listed.has(rel)) problems.push(`lock lists ${rel}, the index does not`);
  for (const f of fs.readdirSync(dir)) if (!listed.has(f)) problems.push(`unlisted file ${f}`);
  for (const [rel, want] of Object.entries(lock.laneLists ?? {})) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p) || sha256(fs.readFileSync(p)) !== want) problems.push(`${rel} changed since the export: re-run the exporter`);
  }
  const kt = path.join(root, KOTLIN_FILE);
  if (!provisional && (!fs.existsSync(kt) || !fs.readFileSync(kt).equals(kotlinOf(index)))) problems.push(`${KOTLIN_FILE} is not the table of this index`);
  if (provisional && fs.existsSync(kt)) problems.push(`${KOTLIN_FILE} exists for a provisional pin`);
  return { lock, index, problems };
}

async function main(argv) {
  const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const root = path.resolve(opt('--root') ?? ROOT);
  const label = lock => (lock.provisional !== false ? 'provisional pin' : 'pin');
  if (argv.includes('--verify')) {
    const { problems, index, lock } = verifyCommitted(root);
    if (problems.length) { console.error(problems.join('\n')); return 1; }
    console.log(`world shaders: ${index.programs.length} realm + ${(index.globe ?? []).length} globe programs verified against ${LOCK_FILE} (${label(lock)} ${index.source.commit.slice(0, 8)})`);
    return 0;
  }
  const repo = opt('--source') ?? process.env.PKW_GLOBE_SOURCE;
  if (!repo) throw new Error('Pass --source <SHARDKEEP-globe repo> (or PKW_GLOBE_SOURCE)');
  const check = argv.includes('--check');
  const lockPath = path.join(root, LOCK_FILE);
  const locked = check ? JSON.parse(fs.readFileSync(lockPath, 'utf8')) : null;
  const pin = check ? locked.source.commit : opt('--pin');
  const chosen = check ? (locked.provisional === false ? locked.chosenReason : null) : (opt('--chosen') ?? null);
  const result = await exportShaders({ repo: path.resolve(repo), pin, chosen, lanes: readLaneLists(root) });
  const out = opt('--out') ?? (check ? locked.out : result.lock.out);
  if (check) {
    const drift = compareExport(root, out, result);
    if (drift.length) { console.error(`world shaders drift against ${pin}:\n  ${drift.join('\n  ')}`); return 1; }
    console.log(`world shaders: no drift (${result.files.size - 1} stages, ${label(result.lock)} ${pin.slice(0, 8)})`);
    return 0;
  }
  writeExport(root, out, result);
  console.log(`world shaders: exported ${result.files.size - 1} stages from ${label(result.lock)} ${result.lock.source.commit} into ${out}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { console.error(e.message); process.exitCode = 1; });
}
