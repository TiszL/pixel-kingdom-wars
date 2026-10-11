#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Pools obtains both types through ReflectionPool, including constructors that R8
// cannot discover from ordinary call sites. A debug build cannot verify this.
export const REFLECTED_GDX_CLASSES = [
  'com.badlogic.gdx.graphics.g2d.GlyphLayout',
  'com.badlogic.gdx.graphics.g2d.GlyphLayout$GlyphRun',
];

export function reflectedClassNames(mapping) {
  return REFLECTED_GDX_CLASSES.map((original) => {
    const matches = [...mapping.matchAll(/^(\S+) -> ([\w.$]+):\r?$/gm)]
      .filter((match) => match[1] === original);
    if (matches.length !== 1) throw new Error(`${original}: expected one R8 class mapping`);
    return { original, compiled: matches[0][2] };
  });
}

export function assertReflectiveConstruction(disassembly, compiled) {
  const descriptor = `L${compiled.replaceAll('.', '/')};`;
  const declarations = [...disassembly.matchAll(/^\.class\s+([^\r\n]+)$/gm)]
    .map((match) => match[1].trim().split(/\s+/));
  if (declarations.length !== 1 || declarations[0].at(-1) !== descriptor) {
    throw new Error(`${compiled}: class missing or unexpected DEX declaration`);
  }
  const flags = declarations[0].slice(0, -1);
  if (!flags.includes('public') || flags.includes('abstract') || flags.includes('interface')) {
    throw new Error(`${compiled}: reflection requires a public concrete class`);
  }
  const constructors = [...disassembly.matchAll(/^\.method\s+([^\r\n]+)$/gm)]
    .map((match) => match[1].trim().split(/\s+/))
    .filter((parts) => parts.at(-1) === '<init>()V');
  if (constructors.length !== 1 || !constructors[0].includes('public') ||
      !constructors[0].includes('constructor') ||
      constructors[0].some((flag) => ['abstract', 'static', 'native'].includes(flag))) {
    throw new Error(`${compiled}: ReflectionPool requires a public no-argument constructor in DEX`);
  }
}

function main(args) {
  if (args.length !== 2) throw new Error('Usage: node tools/check-gdx-reflection.mjs APK R8_MAPPING');
  const [apk, mapping] = args.map((arg) => path.resolve(arg));
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? path.join(homedir(), '.bubblewrap/android_sdk');
  const java = process.env.JAVA_HOME ?? path.join(homedir(), '.bubblewrap/jdk/jdk-17.0.11+9/Contents/Home');
  const analyzer = path.join(sdk, 'cmdline-tools/latest/bin/apkanalyzer');
  const classes = reflectedClassNames(readFileSync(mapping, 'utf8'));
  for (const { original, compiled } of classes) {
    const dex = execFileSync(analyzer, ['dex', 'code', '--class', compiled, apk], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, JAVA_HOME: java },
    });
    try { assertReflectiveConstruction(dex, compiled); }
    catch (error) { throw new Error(`${original}: ${error.message}`); }
  }
  console.log(JSON.stringify({ apk, mapping, reflectedGdxConstructors: 'passed', classes }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
