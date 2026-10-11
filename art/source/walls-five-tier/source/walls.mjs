/** Local Crownkeep geometry study. Never imported by production. */
export const TILE = 32;
export const TIER_HEIGHTS = Object.freeze([44, 48, 52, 56, 60]);
export const COLLAPSE_DURATION = 1000 * 4 / 12;
// Context shoulders may rise above a lower-tier source cell. Keep the
// declared local source dimensions, and expose the honest envelope used by dynamic rendering.
export const CONTEXT_FRAME_HEIGHT = 60;
export const SHAPES = Object.freeze(['post', 'end_n', 'end_e', 'corner_sw', 'end_s', 'ns', 'corner_nw', 'tee_e', 'end_w', 'corner_se', 'straight', 'tee_n', 'corner_ne', 'tee_w', 'tee_s', 'cross']);
const DIR = { n: [0,-1,1], e: [1,0,2], s: [0,1,4], w: [-1,0,8] };
const DIAG = { nw: [-1,-1,'n','w'], ne: [1,-1,'n','e'], se: [1,1,'s','e'], sw: [-1,1,'s','w'] };
const key = (x,y) => `${x},${y}`;
const mod = (v,n) => ((v%n)+n)%n;
const tierOf = w => Math.max(1, Math.min(5, Math.floor(w?.tier || 1)));
export function resolveWall(grid,x,y) {
  const wall = grid.get(key(x,y));
  if (!wall) return null;
  const tier=tierOf(wall), neighbors={}, exposed={}, steps={}, diagonals={}, filledCorners={};
  let mask=0, occupancyMask=0;
  for (const [d,[dx,dy,bit]] of Object.entries(DIR)) {
    const other=grid.get(key(x+dx,y+dy));
    neighbors[d]=other ? {tier:tierOf(other),damage:!!other.damage} : null;
    exposed[d]=!other;
    steps[d]=other ? TIER_HEIGHTS[tier-1]-TIER_HEIGHTS[tierOf(other)-1] : 0;
    if(other) mask|=bit;
  }
  occupancyMask=mask;
  Object.entries(DIAG).forEach(([d,[dx,dy,a,b]],i) => {
    const other=grid.get(key(x+dx,y+dy));
    diagonals[d]=other ? {tier:tierOf(other),damage:!!other.damage} : null;
    filledCorners[d]=!!(other && neighbors[a] && neighbors[b]);
    if(other) occupancyMask|=16<<i;
  });
  const corner=mask!==5 && mask!==10 && ((mask&3)===3 || (mask&6)===6 || (mask&12)===12 || (mask&9)===9);
  const radius=corner && Object.values(filledCorners).filter(Boolean).length<=1?12:mask===0?10:6;
  return {x,y,tier,damage:!!wall.damage,damageStage:wall.damageStage===2?2:1,mask,occupancyMask,piece:SHAPES[mask],neighbors,diagonals,exposed,steps,filledCorners,radius,anchor:{x:x*TILE+16,y:(y+1)*TILE},frame:{width:32,height:TIER_HEIGHTS[tier-1]},contextFrame:{width:32,height:CONTEXT_FRAME_HEIGHT}};
}

/** Exact mating footprint: cardinal arms; a quadrant fills only for a solid 2×2. */
export function footprintAt(state,px,py) {
  if(!state || px<0 || py<0 || px>=32 || py>=32) return false;
  const {mask,filledCorners:f,radius}=state;
  const dx=Math.abs(px-15.5),dy=Math.abs(py-15.5);
  if(dx<=radius && dy<=radius && dx+dy<=radius*2-2) return true;
  if(px>=10 && px<22 && ((mask&1 && py<=16)||(mask&4 && py>=15))) return true;
  if(py>=10 && py<22 && ((mask&8 && px<=16)||(mask&2 && px>=15))) return true;
  if(px<16 && py<16 && f.nw || px>=16 && py<16 && f.ne || px>=16 && py>=16 && f.se || px<16 && py>=16 && f.sw) return true;
  return false;
}

