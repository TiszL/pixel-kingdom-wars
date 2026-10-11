/** Bounded recognized RPC failure shapes; no finality or retry authority. */
const safe=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
// RPC enum names from installed @solana/rpc-types; legacy Agave also serializes
// BorshIoError with a string payload. Unknown future variants remain unresolved.
const TRANSACTION_ERRORS=new Set(('AccountBorrowOutstanding AccountInUse AccountLoadedTwice AccountNotFound AddressLookupTableNotFound AlreadyProcessed BlockhashNotFound CallChainTooDeep ClusterMaintenance InsufficientFundsForFee InvalidAccountForFee InvalidAccountIndex InvalidAddressLookupTableData InvalidAddressLookupTableIndex InvalidAddressLookupTableOwner InvalidLoadedAccountsDataSizeLimit InvalidProgramForExecution InvalidRentPayingAccount InvalidWritableAccount MaxLoadedAccountsDataSizeExceeded MissingSignatureForFee ProgramAccountNotFound ResanitizationNeeded SanitizeFailure SignatureFailure TooManyAccountLocks UnbalancedTransaction UnsupportedVersion WouldExceedAccountDataBlockLimit WouldExceedAccountDataTotalLimit WouldExceedMaxAccountCostLimit WouldExceedMaxBlockCostLimit WouldExceedMaxVoteCostLimit').split(' '));
const INSTRUCTION_ERRORS=new Set(('AccountAlreadyInitialized AccountBorrowFailed AccountBorrowOutstanding AccountDataSizeChanged AccountDataTooSmall AccountNotExecutable AccountNotRentExempt ArithmeticOverflow BorshIoError BuiltinProgramsMustConsumeComputeUnits CallDepth ComputationalBudgetExceeded DuplicateAccountIndex DuplicateAccountOutOfSync ExecutableAccountNotRentExempt ExecutableDataModified ExecutableLamportChange ExecutableModified ExternalAccountDataModified ExternalAccountLamportSpend GenericError IllegalOwner Immutable IncorrectAuthority IncorrectProgramId InsufficientFunds InvalidAccountData InvalidAccountOwner InvalidArgument InvalidError InvalidInstructionData InvalidRealloc InvalidSeeds MaxAccountsDataAllocationsExceeded MaxAccountsExceeded MaxInstructionTraceLengthExceeded MaxSeedLengthExceeded MissingAccount MissingRequiredSignature ModifiedProgramId NotEnoughAccountKeys PrivilegeEscalation ProgramEnvironmentSetupFailure ProgramFailedToCompile ProgramFailedToComplete ReadonlyDataModified ReadonlyLamportChange ReentrancyNotAllowed RentEpochModified UnbalancedInstruction UninitializedAccount UnsupportedProgramId UnsupportedSysvar').split(' '));
function member(v:unknown,set:Set<string>):boolean{return typeof v==='string'&&v.length<=64&&set.has(v);}
function single(v:unknown):[string,unknown]|null{
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.getPrototypeOf(v)!==Object.prototype)return null;
 let field:string|undefined;for(const k in v){if(field!==undefined)return null;field=k;}
 return field===undefined?null:[field,(v as Record<string,unknown>)[field]];
}
export function isFailedSolanaExecution(v:unknown,instructions:number,accounts:number):boolean{
 if(member(v,TRANSACTION_ERRORS))return true;
 const entry=single(v);if(!entry)return false;const [tag,value]=entry;
 const index=(n:unknown,max:number)=>safe(n)&&n<max;
 if(tag==='DuplicateInstruction')return index(value,instructions);
 if(tag==='InsufficientFundsForRent'||tag==='ProgramExecutionTemporarilyRestricted'){
  const detail=single(value);return detail?.[0]==='account_index'&&index(detail[1],accounts);
 }
 if(tag!=='InstructionError'||!Array.isArray(value)||value.length!==2||!index(value[0],instructions))return false;
 if(member(value[1],INSTRUCTION_ERRORS))return true;
 const detail=single(value[1]);return !!detail&&(detail[0]==='Custom'&&safe(detail[1])&&detail[1]<=0xffffffff||detail[0]==='BorshIoError'&&typeof detail[1]==='string'&&detail[1].length<=256);
}
