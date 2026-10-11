import {locateIsland} from './island-shapes.mjs';
import {offshoreRegionAt} from './geography.mjs';
// Standalone art/demo geometry. No shared gameplay types or tunables.
export const TAU = Math.PI * 2;
export const RAD = Math.PI / 180;
export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
export const wrap = n => ((n + Math.PI) % TAU + TAU) % TAU - Math.PI;
export const REGIONS = [
  { id: 'frostveil', name: 'Frostveil', epithet: 'The sleeping north', color: '#afdae1', lon: -23, lat: 53,
    lore: 'Beneath the blue ice, the bells of a buried kingdom still ring. Keepers of the last winter roads trade glacial crystal and guard ruins older than the Shattering.',
    landscape: 'Ice shelves · frozen ridges · buried ruins',
    effects: [['Production', 'Rich crystal seams', 'Short growing season'], ['Crafting', 'Exceptional tempering', 'Fuel-hungry workshops'], ['Training', 'Hardened defenders', 'Slower outdoor drills'], ['Research', 'Preserved ancient records', 'Difficult expeditions']] },
  { id: 'elderwood', name: 'Elderwood', epithet: 'Where the old roots remember', color: '#8eb775', lon: -43, lat: 1,
    lore: 'Strongholds vanish beneath a canopy of silver-root trees. Grove wardens read the land through its living roots; every felled tree carries a debt to the forest.',
    landscape: 'Deep forest · ancient groves · green strongholds',
    effects: [['Production', 'Abundant timber and herbs', 'Scarce exposed ore'], ['Crafting', 'Fine bows and living wood', 'Damp stores and forges'], ['Training', 'Natural ranger grounds', 'Restricted heavy drills'], ['Research', 'Ancient botanical knowledge', 'Unreliable sightlines']] },
  { id: 'sunscar', name: 'Sunscar', epithet: 'Under the broken sun', color: '#dfb36d', lon: 43, lat: -26,
    lore: 'A sea of amber dunes surrounds the shattered observatories. Caravan cities follow the shade of sandstone ridges, trading sun-glass and charts of vanished stars.',
    landscape: 'Amber dunes · sandstone ridges · lost observatories',
    effects: [['Production', 'Sun-glass and precious ore', 'Water scarcity'], ['Crafting', 'Powerful solar furnaces', 'Abrasive dust'], ['Training', 'Endurance and mobility', 'Daytime heat fatigue'], ['Research', 'Clear skies and old lenses', 'Fragile supply routes']] },
  { id: 'crownlands', name: 'Crownlands', epithet: 'The roads between kingdoms', color: '#c4b67f', lon: 26, lat: 23,
    lore: 'Fields and ruined causeways bind the scattered crowns. No throne rules all these valleys, but their market roads carry the stories, seeds and ambitions of every realm.',
    landscape: 'Rolling fields · river valleys · fallen watchtowers',
    effects: [['Production', 'Reliable harvests and trade', 'Contested resources'], ['Crafting', 'Diverse materials nearby', 'Fewer rare specialties'], ['Training', 'Open mustering grounds', 'Little natural cover'], ['Research', 'Exchange between scholars', 'Few untouched ruins']] },
];
REGIONS.push({ id:'seeker-reach', name:'Solana Reach', epithet:'Where the beacons awaken', color:'#b98ce9', lon:-115, lat:38,
  lore:'Violet terraces rise above sheltered mint-blue bays. Wandering beacon keepers follow crystal rivers to observatories built before the Shattering, carrying messages between distant shores.',
  landscape:'Violet terraces · crystal rivers · ancient beacons',
  effects:[['Production','Rich crystal deposits','Thin growing soil'],['Crafting','Resonant crystal instruments','Specialized stonework'],['Training','Beacon-guided navigation','Steep approach paths'],['Research','Ancient signal archives','Fragmented records']] });
