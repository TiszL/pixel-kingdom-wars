#!/usr/bin/env node
// The N5 release audit (D-NEXT: the GL30 world runs in release, its content bundled in every APK). A debug build proves
// none of this: only the R8-shrunk release APK shows what reaches players. Every failure below is silent on a device:
// the world falls back to the legacy globe, or the realm maps stay at the overview, and release logs nothing.
//
//   node tools/check-release-world.mjs app/build/outputs/apk/release/app-release-unsigned.apk \
//        app/build/outputs/mapping/release/mapping.txt
//
// Checks: (1) assets/world/content.json and every file it lists, at its size and sha256 (the app checks each at load);
// (2) every world shader stage WorldShaders.kt pins, on the classpath path it opens, at its sha256 (a miss throws, and
// the engine falls back); (3) every class that opens a resource by a name relative to its own package kept its name,
// and the resource sits in that package (R8 renames packages); (4) no debug-only world activity in the manifest;
// (5) no PKWWorldGL tag in the dex: WorldLog is off in release, so R8 removes the only code that writes it.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MAIN_SOURCES = ['app/src/main', 'renderer/src/main', 'network/src/main', 'content/src/main', 'wallet/src/main'];
export const RULES = 'app/proguard-rules.pro';
export const WORLD_SHADERS = 'renderer/src/main/kotlin/gg/pixelkingdomwars/nativeclient/renderer/generated/WorldShaders.kt';
export const DEBUG_ONLY_ACTIVITIES = ['DeviceProbeActivity', 'WorldEngineSmokeActivity'];
export const WORLD_TAG = 'PKWWorldGL';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function* walk(dir) {
  for (const d of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) yield* walk(p); else yield p;
  }
}

/** Every `X::class.java.getResource[AsStream](name)` in main Kotlin whose name (a literal or a `const val` of the same
 *  file) is relative: the platform resolves it against X's runtime package, which R8 renames unless X keeps its name. */
export function relativeResourceLookups(root = ROOT) {
  const out = [];
  for (const dir of MAIN_SOURCES) for (const file of walk(path.join(root, dir))) {
    if (!file.endsWith('.kt')) continue;
    const text = fs.readFileSync(file, 'utf8'); const rel = path.relative(root, file);
    for (const m of text.matchAll(/\b(\w+)::class\.java\.getResource(?:AsStream)?\(\s*(?:"([^"]*)"|(\w+))\s*\)/g)) {
      const name = m[2] ?? new RegExp(`const val ${m[3]}(?:: String)? = "([^"]*)"`).exec(text)?.[1];
      if (name === undefined) throw new Error(`${rel}: cannot resolve the resource name ${m[3]}`);
      if (name.startsWith('/')) continue;
      const pkg = /^package ([\w.]+)/m.exec(text)?.[1];
      if (!pkg || !new RegExp(`^(?:\\w+ )*(?:class|object) ${m[1]}\\b`, 'm').test(text)) {
        throw new Error(`${rel}: ${m[1]} is not a top-level class of this file, so its binary name is unknown`);
      }
      out.push({ file: rel, className: `${pkg}.${m[1]}`, path: `${pkg.replaceAll('.', '/')}/${name}` });
    }
  }
  return out;
}

/** Classes whose names a rule keeps (-keepnames, or -keep without allowobfuscation). */
export function keptNames(rules) {
  const active = rules.split('\n').filter(line => !line.trim().startsWith('#')).join('\n');
  return new Set([...active.matchAll(/^-keep(?:names)?((?:,\w+)*)\s+class\s+([\w.$]+)/gm)]
    .filter(m => !m[1].includes('allowobfuscation')).map(m => m[2]));
}

/** `name -> compiled` from an R8 mapping for each name that R8 renamed or removed. */
export function renamedClasses(mapping, names) {
  return names.flatMap(name => {
    const at = mapping.indexOf(`\n${name} -> `);
    const compiled = at < 0 ? 'absent' : mapping.slice(at + name.length + 5, mapping.indexOf(':', at + name.length + 5));
    return compiled === name ? [] : [`${name} -> ${compiled}`];
  });
}

/** The stages WorldShaders.kt pins: `Stage("path", "sha256", chars)`. */
export const shaderStages = source => [...source.matchAll(/Stage\("([^"]+)", "([0-9a-f]{64})", \d+\)/g)].map(m => ({ path: m[1], sha256: m[2] }));

/** Problems of the APK's files (apk path -> { size, sha256 }) against wanted { path, bytes?, sha256 } entries. */
export function fileProblems(want, files, prefix) {
  if (want.length === 0) return [`${prefix}: nothing listed`];
  return want.flatMap(({ path: p, bytes, sha256: sha }) => {
    const got = files.get(prefix + p);
    if (!got) return [`missing ${prefix}${p}`];
    if (bytes !== undefined && got.size !== bytes) return [`size ${prefix}${p}: ${got.size}, listed ${bytes}`];
    return got.sha256 === sha.toLowerCase() ? [] : [`sha256 ${prefix}${p} differs from its pin`];
  });
}

/** The world content's problems: assets/world/content.json and every file it lists, from the APK's files. An APK without
 *  the bundle (a CI build made with -PpkwWorldContent=absent-ci) fails here whatever else it carries: it must never ship. */
export function worldContentProblems(indexBytes, files) {
  const index = indexBytes ? JSON.parse(indexBytes) : { files: [] };
  return [...(indexBytes ? [] : ['missing assets/world/content.json']), ...fileProblems(index.files, files, 'assets/world/')];
}

export const manifestProblems = manifest => DEBUG_ONLY_ACTIVITIES.filter(a => manifest.includes(a)).map(a => `release manifest declares ${a}`);
export const dexProblems = dexes => dexes.some(d => d.includes(WORLD_TAG))
  ? [`release dex carries the ${WORLD_TAG} tag: a world log line is reachable in release (WorldLog must be off there)`] : [];

/** The APK's entries from its central directory (APKs are never zip64): name -> { size, csize, method, offset }. */
export function zipEntries(fd) {
  const { size } = fs.fstatSync(fd); const len = Math.min(size, 65557);
  const tail = Buffer.alloc(len); fs.readSync(fd, tail, 0, len, size - len);
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip: no end of central directory');
  const cd = Buffer.alloc(tail.readUInt32LE(eocd + 12)); fs.readSync(fd, cd, 0, cd.length, tail.readUInt32LE(eocd + 16));
  const entries = new Map();
  for (let p = 0, i = 0, n = tail.readUInt16LE(eocd + 10); i < n; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
    const nameLen = cd.readUInt16LE(p + 28);
    entries.set(cd.toString('utf8', p + 46, p + 46 + nameLen),
      { method: cd.readUInt16LE(p + 10), csize: cd.readUInt32LE(p + 20), size: cd.readUInt32LE(p + 24), offset: cd.readUInt32LE(p + 42) });
    p += 46 + nameLen + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32);
  }
  return entries;
}

export function readEntry(fd, entry) {
  const head = Buffer.alloc(30); fs.readSync(fd, head, 0, 30, entry.offset);
  const raw = Buffer.alloc(entry.csize); fs.readSync(fd, raw, 0, entry.csize, entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28));
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`unsupported zip method ${entry.method}`);
}

