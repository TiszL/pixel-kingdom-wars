import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {it,expect} from 'vitest';
import {CharterTournamentOperationSchema,postgresJsonbText} from '@shardkeep/shared/charterTournamentApi';
import {tournamentFixture} from './testFixture';
import {prepareTournamentSigning,signTournament,tournamentTermsHash,verifyTournamentWire} from './signing';
const path=fileURLToPath(new URL('../../../../../packages/shared/src/testFixtures/charterTournamentSigning.json',import.meta.url));
// Public, synthetic vectors only. The generated object never includes keypairs.
if(process.env.CHARTER_TOURNAMENT_WRITE_PUBLIC_VECTORS==='true'){
 const rows=[];for(const action of ['set','clear'] as const){const f=await tournamentFixture(action),prepared=await prepareTournamentSigning(f.operation,f.trust,f.actor),wire=await signTournament(prepared,{publicKey:f.leader.publicKey,signVersionedTransaction:async tx=>{tx.sign([f.leader]);return tx;}}),termsText=postgresJsonbText(f.terms);rows.push({action,leader:f.actor,trust:f.trust,operation:f.operation,wire,termsText,termsUtf8Hex:Buffer.from(termsText).toString('hex'),termsHash:f.original.operation.termsHash});}
 writeFileSync(path,JSON.stringify({version:1,fixtureOnly:true,rows},null,2)+'\n');
}
it('reconstructs public set and clear vectors with independent pins and real Ed25519 evidence',async()=>{const vectors=JSON.parse(readFileSync(path,'utf8'));expect(vectors.version).toBe(1);expect(vectors.fixtureOnly).toBe(true);expect(vectors.rows).toHaveLength(2);for(const row of vectors.rows){const original=CharterTournamentOperationSchema.parse(row.operation);expect(postgresJsonbText(original.operationTerms)).toBe(row.termsText);expect(Buffer.from(row.termsUtf8Hex,'hex').toString()).toBe(row.termsText);expect(await tournamentTermsHash(original.operationTerms)).toBe(row.termsHash);await prepareTournamentSigning(original,row.trust,row.leader);expect(await verifyTournamentWire(original,row.wire)).toEqual(row.wire);}expect(readFileSync(path,'utf8')).not.toContain('secretKey');});
