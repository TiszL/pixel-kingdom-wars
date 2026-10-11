import path from 'node:path';
import { createHash } from 'node:crypto';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const safe = p => typeof p === 'string' && /^atlas\/[a-zA-Z0-9_@./-]+\.json$/.test(p) && !p.split('/').includes('..');

/** Lossless visible-pixel crop. Logical source canvas and anchors remain unchanged;
 * transparent padding is represented by spriteSourceSize instead of GPU texels. */
export function trimCampFrame(image, frame) {
  const box=frame.frame, source=frame.sourceSize, seat=frame.spriteSourceSize;
  requireValue(!frame.rotated && [box.x,box.y,box.w,box.h,source.w,source.h,seat.x,seat.y].every(Number.isInteger), 'Unsupported camp frame geometry');
  requireValue(box.x>=0 && box.y>=0 && box.w>0 && box.h>0 && box.x+box.w<=image.width && box.y+box.h<=image.height &&
    source.w>0 && source.h>0 && seat.x>=0 && seat.y>=0 && seat.x+box.w<=source.w && seat.y+box.h<=source.h, 'Camp frame is outside its source canvas');
  let left=box.w, top=box.h, right=-1, bottom=-1;
  for(let y=0;y<box.h;y++)for(let x=0;x<box.w;x++)if(image.data[((box.y+y)*image.width+box.x+x)*4+3]!==0) {
    left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
  }
  const empty=right<0;if(empty){left=0;top=0;right=0;bottom=0;}
  const width=right-left+1,height=bottom-top+1,data=Buffer.alloc(width*height*4);
  if(!empty)for(let y=0;y<height;y++) {
    const offset=((box.y+top+y)*image.width+box.x+left)*4;
    data.set(image.data.subarray(offset,offset+width*4),y*width*4);
  }
  return {data,width,height,sourceSize:{...source},spriteSourceSize:{x:seat.x+left,y:seat.y+top,w:width,h:height}};
}

/** Stable shelves; try several widths and choose the smallest decoded allocation.
 * These are atlas packing limits, not game rules. Source canvases are never resized. */
export function packCampFrames(frames) {
  requireValue(frames.length>0,'Empty camp atlas');
  const padding=2, sideLimit=4096;
  const sorted=frames.map((frame,index)=>({...frame,index})).sort((a,b)=>b.height-a.height || b.width-a.width || a.index-b.index);
  const minimum=Math.max(...sorted.map(f=>f.width+padding*2));
  const area=sorted.reduce((sum,f)=>sum+(f.width+padding*2)*(f.height+padding*2),0);
  const widths=[minimum,...[256,512,1024,2048,4096],Math.ceil(Math.sqrt(area)/64)*64].filter(w=>w>=minimum && w<=sideLimit);
  let best;
  for(const width of [...new Set(widths)].sort((a,b)=>a-b)) {
    let x=padding,y=padding,row=0,usedWidth=0;const seats=[];
    for(const f of sorted) {
      if(x+f.width+padding>width){x=padding;y+=row+padding*2;row=0;}
      seats.push({index:f.index,x,y});usedWidth=Math.max(usedWidth,x+f.width+padding);
      x+=f.width+padding*2;row=Math.max(row,f.height);
    }
    const height=y+row+padding;if(height>sideLimit)continue;
    const candidate={width:usedWidth,height,seats};
    if(!best || usedWidth*height<best.width*best.height)best=candidate;
  }
  requireValue(best,'Camp atlas exceeds the 4096px graphics limit');
  const data=Buffer.alloc(best.width*best.height*4);const metadata=[];
  for(const seat of best.seats) {
    const f=frames[seat.index];
    for(let y=0;y<f.height;y++)data.set(f.data.subarray(y*f.width*4,(y+1)*f.width*4),((seat.y+y)*best.width+seat.x)*4);
    metadata[seat.index]={filename:f.name,rotated:false,trimmed:true,sourceSize:f.sourceSize,spriteSourceSize:f.spriteSourceSize,
      frame:{x:seat.x,y:seat.y,w:f.width,h:f.height}};
  }
  return {...best,data,frames:metadata};
}

/** Adds compact home-only resources. Original atlas bytes and combat profiles are
 * read-only. Every frame, facing, cadence, loop flag, anchor and scale is retained. */