REGIONS.push(
  {id:'stormcairn',name:'Stormcairn',epithet:'The thunder beyond the horizon',color:'#99b6c2',lon:157.3,lat:23.8,
    lore:'Storm-worn cairns mark the passes between green coastal terraces and a snowy northern range. Highland watchkeepers read the thunder before it reaches their sheltered harbors.',
    landscape:'Storm-weathered highlands · green coastal terraces · snowy northern range',
    effects:[['Production','Highland ore and coastal timber','Storm-bound supply roads'],['Crafting','Weatherproof stone and metalwork','Salt-worn tools'],['Training','Defensible mountain passes','Unpredictable coastal weather'],['Research','Skywatch records and cairn archives','Remote northern observatories']]},
  {id:'thornwake',name:'Thornwake',epithet:'The jungle beyond the western sea',color:'#9ca978',lon:-142.2,lat:-17.8,
    lore:'Waterfalls disappear into layers of fern and towering jungle. Old causeways lead between clearings where overgrown ruins still hold the marks of a seafaring kingdom.',
    landscape:'Layered jungle · fern clearings · waterfalls · overgrown ruins',
    effects:[['Production','Rich timber and river plants','Hidden mineral beds'],['Crafting','Resilient fibers and hardwood','Humid workshops'],['Training','Concealed woodland approaches','Dense undergrowth'],['Research','Overgrown maritime archives','Ruins reclaimed by roots']]},
  {id:'cinderfall',name:'Cinderfall',epithet:'Where the last embers sleep',color:'#cf946d',lon:-152.4,lat:-57.3,
    lore:'Ochre ash drifts through weathered ruins beneath ridges of black obsidian. Hardy plants take root around sheltered springs, tracing the roads of the vanished furnace cities.',
    landscape:'Ochre ashlands · obsidian ridges · weathered ruins · hardy vegetation',
    effects:[['Production','Obsidian and exposed minerals','Sparse fertile ground'],['Crafting','Ancient furnace traditions','Abrasive ash'],['Training','Sheltered ridge strongholds','Broken volcanic paths'],['Research','Preserved furnace-city relics','Buried and fragile records']]},
);
const appearance = [
  {palette:[[137,175,184],[189,219,216],[221,233,210],[90,128,149]],ground:[153,183,181],numeral:'I',nav:'FROZEN NORTH',settlementCopy:'Packed snow, blue ice and frost-worn stone cover the full base ground. Frosted pines surround the same buildings and claim.',settlementDetails:'packed snow, blue ice, frost stone and frosted pines'},
  {palette:[[44,82,57],[72,110,63],[112,136,73],[30,63,49]],ground:[61,85,51],numeral:'II',nav:'ANCIENT FOREST',settlementCopy:'Living moss, fern beds and woodland earth spread beneath the familiar buildings. Old-growth trees gather beyond the unchanged claim.',settlementDetails:'living moss, fern beds, woodland earth and old-growth trees'},
  {palette:[[147,101,58],[189,141,77],[224,185,109],[119,79,53]],ground:[174,137,81],numeral:'III',nav:'AMBER DESERT',settlementCopy:'Wind-carved sand, sandstone and sun-glass cover the full base ground. A worn approach crosses the desert beneath the same buildings.',settlementDetails:'wind-carved sand, sandstone and sun-glass'},
  {palette:[[84,110,63],[120,137,77],[165,161,101],[68,88,58]],ground:[82,115,72],numeral:'IV',nav:'TEMPERATE HEART',settlementCopy:'Meadow turf, chalk gravel and worn earth form a temperate home beneath the same Keep and buildings. A trade road crosses the claim.',settlementDetails:'meadow turf, chalk gravel, worn earth and scattered trees'},
  {palette:[[83,73,102],[118,100,143],[148,155,137],[65,61,81]],ground:[95,86,115],numeral:'V',nav:'BEACON FRONTIER',settlementCopy:'Violet slate, crystal grass and mint seams extend across the full base ground. The same Keep stands among pale stone paths and crystal growths.',settlementDetails:'violet slate, crystal grass, mint seams and crystal growths'},
  {palette:[[73,101,103],[111,139,107],[180,196,191],[57,72,88]],ground:[92,114,103],numeral:'VI',nav:'STORM HIGHLANDS',settlementCopy:'Wet slate, silver heath and shallow rain pools cover the highland base. Storm-worn stones shelter the same Keep and unchanged claim.',settlementDetails:'wet slate, silver heath, rain pools and storm-worn stones'},
  {palette:[[37,76,55],[70,111,66],[119,145,82],[43,63,53]],ground:[67,88,56],numeral:'VII',nav:'WESTERN JUNGLE',settlementCopy:'Deep moss, braided roots and twilight ferns spread beneath the same buildings. Jungle growth gathers around the unchanged claim.',settlementDetails:'deep moss, braided roots, twilight ferns and jungle growth'},
  {palette:[[92,75,69],[145,105,70],[183,144,89],[54,56,65]],ground:[126,99,75],numeral:'VIII',nav:'OBSIDIAN ASHLANDS',settlementCopy:'Basalt ash, rust-red shale and ember seams cover the full base ground. Hardy plants and dark stone surround the same buildings.',settlementDetails:'basalt ash, rust-red shale, ember seams and hardy plants'},
];
REGIONS.forEach((r,i)=>Object.assign(r,appearance[i]));
const terrainProfiles=[
  ['snow','blue ice','exposed stone','frost vegetation'],['forest soil','moss','roots','sheltered clearings'],
  ['sand','sandstone','wind ridges','sparse vegetation'],['meadows','river valleys','worn roads','natural stone'],
  ['violet terraces','mint waterways','crystal vegetation'],['storm-weathered highlands','green coastal terraces','snowy northern range'],
  ['layered jungle','fern clearings','waterfalls','overgrown ruins'],['ochre ashlands','obsidian ridges','weathered ruins','sparse hardy vegetation'],
];
REGIONS.forEach((r,i)=>{r.terrainProfile=terrainProfiles[i];});
export const ARCHIPELAGOS = [
  {id:'glasswake',name:'Glasswake Keys',lon:-106,lat:-16,region:1,lore:'Clear shoals hide drowned signal towers. Future expeditions may trace the forgotten sea road.',points:[[-108.5,-19],[-103.5,-17],[-107,-12.5],[-104,-21]]},
  {id:'aurora',name:'Aurora Shoals',lon:108,lat:60,region:0,lore:'Pale islands catch the northern lights above silent harbors sealed by winter.',points:[[101,58],[106,61],[112,64],[115,58],[109,55]]},
  {id:'emberwake',name:'Emberwake Isles',lon:120,lat:-55,region:2,lore:'Ember-colored cliffs surround ash gardens and abandoned caravan landings.',points:[[114,-58],[118,-54],[124,-51],[127,-56],[122,-59],[113,-50]]},
  {id:'whispering',name:'Whispering Skerries',lon:-43,lat:-66,region:0,lore:'Low stone islands shelter whispering ruins beyond the last charted shipping lane.',points:[[-51,-65],[-45,-62],[-36,-64],[-40,-69],[-51,-70]]},
  {id:'mintwake',name:'Mintwake Atolls',lon:-130.5,lat:12.3,region:4,sourceGrid:[2,2],sourceInset:16,lore:'Mint-bright streams descend through terraced timber groves to sheltered lagoons. Ruined landings mark the Reach’s old forest routes, where future expeditions could gather wood and trace the freshwater springs.',landscape:'Timber groves · mint lagoons · freshwater falls',points:[[-132.5,10.5],[-128.7,10.9],[-132.2,14],[-128.4,14.2]]},
  {id:'prismforge',name:'Prismforge Isles',lon:-116.3,lat:9.4,region:4,sourceGrid:[2,2],sourceInset:16,lore:'Violet basalt shelves shelter thermal pools, exposed crystal seams and the silent remains of coastal forges. Future expeditions could investigate the mineral beds beneath these ancient workshops.',landscape:'Violet basalt · thermal pools · crystal seams',points:[[-119.8,7.5],[-113,7.6],[-119,11.5],[-113.5,11.2]]},
  {id:'lumenreef',name:'Lumenreef Keys',lon:-94,lat:13.6,region:4,sourceGrid:[2,2],sourceInset:16,lore:'Turquoise channels thread luminous reef gardens beneath weathered beacons. Tidal caves shelter rare growths, offering future explorers a quiet route between the Reach and the wider sea.',landscape:'Luminous groves · tidal caves · reef beacons',points:[[-97,11.5],[-91.4,11.8],[-96.8,15.5],[-91.6,15.4]]},
].map(a=>({...a,sourceGrid:a.sourceGrid??[3,2],locked:true,islands:a.points.map(([lon,lat],i)=>({lon,lat,ry:1.15+i%2*.12,rx:(1.15+i%2*.12)/Math.cos(lat*RAD)*.8}))}));
export function vector(lon, lat) { const c = Math.cos(lat); return [c * Math.cos(lon), Math.sin(lat), c * Math.sin(lon)]; }
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const centres = REGIONS.map(r => vector(r.lon * RAD, r.lat * RAD));
const patches = [[-23,53,0,.12],[-43,1,1,.15],[-64,-23,1,.08],[26,23,3,.13],[58,38,3,.06],[43,-26,2,.16],[72,-44,2,.06],[-143,-18,1,.11],[150,12,3,.15],[174,43,0,.07],[-154,-56,2,.04]].map(([lo,la,r,w]) => ({v: vector(lo*RAD,la*RAD),r,w}));
// Coastline lobes control land area, not a realm's territorial reach. Giving a
// broad lobe both jobs let Crownlands paint a hard patch over the adjacent realm.
const territories = [[-23,53,0],[-43,1,1],[-64,-23,1],[26,23,3],[58,25,3],[43,-26,2],[72,-44,2],[-143,-18,1],[150,12,3],[174,43,0],[-154,-56,2]].map(([lo,la,r])=>({v:vector(lo*RAD,la*RAD),r}));
const TRANSITION_BAND = .055;
const smooth = t => t * t * (3 - 2 * t);
const mix = (a,b,t) => a + (b-a)*t;
function hash(x,y,z) { let h = Math.imul(x,374761393) + Math.imul(y,668265263) + Math.imul(z,2147483647) + 97371; h = Math.imul(h ^ (h >>> 13),1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967295; }
export function noise(x,y,z) {
  const ix=Math.floor(x), iy=Math.floor(y), iz=Math.floor(z), u=smooth(x-ix), v=smooth(y-iy), w=smooth(z-iz);
  return mix(mix(mix(hash(ix,iy,iz),hash(ix+1,iy,iz),u),mix(hash(ix,iy+1,iz),hash(ix+1,iy+1,iz),u),v),mix(mix(hash(ix,iy,iz+1),hash(ix+1,iy,iz+1),u),mix(hash(ix,iy+1,iz+1),hash(ix+1,iy+1,iz+1),u),v),w);
}
function realms(p) {
  // A low-frequency domain warp bends the boundary like a watershed. It does
  // not add isolated biome islands or change with longitude wrapping.
  const q=p.map((v,i)=>v+(noise(p[0]*3+i*17,p[1]*3+5,p[2]*3+11)-.5)*.035);
  const length=Math.hypot(...q);for(let i=0;i<3;i++)q[i]/=length;
  const scores=[-1,-1,-1,-1];
  for(const c of territories)scores[c.r]=Math.max(scores[c.r],dot(q,c.v));
  let region=0;for(let i=1;i<4;i++)if(scores[i]>scores[region])region=i;
  const weights=scores.map(score=>smooth(clamp(1-(scores[region]-score)/TRANSITION_BAND,0,1)));
  const total=weights.reduce((sum,w)=>sum+w,0);
  return {region,weights:[...weights.map(w=>w/total),...REGIONS.slice(4).map(()=>0)]};
}
// The strongest weight owns the deed/pick region. Only terrain materials blend;
// land identity remains one discrete realm even in an ecological transition.
export function realmWeights(lon,lat) { const t=terrain(lon,lat);return {region:t.region<0?realms(vector(lon,lat)).region:t.region,weights:t.weights}; }
// All terrain is sampled in continuous 3D space: there is no longitude cut.
function originalTerrain(lon,lat) {
  const p=vector(lon,lat); let best=-1;
  for (const c of patches) { const h=Math.exp((dot(p,c.v)-1)/c.w); if(h>best)best=h; }
  const rough=noise(p[0]*9+7,p[1]*9+11,p[2]*9+3), fine=noise(p[0]*28,p[1]*28,p[2]*28);
  const height=best + (rough-.5)*.39 + (fine-.5)*.1;
  const ridge=1-Math.abs(noise(p[0]*15+20,p[1]*15+9,p[2]*15+1)*2-1);
  const realm=realms(p);
  return {height, region: height>.48?realm.region:-1, weights:realm.weights, rough, fine, ridge};
}
// Additions only occupy verified ocean. The accepted offshore continents now
// have distinct identities; their coastlines and all parcel addresses stay frozen.
function addition(lon,lat) {
  const x=wrap(lon)/RAD,y=lat/RAD;
  if(x>-142&&x<-88&&y>16&&y<60){
    const lobes=[[-117,40,19,16],[-106,29,14,11],[-126,27,10,9],[-120,51,13,8],[-99,44,9,10]];
    let shape=-10;
    for(const [cx,cy,rx,ry]of lobes)shape=Math.max(shape,1-((x-cx)/rx)**2-((y-cy)/ry)**2);
    // Cut sheltered bays into the eastern and western shores.
    for(const [cx,cy,rx,ry]of [[-96,34,9,5],[-135,39,6,5]])shape=Math.min(shape,((x-cx)/rx)**2+((y-cy)/ry)**2-1);
    const p=vector(lon,lat),edge=shape+(noise(p[0]*37,p[1]*37,p[2]*37)-.5)*.2;
    if(edge>0)return {region:4,depth:edge,explorationId:null,featureId:'seeker-mainland'};
  }
  const island=locateIsland(lon,lat,ARCHIPELAGOS);
  if(island?.visibleLand)return {region:island.region,depth:Math.max(.01,island.depth),explorationId:island.explorationId,featureId:island.featureId};
  return null;
}
export function terrain(lon,lat) {
  const t=originalTerrain(lon,lat);
  if(t.region>=0){
    const region=offshoreRegionAt(lon,lat,t.region),weights=region>=5?REGIONS.map((_,i)=>Number(i===region)):t.weights;
    return {...t,region,weights,visibleLand:true,deedEligible:true,explorationId:null,featureId:REGIONS[region].id};
  }
  const a=addition(lon,lat);
  if(!a)return {...t,visibleLand:false,deedEligible:false,explorationId:null,featureId:null};
  return {...t,...a,height:.48+Math.min(.45,a.depth*.4),weights:REGIONS.map((_,i)=>Number(i===a.region)),visibleLand:true,deedEligible:!a.explorationId};
}
export function surfaceAt(lon,lat) {
  const {visibleLand,deedEligible,explorationId,region,featureId}=terrain(lon,lat);
  return {visibleLand,deedEligible,explorationId,region,featureId};
}
export function project(lon,lat,cam) {
  const d=lon-cam.lon, cp=Math.cos(lat), sp=Math.sin(lat), s0=Math.sin(cam.lat), c0=Math.cos(cam.lat), cd=Math.cos(d);
  return {x:cp*Math.sin(d), y:-(c0*sp-s0*cp*cd), z:s0*sp+c0*cp*cd};
}
export function unproject(x,y,cam) {
  const r2=x*x+y*y; if(r2>1+1e-9) return null;
  const z=Math.sqrt(Math.max(0,1-r2)), up=-y, s0=Math.sin(cam.lat), c0=Math.cos(cam.lat);
  return {lon:wrap(cam.lon+Math.atan2(x,z*c0-up*s0)),lat:Math.asin(clamp(up*c0+z*s0,-1,1))};
}
export function textureIndex(lon,lat,width,height) {
  const x=((Math.floor((wrap(lon)+Math.PI)/TAU*width)%width)+width)%width;
  const y=clamp(Math.floor((Math.PI/2-lat)/Math.PI*height),0,height-1);
  return y*width+x;
}
export function regionAt(lon,lat) { return terrain(lon,lat).region; }
export function regionCentre(index) { return centres[index].slice(); }
// Original ocean depth ignores new islands, allowing one continuous sea surface
// beneath close-up island scenes without revealing rectangular texture patches.
export const originalOceanHeight=(lon,lat)=>originalTerrain(lon,lat).height;
