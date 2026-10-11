import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

/** Execute the current React result functions; render their exact SVG inputs through
 * the existing pipeline WITHOUT attaching the newer game-v4 atlas overlays. */
export async function captureResultPresentation(source) {
  const ts=(await import(pathToFileURL(path.join(source,'scripts/node_modules/typescript/lib/typescript.js')).href)).default;
  const hashes={};
  const read=async relative=>{const bytes=await readFile(path.join(source,relative));hashes[relative]=createHash('sha256').update(bytes).digest('hex');return bytes.toString('utf8');};
  const text=await read('apps/web/src/ui/screens/results.tsx');
  const ast=ts.createSourceFile('results.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const names=['StarRow','FxSprite','VictoryScreen','DefeatScreen'];
  const functions=names.map(name=>{const n=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);if(!n)throw new Error(`Missing result source ${name}`);return n.getText(ast).replace(/^export\s+/,'');}).join('\n');
  const icons=await read('apps/web/src/ui/icons.ts');
  const primitives=await read('apps/web/src/ui/primitives.tsx');
  const raid=await read('apps/web/src/ui/RaidUI.tsx');
  if(!icons.includes("import star from '../../../../art/game-v4/ui/legacy-ui_icon_star.png'") ||
     !icons.includes("'../../../../art/source/assets-v2/*.svg'") ||
     !primitives.includes("imageRendering: 'pixelated'") ||
     !raid.includes('result screens (victory / defeat) — live raids only; replays returned above.'))throw new Error('Result source routing/art contract changed');
  const audioText=await read('apps/web/src/lib/audio.ts');
  const audioAst=ts.createSourceFile('audio.ts',audioText,ts.ScriptTarget.Latest,true);
  const declaration=(file,name)=>file.statements.filter(ts.isVariableStatement).flatMap(n=>[...n.declarationList.declarations]).find(n=>n.name.getText(file)===name)?.initializer;
  const compile=(script,bindings={})=>new Function(...Object.keys(bindings),ts.transpile(script,{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}))(...Object.values(bindings));
  const familyNode=declaration(audioAst,'LEGACY_PRODUCTION_FAMILY');if(!familyNode)throw new Error('Missing legacy sound family map');
  const families=compile(`return (${familyNode.getText(audioAst)});`);
  const defaults={};const visit=n=>{if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.QuestionQuestionToken) {
    const name=n.left.getText(audioAst);if(name==='opts?.volume'||name==='opts?.priority')defaults[name.split('.').at(-1)]=compile(`return ${n.right.getText(audioAst)};`);
  }ts.forEachChild(n,visit);};visit(audioAst);
  if(defaults.volume!==1||defaults.priority!=='normal')throw new Error('Result sound default admission changed');
  const juice=await read('apps/web/src/lib/juice.ts');const juiceAst=ts.createSourceFile('juice.ts',juice,ts.ScriptTarget.Latest,true);
  const patterns=compile(`return (${declaration(juiceAst,'PATTERN')?.getText(juiceAst)});`);
  let effects=[],audio=[],haptics=[],intervals=[],frame=0,reduce=false;
  const React={Fragment:'fragment',createElement:(type,props,...children)=>({type:typeof type==='function'?type.name:type,props:props??{},children:children.flat(Infinity)})};
  const bindings={React,useEffect:fn=>effects.push(fn),useState:()=>[frame,()=>{}],useApp:selector=>selector({reduceMotion:reduce}),
    playSfx:(legacy,options)=>audio.push({legacy,family:families[legacy],gain:options?.volume??defaults.volume,priority:options?.priority??defaults.priority}),
    haptic:kind=>haptics.push(kind),sprite:name=>name,home(){},setInterval:(_,ms)=>{intervals.push(ms);return 1;},clearInterval(){},
    C:{},Icon:'Icon',Btn:'Btn',Chip:'Chip',ModalWrap:'ModalWrap',Phead:'Phead',Sp:'Sp',fmtN:String};
  const owner=compile(`${functions};return {${names.join(',')}};`,bindings);
  const reset=()=>{effects=[];audio=[];haptics=[];intervals=[];};
  const runEffects=()=>effects.forEach(fn=>fn());
  const find=(node,type)=>node?.type===type?[node]:(node?.children??[]).flatMap(c=>find(c,type));
  const row=owner.StarRow({filled:0}),stars=find(row,'Icon');
  if(stars.length===0||stars.some(n=>n.props.name!=='star')||stars.some(n=>n.props.size!==stars[0].props.size))throw new Error('Unsupported authored result stars');
  const filledStars=find(owner.StarRow({filled:stars.length}),'Icon');
  const cases=[];
  for(const n of [0,...stars.map((_,i)=>i+1),stars.length+1]) {
    reset();owner.VictoryScreen({result:{stars:n}});runEffects();cases.push({stars:n,audio:[...audio],haptics:[...haptics]});
  }
  reset();const victory=owner.VictoryScreen({result:{stars:stars.length}});runEffects();
  const fxNodes=find(victory,'FxSprite');
  if(fxNodes.length!==2)throw new Error('Result decoration families changed');
  const fx={};const outputs=[];
  const rasterText=await read('scripts/src/rasterize.ts');
  const rasterAst=ts.createSourceFile('rasterize.ts',rasterText,ts.ScriptTarget.Latest,true);
  const rasterFunctions=['parseViewBox','renderSvg','renderBase'].map(name=>{
    const node=rasterAst.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);
    if(!node)throw new Error(`Missing deterministic rasterizer ${name}`);
    return node.getText(rasterAst).replace(/^export\s+/,'');
  }).join('\n');
  const require=createRequire(path.join(source,'scripts/package.json'));
  const sharp=require('sharp'),{Resvg}=require('@resvg/resvg-js');
  // Execute the unchanged renderer in an empty overlay context: these are React's
  // SVG masters, not the later atlas-only game-v4 replacement records.
  const renderBase=compile(`${rasterFunctions};return renderBase;`,{Resvg,Buffer,path,fs:{readFile},
    GAME_V4_OVERLAY_BASE_SOURCES:new Map(),assertPngSize:async(bytes,w,h)=>{
      const info=await sharp(bytes).metadata();if(info.width!==w||info.height!==h)throw new Error('Result PNG size mismatch');
    }});
  const fxProof=[];
  for(const node of fxNodes) {
    const props=node.props;const key=props.frames[0].match(/^fx_(sparkle|loot)_f1$/)?.[1];if(!key)throw new Error('Unknown result decoration source');
    const records=[];
    for(const name of props.frames) {
      if(!/^fx_(sparkle|loot)_f[1-9][0-9]*$/.test(name))throw new Error('Unsupported result frame name');
      // Current React first-match glob order. Refuse if a higher-precedence master appears.
      for(const dir of ['art/source/assets-v3','art/source/expanded-assets/characters']) {
        try {await readFile(path.join(source,dir,`${name}.svg`));throw new Error(`Result sprite precedence changed: ${dir}/${name}`);}catch(error){if(error.code!=='ENOENT')throw error;}
      }
      const relative=`art/source/assets-v2/${name}.svg`;const svg=await read(relative);
      const vb=svg.match(/viewBox="0 0 (\d+) (\d+)"/);if(!vb)throw new Error('Unsupported result SVG viewBox');
      const width=Number(vb[1]),height=Number(vb[2]);
      const bytes=await renderBase({srcDir:path.join(source,'art/source/assets-v2'),file:`${name}.svg`,w:width,h:height});
      const info=await sharp(bytes).metadata();if(info.width!==width||info.height!==height)throw new Error('Result rasterization dimensions differ');
      const output=`ui/results/${name}.png`;outputs.push({path:output,bytes});records.push({path:output,width,height});
      fxProof.push({name,source:relative,pngSha256:createHash('sha256').update(bytes).digest('hex'),width,height});
    }
    reset();frame=0;reduce=false;const image=owner.FxSprite(props);runEffects();
    if(intervals.length!==1)throw new Error('Result frame interval changed');
    const frameMs=intervals[0];const samples=[];
    for(frame=0;frame<props.frames.length;frame++){reset();samples.push(owner.FxSprite(props).props.src);}
    reset();reduce=true;frame=props.frames.length-1;const held=owner.FxSprite(props);runEffects();
    if(intervals.length||held.props.src!==props.frames[0])throw new Error('Reduced result animation no longer holds first frame');
    fx[key]={frames:records,size:image.props.width,frameMs,style:props.style};
    if(image.props.height!==image.props.width||JSON.stringify(samples)!==JSON.stringify(props.frames))throw new Error('Result frame drawing changed');
  }
  reset();owner.DefeatScreen({result:{stars:0}});runEffects();
  const defeat={audio:[...audio],haptics:[...haptics]};
  const starSource='art/game-v4/ui/legacy-ui_icon_star.png';await read(starSource);
  const padding=row.props.style.padding.match(/^(\d+)px 0 (\d+)px$/);if(!padding)throw new Error('Unsupported result star padding');
  const policy={version:1,stars:{atlasPath:'atlas/ui@1x.json',frameKey:'ui_icon_star',source:starSource,size:stars[0].props.size,
    gap:row.props.style.gap,paddingTop:Number(padding[1]),paddingBottom:Number(padding[2]),opacity:stars.map(n=>n.props.style.opacity),filledOpacity:filledStars.map(n=>n.props.style.opacity),offsetY:stars.map(n=>Number(n.props.style.transform?.match(/translateY\((-?\d+)px\)/)?.[1]??0))},
    fx,victory:cases,defeat,patterns:Object.fromEntries(Object.entries(patterns).map(([k,v])=>[k,Array.isArray(v)?v:[v]])),sourceHashes:hashes};
  return {policy,outputs,proof:{policy,fx:fxProof}};
}
