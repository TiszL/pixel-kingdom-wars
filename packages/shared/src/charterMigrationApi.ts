/** D153.205 existing-clan cutover. A registration packet is not evidence of a
 * funded new-clan reservation, payment, historical coverage or activation. */
import {z} from 'zod';
import {CLANS} from './constants';
import {CharterCreationOriginalSchema,CharterCreationSigningSchema,CharterWireSchema} from './charterApi';
const Id=z.uuid().refine(v=>v===v.toLowerCase()&&v!=='00000000-0000-0000-0000-000000000000');
const Address=z.string().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/),Hash=z.string().length(64).regex(/^[0-9a-f]+$/);
const Count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),Amount=z.string().min(1).max(20).regex(/^(0|[1-9][0-9]*)$/).refine(v=>BigInt(v)<(1n<<64n));
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b),No=z.literal(false);
export const CharterMigrationRequestSchema=z.object({clanId:Id,idempotencyKey:Id}).strict();
export const CharterMigrationSnapshotSchema=z.object({
 clan:z.object({id:Id,name:z.string().min(CLANS.nameMinLen).max(CLANS.nameMaxLen),tag:z.string().min(CLANS.tagMinLen).max(CLANS.tagMaxLen),inviteMode:z.enum(['open','invite'])}).strict(),
 memberCount:Count.min(1).max(CLANS.rosterCap),chestShards:Amount,capturedAt:z.iso.datetime({offset:true}),commitment:Hash,
}).strict();
export const CharterMigrationSchema=z.object({version:z.literal(1),id:Id,actor:Address,request:CharterMigrationRequestSchema,
 snapshot:CharterMigrationSnapshotSchema,original:CharterCreationOriginalSchema,
 status:z.enum(['pending','issuing','prepared','signed','controlled','cancelled']),
 signing:CharterCreationSigningSchema.nullable(),wire:CharterWireSchema.nullable(),
 terminal:z.object({id:Id,outcome:z.enum(['controlled','cancelled'])}).strict().nullable(),
 signingAuthorized:No,relayAuthorized:No,migrationAuthorized:No,fenceReleaseAuthorized:No,
}).strict().superRefine((v,c)=>{
 const issue=(message:string)=>c.addIssue({code:'custom',message});
 if(v.original.creationIntentId!==v.id||v.request.clanId!==v.snapshot.clan.id||v.original.clanId!==v.request.clanId||v.original.payer!==v.actor||v.original.metadata.name!==v.snapshot.clan.name||v.original.admissionCommitment!==v.snapshot.commitment)issue('Migration differs from the captured clan and leader');
 if(v.signing&&!same(v.signing.original,v.original))issue('Registration packet differs from the migration original');
 if(v.wire&&(!v.signing||v.wire.messageSha256!==v.signing.packet.messageSha256))issue('Signed wire differs from the original registration');
 if(v.terminal?v.status!==v.terminal.outcome:['controlled','cancelled'].includes(v.status))issue('Migration terminal backing differs');
 if(v.status==='pending'&&(v.signing||v.wire)||v.status==='issuing'&&(v.signing||v.wire)||v.status==='prepared'&&(!v.signing||v.wire)||v.status==='signed'&&(!v.signing||!v.wire))issue('Migration stage lacks its saved backing');
});
export type CharterMigration=z.infer<typeof CharterMigrationSchema>;
export type CharterMigrationRequest=z.infer<typeof CharterMigrationRequestSchema>;
export const CharterMigrationByKeySchema=z.object({version:z.literal(1),actor:Address,idempotencyKey:Id,migration:CharterMigrationSchema.nullable()}).strict()
 .refine(v=>!v.migration||v.migration.actor===v.actor&&v.migration.request.idempotencyKey===v.idempotencyKey);
export const CharterMigrationJournalSchema=z.object({version:z.literal(1),identity:z.unknown(),revision:Count,
 request:CharterMigrationRequestSchema.nullable(),migrationId:Id.nullable(),migration:CharterMigrationSchema.nullable(),
 signingStarted:z.boolean(),signed:CharterWireSchema.nullable(),observed:z.array(z.enum(['controlled','cancelled','unknown'])).max(3)}).strict();
export type CharterMigrationJournalRecord=z.infer<typeof CharterMigrationJournalSchema>;

/** Recent originals and the current leader's clan are discovery only. */
export const CharterMigrationActivitySchema=z.object({version:z.literal(1),actor:Address,newActions:z.boolean(),
 currentClan:CharterMigrationSnapshotSchema.shape.clan.extend({authority:z.enum(['legacy','pending','controlled']),migrationId:Id.nullable()}).strict().nullable(),
 items:z.array(z.object({id:Id,clanId:Id,name:z.string().min(CLANS.nameMinLen).max(CLANS.nameMaxLen),tag:z.string().min(CLANS.tagMinLen).max(CLANS.tagMaxLen),status:CharterMigrationSchema.shape.status}).strict()).max(20),
}).strict().superRefine((v,c)=>{if(v.currentClan?.authority==='pending'&&!v.currentClan.migrationId||v.newActions&&v.currentClan?.authority!=='legacy')c.addIssue({code:'custom',message:'Migration discovery differs from current clan authority'});});
export type CharterMigrationActivity=z.infer<typeof CharterMigrationActivitySchema>;
