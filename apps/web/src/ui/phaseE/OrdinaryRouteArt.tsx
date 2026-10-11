import {useState} from 'react';
import {PHASE_E_ORDINARY_ROUTES} from '@shardkeep/shared';
import {ordinaryRoute,type OrdinaryRouteId} from '@shardkeep/shared/ordinaryRoutes';
import {versionedPublicAsset} from '../../lib/version';
/** Crop only the supplied detail atlas. No generated files or renderer changes. */
export function OrdinaryRouteArt({routeId}:{routeId:OrdinaryRouteId}){
 const route=ordinaryRoute(routeId),crop=PHASE_E_ORDINARY_ROUTES.art,size=80,scale=size/crop.cell;
 const src=versionedPublicAsset(`/atlas/fantasy/globe/generated/${route.chain}-detail.png`),[failed,setFailed]=useState<string|null>(null);
 return <div style={{position:'relative',width:size,height:size,overflow:'hidden',flexShrink:0,borderRadius:8,background:'rgba(0,0,0,.22)',display:'grid',placeItems:'center'}}>
  {failed===src?<span style={{fontSize:11,textAlign:'center'}}>Map art unavailable</span>:<img src={src} alt="" loading="lazy" decoding="async" onError={()=>setFailed(src)} style={{position:'absolute',maxWidth:'none',width:crop.atlas*scale,height:crop.atlas*scale,left:-(route.index%crop.columns)*size,top:-Math.floor(route.index/crop.columns)*size}}/>}
 </div>;
}
