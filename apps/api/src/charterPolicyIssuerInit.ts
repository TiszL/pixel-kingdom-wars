/** Explicit OFFLINE journal creation; server startup never calls this command. */
import {pathToFileURL} from 'node:url';
import {loadCharterIssuerJournalConfig} from './charterPolicyIssuerConfig';
import {initializeCharterIssuerJournal} from './charterPolicyIssuerJournal';
export async function main(argv:string[],env:NodeJS.ProcessEnv=process.env,io={print:(line:string)=>console.log(line),printError:(line:string)=>console.error(line)}):Promise<number>{
 if(argv.length!==1||argv[0]!=='initialize'){io.printError('usage: charter-policy-issuer-init initialize');return 2;}
 try{const {journalFile,domain}=loadCharterIssuerJournalConfig(env);await initializeCharterIssuerJournal(journalFile,domain);io.print('CHARTER_ISSUER_JOURNAL_INITIALIZED');return 0;}
 catch{io.printError('CHARTER_ISSUER_INIT_REFUSED');return 1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await main(process.argv.slice(2));
