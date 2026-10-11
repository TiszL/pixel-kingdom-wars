import {RAD,clamp,project} from './world.mjs';

/** Keyboard order follows the visible, stable realm IDs, including wrapped ends. */
export function realmNavigationIndex(index,key,count){
  if(!Number.isInteger(index)||!Number.isInteger(count)||count<1)return null;
  if(key==='Home')return 0;
  if(key==='End')return count-1;
  if(key==='ArrowRight')return (index+1)%count;
  if(key==='ArrowLeft')return (index+count-1)%count;
  return null;
}

/** Label positions share the ground projection. Collision offsets never move land. */
export function layoutRealmLabels(regions,camera,radius,{sizes=[],selectedIndex=-1,width=400,height=400,centerX=width/2,centerY=height/2,bounds={left:5,top:5,right:width-5,bottom:height-5},exclude=[]}={}){
  const candidates=regions.map((realm,index)=>{
    const p=project(realm.lon*RAD,realm.lat*RAD,camera);
    const size=sizes[index]??{width:100,height:24};
    return {index,anchorX:centerX+p.x*radius,anchorY:centerY+p.y*radius,z:p.z,...size};
  }).sort((a,b)=>Number(b.index===selectedIndex)-Number(a.index===selectedIndex)||b.z-a.z||a.index-b.index);
  // Keeps own their existing touch targets. A label may move or disappear,
  // while its realm remains accessible in the navigation rail.
  const placed=[...exclude],out=Array(regions.length).fill(null);
  for(const p of candidates){
    const alpha=clamp((p.z-.08)/.20,0,1)*clamp((3.8-camera.zoom)/.8,0,1);
    if(alpha<=0||p.anchorX<0||p.anchorX>width||p.anchorY<0||p.anchorY>height)continue;
    if(p.width+6>bounds.right-bounds.left||p.height+6>bounds.bottom-bounds.top)continue;
    const lift=p.height*.75;
    for(const [dx,dy]of [[0,-lift],[0,-lift-p.height-5],[0,8],[0,8+p.height+5],[-p.width*.42,-lift],[p.width*.42,-lift]]){
      const x=clamp(p.anchorX+dx,bounds.left+p.width/2+3,bounds.right-p.width/2-3),y=p.anchorY+dy;
      const box={left:x-p.width/2-3,right:x+p.width/2+3,top:y-p.height/2-3,bottom:y+p.height/2+3};
      if(box.top<bounds.top||box.bottom>bounds.bottom||placed.some(b=>box.left<b.right&&box.right>b.left&&box.top<b.bottom&&box.bottom>b.top))continue;
      placed.push(box);out[p.index]={...p,x,y,alpha};break;
    }
  }
  return out;
}
