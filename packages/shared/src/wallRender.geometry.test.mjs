import { test } from 'vitest';
import assert from 'node:assert/strict';
import {TIER_HEIGHTS,CONTEXT_FRAME_HEIGHT,SHAPES,resolveWall,footprintAt,buildField,captureCollapse,drawCollapses,drawWalls} from './wallRender';
const offsets=[[0,-1],[1,0],[0,1],[-1,0],[-1,-1],[1,-1],[1,1],[-1,1]];
const gridFor=(mask,tier=2)=>new Map([['0,0',{tier}],...offsets.flatMap(([x,y],i)=>mask&(1<<i)?[[`${x},${y}`,{tier}]]:[])]);

test('all 256 neighborhoods preserve production cardinal meanings and outer elbows',()=>{
  for(let mask=0;mask<256;mask++) {
    const s=resolveWall(gridFor(mask),0,0);
    assert.equal(s.mask,mask&15);
    assert.equal(s.piece,SHAPES[mask&15]);
    assert.equal(s.occupancyMask,mask);
    for(const [d,bit] of [['n',1],['e',2],['s',4],['w',8]])assert.equal(s.exposed[d],!(mask&bit));
    assert.equal(s.filledCorners.nw,!!((mask&1)&&(mask&8)&&(mask&16)));
    assert.equal(s.filledCorners.ne,!!((mask&1)&&(mask&2)&&(mask&32)));
  }
  assert.equal(resolveWall(gridFor(3),0,0).piece,'corner_sw');
  assert.equal(resolveWall(gridFor(12),0,0).piece,'corner_ne');
});

test('100 ordered directional tier joins have identical foundations and opposite height shoulders',()=>{
  for(let a=1;a<=5;a++)for(let b=1;b<=5;b++)for(let dir=0;dir<4;dir++) {
    const [dx,dy]=offsets[dir],names=['n','e','s','w'];
    const grid=new Map([['0,0',{tier:a}],[`${dx},${dy}`,{tier:b}]]);
    const here=resolveWall(grid,0,0),there=resolveWall(grid,dx,dy);
    assert.equal(here.steps[names[dir]],TIER_HEIGHTS[a-1]-TIER_HEIGHTS[b-1]);
    assert.equal(here.steps[names[dir]]+there.steps[names[(dir+2)%4]],0);
    for(let i=0;i<32;i++) {
      const x=dx===0?i:dx>0?31:0,y=dy===0?i:dy>0?31:0;
      const nx=dx===0?i:dx>0?0:31,ny=dy===0?i:dy>0?0:31;
      assert.equal(footprintAt(here,x,y),footprintAt(there,nx,ny));
    }
  }
});

test('dense 3×3 center is coherent fill without interior battlements, unlike a cross',()=>{
  const field=buildField(gridFor(255));
  for(let y=0;y<32;y++)for(let x=0;x<32;x++) {
    assert.ok(field.at(x,y));
    assert.equal(field.at(x,y).edge,4);
    assert.equal(field.at(x,y).merlon,false);
  }
  assert.equal(footprintAt(resolveWall(gridFor(15),0,0),0,0),false);
  assert.equal(footprintAt(resolveWall(gridFor(255),0,0),0,0),true);
});

test('diagonal-only walls stay separate and cannot fill the intervening corner',()=>{
  const s=resolveWall(gridFor(240),0,0);
  assert.equal(s.mask,0);
  assert.ok(Object.values(s.filledCorners).every(v=>!v));
  for(const [x,y]of[[0,0],[31,0],[31,31],[0,31]])assert.equal(footprintAt(s,x,y),false);
});

