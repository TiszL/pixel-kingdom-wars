import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCampAtlases,trimCampFrame,packCampFrames} from './camp-atlases.mjs';

const sourceFrame=(filename,x)=>({filename,rotated:false,trimmed:false,sourceSize:{w:4,h:4},spriteSourceSize:{x:0,y:0,w:4,h:4},frame:{x,y:0,w:4,h:4}});
function fixture() {
  const image={width:16,height:4,data:Buffer.alloc(16*4*4)};
  for(let cell=0;cell<4;cell++)for(let y=1;y<3;y++)for(let x=1;x<3;x++) image.data.set([20+cell,40+x,60+y,255],(y*16+cell*4+x)*4);
  const frames=['a','b','c','attack'].map((name,i)=>sourceFrame(name,i*4));
  const clip=(key,frames)=>({key,atlasPath:'atlas/source.json',frames,rowOrder:['e','w'],fps:12,anchor:[.4,.8],scale:1.32,cellWidth:4,cellHeight:4,loop:true,flipX:[false,true],fxCues:[],emitters:{hand:[[[1,2]],[[2,2]]]}});
  const move=clip('walk',[['a','b'],['b','a']]);const stand=clip('idle',[['c'],['c']]);
  const profiles={profile:{profile:{move:'walk',stand:'idle'},clips:{walk:move,idle:stand,attack:clip('attack',[['attack'],['attack']])}}};
  const actors=[{type:'bowman',level:1,frameKey:'body1',combatKey:'profile'},{type:'bowman',level:2,frameKey:'body1',combatKey:'profile'}];
  const writes=new Map();
  return {image,frames,move,stand,profiles,actors,writes,options:{actors,combatProfiles:profiles,publicRoot:'/assets',
    readFile:async file=>file.endsWith('.json')?Buffer.from(JSON.stringify({textures:[{image:'source.png',frames}]})):Buffer.from('source'),
    decodePng:async()=>image,encodePng:async packed=>Buffer.from(JSON.stringify({width:packed.width,height:packed.height,data:[...packed.data]})),
    put:async(path,bytes)=>{assert(!writes.has(path));writes.set(path,bytes);}}};
}
function logical(image,frame) {
  const bytes=Buffer.alloc(frame.sourceSize.w*frame.sourceSize.h*4);
  for(let y=0;y<frame.frame.h;y++)for(let x=0;x<frame.frame.w;x++) {
    const src=((frame.frame.y+y)*image.width+frame.frame.x+x)*4;
    const dst=((frame.spriteSourceSize.y+y)*frame.sourceSize.w+frame.spriteSourceSize.x+x)*4;
    if(image.data[src+3])bytes.set(image.data.subarray(src,src+4),dst);
  }
  return bytes;
}
test('home atlas preserves every visible authored pixel, canvas, cadence, facing and anchor without combat dependencies',async()=>{
  const f=fixture();const before=JSON.stringify([f.profiles,f.actors]);
  const output=await buildCampAtlases(f.options);
  assert.equal(f.writes.size,2,'same tier/frame key is packed only once');assert.equal(output.version,1);
  const entry=output.actors.body1;assert.equal(entry.move.atlasPath,entry.stand.atlasPath);
  const atlas=JSON.parse(f.writes.get(entry.move.atlasPath));const packed=JSON.parse(f.writes.get(entry.move.atlasPath.replace('.json','.png')));packed.data=Buffer.from(packed.data);
  assert.equal(atlas.textures[0].frames.length,3,'attack cells must not enter home residency');
  for(const [role,clip] of [['move',f.move],['stand',f.stand]]) {
    assert.deepEqual({...entry[role],frames:clip.frames,atlasPath:clip.atlasPath},clip);
    for(let row=0;row<clip.frames.length;row++)for(let column=0;column<clip.frames[row].length;column++) {
      const original=f.frames.find(x=>x.filename===clip.frames[row][column]);
      const final=atlas.textures[0].frames.find(x=>x.filename===entry[role].frames[row][column]);
      assert.deepEqual(logical(packed,final),logical(f.image,original));
    }
  }
  assert.equal(JSON.stringify([f.profiles,f.actors]),before,'original combat profiles and actors remain immutable');
  const again=fixture();assert.deepEqual(await buildCampAtlases(again.options),output);assert.deepEqual(again.writes,f.writes);
});
test('transparent trimming retains original trimmed seat and an empty authored frame',()=>{
  const image={width:5,height:5,data:Buffer.alloc(100)};image.data.set([30,40,50,255],(2*5+3)*4);
  const frame={...sourceFrame('a',0),sourceSize:{w:10,h:12},spriteSourceSize:{x:2,y:3,w:4,h:4}};
  const cropped=trimCampFrame(image,frame);assert.equal(cropped.width,1);assert.equal(cropped.height,1);
  assert.deepEqual(cropped.spriteSourceSize,{x:5,y:5,w:1,h:1});assert.deepEqual(cropped.sourceSize,{w:10,h:12});
  const empty=trimCampFrame({...image,data:Buffer.alloc(100)},frame);assert.equal(empty.data[3],0);assert.equal(empty.width,1);
  assert.throws(()=>trimCampFrame(image,{...frame,rotated:true}),/geometry/);
});
test('packing is bounded, padded and never rescales source pixels',()=>{
  const frame={name:'wide',width:5000,height:2,data:Buffer.alloc(40000),sourceSize:{w:5000,h:2},spriteSourceSize:{x:0,y:0,w:5000,h:2}};
  assert.throws(()=>packCampFrames([frame]),/4096/);
});
test('missing authored frame or unsafe source path cannot produce a partial admitted section',async()=>{
  const f=fixture();f.move.frames=[['missing'],['missing']];await assert.rejects(buildCampAtlases(f.options),/Missing authored camp frame/);assert.equal(f.writes.size,0);
  const unsafe=fixture();unsafe.move.atlasPath='atlas/../private.json';await assert.rejects(buildCampAtlases(unsafe.options),/Unsafe/);
});
