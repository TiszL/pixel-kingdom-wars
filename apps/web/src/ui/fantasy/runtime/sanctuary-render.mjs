import {SANCTUARY} from './allocations.mjs';
import {project} from './world.mjs';
// The Crystal Vale itself is painted into solana-detail.png. Only a restrained
// survey edge remains here; there is no screen-facing monument image.
export function drawSanctuary(ctx,cam,radius,centerX=200,centerY=200){
  if(cam.zoom>9||cam.zoom<2.5)return;
  ctx.save();ctx.imageSmoothingEnabled=false;
  ctx.strokeStyle='#c4b1d04c';ctx.lineWidth=1;ctx.beginPath();
  for(const {from,to} of SANCTUARY.perimeter){const a=project(from.lon,from.lat,cam),b=project(to.lon,to.lat,cam);if(a.z<.15||b.z<.15)continue;ctx.moveTo(Math.round(centerX+a.x*radius),Math.round(centerY+a.y*radius));ctx.lineTo(Math.round(centerX+b.x*radius),Math.round(centerY+b.y*radius));}ctx.stroke();
  ctx.restore();
}
