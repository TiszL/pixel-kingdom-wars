package gg.pixelkingdomwars.nativeclient.wallet

import com.solana.publickey.ProgramDerivedAddress
import com.solana.publickey.SolanaPublicKey
import org.bouncycastle.math.ec.rfc8032.Ed25519
import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.security.MessageDigest
import java.util.Base64

/** Independent application pin; never installed from a preparation response. */
data class MiningClaimOrderedPin(val address:String,val dataSha256:String)
data class MiningClaimOrderedFormat(val address:String,val owner:String,val executable:Boolean,val dataHex:String,val slot:Long,
 val expectedAddress:String,val expectedDataSha256:String,val blockhashContextSlot:Long)

/** Exact config/vault/mint ALT and purpose-specific v0 instructions. This compiler
 * owns account ordering independently of web3 and never interprets arbitrary wallet messages. */
internal suspend fun prepareOrderedMiningClaim(input:MiningClaimSigningInput,pin:MiningClaimOrderedPin,ordinal:Int,computeUnitLimit:Int):PreparedMiningClaim {
 require(computeUnitLimit>0&&input.proof.size<=16&&input.transactions.size in 1..2&&ordinal in input.transactions.indices)
 val p=input.copy(proof=input.proof.toList(),transactions=input.transactions.map{it.copy(lookupTables=it.lookupTables.toList())});val f=requireNotNull(p.orderedFormat)
 require(pin.address==f.address&&pin.address==f.expectedAddress&&pin.dataSha256==f.expectedDataSha256&&f.owner=="AddressLookupTab1e1111111111111111111111111"&&!f.executable)
 require(f.dataHex.matches(Regex("[0-9a-f]{304}")));val data=f.dataHex.chunked(2).map{it.toInt(16).toByte()}.toByteArray();require(MessageDigest.getInstance("SHA-256").digest(data).joinToString(""){"%02x".format(it)}==pin.dataSha256)
 fun number(bytes:ByteArray)=BigInteger(1,bytes.reversedArray())
 require(number(data.copyOfRange(0,4))==BigInteger.ONE&&number(data.copyOfRange(4,12))==BigInteger.ONE.shiftLeft(64)-BigInteger.ONE&&data[21]==0.toByte())
 require(f.slot in 0..9_007_199_254_740_991L&&f.blockhashContextSlot in f.slot..9_007_199_254_740_991L&&number(data.copyOfRange(12,20))<BigInteger.valueOf(f.slot)&&(data[20].toInt()and 255)<=3)
 fun key(v:String):ByteArray {require(v.length in 32..44);return publicKeyBytes(v).also{require(it.size==32&&base58(it)==v)}}
 fun u64(v:String,positive:Boolean=false):ByteArray {require(v.matches(Regex("0|[1-9][0-9]{0,19}")));val n=v.toBigInteger();require(n.bitLength()<=64&&(!positive||n.signum()>0));return ByteArray(8){n.shiftRight(it*8).toByte()}}
 val t=p.identity;listOf(t.genesisHash,t.programId,t.configAddress,t.keepMint,t.reserveOwner).forEach(::key)
 val wallet=key(p.wallet);require(Ed25519.validatePublicKeyFull(wallet,0));val program=key(t.programId);val mint=key(t.keepMint);val token=key("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");val ataProgram=key("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");val system=ByteArray(32)
 val sequence=u64(p.rootSequence,true);val keep=u64(p.cumulativeKeepBaseUnits,true);val renown=u64(p.cumulativeRenown);val days=u64(p.cumulativeDays);require(p.cumulativeRenown.toBigInteger()<=p.cumulativeDays.toBigInteger())
 require(p.wallet==p.leafWallet&&p.rootSequence==p.leafRootSequence)
 suspend fun pda(seed:String,tail:ByteArray?=null)=ProgramDerivedAddress.find(listOfNotNull(seed.toByteArray(),tail),SolanaPublicKey(program)).getOrThrow().bytes
 suspend fun ata(owner:ByteArray)=ProgramDerivedAddress.find(listOf(owner,token,mint),SolanaPublicKey(ataProgram)).getOrThrow().bytes
 val config=pda("economy");require(base58(config)==t.configAddress);val vault=ata(config);val destination=ata(wallet);val miner=pda("miner",wallet);val renownAccount=pda("renown",wallet);val root=pda("alloc",sequence)
 val addresses=List(3){data.copyOfRange(56+it*32,88+it*32)};require(addresses.zip(listOf(config,vault,mint)).all{(a,b)->a.contentEquals(b)})
 fun meta(k:ByteArray,w:Boolean=false,s:Boolean=false)=AccountMeta(k,s,w)
 val compute=Instruction(key("ComputeBudget111111111111111111111111111111"),emptyList(),byteArrayOf(2)+ByteArray(4){(computeUnitLimit ushr(it*8)).toByte()})
 val setup=buildList {
  if(p.needsAta)add(Instruction(ataProgram,listOf(meta(wallet,true,true),meta(destination,true),meta(wallet),meta(mint),meta(system),meta(token)),byteArrayOf(1)))
  if(p.needsMinerRecords)add(Instruction(program,listOf(meta(wallet,true,true),meta(miner,true),meta(renownAccount,true),meta(system)),byteArrayOf(119,14,190.toByte(),166.toByte(),208.toByte(),181.toByte(),158.toByte(),100)+wallet))
 }
 val proof=p.proof.fold(ByteArray(0)){bytes,node->require(node.hash.matches(Regex("[0-9a-f]{64}")));bytes+node.hash.chunked(2).map{it.toInt(16).toByte()}.toByteArray()+u64(node.sumBaseUnits)+byteArrayOf(if(node.isLeft)1 else 0)}
 val claim=Instruction(program,listOf(meta(wallet,s=true),meta(config,true),meta(root,true),meta(miner,true),meta(renownAccount,true),meta(vault,true),meta(destination,true),meta(mint),meta(token)),byteArrayOf(222.toByte(),36,64,123,32,17,219.toByte(),8)+sequence+keep+renown+days+byteArrayOf(p.proof.size.toByte(),0,0,0)+proof)
 require(p.transactions.size==if(setup.isEmpty())1 else 2)
 for((index,tx)in p.transactions.withIndex()){
  require(tx.ordinal==index&&tx.version=="v0"&&tx.feePayer==p.wallet&&tx.blockhash==p.transactions[0].blockhash&&tx.kind==if(setup.isNotEmpty()&&index==0)"setup" else "claim")
  val instructions=listOf(compute)+(if(tx.kind=="setup")setup else listOf(claim));val compiled=compileOrderedMiningMessage(wallet,key(tx.blockhash),instructions,key(f.address),addresses)
  require(tx.lookupTables==listOf(f.address))
  require(tx.message.length<=1556&&tx.message.length%4==0);val actual=Base64.getDecoder().decode(tx.message);require(actual.size+65<=1232&&Base64.getEncoder().encodeToString(actual)==tx.message&&actual.contentEquals(compiled.first)) {"Ordered mining packet differs from its canonical instructions"}
 }
 return PreparedMiningClaim(p.wallet,Base64.getDecoder().decode(p.transactions[ordinal].message),ordinal)
}
private fun compileOrderedMiningMessage(wallet:ByteArray,blockhash:ByteArray,instructions:List<Instruction>,table:ByteArray,addresses:List<ByteArray>):Pair<ByteArray,Boolean>{
 val keys=linkedMapOf<String,AccountMeta>();val programs=instructions.map{base58(it.programId)}.toSet()
 fun add(m:AccountMeta){val k=base58(m.key);val old=keys[k];keys[k]=if(old==null)m else old.copy(signer=old.signer||m.signer,writable=old.writable||m.writable)}
 add(AccountMeta(wallet,true,true));for(ix in instructions){add(AccountMeta(ix.programId,false,false));ix.keys.forEach(::add)}
 val lookup=keys.values.filter{!it.signer&&base58(it.key) !in programs&&addresses.any{a->a.contentEquals(it.key)}}
 val writable=lookup.filter{it.writable};val readonly=lookup.filter{!it.writable};val loaded=(writable+readonly).map{base58(it.key)}.toSet()
 val static=keys.values.filter{base58(it.key) !in loaded}.sortedWith(compareByDescending<AccountMeta>{it.signer}.thenByDescending{it.writable});require(static.count{it.signer}==1&&static.first().key.contentEquals(wallet))
 val ordered=static+writable+readonly;val indices=ordered.mapIndexed{i,m->base58(m.key) to i}.toMap();require(ordered.size<=32)
 val bytes=ByteArrayOutputStream().apply{
  write(128);write(1);write(0);write(static.count{!it.signer&&!it.writable});write(compactU16(static.size));static.forEach{write(it.key)};write(blockhash);write(compactU16(instructions.size))
  for(ix in instructions){write(indices.getValue(base58(ix.programId)));write(compactU16(ix.keys.size));ix.keys.forEach{write(indices.getValue(base58(it.key)))};write(compactU16(ix.data.size));write(ix.data)}
  write(if(lookup.isEmpty())0 else 1);if(lookup.isNotEmpty()){write(table);write(compactU16(writable.size));writable.forEach{m->write(addresses.indexOfFirst{it.contentEquals(m.key)})};write(compactU16(readonly.size));readonly.forEach{m->write(addresses.indexOfFirst{it.contentEquals(m.key)})}}
 }.toByteArray();return bytes to lookup.isNotEmpty()
}