function main(args) {
  if (args.length !== 2) throw new Error('Usage: node tools/check-release-world.mjs RELEASE_APK R8_MAPPING');
  const [apk, mappingFile] = args.map(arg => path.resolve(arg));
  const fd = fs.openSync(apk, 'r'); const entries = zipEntries(fd);
  const files = new Map(); const read = name => entries.has(name) ? readEntry(fd, entries.get(name)) : null;
  for (const name of entries.keys()) if (name.startsWith('assets/world/') || name.startsWith('world/shaders/')) {
    const bytes = read(name); files.set(name, { size: bytes.length, sha256: sha256(bytes) });
  }
  const indexBytes = read('assets/world/content.json');
  const index = indexBytes ? JSON.parse(indexBytes) : { files: [] };
  const stages = shaderStages(fs.readFileSync(path.join(ROOT, WORLD_SHADERS), 'utf8'));
  const lookups = relativeResourceLookups();
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? path.join(homedir(), '.bubblewrap/android_sdk');
  const java = process.env.JAVA_HOME ?? path.join(homedir(), '.bubblewrap/jdk/jdk-17.0.11+9/Contents/Home');
  const manifest = execFileSync(path.join(sdk, 'cmdline-tools/latest/bin/apkanalyzer'), ['manifest', 'print', apk],
    { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, JAVA_HOME: java } });
  const problems = [
    ...worldContentProblems(indexBytes, files),
    ...fileProblems(stages, files, 'world/shaders/'),
    ...renamedClasses(fs.readFileSync(mappingFile, 'utf8'), lookups.map(l => l.className)).map(r => `relative resource lookup renamed by R8: ${r}`),
    ...lookups.filter(l => !entries.has(l.path)).map(l => `missing ${l.path} (${l.file})`),
    ...manifestProblems(manifest),
    ...dexProblems([...entries.keys()].filter(n => /^classes\d*\.dex$/.test(n)).map(read)),
  ];
  fs.closeSync(fd);
  if (problems.length) throw new Error(`release world audit failed (${problems.length}):\n  ${problems.join('\n  ')}`);
  console.log(JSON.stringify({ apk, apkBytes: fs.statSync(apk).size, worldFiles: index.files.length, shaderStages: stages.length,
    relativeResources: lookups.map(l => l.path), releaseWorldAudit: 'passed' }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
