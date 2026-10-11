package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.migration.*
import gg.pixelkingdomwars.nativeclient.network.EncryptedStore
import gg.pixelkingdomwars.nativeclient.network.storageNamespace
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.util.UUID
import kotlinx.serialization.json.*

class MigrationAppPorts(private val charter:CharterPorts,override val transport:MigrationTransport,private val catalogue:()->JsonObject?):MigrationPorts {
 override fun capture(newAction:Boolean)=charter.capture(newAction)
 override fun trust()=charter.trust()
 override fun cryptoPolicy()=charter.cryptoPolicy()
 override fun key()=UUID.randomUUID().toString()
 override fun validate(migration:JsonObject)=MigrationProtocol.validatePolicy(migration,requireNotNull(catalogue()).charterObject("constants").charterObject("CLANS"))
 override suspend fun live(prepared:PreparedCharter,signing:JsonObject,guard:()->Unit)=charter.live(prepared,signing,guard)
 override suspend fun ready(guard:()->Unit)=charter.ready(guard)
 override suspend fun sign(prepared:PreparedCharter,guard:()->Unit,retain:suspend(SignedCharter)->Unit)=charter.sign(prepared,guard,retain)
 override suspend fun hydrate(guard:()->Unit)=charter.hydrate(guard)
}
data class MigrationClient(val repository:MigrationRepository,val wallet:CharterWallet,val configured:Boolean)
fun AppGraph.migrationClient(session:SessionGraph,mwa:WalletLogin?,lifecycle:()->CharterLifecycle,independentPins:CharterSigningTrust?=null):MigrationClient {
 holder.requireCurrent(session.session);val identity=StarterIdentity(origin.trimEnd('/'),cluster.id,session.session.wallet)
 val store=MigrationStore(EncryptedStore(application,storageNamespace(origin,"charter-migration-${cluster.id}-${identity.wallet}")),identity)
 val external=mwa?.let{login->CharterExternalSigner{p,chain,retain,guard->login.signTransactionOnlyWithEvidence(p,chain,session.session.token,retain){holder.requireCurrent(session.session);guard()}}}
 val wallet=CharterWallet(session.session,holder,origin,cluster,socialBinding::isBoundForSecurity,::social,external)
 val port=gameApi.charterClientPort(identity,session.session.token)
 val ordinary=CharterAppPorts(session.session,holder,CharterTransport(port),{independentPins},{content.state.value.catalogue},lifecycle,CharterSessionRpc(session.api,cluster),wallet,android.os.SystemClock::elapsedRealtime,{session.clans.refresh();session.base.refreshWithoutJourneys()})
 return MigrationClient(MigrationRepository(store,MigrationAppPorts(ordinary,MigrationTransport(MigrationHttpPort(port))){content.state.value.catalogue}),wallet,independentPins!=null)
}
