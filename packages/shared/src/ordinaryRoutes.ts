/** D153.183 installed catalogue metadata only. No current permit or fleet authority. */
import {z} from 'zod';
import {PHASE_E_ORDINARY_ROUTES as C} from './constants';
export type OrdinaryRouteId=keyof typeof C.routes;
export const ORDINARY_ROUTE_IDS=Object.freeze(Object.keys(C.routes) as [OrdinaryRouteId,...OrdinaryRouteId[]]);
export const OrdinaryRouteIdSchema=z.enum(ORDINARY_ROUTE_IDS);
export const OrdinaryRouteGradeSchema=z.custom<keyof typeof C.gradeFactors>(value=>typeof value==='number'&&Number.isInteger(value)&&Object.hasOwn(C.gradeFactors,value));
export type OrdinaryRoute=typeof C.routes[OrdinaryRouteId];
export function ordinaryRoute(id:unknown):OrdinaryRoute{return Object.freeze({...C.routes[OrdinaryRouteIdSchema.parse(id)]});}