test('all neighborhood footprints mate across every occupied cardinal edge',()=>{
  for(let mask=0;mask<256;mask++) {
    const grid=gridFor(mask),here=resolveWall(grid,0,0);
    for(let dir=0;dir<4;dir++) {
      if(!(mask&(1<<dir)))continue;
      const [dx,dy]=offsets[dir],there=resolveWall(grid,dx,dy);
      for(let i=0;i<32;i++) {
        const x=dx===0?i:dx>0?31:0,y=dy===0?i:dy>0?31:0;
        const nx=dx===0?i:dx>0?0:31,ny=dy===0?i:dy>0?0:31;
        assert.equal(footprintAt(here,x,y),footprintAt(there,nx,ny),`pattern${mask} dir${dir} pixel${i}`);
      }
    }
  }
});

test('damage is local and removal reopens adjacent foundations without mutating captured collapse',()=>{
  const grid=gridFor(255,4),healthy=buildField(grid),before=healthy.at(20,20).h;
  const snapshot=captureCollapse(grid,0,0,100);
  const commands=JSON.stringify(snapshot.pixels);
  grid.set('0,0',{tier:4,damage:true});
  const damaged=buildField(grid);
  assert.equal(damaged.at(20,20).state.damage,true);
  assert.equal(damaged.at(40,20).state.damage,false);
  assert.ok(damaged.at(20,20).h<=before);
  grid.delete('0,0');
  assert.equal(resolveWall(grid,0,-1).exposed.s,true);
  assert.equal(buildField(grid).at(20,20),null);
  assert.equal(JSON.stringify(snapshot.pixels),commands);
  const pixels=[];
  drawCollapses({fillStyle:'',fillRect(x,y,w,h){pixels.push({x,y,w,h});}},[snapshot],800);
  assert.ok(pixels.length>0);
  assert.ok(pixels.every(p=>p.y>=21 && p.y+p.h<=32),'finished debris lies low inside the breached footprint');
});

test('all five tiers fit the local bottom-center source frame rectangles',()=>{
  for(let tier=1;tier<=5;tier++)for(let mask=0;mask<16;mask++) {
    const snapshot=captureCollapse(gridFor(mask,tier),0,0,0);
    assert.ok(snapshot.pixels.length);
    for(const [,x,y,w,h]of snapshot.pixels) {
      assert.ok(x>=0 && x+w<=32);
      assert.ok(y>=32-TIER_HEIGHTS[tier-1] && y+h<=32,`tier${tier} mask${mask} y${y}`);
    }
  }
});

test('all 6480 center/cardinal tier configurations retain reciprocal pixel mating edges',()=>{
  for(let center=1;center<=5;center++)for(let code=0;code<1296;code++) {
    const grid=new Map([['0,0',{tier:center}]]);let value=code;
    for(const [x,y]of offsets.slice(0,4)) {
      const tier=value%6;value=Math.floor(value/6);
      if(tier)grid.set(`${x},${y}`,{tier});
    }
    const s=resolveWall(grid,0,0);
    for(let dir=0;dir<4;dir++) {
      const [dx,dy]=offsets[dir],n=resolveWall(grid,dx,dy);
      if(!n)continue;
      for(let i=0;i<32;i++) {
        const x=dx===0?i:dx>0?31:0,y=dy===0?i:dy>0?31:0;
        const nx=dx===0?i:dx>0?0:31,ny=dy===0?i:dy>0?0:31;
        assert.equal(footprintAt(s,x,y),footprintAt(n,nx,ny));
      }
    }
  }
});

test('two local damage appearances differ while foundations and neighbors remain unchanged',()=>{
  for(let tier=1;tier<=5;tier++) {
  const grid=gridFor(15,tier);grid.set('0,0',{tier,damage:true,damageStage:1});
  const first=captureCollapse(grid,0,0),neighbor=captureCollapse(grid,1,0);
  grid.set('0,0',{tier,damage:true,damageStage:2});
  const second=captureCollapse(grid,0,0);
  assert.notDeepEqual(first.pixels,second.pixels);
  assert.deepEqual(captureCollapse(grid,1,0).pixels,neighbor.pixels);
  for(let y=0;y<32;y++)for(let x=0;x<32;x++)assert.equal(footprintAt(first,x,y),footprintAt(second,x,y));
  }
});

