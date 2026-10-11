package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.network.EncryptedStore
import gg.pixelkingdomwars.nativeclient.network.storageNamespace
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Base64
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

/** All game amounts and freshness policy come from admitted canonical content. */
data class CharterAppPolicy(val protocol:CharterProtocolPolicy,val crypto:CharterCryptoPolicy,val observationMaxAgeMs:Long)
fun charterAppPolicy(catalogue:JsonObject?):CharterAppPolicy?=runCatching {
    val c=requireNotNull(catalogue).charterObject("constants");val clans=c.charterObject("CLANS");val policy=c.charterObject("PHASE_E_POLICY")
    val preparation=c.charterObject("PHASE_E_CHARTER_PREPARATION");val transfer=c.charterObject("PHASE_E_CHARTER_TRANSFER");val admission=c.charterObject("PHASE_E_CHARTER_ADMISSION").charterObject("v1");val auction=c.charterObject("PHASE_E_SEEKER_AUCTION")
    fun n(o:JsonObject,k:String)=CharterGrammar.number(o.getValue(k))
    fun i(o:JsonObject,k:String)=n(o,k).also{require(it<=Int.MAX_VALUE)}.toInt()
    val protocol=CharterProtocolPolicy(i(clans,"nameMinLen"),i(clans,"nameMaxLen"),i(clans,"tagMinLen"),i(clans,"tagMaxLen"),n(clans,"createCostShards").toString(),i(transfer,"royaltyBps"),i(policy,"basisPoints"),n(preparation,"coreCreateFeeLamports").toString()).also{it.validate()}
    val crypto=CharterCryptoPolicy(i(preparation,"computeUnitLimit"),n(auction,"maxPolicyPermitTtlSec"),n(admission,"issuedPermitTtlSec"),protocol.coreCreateFeeLamports,protocol.royaltyBps,protocol.basisPoints)
    CharterAppPolicy(protocol,crypto,n(admission,"observationMaxAgeMs").also{require(it>0)})
}.getOrNull()
data class CharterLifecycle(val active:Boolean,val visible:Boolean,val viewEpoch:Long,val actionsAllowed:Boolean,val contentReady:Boolean,val contentIdentity:String?,val battleActive:Boolean,val selectionIdentity:String?=null)
data class CharterClock(val slot:Long,val unixTimestamp:Long)
interface CharterRpcReads {suspend fun genesisHash():String;suspend fun finalizedBlockHeight():Long;suspend fun clock(minimumSlot:Long):CharterClock}
/** The existing authenticated RPC relay supplies reads only; no new wallet send. */
class CharterSessionRpc(private val api:ApiClient,private val cluster:SolanaCluster):CharterRpcReads {
    private val rpc=SolanaRpc{api.post("/rpc/solana/${cluster.id}",it)}
    override suspend fun genesisHash()=rpc.genesisHash()
    override suspend fun finalizedBlockHeight()=rpc.finalizedBlockHeight()
    override suspend fun clock(minimumSlot:Long):CharterClock {
        val raw=api.post("/rpc/solana/${cluster.id}",buildJsonObject{put("jsonrpc","2.0");put("id",1);put("method","getAccountInfo");put("params",buildJsonArray{add("SysvarC1ock11111111111111111111111111111111");add(buildJsonObject{put("encoding","base64");put("commitment","finalized");put("minContextSlot",minimumSlot)})})})
        require(raw["error"]==null);val result=raw.charterObject("result");val slot=CharterGrammar.number(result.charterObject("context").getValue("slot"));require(slot>=minimumSlot)
        val account=result.charterObject("value");require(account.charterText("owner")=="Sysvar1111111111111111111111111111111111111" && !CharterGrammar.bool(account.getValue("executable")))
        val data=account.getValue("data").jsonArray;require(data.size==2 && CharterGrammar.text(data[1])=="base64");val encoded=CharterGrammar.text(data[0]);require(encoded.length==56)
        val bytes=Base64.getDecoder().decode(encoded);require(bytes.size==40 && Base64.getEncoder().encodeToString(bytes)==encoded)
        val timestamp=ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).getLong(32);require(timestamp>=0);return CharterClock(slot,timestamp)
    }
}
/** The accepted bounded RPC gate also fences noncooperative late underlying reads.
 * Its ownership is process-wide per original identity, independent from UI lifetime. */