export async function buildCampAtlases({actors,combatProfiles,publicRoot,readFile,put,decodePng,encodePng}) {
  const groups=new Map();
  for(const actor of actors) {
    // Heroes do not occupy ready-army camp seats.
    if(actor.type==='vex' || actor.type==='theodor')continue;
    const body=actor.combat ?? combatProfiles[actor.combatKey];
    requireValue(body,'Missing camp combat profile');
    const move=body.clips?.[body.profile?.move],stand=body.clips?.[body.profile?.stand];
    requireValue(move && stand,'Missing authored camp move/stand clip');
    const identity=JSON.stringify([move,stand]);
    const group=groups.get(identity) ?? {move,stand,keys:new Set()};group.keys.add(actor.frameKey);groups.set(identity,group);
  }
  const result={version:1,actors:{},atlases:[]};
  for(const group of groups.values()) {
    // Bound decoded source residency to this body's two source atlas sets.
    const atlases=new Map(),images=new Map();
    for(const clip of [group.move,group.stand]) {
      requireValue(safe(clip.atlasPath),'Unsafe camp source atlas path');
      if(atlases.has(clip.atlasPath))continue;
      const atlas=JSON.parse((await readFile(path.join(publicRoot,clip.atlasPath))).toString());
      requireValue(Array.isArray(atlas.textures),'Unsupported camp source atlas');
      const entries=new Map();
      for(const texture of atlas.textures) {
        requireValue(typeof texture.image==='string' && /^[a-zA-Z0-9_@.-]+\.png$/.test(texture.image),'Unsafe camp texture path');
        const file=path.posix.join(path.posix.dirname(clip.atlasPath),texture.image);
        if(!images.has(file))images.set(file,await decodePng(await readFile(path.join(publicRoot,file))));
        for(const frame of texture.frames) {
          requireValue(!entries.has(frame.filename),'Duplicate camp source frame');entries.set(frame.filename,{frame,image:images.get(file)});
        }
      }
      atlases.set(clip.atlasPath,entries);
    }
    const sourceFrames=[],bySource=new Map();
    for(const clip of [group.move,group.stand])for(const row of clip.frames)for(const key of row) {
      const identity=`${clip.atlasPath}:${key}`;if(bySource.has(identity))continue;
      const entry=atlases.get(clip.atlasPath).get(key);requireValue(entry,`Missing authored camp frame ${key}`);
      requireValue(entry.frame.sourceSize.w===clip.cellWidth && entry.frame.sourceSize.h===clip.cellHeight,'Camp clip canvas disagrees with atlas');
      const index=sourceFrames.length;bySource.set(identity,index);sourceFrames.push({...trimCampFrame(entry.image,entry.frame),name:`home_${index}`});
    }
    const packed=packCampFrames(sourceFrames), png=await encodePng(packed);
    const contentId=hash(Buffer.concat([png,Buffer.from(JSON.stringify([packed.frames,group.move,group.stand]))]));
    const stem=`atlas/home-camps/${contentId}`;const atlasPath=`${stem}.json`;
    // Globally unique names keep renderer frame lookup safe beside other camp bodies.
    const names=packed.frames.map((f,i)=>`home_${contentId.slice(0,16)}_${i}`);
    const frames=packed.frames.map((f,i)=>({...f,filename:names[i]}));
    const json=Buffer.from(JSON.stringify({textures:[{image:`${contentId}.png`,format:'RGBA8888',size:{w:packed.width,h:packed.height},scale:1,frames}]}));
    await put(`${stem}.png`,png);await put(atlasPath,json);
    const rewrite=clip=>({...clip,atlasPath,frames:clip.frames.map(row=>row.map(key=>names[bySource.get(`${clip.atlasPath}:${key}`)]))});
    const value={move:rewrite(group.move),stand:rewrite(group.stand)};
    for(const key of group.keys) {
      requireValue(!result.actors[key] || JSON.stringify(result.actors[key])===JSON.stringify(value),'Conflicting camp artwork key');result.actors[key]=value;
    }
    result.atlases.push({path:atlasPath,pngSha256:hash(png),jsonSha256:hash(json),width:packed.width,height:packed.height,rgbaBytes:packed.width*packed.height*4,pngBytes:png.length,jsonBytes:json.length});
  }
  return result;
}
