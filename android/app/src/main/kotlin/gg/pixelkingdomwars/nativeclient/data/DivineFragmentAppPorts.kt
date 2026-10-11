package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.divinefragments.*
import gg.pixelkingdomwars.nativeclient.network.EncryptedStore
import gg.pixelkingdomwars.nativeclient.network.storageNamespace
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import java.util.UUID
import kotlinx.serialization.json.JsonObject

class DivineFragmentAppPorts(private val session:AccountSession,private val holder:AccountSessionHolder,
 override val transport:DivineFragmentTransport,private val catalogue:()->JsonObject?,private val lifecycle:()->CharterLifecycle,
 private val selected:()->String?,private val requireOwned:(String)->Unit,private val refreshDomain:suspend()->Unit):DivineFragmentPorts {
 init{require(transport.identity.wallet==session.wallet&&transport.identity.origin==session.origin.trimEnd('/'))}
 override fun rules(policy:JsonObject)=DivineFragmentRules.installed(policy,requireNotNull(catalogue()){"Fragment validation content is unavailable. Saved receipts remain available."})
 override fun selectedBase()=selected()
 override fun owned(base:String){holder.requireCurrent(session);requireOwned(base)}
 override fun key()=UUID.randomUUID().toString()
 override fun discoveryGuard():()->Unit {holder.requireCurrent(session);val guard={holder.requireCurrent(session);check(lifecycle().active)};guard();return guard}
 override fun capture(destination:Boolean):()->Unit {holder.requireCurrent(session);val initial=lifecycle();val guard={holder.requireCurrent(session);val now=lifecycle();check(now.active&&now.visible&&now.viewEpoch==initial.viewEpoch){"Fragment view changed. Its original request remains saved."};if(destination)check(now.actionsAllowed&&now.contentReady&&!now.battleActive&&now.selectionIdentity==initial.selectionIdentity&&now.contentIdentity==initial.contentIdentity){"Destination changed. Review the original request again."}};guard();return guard}
 override suspend fun refresh(guard:()->Unit){guard();refreshDomain();guard()}
}
fun AppGraph.divineFragmentClient(session:SessionGraph,lifecycle:()->CharterLifecycle):DivineFragmentRepository {
 holder.requireCurrent(session.session);val id=StarterIdentity(origin.trimEnd('/'),cluster.id,session.session.wallet)
 val store=DivineFragmentStore(EncryptedStore(application,storageNamespace(origin,"divine-fragments-${cluster.id}-${id.wallet}")),id)
 val ports=DivineFragmentAppPorts(session.session,holder,DivineFragmentTransport(DivineFragmentHttpPort(gameApi.charterClientPort(id,session.session.token))),{content.state.value.catalogue},lifecycle,{account.state.value.selectedBaseId},{base->val a=account.state.value;val d=requireNotNull(a.directory);check(a.selectedBaseId==base&&d.enabled&&d.stableMutations&&d.bases.any{it.id==base&&it.selectable}){"Select a currently owned stable kingdom."}},{account.refreshDirectory();account.refreshIdentity()})
 return DivineFragmentRepository(store,ports)
}