test('mixed-height dense blocks retain a fully painted interior through damage and all painter directions',()=>{
  for(let rotation=0;rotation<4;rotation++) {
    const grid=new Map();
    for(let y=0;y<3;y++)for(let x=0;x<3;x++)grid.set(`${x},${y}`,{tier:1+(x+y*3+rotation)%5,damage:(x+y)%2===0,damageStage:2});
    const pixels=new Set();
    drawWalls({fillStyle:'',fillRect(x,y,w,h){for(let iy=0;iy<h;iy++)for(let ix=0;ix<w;ix++)pixels.add(`${x+ix},${y+iy}`);}},grid);
    // The filled center's projected vertical columns must be continuous. An
    // interior gap would expose the grass despite fully occupied foundations.
    for(let x=32;x<64;x++) {
      const rows=[...pixels].map(k=>k.split(',').map(Number)).filter(p=>p[0]===x).map(p=>p[1]);
      // Every column crosses the solid center tile. Without this assertion an
      // entirely missing column yields Infinity/-Infinity and skips the loop.
      assert.ok(rows.length>0,`rotation${rotation} missing interior column${x}`);
      const low=Math.min(...rows),high=Math.max(...rows);
      for(let y=low;y<=high;y++)assert.ok(pixels.has(`${x},${y}`),`rotation${rotation} hole${x},${y}`);
    }
  }
});

test('all 100 ordered directional tier joins share exact coping heights and grade one pixel at a time',()=>{
  for(let a=1;a<=5;a++)for(let b=1;b<=5;b++)for(let dir=0;dir<4;dir++) {
    const [dx,dy]=offsets[dir];
    const grid=new Map([['0,0',{tier:a,damage:true,damageStage:2}],[`${dx},${dy}`,{tier:b}]]);
    const field=buildField(grid);
    for(let i=0;i<32;i++) {
      const x=dx===0?i:dx>0?31:0,y=dy===0?i:dy>0?31:0;
      const here=field.at(x,y),there=field.at(x+dx,y+dy);
      if(!here)continue;
      assert.equal(here.body,there.body,`body jump T${a}→T${b} dir${dir} pixel${i}`);
      assert.equal(here.h,there.h,`coping jump T${a}→T${b} dir${dir} pixel${i}`);
    }
    // Tier-height cores remain recognizable; only their shoulders interpolate.
    assert.equal(field.at(15,15).body,TIER_HEIGHTS[a-1]-36);
    assert.equal(field.at(dx*32+15,dy*32+15).body,TIER_HEIGHTS[b-1]-36);
    for(let step=0;step<32;step++) {
      const x=15+dx*step,y=15+dy*step,next=field.at(x+dx,y+dy),here=field.at(x,y);
      assert.ok(Math.abs(next.body-here.body)<=1,`abrupt shoulder T${a}→T${b} dir${dir} step${step}`);
    }
  }
});

test('mixed-height collars agree through every eight-neighbor pattern, including concave three-cell corners',()=>{
  for(let mask=0;mask<256;mask++) {
    const grid=gridFor(mask,1+(mask%5));
    for(let i=0;i<offsets.length;i++) {
      const [x,y]=offsets[i],s=grid.get(`${x},${y}`);
      if(s){s.tier=1+(i+mask)%5;s.damage=i%2===0;s.damageStage=2;}
    }
    const field=buildField(grid);
    for(let dir=0;dir<4;dir++) {
      if(!(mask&(1<<dir)))continue;
      const [dx,dy]=offsets[dir];
      for(let i=0;i<32;i++) {
        const x=dx===0?i:dx>0?31:0,y=dy===0?i:dy>0?31:0;
        const here=field.at(x,y),there=field.at(x+dx,y+dy);
        if(here) {
          assert.equal(here.body,there.body,`body pattern${mask} dir${dir} pixel${i}`);
          assert.equal(here.h,there.h,`coping pattern${mask} dir${dir} pixel${i}`);
        }
      }
    }
  }
});

