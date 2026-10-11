import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import {divineTrialCanonicalJson} from '@shardkeep/shared/divineTrials';
import {DivineTrialEncounterSchema,DivineTrialAttemptSchema,DivineTrialEventSchema,type DivineTrialEncounter} from '@shardkeep/shared/divineTrialsApi';
export function need(v:unknown,message='The original Divine trial differs.'):asserts v{if(!v)throw Error(message);}
export const same=(a:unknown,b:unknown)=>divineTrialCanonicalJson(a)===divineTrialCanonicalJson(b);
export const trialHash=(v:unknown)=>bytesToHex(sha256(new TextEncoder().encode(divineTrialCanonicalJson(v))));
export function verifyEncounter(raw:unknown):DivineTrialEncounter{const v=DivineTrialEncounterSchema.parse(raw),{inputSha256,...body}=v;need(trialHash(body)===inputSha256,'The fixed encounter commitment differs.');return v;}
export function verifyAttempt(raw:unknown){const a=DivineTrialAttemptSchema.parse(raw);verifyEncounter(a.encounter);if(a.result)need(trialHash({encounter:a.encounter,orders:a.orders})===a.result.inputSha256,'The recorded result belongs to another plan.');return a;}
export function verifyEvent(raw:unknown){const e=DivineTrialEventSchema.parse(raw);verifyEncounter(e.encounter);return e;}