const PALETTES = [
  {top:'#94724e',light:'#bd9563',cap:'#cfaa78',face:'#795331',stone:'#9a7448',dark:'#513e2b',mortar:'#6b4b30',line:'#302c25',accent:'#565b51'},
  {top:'#b6a787',light:'#d7c8a2',cap:'#e3d6b2',face:'#958368',stone:'#ac9978',dark:'#655942',mortar:'#8c7e63',line:'#39382e',accent:'#95805a'},
  {top:'#bcae8a',light:'#dfd0a9',cap:'#eadfbb',face:'#a08e6e',stone:'#b9a582',dark:'#6b5b44',mortar:'#918267',line:'#403a2d',accent:'#ac9159'},
  {top:'#c1b38e',light:'#e2d5b3',cap:'#eee3c2',face:'#a29373',stone:'#c0ac86',dark:'#6c6048',mortar:'#95876a',line:'#413a2d',accent:'#c3a15a'},
  {top:'#c1b69b',light:'#e5dbc1',cap:'#f0e8d0',face:'#a29478',stone:'#c2b18e',dark:'#69604c',mortar:'#978a70',line:'#3e3c30',accent:'#bda76d'},
];
const bodyHeight = state => TIER_HEIGHTS[state.tier-1]-36;
// Two shared boundary pixels have exactly the same blend weight. The 11px
// shoulder on either side grades at most an ordinary one-pixel stone step for
// the largest isolated T1↔T5 join, while the central 8px retains its own height.
const edgeWeight = pixel => Math.max(0,(12-Math.min(pixel,31-pixel))/22);
function heightPatch(cells,s,dx,dy) {
  const nodes=[s,cells.get(key(s.x+dx,s.y)),cells.get(key(s.x,s.y+dy)),cells.get(key(s.x+dx,s.y+dy))];
  // A diagonal participates only when connected inside this four-center patch.
  // This includes a three-cell concave corner without blending across grass.
  const connected=[true,!!nodes[1],!!nodes[2],!!nodes[3] && !!(nodes[1]||nodes[2])];
  return nodes.map((n,i)=>connected[i]?bodyHeight(n):null);
}
function shoulderHeight(s,px,py) {
  const u=Math.min(.5,edgeWeight(px)),v=Math.min(.5,edgeWeight(py));
  const values=s.heightPatches[(py<16?0:2)+(px<16?0:1)];
  const weights=[(1-u)*(1-v),u*(1-v),(1-u)*v,u*v];
  let total=0,weight=0,transition=false;
  for(let i=0;i<4;i++)if(values[i]!==null && weights[i]>0) {
    total+=values[i]*weights[i];weight+=weights[i];
    if(values[i]!==values[0])transition=true;
  }
  return {body:Math.round(total/weight),transition};
}
let lastGrid, lastSignature, lastField;
/** Prepared per-frame geometry is exported for deterministic visual audits. */
export function buildField(grid) {
  const signature=Array.from(grid,([k,v])=>`${k}:${v.tier}:${!!v.damage}:${v.damageStage||1}`).join('|');
  if(lastGrid===grid && lastSignature===signature) return lastField;
  const cells=new Map();
  for(const k of grid.keys()) {const [x,y]=k.split(',').map(Number); cells.set(k,resolveWall(grid,x,y));}
  for(const s of cells.values())s.heightPatches=[heightPatch(cells,s,-1,-1),heightPatch(cells,s,1,-1),heightPatch(cells,s,-1,1),heightPatch(cells,s,1,1)];
  const getState=(wx,wy)=>cells.get(key(Math.floor(wx/32),Math.floor(wy/32)));
  const occupied=(wx,wy)=>footprintAt(getState(wx,wy),mod(wx,32),mod(wy,32));
  const sample=(wx,wy)=> {
    const s=getState(wx,wy);
    if(!footprintAt(s,mod(wx,32),mod(wy,32))) return null;
    // Border distance is derived from the union, never a tile's own outline.
    let edge=4, direction='';
    for(let d=1;d<=3;d++) {
      if(!occupied(wx,wy-d)) {edge=d;direction='n';break;}
      if(!occupied(wx-d,wy)) {edge=d;direction='w';break;}
      if(!occupied(wx,wy+d)) {edge=d;direction='s';break;}
      if(!occupied(wx+d,wy)) {edge=d;direction='e';break;}
    }
    const px=mod(wx,32),py=mod(wy,32);
    const {body,transition}=shoulderHeight(s,px,py);
    const along=direction==='n'||direction==='s'?wx:wy;
    // Crenels never start/end exactly at a tile join. The common shoulder
    // remains visible as continuous coping between the decorative blocks.
    const merlon=edge<=3 && mod(along,16)>=4 && mod(along,16)<12;
    let h=body+(edge<=3?2:0)+(merlon?2:0);
    // Chips are local surface damage; the shared foundation remains continuous.
    const mating=(px<=1&&s.neighbors.w)||(px>=30&&s.neighbors.e)||(py<=1&&s.neighbors.n)||(py>=30&&s.neighbors.s);
    const damaged=s.damage && !mating && mod(wx*7+wy*11,23)<(s.damageStage===2?9:5);
    if(damaged) h=Math.max(2,h-(s.damageStage===2?3:2));
    return {h,body,transition,edge,direction,merlon,state:s,damaged};
  };
  // Cache samples once; drawing never recomputes neighbor footprints per pixel.
  const samples=new Map();
  for(const s of cells.values()) {
    const data=new Array(1024);
    for(let py=0;py<32;py++) for(let px=0;px<32;px++) data[py*32+px]=sample(s.x*32+px,s.y*32+py);
    samples.set(key(s.x,s.y),data);
  }
  const at=(wx,wy)=>samples.get(key(Math.floor(wx/32),Math.floor(wy/32)))?.[mod(wy,32)*32+mod(wx,32)] || null;
  lastGrid=grid;lastSignature=signature;lastField={cells,at,occupied,samples};return lastField;
}
function pixel(ctx,color,x,y,w=1,h=1) {ctx.fillStyle=color;ctx.fillRect(x,y,w,h);}

