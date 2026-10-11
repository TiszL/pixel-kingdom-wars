// Test-only reference: execute the unchanged canonical coin scenario and web controllers.
// This writes no pack, art, simulator input or gameplay configuration.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { captureImageSweeps } from './combat-catalog.mjs';

export async function heroCoinReference(source) {
  const load = (relative) => import(pathToFileURL(path.join(source, relative)).href);
  const { register } = await load('scripts/node_modules/tsx/dist/esm/api/index.mjs');
  // This standalone test capture owns one scope. Re-registering for each import
  // multiplies async Node22 hooks and stalls the final shared-barrel dependency.
  const scope = register({ namespace: `hero-coin-reference-${randomUUID()}` });
  const typed = (relative) => scope.import(pathToFileURL(path.join(source, relative)).href, import.meta.url);
  try {
  const ts = (await load('scripts/node_modules/typescript/lib/typescript.js')).default;
  const shared = await typed('packages/shared/src/index.ts');
  const { simulateRaid } = await typed('packages/sim/src/sim.ts');
  const { SIM_VERSION } = await typed('packages/sim/src/version.ts');
  const { TICKS_PER_SEC } = await typed('packages/sim/src/stats.ts');
  const helpers = await typed('packages/sim/tests/helpers.ts');
  const depth = await typed('apps/web/src/game/world/depth.ts');
  const texts = {};
  const read = async (relative) => texts[relative] = await readFile(path.join(source, relative), 'utf8');
  const parse = (text) => ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true);
  const compile = (code, bindings = {}) => new Function(...Object.keys(bindings), ts.transpile(code,
    { target: ts.ScriptTarget.ES2022 }))(...Object.values(bindings));
  const testAst = parse(await read('packages/sim/tests/hero-skills.test.ts'));
  const coinSuite = testAst.statements.find((node) => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(testAst) === 'describe'
    && node.expression.arguments[0]?.text?.startsWith('DOUBLE OR NOTHING'))?.expression.arguments[1];
  if (!coinSuite || !ts.isArrowFunction(coinSuite)) throw new Error('Missing canonical coin scenario');
  const declarations = (scope) => scope.statements.flatMap((node) => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : []);
  const declaration = (scope, name) => {
    const node = declarations(scope).find((node) => node.name.getText(testAst) === name);
    if (!node?.initializer) throw new Error(`Missing canonical coin fixture ${name}`);
    return node.initializer.getText(testAst);
  };
  const run = compile(`const drop = ${declaration(testAst, 'drop')}; const scenario = ${declaration(coinSuite.body, 'scenario')};
    return (${declaration(coinSuite.body, 'run')});`, { ...shared, ...helpers, simulateRaid });
  // Read the two existing assertions' run inputs, so the native fixture owns no level or RNG tuning.
  const inputs = {};
  const findInputs = (node) => {
    if (ts.isVariableDeclaration(node) && ['heads', 'tails'].includes(node.name.getText(testAst))
      && node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(testAst) === 'run') {
      inputs[node.name.getText(testAst)] = node.initializer.arguments.map((arg) => {
        if (!ts.isNumericLiteral(arg)) throw new Error('Canonical coin scenario input is no longer literal');
        return Number(arg.text);
      });
    }
    ts.forEachChild(node, findInputs);
  };
  findInputs(coinSuite);
  const method = (text, className, name) => {
    const ast = parse(text);
    const owner = ast.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === className);
    const fn = owner?.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(ast) === name);
    if (!fn) throw new Error(`Missing canonical ${className}.${name}`);
    return fn.getText(ast).replace(/^(?:private|protected|public)\s+/, '');
  };
  const body = compile(`function ${method(await read('apps/web/src/game/fx/troop.ts'), 'TroopFx', 'onHeroSkill')}; return onHeroSkill;`,
    { HERO_SKILLS: shared.HERO_SKILLS });
  const battleText = await read('apps/web/src/game/scenes/BattleScene.ts');
  const battleAst = parse(battleText);
  const bodyUntilNode = battleAst.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'heroSkillBodyUntilTick');
  if (!bodyUntilNode) throw new Error('Missing canonical hero clock');
  const bodyUntil = compile(`${bodyUntilNode.getText(battleAst).replace(/^export\s+/, '')}; return heroSkillBodyUntilTick;`);
  const effects = compile(`function ${method(battleText, 'BattleScene', 'onHeroSkill')}; return onHeroSkill;`, {
    ...depth, TICK_MS: 1000 / TICKS_PER_SEC, heroSkillBodyUntilTick: bodyUntil,
    BattleScene: { prototype: { applyHeroSkillState() {}, ownTransientFx: (image) => image, destroyTransientFx: (image) => image.destroy() } },
  });
  const cases = ['heads', 'tails'].map((face) => {
    if (inputs[face]?.length !== 2) throw new Error(`Missing canonical ${face} input`);
    const result = run(...inputs[face]);
    const coins = result.events.filter((event) => event.e === 'heroSkill' && event.skill.startsWith('doubleOrNothing'));
    if (coins.length !== 1 || coins[0].phase !== face) throw new Error(`Canonical ${face} scenario no longer emits exactly that face`);
    const coin = coins[0];
    // Retain original ordering/bytes of the actor's positional prefix and same-tick death.
    // Other attacks and skills are deliberately excluded to isolate this visual cue.
    const events = result.events.filter((event) => event.id === coin.id && event.t <= coin.t && (
      ['deploy', 'pos'].includes(event.e) || event === coin || event.e === 'troopDeath' && event.t === coin.t));
    const bodyAt = (state) => {
      let captured = null;
      body.call({ skin: 'hero_vex', state, heroLocked: false, named: (base, count) => Array.from({ length: count }, (_, i) => `${base}_f${i + 1}`),
        playHeroBody: (frames, lockMs, priority, once) => { captured = { frames, lockMs, priority, once }; } },
      coin.skill, coin.phase, (bodyUntil(coin) - coin.t) * 1000 / TICKS_PER_SEC);
      return captured;
    };
    const sweeps = captureImageSweeps((scene) => effects.call({ ...scene, jumping: false, ux: (n) => n, uy: (n) => n,
      troops: new Map() }, coin));
    return { face, input: inputs[face], events, body: bodyAt('idle'), bodyAfterDeath: bodyAt('dying'), sweeps };
  });
  await read('packages/sim/src/sim.ts');
  await read('packages/sim/tests/helpers.ts');
  await read('packages/shared/src/constants.ts');
  return { sourceCommit: execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceHashes: Object.fromEntries(Object.entries(texts).map(([file, text]) => [file, createHash('sha256').update(text).digest('hex')])),
    simVersion: SIM_VERSION, tickMs: 1000 / TICKS_PER_SEC, cases };
  } finally { await scope.unregister(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = path.resolve(process.argv[2]), output = path.resolve(process.argv[3]);
  const reference = await heroCoinReference(source);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(reference, null, 2) + '\n');
  console.log(`Wrote ${reference.cases.length} actual simulator coin cases from ${reference.sourceCommit}`);
}