private object CharterReadGates {private val gates=mutableMapOf<StarterIdentity,RealmSalesRpcGate>();@Synchronized fun forIdentity(id:StarterIdentity)=gates.getOrPut(id){RealmSalesRpcGate()}}
class CharterAppPorts(private val session:AccountSession,private val holder:AccountSessionHolder,override val transport:CharterTransport,
    private val configured:()->CharterSigningTrust?,private val catalogue:()->JsonObject?,private val lifecycle:()->CharterLifecycle,
    private val rpc:CharterRpcReads,private val wallet:CharterWallet,private val monotonicMs:()->Long,private val refreshDomain:suspend ()->Unit,private val timeoutMs:Long=30_000):CharterPorts {
    private val rpcGate=CharterReadGates.forIdentity(transport.identity)
    init {require(timeoutMs in 1..30_000);require(transport.identity.wallet==session.wallet && transport.identity.origin==session.origin.trimEnd('/'))}
    override fun policy()=charterAppPolicy(catalogue())?.protocol
    override fun cryptoPolicy()=charterAppPolicy(catalogue())?.crypto
    override fun trust()=configured()
    override fun key()=UUID.randomUUID().toString()
    override fun capture(newAction:Boolean):()->Unit {
        holder.requireCurrent(session);val page=lifecycle();val pins=if(newAction)requireNotNull(trust()){ "Charter signing is not configured." } else null
        val policy=if(newAction)requireNotNull(charterAppPolicy(catalogue())){"Charter content is unavailable."} else null
        if(newAction)rpcGate.requireIdle()
        val guard={holder.requireCurrent(session);val current=lifecycle();check(current.active && current.visible && current.viewEpoch==page.viewEpoch){"The Charter view changed. Its saved outcome is kept."}
            if(newAction)check(current.actionsAllowed && current.contentReady && !current.battleActive && !current.contentIdentity.isNullOrBlank() && current.contentIdentity==page.contentIdentity && current.selectionIdentity==page.selectionIdentity && trust()==pins && charterAppPolicy(catalogue())==policy){"Charter admission changed."}}
        guard();return guard
    }
    override suspend fun live(prepared:PreparedCharter,signing:JsonObject,guard:()->Unit):()->Unit {
        guard();require(prepared.wallet==session.wallet);val pins=requireNotNull(trust());val expected=pins.toJson().charterObject("deployment").charterText("expectedGenesisHash")
        val policy=requireNotNull(charterAppPolicy(catalogue()));val floor=CharterGrammar.number(signing.charterObject("context").getValue("closingSlot"));val maxHeight=CharterGrammar.number(signing.getValue("lastValidBlockHeight"))
        var sample:CharterClock?=null;val started=monotonicMs();require(started>=0)
        rpcGate.run(timeoutMs,guard){check->
            require(rpc.genesisHash()==expected);check();val height=rpc.finalizedBlockHeight();check();require(height in 0..maxHeight){"Original Charter blockhash has expired."}
            sample=rpc.clock(floor);check();require(requireNotNull(sample).slot>=floor && requireNotNull(sample).unixTimestamp>=prepared.observedUnixTimestamp && requireNotNull(sample).unixTimestamp<=prepared.expiryUnixTimestamp)
        }
        val clock=requireNotNull(sample)
        val fresh={guard();val elapsed=Math.subtractExact(monotonicMs(),started);require(elapsed in 0..policy.observationMaxAgeMs){"Review the Charter transaction again."};require(clock.unixTimestamp.toBigInteger()*1000.toBigInteger()+elapsed.toBigInteger()<=prepared.expiryUnixTimestamp.toBigInteger()*1000.toBigInteger()){ "The original Charter approval expired." };check(trust()==pins && charterAppPolicy(catalogue())==policy)}
        fresh();return fresh
    }
    override suspend fun hydrate(guard:()->Unit){guard();refreshDomain();guard()}
    override suspend fun ready(guard:()->Unit)=wallet.requireAvailable(guard)
    override suspend fun sign(prepared:PreparedCharter,guard:()->Unit,retain:suspend (SignedCharter)->Unit){wallet.sign(prepared,retain,guard)}
}
data class CharterClient(val repository:CharterRepository,val wallet:CharterWallet,val configured:Boolean,val policy:()->CharterAppPolicy?)
/** Null production pins keep approval/delivery closed. Historical GETs remain available. */
fun AppGraph.charterClient(session:SessionGraph,mwa:WalletLogin?,lifecycle:()->CharterLifecycle,independentPins:CharterSigningTrust?=null):CharterClient {
    holder.requireCurrent(session.session);val identity=StarterIdentity(origin.trimEnd('/'),cluster.id,session.session.wallet)
    val store=CharterStore(EncryptedStore(application,storageNamespace(origin,"charter-${cluster.id}-${identity.wallet}")),identity)
    val external=mwa?.let{login->CharterExternalSigner{prepared,chain,retain,guard->login.signTransactionOnlyWithEvidence(prepared,chain,session.session.token,retain){holder.requireCurrent(session.session);guard()}}}
    val wallet=CharterWallet(session.session,holder,origin,cluster,socialBinding::isBoundForSecurity,::social,external)
    val ports=CharterAppPorts(session.session,holder,CharterTransport(gameApi.charterClientPort(identity,session.session.token)),{independentPins},{content.state.value.catalogue},lifecycle,CharterSessionRpc(session.api,cluster),wallet,android.os.SystemClock::elapsedRealtime,session.clans::refresh)
    return CharterClient(CharterRepository(store,ports),wallet,independentPins!=null){charterAppPolicy(content.state.value.catalogue)}
}