// Material collars are limited to the outer coping where timber meets stone.
// They do not add a perimeter to adjoining platforms or change mating height.
function materialCollar(s,px,py) {
  const timber=s.tier===1;
  return (px<=1 && s.neighbors.w && (s.neighbors.w.tier===1)!==timber)
    || (px>=30 && s.neighbors.e && (s.neighbors.e.tier===1)!==timber)
    || (py<=1 && s.neighbors.n && (s.neighbors.n.tier===1)!==timber)
    || (py>=30 && s.neighbors.s && (s.neighbors.s.tier===1)!==timber);
}

function timberFace(p,wx,z,a,exterior) {
  const post=mod(wx,16)>=4 && mod(wx,16)<=6;
  // Long planks, paired rails and diagonal braces sit only on exposed faces.
  let color=z===0?p.line:mod(wx,6)===0?p.dark:mod(wx,6)===1?p.stone:p.face;
  if(mod(wx*7+z*3,31)===0)color=p.dark;
  if(mod(wx,6)===3 && mod(z+Math.floor(wx/6)*3,7)<3)color=p.dark;
  if(exterior && post)color=mod(wx,16)===4?p.light:p.stone;
  if(exterior && (z===2 || z===a.h-3))color=p.stone;
  if(exterior && !post && mod(wx+z,16)===9 && z>2 && z<a.h-3)color=p.light;
  if(exterior && post && (z===2 || z===a.h-3))color=mod(wx,16)===5?'#bec0a6':'#4b5048';
  if(z===a.h-2 && a.edge<=3)color=p.dark;
  if(z===a.h-1 && a.edge<=3)color=p.stone;
  return color;
}

function timberDeck(p,wx,wy,a) {
  let color=a.edge===1?p.light:a.edge<=3?p.cap:p.top;
  if(a.edge>3) {
    const board=mod(wx,5),length=mod(wy+(Math.floor(wx/5)%2)*9,24);
    if(board===0 || length===0)color=p.dark;
    else if(board===1)color=p.light;
    else if(mod(wx*11+wy*3,43)===0)color=p.face;
    // Short staggered grain marks and knots survive nearest-neighbor zoom.
    if(board>=2 && mod(wy+Math.floor(wx/5)*7,19)===3)color=p.stone;
    if(board===3 && mod(wy+Math.floor(wx/5)*7,19)<3)color=p.face;
  }
  if(a.direction==='e' && a.edge===1)color=p.dark;
  const along=a.direction==='n'||a.direction==='s'?wx:wy;
  if(a.merlon && a.edge===2 && mod(along,16)>=6 && mod(along,16)<=9)color=p.stone;
  if(a.merlon && a.edge===3)color=p.dark;
  return color;
}

