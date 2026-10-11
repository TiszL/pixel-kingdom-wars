import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Export the canonical pure ocean field rather than reimplementing its noise on a device. */
export async function buildGlobePresentation({ source, readFile, addFile }) {
  const runtime = 'apps/web/src/ui/fantasy/runtime/';
  const load = relative => import(pathToFileURL(path.join(source, relative)).href);
  const ts = (await load('scripts/node_modules/typescript/lib/typescript.js')).default;
  async function declarations(file, names) {
    const text = await readFile(path.join(source, runtime, file), 'utf8');
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true), result = {};
    for (const statement of ast.statements) if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const name = declaration.name.getText(ast);
        if (names.includes(name) && declaration.initializer) result[name] = new Function(`return (${declaration.initializer.getText(ast)});`)();
      }
    }
    if (names.some(name => result[name] === undefined)) throw Error(`Globe presentation changed: ${file}`);
    return result;
  }
  const world = await load(`${runtime}world.mjs`);
  const shapes = await load(`${runtime}island-shapes.mjs`);
  const { W: width, H: height, stops } = await declarations('ocean-detail.mjs', ['W', 'H', 'stops']);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width * height > 65536 || stops.length !== 4) throw Error('Globe ocean layout changed');
  const depthPath = 'atlas/fantasy/globe/native-ocean-depth.rgba';
  const bytes = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    bytes.writeFloatBE(world.originalOceanHeight((x + .5) / width * world.TAU - Math.PI, Math.PI / 2 - (y + .5) / height * Math.PI), (y * width + x) * 4);
  }
  await addFile(depthPath, bytes);
  const { BANKS: banks, BW: bankWidth, BH: bankHeight } = await declarations('clouds.mjs', ['BANKS', 'BW', 'BH']);
  if (banks.length !== 3 || banks.some(bank => bank.length !== 4)) throw Error('Globe cloud layout changed');
  // Golden colours include the dateline and poles, where a clamped colour texture would drift.
  const { sampleOceanColor } = await load(`${runtime}ocean-detail.mjs`);
  const vectors = [[-180, 90], [180, -90], [-179.99, 4], [179.99, 4], [0, 0], [-115, 38], [26, 23]]
    .map(([lon, lat]) => ({ lon, lat, rgb: sampleOceanColor(lon * world.RAD, lat * world.RAD) }));
  const { effectAnchors } = await load(`${runtime}island-effects.mjs`);
  const effectsPath = 'atlas/fantasy/globe/native-island-effects.json';
  if (effectAnchors.length !== world.ARCHIPELAGOS.reduce((n, chain) => n + chain.islands.length, 0)) throw Error('Globe feature site layout changed');
  await addFile(effectsPath, Buffer.from(JSON.stringify(effectAnchors)));
  return {
    effectsPath,
    islands: { cell: shapes.ISLAND_CELL, atlas: shapes.ISLAND_ATLAS, extent: shapes.ISLAND_EXTENT },
    ocean: { path: depthPath, width, height, encoding: 'ieee754-float32-big-endian-rgba', stops, vectors },
    clouds: { banks, bankWidth, bankHeight, path: 'atlas/fantasy/globe/generated/cloud-banks.png' },
  };
}