test('diagonal-only higher tiers never distort an unconnected lower wall',()=>{
  const alone=buildField(new Map([['0,0',{tier:1}]]));
  const diagonal=buildField(new Map([['0,0',{tier:1}],['1,1',{tier:4}],['-1,-1',{tier:3}]]));
  for(let y=0;y<32;y++)for(let x=0;x<32;x++)assert.equal(alone.at(x,y)?.body,diagonal.at(x,y)?.body);
});

test('mixed-tier raised shoulders use the declared context envelope without claiming lower-tier source bounds',()=>{
  let raised=false;
  for(let tier=1;tier<=5;tier++)for(let other=1;other<=5;other++)for(let dir=0;dir<4;dir++) {
    const [dx,dy]=offsets[dir];
    const grid=new Map([['0,0',{tier}],[`${dx},${dy}`,{tier:other}]]);
    const snapshot=captureCollapse(grid,0,0,0);
    assert.equal(snapshot.frame.height,TIER_HEIGHTS[tier-1]);
    assert.equal(snapshot.contextFrame.height,CONTEXT_FRAME_HEIGHT);
    for(const [,x,y,w,h]of snapshot.pixels) {
      assert.ok(x>=0 && x+w<=32);
      assert.ok(y>=32-CONTEXT_FRAME_HEIGHT && y+h<=32);
      if(y<32-TIER_HEIGHTS[tier-1])raised=true;
    }
  }
  assert.ok(raised,'a T1 shoulder beside northern T5 uses dynamic headroom, so exporting only the T1 source frame would clip it');
});

test('all 6480 center/cardinal tier configurations have smooth shared surface heights',()=>{
  for(let center=1;center<=5;center++)for(let code=0;code<1296;code++) {
    const grid=new Map([['0,0',{tier:center}]]);let value=code;
    for(const [x,y]of offsets.slice(0,4)) {
      const tier=value%6;value=Math.floor(value/6);
      if(tier)grid.set(`${x},${y}`,{tier});
    }
    const field=buildField(grid);
    assert.equal(field.at(15,15).body,TIER_HEIGHTS[center-1]-36);
    for(const [dx,dy]of offsets.slice(0,4)) {
      if(!grid.has(`${dx},${dy}`))continue;
      for(let i=0;i<32;i++) {
        const x=dx===0?i:dx>0?31:0,y=dy===0?i:dy>0?31:0;
        const here=field.at(x,y),there=field.at(x+dx,y+dy);
        if(here)assert.equal(here.h,there.h,`T${center} configuration${code} direction${dx},${dy} pixel${i}`);
      }
      for(let step=0;step<32;step++) {
        const x=15+dx*step,y=15+dy*step,here=field.at(x,y),next=field.at(x+dx,y+dy);
        assert.ok(Math.abs(next.body-here.body)<=1,`T${center} configuration${code} shoulder step${step}`);
      }
    }
  }
},15_000); // Exhaustive native geometry stays bounded under whole-workspace CPU contention.

test('timber doubles the former starter body and five tiers preserve a four-pixel height progression',()=>{
  assert.deepEqual(TIER_HEIGHTS,[44,48,52,56,60]);
  for(let tier=1;tier<=5;tier++) {
    assert.equal(buildField(new Map([['0,0',{tier}]])).at(15,15).body,8+(tier-1)*4);
  }
});

test('wood collapses into long narrow splinters while stone keeps block rubble',()=>{
  const render=tier=>{
    const pixels=[];
    drawCollapses({fillStyle:'',fillRect(x,y,w,h){pixels.push({x,y,w,h});}},[captureCollapse(gridFor(0,tier),0,0,0)],1000);
    return pixels;
  };
  const wood=render(1),stone=render(2);
  assert.ok(wood.some(p=>p.w===5&&p.h===1),'Timber needs broken plank lengths after collapse.');
  assert.ok(wood.some(p=>p.w===1&&p.h===2),'Timber needs pointed exposed splinters.');
  assert.ok(stone.every(p=>p.h===2&&p.w>=3),'Masonry debris retains its existing block character.');
});
