import type {FantasyPixels} from '../art';
import type {FantasyView,FantasyWorldMarker,FantasyTile,FantasyExploration,FantasyRenderStats,FantasyRealm,FantasyChain} from '../types';
export const REGIONS: readonly FantasyRealm[];
export const ARCHIPELAGOS: readonly FantasyChain[];
export const SIZE: number;
export function rasterSize(width:number,height:number):{width:number;height:number};
export interface RealmLabel { x: number; y: number; alpha: number }
export interface RealmLabelBounds { left: number; top: number; right: number; bottom: number }
export interface RealmLabelLayout {
  bounds?: RealmLabelBounds;
  exclude?: readonly RealmLabelBounds[];
  sizes?: readonly {width:number;height:number}[];
}
export interface FantasyRenderer {
  ready: Promise<void>;
  resize(width:number,height:number,centerX?:number,centerY?:number):void;
  draw(view: FantasyView, options?: {selectedTileId?: number|null; worldMarkers?: readonly FantasyWorldMarker[]; realmId?: string; scale?: number; interacting?: boolean}): void;
  realmLabels(options?: RealmLabelLayout): Array<RealmLabel|null>;
  pick(x:number,y:number,view?:FantasyView): {tile:FantasyTile|null;realmId:string|null;exploration:FantasyExploration|null};
  markerPositions(): Array<FantasyWorldMarker & {x:number;y:number;z:number;realmId:string;parcelWidth:number;parcelHeight:number}>;
  surfaceAt(lon:number,lat:number): {visibleLand:boolean;deedEligible:boolean;region:number;explorationId:string|null};
  animate(time:number,force?:boolean): void;
  setCloudMotion(value:boolean): void;
  retry(): Promise<void>;
  stats(): FantasyRenderStats;
  dispose():void;
}
export function normalizedView(view:FantasyView):FantasyView;
export function tileFocus(tile:FantasyTile,cssScale?:number):FantasyView;
export function islandFocus(chainId:string,islandId?:string,cssScale?:number,available?:{width:number;height:number}):FantasyView|null;
export function createFantasyRenderer(options:{
 canvas:HTMLCanvasElement;cloudCanvas:HTMLCanvasElement;effectCanvas:HTMLCanvasElement;
 read(path:string):Promise<FantasyPixels>;readDetail?(path:string):Promise<FantasyPixels>;resolveTile(cell:number):FantasyTile|null;
 invalidate():void;onError(error:unknown):void;onDetailStatus?(status:{pending:boolean;error:unknown|null}):void;getReducedMotion?():boolean;
}):FantasyRenderer;
