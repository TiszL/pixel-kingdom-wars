import {originalOceanHeight,wrap,TAU,clamp} from './world.mjs';
const W=256,H=128;
let depths;
const stops=[[0,20,39,60],[.18,27,53,76],[.34,37,68,96],[.48,58,99,119]];
function prepare(){
 if(depths)return;
 depths=new Float32Array(W*H);
 for(let y=0;y<H;y++)for(let x=0;x<W;x++)depths[y*W+x]=originalOceanHeight((x+.5)/W*TAU-Math.PI,Math.PI/2-(y+.5)/H*Math.PI);
}
export function sampleOceanColor(lon,lat,out=[0,0,0]){
 prepare();
 const u=(wrap(lon)+Math.PI)/TAU*W-.5,v=clamp((Math.PI/2-lat)/Math.PI*H-.5,0,H-1),x=Math.floor(u),y=Math.floor(v),fx=u-x,fy=v-y;
 const x0=(x%W+W)%W,x1=((x+1)%W+W)%W,y0=Math.min(H-1,y)*W,y1=Math.min(H-1,y+1)*W;
 const h=(depths[y0+x0]*(1-fx)+depths[y0+x1]*fx)*(1-fy)+(depths[y1+x0]*(1-fx)+depths[y1+x1]*fx)*fy;
 let a=stops[0],b=stops[1];for(let i=1;i<stops.length;i++){b=stops[i];if(h<=b[0])break;a=b;}
 const t=a===b?0:clamp((h-a[0])/(b[0]-a[0]),0,1);
 out[0]=a[1]+(b[1]-a[1])*t;out[1]=a[2]+(b[2]-a[2])*t;out[2]=a[3]+(b[3]-a[3])*t;
 return out;
}
