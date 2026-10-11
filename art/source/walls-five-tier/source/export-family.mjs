/** Review-only export; production sources and atlas selection stay untouched. */
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SHAPES, TIER_HEIGHTS, COLLAPSE_DURATION, drawWall, drawWalls, captureCollapse, drawCollapses } from './walls.mjs';
const require = createRequire(new URL('../../../scripts/package.json', import.meta.url));
const sharp = require('sharp');
const output = new URL('./family/', import.meta.url);
const directions = [[0,-1,1],[1,0,2],[0,1,4],[-1,0,8]];
export function neighborhood(tier, mask, damage=false, damageStage=1) {
  const grid = new Map([['0,0',{tier,damage,damageStage}]]);
  for (const [x,y,bit] of directions) if (mask&bit) grid.set(`${x},${y}`,{tier,damage,damageStage});
  return grid;
}
function recorder() {
  const rectangles=[];
  return { rectangles, fillStyle:'#000000', globalAlpha:1, dx:0, dy:0,
    fillRect(x,y,w,h) {
      rectangles.push(`<rect x="${x+this.dx}" y="${y+this.dy}" width="${w}" height="${h}" fill="${this.fillStyle}" opacity="${this.globalAlpha}"/>`);
    }
  };
}
async function savePng(path, width, height, ctx) {
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" shape-rendering="crispEdges">${ctx.rectangles.join('')}</svg>`;
  await mkdir(new URL('./',new URL(path,output)),{recursive:true});
  await sharp(Buffer.from(svg)).png().toFile(fileURLToPath(new URL(path,output)));
}
export async function exportFamily() {
  const assets=[];
  for (let tier=1;tier<=5;tier++) {
    const height=TIER_HEIGHTS[tier-1];
    for(let mask=0;mask<16;mask++) {
      const ctx=recorder();ctx.dy=height-32;
      drawWall(ctx,neighborhood(tier,mask),0,0);
      const path=`t${tier}/pieces/${SHAPES[mask]}.png`;
      await savePng(path,32,height,ctx);
      assets.push({path,tier,state:'intact',mask,width:32,height,rows:1,columns:1,frameCells:1,anchor:[.5,1]});
    }
    for(const state of ['damaged','collapse']) {
      const columns=state==='damaged'?2:4,ctx=recorder();
      for(let mask=0;mask<16;mask++) {
        const grid=neighborhood(tier,mask,state==='damaged');
        const snapshot=state==='collapse'?captureCollapse(grid,0,0,0):null;
        for(let frame=0;frame<columns;frame++) {
          ctx.dx=frame*32;ctx.dy=mask*height+height-32;
          if(snapshot)drawCollapses(ctx,[snapshot],frame*COLLAPSE_DURATION/3);
          else drawWall(ctx,neighborhood(tier,mask,true,frame+1),0,0);
        }
      }
      const path=`t${tier}/${state}.png`;
      await savePng(path,32*columns,height*16,ctx);
      assets.push({path,tier,state,width:32*columns,height:height*16,cell:[32,height],rows:16,columns,frameCells:16*columns,anchor:[.5,1],fps:state==='damaged'?0:12,loop:false});
    }
  }
  // Context specimens demonstrate extra visual states; these are not replacement masks.
  const specimens=recorder();const specimensMeta=[];
  for(let a=1;a<=5;a++)for(let b=1;b<=5;b++) {
    const column=(a-1)*5+b-1;
    for(const [direction,dx,dy,row] of [['north',0,-1,0],['east',1,0,1],['south',0,1,2],['west',-1,0,3]]) {
      const grid=new Map([['0,0',{tier:a}],[`${dx},${dy}`,{tier:b}]]);
      specimens.dx=column*72+(dx<0?32:0);specimens.dy=row*112+28+(dy<0?32:0);
      drawWalls(specimens,grid);
      specimensMeta.push({kind:'ordered-tier-pair',direction,tiers:[a,b],rect:[column*72,row*112,72,112]});
    }
  }
  for(let tier=1;tier<=5;tier++) {
    const grid=new Map();
    for(let y=0;y<3;y++)for(let x=0;x<3;x++)grid.set(`${x},${y}`,{tier});
    specimens.dx=(tier-1)*144;specimens.dy=448+28;
    drawWalls(specimens,grid);
    specimensMeta.push({kind:'filled-3x3',tier,rect:[(tier-1)*144,448,112,128]});
  }
  await savePng('context-specimens.png',1800,576,specimens);
  const rendererSha256=createHash('sha256').update(await readFile(new URL('./walls.mjs',import.meta.url))).digest('hex');
  const manifest={version:2,rendererSha256,status:'local-review-only',tileSpacing:32,anchor:[.5,1],rowOrder:SHAPES,tierCellHeights:TIER_HEIGHTS,tierMaterials:['reinforced-timber','hewn-stone','dressed-stone','reinforced-stone','shard-crown'],masters:assets.length,frameCells:assets.reduce((n,a)=>n+a.frameCells,0),assets,extras:[{path:'context-specimens.png',width:1800,height:576,specimens:specimensMeta}],notes:[
    'The 90 baseline masters encode isolated cardinal neighborhoods at uniform tier. They do not encode the complete context-sensitive family.',
    'walls.mjs resolves neighboring tiers, diagonals, filled quadrants and shared perimeter at placement time. Context specimens are an inspection atlas, not a production lookup table.',
    'Mixed-tier geometry uses the full 32x60 visual envelope when shoulders extend a lower-tier cell. These are new local preview dimensions, not a production level mapping. The individual tier-height baseline sheets must not be substituted for this dynamic context.',
    'Damaged frames show distinct light/heavy damage stages. The current fps 0 runtime holds frame one; stage selection requires later integration.',
    'Collapse samples the complete 333.333 ms preview motion in four states; the exported clip preserves the existing four-frame 12fps asset contract.',
    'No existing art source, production renderer or atlas registration is modified.'
  ]};
  await writeFile(new URL('manifest.json',output),JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const manifest=await exportFamily();
  console.log(`Exported ${manifest.masters} baseline PNGs / ${manifest.frameCells} cells plus context specimen atlas.`);
}
