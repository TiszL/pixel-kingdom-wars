// Test fixture only. Execute the canonical PURE source functions with their real shared
// bounds, excluding browser-only import side effects. Never edit or export owner audio.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const source = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
if (!process.env.PKW_AUDIO_REFERENCE_LOADER) {
  execFileSync(process.execPath, ['--import', path.join(source, 'scripts/node_modules/tsx/dist/loader.mjs'),
    fileURLToPath(import.meta.url), source, output], { stdio: 'inherit', env: { ...process.env, PKW_AUDIO_REFERENCE_LOADER: '1' } });
  process.exit(0);
}
const ts = createRequire(path.join(source, 'scripts/package.json'))('typescript');
const { AUDIO_RUNTIME, RAID_REPLAY_LIMITS } = await import(pathToFileURL(path.join(source, 'packages/shared/src/constants.ts')).href);
const replay = await readFile(path.join(source, 'packages/shared/src/replay.ts'), 'utf8');
const battle = await readFile(path.join(source, 'apps/web/src/lib/battleAudio.ts'), 'utf8');
const audio = await readFile(path.join(source, 'apps/web/src/lib/audio.ts'), 'utf8');
function pureModule(text, bindings, exports) {
  const stripped = text.replace(/^import[\s\S]*?from[^;]+;\s*/gm, '').replace(/^export /gm, '');
  const code = ts.transpile(stripped, { target: ts.ScriptTarget.ES2022 }).replace(/export \{\};?/g, '');
  return new Function(...Object.keys(bindings), `${code}; return {${exports.join(',')}}`)(...Object.values(bindings));
}
const { attackRunCycleStarts } = pureModule(replay, { RAID_REPLAY_LIMITS }, ['attackRunCycleStarts']);
const { planBattleSfx } = pureModule(battle, { AUDIO_RUNTIME, attackRunCycleStarts }, ['planBattleSfx']);
const audioAst = ts.createSourceFile('audio.ts', audio, ts.ScriptTarget.Latest, true);
const hashNode = audioAst.statements.find((item) => ts.isFunctionDeclaration(item) && item.name?.text === 'deterministicSfxHash');
const { deterministicSfxHash } = pureModule(hashNode.getText(audioAst), {}, ['deterministicSfxHash']);
const troopTypes = ['highlander','bowman','kegrunner','tunneler','turrider','plunderer','giant','troll','dragon','mage','bilgewraith','gloamfang','direwyvern','hexbarrow','barrowling','wyrmling'];
const run = (troop, id, extra = {}) => ({ t: 5, e:'attackRun', id, troop, mode: 'melee', targetKind:'building', technique:'strike',
  count:2, cycleTicks:6, cadenceTicks:7, releaseOffsetTicks:1, cycleMs:550, releaseOffsetMs:135, impactOffsetsTicks:[3,5], ...extra });
const cases = [];
for (const [id,troop] of troopTypes.entries()) cases.push({ name:`troop ${troop}`, buildings:[], events:[
  { t:0,e:'deploy',id,troop }, run(troop,id,{ technique:troop==='direwyvern'?'maul':'strike' }),
  { t:5,e:'troopAttack',id }, { t:12,e:'troopAttack',id }, { t:19,e:'troopAttack',id }, { t:23,e:'troopDeath',id },
] });
cases.push({name:'boulder and authored stream',buildings:[],events:[run('giant',1,{technique:'boulder',mode:'projectile'}),run('dragon',2,{mode:'stream'})]});
const skills=['crimsonDash','moonsunderWave','degenAwakening','doubleOrNothingHeads','doubleOrNothingTails','omegaShardstorm','cheekQuake','snotRocket','cannonball','skillIssue','bellyBounce','brownNote','rageQuit','rageQuitWake','silentButDeadly','futureSkill'];
cases.push({name:'hero phases',buildings:[],events:[
  ...['vex','theodor'].flatMap((hero,id)=>[{t:0,e:'deploy',id,troop:'highlander',hero},{t:2,e:'heroAttack',id,hero},{t:3,e:'troopAttack',id},{t:4,e:'troopDeath',id}]),
  ...skills.flatMap((skill,id)=>['cast','impact'].map((phase,index)=>({t:10+id*2+index,e:'heroSkill',id,skill,phase}))),
]});
const defenses=['cannon','archertower','mortar','electrictower','magetower','lasertower','keep'];
cases.push({name:'defense release and contacts',buildings:defenses.map((type,id)=>({id:`b${id}`,type})),events:defenses.map((type,id)=>({t:id,e:'fire',id:`b${id}`,releaseOffsetMs:123,impactOffsetTicks:7}))});
cases.push({name:'actor-owned loops and event cues',buildings:[],events:[
  {t:0,e:'deploy',id:1,troop:'kegrunner'},{t:1,e:'detonate',id:1},{t:2,e:'deploy',id:2,troop:'tunneler'},
  {t:3,e:'burrow',id:2},{t:5,e:'emerge',id:2},{t:2,e:'spawn',id:3,troop:'wyrmling'},{t:3,e:'troopSpawn',id:4},
  ...['howl','leap','lunge','firestorm','maul','disgorge','future'].map((ability,id)=>({t:7+id,e:'troopAbility',id,ability})),
  ...['destroyed','trap','rally'].map((e,id)=>({t:17+id,e,id})), ...[1,2,3].map(n=>({t:20+n,e:'star',n})),
]});
cases.push({name:'malformed run never suppresses legacy attacks',buildings:[],events:[{t:0,e:'deploy',id:1,troop:'bowman'},run('bowman',1,{count:0}),{t:5,e:'troopFire',id:1}]});
const result={sourceCommit:execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  sourceHashes:Object.fromEntries([['battleAudio.ts',battle],['audio.ts',audio],['replay.ts',replay]].map(([file,text])=>[file,createHash('sha256').update(text).digest('hex')])),
  catalogue:{presentation:{tickMs:100},constants:{AUDIO_RUNTIME,RAID_REPLAY_LIMITS}},
  hashes:['','hello','sfx_troop_dragon_breath:2:5:release','astral:🐉','საქართველო'].map(value=>({value,hash:deterministicSfxHash(value)})),
  cases:cases.map(value=>({...value,expected:planBattleSfx(value.events,value.buildings)}))};
await mkdir(path.dirname(output),{recursive:true});
await writeFile(output,JSON.stringify(result,null,2)+'\n');
console.log(`Wrote ${cases.length} canonical audio cases from ${result.sourceCommit}`);
