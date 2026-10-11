/** Read API and single-owner proposal contract. the content pipeline runs only with both reviewed screen proposals. */
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {dirname,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {expect,it} from 'vitest';
const directory=dirname(fileURLToPath(import.meta.url)),src=resolve(directory,'../../..'),screen=resolve(src,'ui/screens/army.tsx');
const source=()=>readFileSync(screen,'utf8');
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
it('preserves the original read exports and pins the complete separately reviewed action-owner source',()=>{
 const text=source();expect(text).toContain('export interface ArmyState {');expect(text).toContain('export function useTrainingArmy() {');
 const original=text.replace('export interface ArmyState {','interface ArmyState {').replace('export function useTrainingArmy() {','function useTrainingArmy() {');
 // PIN UPDATE (night/server, after 82430ce8e): the reviewed MS-F2b v2.1 bytes hashed to 32a31699…3c99. 82430ce8e then
 // capped the two army auto-refetch delays (training + research) at 2_147_483_647 ms with Math.min, because a head past
 // setTimeout's 2^31-1 ms limit fires after 1 ms (notes/fix-web-scripts-tests.md W4). Those two lines are the ONLY delta
 // (verified by hashing 82430ce8e^ and HEAD); they sit outside the MS-F2b review and still need its acknowledgment.
 expect(sha(original)).toBe('76adbea0e7b7cb73ef7b5788730fb6d6605f3e9f7beea34a997c44ec586b011e');
});
const allowed=[
 'ui/Overlay.tsx','ui/sheets.tsx',
 'ui/screens/army.researchRecovery.test.tsx','ui/screens/trainingPresets.test.tsx',
 'ui/screens/army.screen.test.tsx','ui/screens/army.keepConfirm.test.tsx',
 'ui/screens/army.cancel.test.tsx','ui/screens/army.trainingRecovery.test.tsx','ui/screens/army.cancelResearch.test.tsx',
 'ui/pk/army/armyReadOutput.proposal.test.tsx',
 'ui/pk/army/armyActionOwners.proposal.test.tsx',
].sort();
// 2026-10-10 (release/phase-e-20261010, CI run 38043546234): every importers() call parses all ~1,400 .ts/.tsx
// files under src with the TypeScript compiler. One scan measured ~4.5 s on the CI runner and 4.4-5.0 s on a loaded dev
// Mac, so the default 5 s per-test budget failed the first scan on CI with no assertion involved. Each scan gets an
// explicit budget (global timeouts unchanged); the assertions are untouched and a genuine hang still fails.
const TREE_SCAN_BUDGET_MS=30_000;
function files(root:string):string[]{return readdirSync(root,{withFileTypes:true}).flatMap(row=>row.isDirectory()?files(resolve(root,row.name)):/\.tsx?$/.test(row.name)?[resolve(root,row.name)]:[]);}
function importers(target=screen):Map<string,string[]> {
 const found=new Map<string,string[]>();
 for(const file of files(src)){
  const ast=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
  const visit=(node:ts.Node):void=>{
   const literal=(ts.isImportDeclaration(node)||ts.isExportDeclaration(node))?node.moduleSpecifier:ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword?node.arguments[0]:null;
   if(literal&&ts.isStringLiteral(literal)&&resolve(dirname(file),literal.text).replace(/\.tsx?$/,'')===target.replace(/\.tsx?$/,'')){
    const path=relative(src,file).replaceAll('\\','/');found.set(path,[...(found.get(path)??[]),ts.isImportDeclaration(node)?node.importClause?.getText(ast)??'side-effect':ts.isExportDeclaration(node)?'export '+(node.exportClause?.getText(ast)??'*'):'dynamic']);
   }
   ts.forEachChild(node,visit);
  };visit(ast);
 }
 return found;
}
it('names every allowed importer and refuses an unallocated production consumer',()=>{expect([...importers().keys()].sort()).toEqual(allowed);},TREE_SCAN_BUDGET_MS);
it('preserves the existing lazy screen and building tray import sites',()=>{
 const found=importers();expect(found.get('ui/Overlay.tsx')).toEqual(['dynamic']);expect(found.get('ui/sheets.tsx')).toEqual(['dynamic','dynamic','dynamic']);
 expect(found.get('ui/screens/army.screen.test.tsx')).toEqual(['{ ArmyScreen }']);
 expect(found.get('ui/screens/army.keepConfirm.test.tsx')).toEqual(['{ ResearchTray, TrainTray }']);
},TREE_SCAN_BUDGET_MS);

it('names every trainingPresets importer and re-exporter so legacy bypass helpers stay inside the reviewed owner',()=>{
 const found=importers(resolve(src,'ui/screens/trainingPresets.tsx'));
 expect([...found.keys()].sort()).toEqual([
  'ui/pk/army/armyActionOwners.proposal.test.tsx','ui/screens/army.tsx','ui/screens/trainingPresets.test.tsx',
 ].sort());
 expect(found.get('ui/screens/army.tsx')).toEqual([
  '{ TrainingPresets, TrainingPurchaseOwner, ArmyActionSlot, armyOwnerDispatch, armyOwnerRequest, isArmyOwnerBinding, type ArmyOwnerBinding, type TrainingPurchaseModel }',
  'export { ArmyOwnerBinding }',
 ]);
 expect(found.get('ui/screens/trainingPresets.test.tsx')).toEqual(['{ TrainingPresets }']);
},TREE_SCAN_BUDGET_MS);