export function drawWall(ctx,grid,x,y,options={}) {
  const field=options.field || buildField(grid),s=field.cells.get(key(x,y));
  if(!s) return;
  const p=PALETTES[s.tier-1];
  for(let py=0;py<32;py++) for(let px=0;px<32;px++) {
    const wx=x*32+px,wy=y*32+py,a=field.at(wx,wy);
    if(!a) continue;
    const b=field.at(wx,wy+1),floor=b?.h||0,wood=s.tier===1;
    // South faces: continuous masonry courses, shared faces suppressed exactly.
    for(let z=floor;z<a.h;z++) {
      const course=Math.floor(z/4),brick=mod(wx+(course%2)*5,10);
      const stoneTone=mod(Math.floor((wx+(course%2)*5)/10)*7+course*11,5);
      let c=z===0?p.line:z%4===0?p.dark:brick===0?p.mortar:brick===1||stoneTone===0?p.stone:p.face;
      if(a.edge===1 && (a.direction==='w'||a.direction==='e')) c=z%4===0?p.dark:p.light;
      if(z===a.h-2 && a.edge<=3) c=p.dark;
      if(z===a.h-1 && a.edge<=3)c=p.stone;
      if(s.tier>=4 && z===4 && a.h>8) c=p.accent;
      if(s.tier===5 && mod(wx,32)>=14 && mod(wx,32)<=16 && z>=7 && z<=10) c=z===10?'#b7dbca':'#518b80';
      if(wood)c=timberFace(p,wx,z,a,!b);
      if(a.edge<=3 && materialCollar(s,px,py) && z>=a.h-3)c=z===a.h-1?'#a5a38b':'#50564c';
      if(s.damage && mod(wx*3+z*13,37)<(s.damageStage===2?6:3)) c=wood && mod(wx+z,3)===0?p.cap:p.line;
      pixel(ctx,c,wx,wy-z);
    }
    let c=a.edge===1?p.light:a.edge<=3?p.cap:p.top;
    if(a.direction==='e' && a.edge===1)c=p.dark;
    if(a.edge>3 && (mod(wy,8)===0 || mod(wx+(Math.floor(wy/8)%2)*6,12)===0))c=p.mortar;
    if(a.edge>3 && mod(wy,8)===1 && mod(wx+(Math.floor(wy/8)%2)*6,12)>1)c=p.light;
    if(a.edge>3 && mod(wx*13+wy*7,67)===0)c=p.light;
    if(a.merlon && a.edge===3)c=p.dark;
    if(wood)c=timberDeck(p,wx,wy,a);
    if(a.edge<=3 && materialCollar(s,px,py))c=a.edge===1?'#bac0a7':'#687260';
    if(a.damaged)c=wood && mod(wx+wy,3)===0?p.cap:p.dark;
    pixel(ctx,c,wx,wy-a.h);
  }
}

export function drawWalls(ctx,grid,options={}) {
  const field=buildField(grid);
  const cells=[...field.cells.values()].sort((a,b)=>a.anchor.y-b.anchor.y||a.x-b.x);
  for(const s of cells)drawWall(ctx,grid,s.x,s.y,{...options,field});
  drawCollapses(ctx,options.collapses||[],options.time||0);
}

/** Capture before deletion. Geometry is frozen; survivors re-resolve immediately. */
export function captureCollapse(grid,x,y,start=0) {
  const s=resolveWall(grid,x,y);if(!s)return null;
  const field=buildField(grid),pixels=[];
  const recorder={fillStyle:'',fillRect(px,py,w,h){pixels.push([this.fillStyle,px-x*32,py-y*32,w,h]);}};
  drawWall(recorder,grid,x,y,{field});
  return {...s,start,pixels};
}
export function drawCollapses(ctx,collapses,time=0) {
  for(const s of [...collapses].sort((a,b)=>a.y-b.y||a.x-b.x)) {
    const progress=Math.max(0,Math.min(1,(time-s.start)/COLLAPSE_DURATION));
    const p=PALETTES[tierOf(s)-1];
    if(progress<1 && s.pixels) {
      const squash=Math.max(.05,1-progress*1.5);
      for(const [c,px,py,w,h] of s.pixels)pixel(ctx,c,s.x*32+px,s.y*32+Math.round(28+(py-28)*squash),w,h);
    }
    if(progress>.3)for(let i=0;i<7;i++) {
      const rx=s.x*32+6+mod(i*7,21),ry=s.y*32+22+mod(i*5,7);
      if(s.tier===1) {
        // Broken lengths and small end-grain chips, rather than stone rubble.
        pixel(ctx,p.dark,rx,ry,5,1);pixel(ctx,i%2?p.top:p.light,rx+(i%2),ry-1,4,1);
        if(i%2===0)pixel(ctx,p.cap,rx+4,ry-2,1,2);
      } else {pixel(ctx,p.dark,rx,ry,4,2);pixel(ctx,i%2?p.top:p.light,rx,ry-1,3,2);}
    }
  }
}