/** Bounded historical custody check. This does not grant new signing authority;
 * new approval separately reconstructs the entire ordered plan with installed pins. */
fun verifyOrderedMiningClaimWire(wallet:String,blockhash:String,messageBase64:String,wire:String,ordinal:Int):SignedMiningClaim {
 require(ordinal in 0..1&&messageBase64.length<=1556&&wire.length<=1644);val message=Base64.getDecoder().decode(messageBase64);require(message.size in 1..1167&&Base64.getEncoder().encodeToString(message)==messageBase64)
 var offset=0
 fun byte():Int{require(offset<message.size);return message[offset++].toInt()and 255}
 fun compact():Int{var n=0;for(i in 0..2){val b=byte();require(i<2||b<=3);n=n or ((b and 127)shl(i*7));if(b<128){require(i==0||b!=0);return n}};error("Invalid short vector")}
 fun take(n:Int):ByteArray{require(n>=0&&n<=message.size-offset);return message.copyOfRange(offset,offset+n).also{offset+=n}}
 require(byte()==128&&byte()==1&&byte()==0);val ro=byte();val accounts=compact();require(accounts in 1..16&&ro<accounts);require(base58(take(32))==wallet);take((accounts-1)*32);require(base58(take(32))==blockhash)
 val ix=compact();require(ix in 2..3);var maximumIndex=0
 repeat(ix){require(byte()<accounts);val n=compact();require(n<=9);repeat(n){maximumIndex=maxOf(maximumIndex,byte())};val len=compact();require(len<=700);take(len)}
 val tables=compact();require(tables in 0..1);var loaded=0
 repeat(tables){take(32);val indices=mutableSetOf<Int>();repeat(2){val count=compact();require(count<=3);repeat(count){val index=byte();require(index in 0..2&&indices.add(index));loaded++}}}
 require(maximumIndex<accounts+loaded&&offset==message.size)
 return PreparedMiningClaim(wallet,message,ordinal).verifySignedBase64(wire)
}
