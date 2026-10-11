package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.tournament.*
import gg.pixelkingdomwars.nativeclient.network.EncryptedStore
import gg.pixelkingdomwars.nativeclient.network.storageNamespace
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.time.Instant
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit
import java.util.UUID
import kotlinx.serialization.json.*

/** Numeric policy comes only from the admitted shared constants catalogue. Item IDs
 * are the symbolic ORDINARY_REFINED_IDS contract; no client reward arithmetic. */
fun tournamentPolicy(catalogue:JsonObject?):JsonObject?=runCatching {
 val c=requireNotNull(catalogue).charterObject("constants");val rules=c.charterObject("PHASE_E_CHARTER_TOURNAMENT")
 val names=setOf("version","entryWeekdayUtc","entryDurationDays","playDurationDays","occupationDurationDays","raidsPerWallet","maxPendingRequestsPerWallet","maxRequestIdentitiesPerWallet","divineSites","maxStarsPerRaid","maxDestructionPerRaid","maxReplayInputBytes")
 require(rules.keys==names);rules.values.forEach{CharterGrammar.number(it)};require(CharterGrammar.number(rules.getValue("version"))==1L)
 JsonObject(rules+mapOf("rosterCap" to c.charterObject("CLANS").getValue("rosterCap"),"freeRaidsPerBaseDay" to c.charterObject("RAID_ENERGY").getValue("freePerDay"),"fragments" to JsonPrimitive("held"),"prizeSource" to JsonPrimitive("funded-existing-refined-stock"),"prizeItems" to JsonArray(listOf("frostglass","heartwood_beams","sunstone_blocks","crownsteel","prismstone_lens","stormalloy","thornsilk","embercore").map(::JsonPrimitive))))
}.getOrNull()
fun validateTournamentPolicy(operation:JsonObject,policy:JsonObject) {
 val t=operation.charterObject("operationTerms");val e=t.charterObject("event");require(e.charterObject("policy")==policy)
 val roster=t.getValue("roster").jsonArray;require(roster.size.toLong() in 1..CharterGrammar.number(policy.getValue("rosterCap")))
 val start=Instant.parse(e.charterText("entryStartsAt"));val utc=start.atOffset(ZoneOffset.UTC);require(utc.dayOfWeek.value%7L==CharterGrammar.number(policy.getValue("entryWeekdayUtc"))&&utc.toLocalTime()==java.time.LocalTime.MIDNIGHT)
 val play=start.plus(CharterGrammar.number(policy.getValue("entryDurationDays")),ChronoUnit.DAYS);val end=play.plus(CharterGrammar.number(policy.getValue("playDurationDays")),ChronoUnit.DAYS)
 require(play==Instant.parse(e.charterText("playStartsAt"))&&end==Instant.parse(e.charterText("playEndsAt"))&&end.plus(CharterGrammar.number(policy.getValue("occupationDurationDays")),ChronoUnit.DAYS)==Instant.parse(e.charterText("occupationEndsAt")))
 require(e.charterObject("budget").keys==policy.getValue("prizeItems").jsonArray.map(CharterGrammar::text).toSet())
}
class TournamentAppPorts(private val charter:CharterPorts,override val transport:TournamentTransport,private val catalogue:()->JsonObject?,private val selectedBase:()->String?,private val battle:suspend (String,String,()->Unit)->Unit):TournamentPorts {
 override fun capture(newAction:Boolean):()->Unit {val captured=charter.capture(newAction);val p=if(newAction)requireNotNull(policy()){"Tournament content is unavailable."} else null;return {captured();if(newAction)check(policy()==p)}}
 override fun trust()=charter.trust()
 override fun cryptoPolicy()=charter.cryptoPolicy()
 override fun policy()=tournamentPolicy(catalogue())
 override fun key()=UUID.randomUUID().toString()
 override fun requireBase(baseId:String){require(selectedBase()==baseId){"Select the original kingdom before this action."}}
 override suspend fun live(prepared:PreparedCharter,operation:JsonObject,guard:()->Unit):()->Unit {
  val q=operation.charterObject("attempt").charterObject("quote");return charter.live(prepared,buildJsonObject{put("context",q.getValue("context"));put("lastValidBlockHeight",q.charterObject("packetInput").getValue("lastValidBlockHeight"))},guard)
 }
 override suspend fun ready(guard:()->Unit)=charter.ready(guard)
 override suspend fun sign(prepared:PreparedCharter,guard:()->Unit,retain:suspend (SignedCharter)->Unit)=charter.sign(prepared,guard,retain)
 override suspend fun hydrate(guard:()->Unit)=charter.hydrate(guard)
 override suspend fun battle(raidId:String,baseId:String,guard:()->Unit)=battle.invoke(raidId,baseId,guard)
}
data class TournamentClient(val repository:TournamentRepository,val wallet:CharterWallet,val configured:Boolean,val policy:()->JsonObject?)
/** Missing installed trust leaves new effects closed; original history stays readable. */
fun AppGraph.tournamentClient(session:SessionGraph,mwa:WalletLogin?,lifecycle:()->CharterLifecycle,independentPins:CharterSigningTrust?=null):TournamentClient {
 holder.requireCurrent(session.session);val identity=StarterIdentity(origin.trimEnd('/'),cluster.id,session.session.wallet)
 val store=TournamentStore(EncryptedStore(application,storageNamespace(origin,"tournament-${cluster.id}-${identity.wallet}")),identity)
 val external=mwa?.let{login->CharterExternalSigner{p,chain,retain,guard->login.signTransactionOnlyWithEvidence(p,chain,session.session.token,retain){holder.requireCurrent(session.session);guard()}}}
 val wallet=CharterWallet(session.session,holder,origin,cluster,socialBinding::isBoundForSecurity,::social,external)
 val port=gameApi.charterClientPort(identity,session.session.token)
 val ordinary=CharterAppPorts(session.session,holder,CharterTransport(port),{independentPins},{content.state.value.catalogue},lifecycle,CharterSessionRpc(session.api,cluster),wallet,android.os.SystemClock::elapsedRealtime,{session.clans.refresh();session.base.refreshWithoutJourneys()})
 val ports=TournamentAppPorts(ordinary,TournamentTransport(TournamentHttpPort(port)),{content.state.value.catalogue},{account.state.value.selectedBaseId}){raidId,base,guard->guard();require(account.state.value.selectedBaseId==base){"Select the original attacking kingdom to resume this battle."};session.battle.resumePending(raidId)}
 return TournamentClient(TournamentRepository(store,ports),wallet,independentPins!=null){tournamentPolicy(content.state.value.catalogue)}
}
