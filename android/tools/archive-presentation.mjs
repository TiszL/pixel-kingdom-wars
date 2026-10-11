import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {captureLegacyMelee} from './archive-legacy.mjs';
import {captureFacing8StablePlan} from './combat-catalog.mjs';

/** The archived compatibility boundary comes from the current web dispatcher, never a live protocol grant. */
export async function captureArchivePresentation(source,currentSimVersion) {
  const ts=(await import(pathToFileURL(path.join(source,'scripts/node_modules/typescript/lib/typescript.js')).href)).default;
  const files=['apps/web/src/game/scenes/BattleScene.ts','apps/web/src/game/v2/troop.ts','apps/web/src/game/v2/clips.ts','packages/sim/src/version.ts','packages/shared/src/constants.ts'];
  const texts=await Promise.all(files.map(file=>readFile(path.join(source,file),'utf8')));
  const ast=texts.map((text,index)=>ts.createSourceFile(files[index],text,ts.ScriptTarget.Latest,true));
  const variable=(file,name)=>{const declaration=file.statements.filter(ts.isVariableStatement).flatMap(s=>[...s.declarationList.declarations]).find(n=>n.name.getText(file)===name);
    if(!declaration?.initializer)throw new Error(`Missing archive source ${name}`);return declaration.initializer.getText(file);};
  const compile=(text,bindings={})=>new Function(...Object.keys(bindings),ts.transpile(text,{target:ts.ScriptTarget.ES2022}))(...Object.values(bindings));
  const selfDescribing=compile(`return ${variable(ast[0],'SELF_DESCRIBING_MELEE_SIM_VERSION')};`);
  const targetAware=compile(`return ${variable(ast[0],'TARGET_AWARE_MELEE_SIM_VERSION')};`);
  const profiles=compile(`return ${variable(ast[1],'V2_TROOP_PROFILES')};`);
  const scene=ast[0].statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='BattleScene');
  const playback=scene?.members.find(n=>ts.isMethodDeclaration(n)&&n.name.getText(ast[0])==='startPlayback');
  const mode=playback?.body.statements.find(n=>ts.isIfStatement(n)&&n.expression.getText(ast[0]).includes('SELF_DESCRIBING_MELEE_SIM_VERSION'));
  if(!mode)throw new Error('Source archived melee ownership changed');
  const ownership=compile(`const SELF_DESCRIBING_MELEE_SIM_VERSION=${selfDescribing},TARGET_AWARE_MELEE_SIM_VERSION=${targetAware};return function(events,simVersion){${mode.getText(ast[0])}};`,{v2TroopProfile:type=>profiles[type]});
  const events=[{e:'deploy',id:1,troop:'giant'},{e:'deploy',id:2,troop:'troll'},{e:'deploy',id:3,troop:'giant',hero:'theodor'},
    {e:'troopSpawn',id:4,troop:'barrowling'},{e:'troopAttack',id:5},{e:'spawn',id:6,troop:'giant'}];
  const cases=[...new Set([targetAware-1,targetAware,selfDescribing-1,selfDescribing,currentSimVersion])].map(sim=>{
    const owner={meleeDrivenIds:new Set()};ownership.call(owner,events,sim);return {simVersion:sim,events,driven:[...owner.meleeDrivenIds]};
  });
  if(!Number.isSafeInteger(currentSimVersion)||currentSimVersion<selfDescribing||!Number.isSafeInteger(selfDescribing)||selfDescribing<=targetAware)
    throw new Error('Unsupported archive compatibility boundary');
  const clipText=texts[2];
  const clipAst=ts.createSourceFile('clips.ts',clipText,ts.ScriptTarget.Latest,true);
  const functions=['facing8','facing8Stable'].map(name=>clipAst.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name)?.getText(clipAst).replace(/^export\s+/,''));
  if(functions.some(f=>!f))throw new Error('Missing source archived facing helper');
  const facing8Stable=compile(`const FACING8_HYSTERESIS_DEG=${variable(clipAst,'FACING8_HYSTERESIS_DEG')},FACING_ANGLE=${variable(clipAst,'FACING_ANGLE')};${functions.join('\n')};return facing8Stable;`);
  const aim=captureFacing8StablePlan(ts,clipText,facing8Stable,{FACING8_HYSTERESIS_DEG:compile(`return ${variable(clipAst,'FACING8_HYSTERESIS_DEG')};`)});
  // Depth is outside these registration probes; the renderer already admits world depth independently.
  const bodyPolicy=compile(`return ${variable(ast[4],'BATTLE_BODY_PRESENTATION')};`);
  const legacy={...captureLegacyMelee(ts,texts[1],profiles,{facing8Stable,actorDepth:y=>y,BATTLE_BODY_PRESENTATION:bodyPolicy}),aim,
    selfDescribingSimVersion:selfDescribing,targetAwareSimVersion:targetAware};
  const history=[...texts[3].matchAll(/^\s*\*\s*(\d+)\s+—/gm)].map(m=>Number(m[1]));
  if(!history.length||Math.max(...history)!==currentSimVersion)throw new Error('Missing canonical archived SIM history');
  const {cases:legacyCases,...legacyMelee}=legacy;
  return {policy:{version:1,minimumSimVersion:Math.min(...history),maximumSimVersion:currentSimVersion,mode:'currentWebArchive',legacyMelee,
    sourceHashes:Object.fromEntries(files.map((file,index)=>[file,createHash('sha256').update(texts[index]).digest('hex')]))},cases,legacy};
}
