package gg.pixelkingdomwars.nativeclient.ui.phasee

import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.keepEquipmentMarketClient
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.ui.chrome.GamePage
import gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandDestination
import gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandOwner
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.MarketTab
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.keepMarketEntry
import gg.pixelkingdomwars.nativeclient.wallet.WalletLogin
import kotlinx.coroutines.awaitCancellation
import kotlinx.serialization.json.*

/** The same native KEEP owner, hoisted once beside Home; recovery and default-off payment pins stay here. */
@Composable fun KeepEquipmentMarketRegistration(graph:AppGraph,session:SessionGraph,wallet:WalletLogin?,admit:()->Boolean = { true }): FleetCommandOwner {
 val account by graph.account.state.collectAsState();val pack by graph.content.state.collectAsState();val interlock by session.interlock.state.collectAsState();val battle by session.battle.state.collectAsState()
 val lifetime=remember(session,wallet){CharterViewLifetime()};var show by rememberSaveable(session.session.wallet,session.session.origin){mutableStateOf(false)}
    var historyOnly by rememberSaveable(session.session.wallet, session.session.origin) { mutableStateOf(false) }
    // openEntry("BUY" | "SELL" | "SELL:<itemId>") opens live on that tab / item; a new stamp re-applies it to the body.
    var entryTab by rememberSaveable(session.session.wallet, session.session.origin) { mutableStateOf(MarketTab.BUY) }
    var entryItem by rememberSaveable(session.session.wallet, session.session.origin) { mutableStateOf<String?>(null) }
    var entryStamp by rememberSaveable(session.session.wallet, session.session.origin) { mutableStateOf(0) }
    // Inputs reset live remembers; this separate stamp also validates process-restored flags.
    var savedWallet by rememberSaveable { mutableStateOf("") }
    var savedOrigin by rememberSaveable { mutableStateOf("") }
    val actor = PhaseERegistrationActor(session.session.wallet, session.session.origin)
    fun currentPresentation() = phaseERegistrationPresentation(
        PhaseERegistrationActor(savedWallet, savedOrigin), actor, show, historyOnly)
    fun present(next: PhaseERegistrationPresentation) {
        savedWallet = actor.wallet; savedOrigin = actor.origin
        historyOnly = next.historyOnly; show = next.show
    }
    val presentation = currentPresentation()
    SideEffect {
        if (PhaseERegistrationActor(savedWallet, savedOrigin) != actor)
            present(PhaseERegistrationPresentation())
    }

 val lifecycle=LocalLifecycleOwner.current.lifecycle;var foreground by remember(lifecycle){mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED))}
 val opened=remember(lifetime){runCatching{
  val identity=StarterIdentity(graph.origin.trimEnd('/'),graph.cluster.id,session.session.wallet)
  graph.keepEquipmentMarketClient(session,wallet,graph.gameApi.keepEquipmentMarketClientPort(identity,session.session.token),lifecycle={
   val current=graph.content.state.value;val currentBattle=session.battle.state.value
   lifetime.snapshot(current.allowsGameOrders(graph.versionCode)&&session.interlock.state.value.actionsAllowed,current.ready,current.manifest?.contentVersion,
    currentBattle.battleVisible||currentBattle.replay!=null||currentBattle.spectator!=null,"${graph.account.state.value.baseSelectionGeneration}:${graph.account.state.value.selectedBaseId}")
  })
 }}
 val client=opened.getOrNull();val model=client?.let{viewModel<KeepEquipmentMarketViewModel>(key="keep-market-${System.identityHashCode(lifetime)}",factory=viewModelFactory{initializer{KeepEquipmentMarketViewModel(it.repository,it.wallet)}})}
 val state=model?.state?.collectAsState()?.value
 val historyRows=state?.let(PhaseEReceiptRows::market).orEmpty()
 DisposableEffect(lifetime,model,lifecycle){lifetime.setOpen(presentation.show);if(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED))lifetime.start()
  val observer=LifecycleEventObserver{_,event->when(event){Lifecycle.Event.ON_START->{lifetime.start();foreground=true};Lifecycle.Event.ON_STOP->{lifetime.stop();foreground=false;model?.dismiss()};else->Unit}}
  lifecycle.addObserver(observer);onDispose{lifecycle.removeObserver(observer);lifetime.dispose();model?.dismiss()}
 }
 val activeBattle=battle.battleVisible||battle.replay!=null||battle.spectator!=null;val allowed=pack.allowsGameOrders(graph.versionCode)&&interlock.actionsAllowed
 LaunchedEffect(model,lifecycle,show,pack.ready,pack.manifest?.contentVersion,allowed,activeBattle,account.baseSelectionGeneration){lifetime.invalidate();model?.dismiss();if(presentation.show)lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED){model?.foreground();awaitCancellation()}}
 fun ownerCurrent() = graph.sessionGraph.value === session && lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
 fun historyCurrent() = ownerCurrent() && currentPresentation().body == PhaseERegistrationBody.RECEIPTS
 fun refused() { gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts.post("Market controls are no longer current. Open the Market again.") }
 val close={lifetime.setOpen(false);model?.dismiss();present(currentPresentation().close())}
 val open: () -> Unit = { if(ownerCurrent() && admit()) { entryTab=MarketTab.BUY;entryItem=null;lifetime.setOpen(true);present(currentPresentation().openLive()) } else refused() }
 val openEntry: (String) -> Unit = { name -> if(ownerCurrent() && admit()) { val entry=keepMarketEntry(name);entryTab=entry.tab;entryItem=entry.itemId;entryStamp+=1;lifetime.setOpen(true);present(currentPresentation().openLive()) } else refused() }
 // Header art: the selected kingdom's completed Market level and its exported art tier (no client copy of either).
 val home by session.base.state.collectAsState()
 val marketLevel=home.base?.takeIf{it.baseId!=null&&it.baseId.equals(account.selectedBaseId,ignoreCase=true)}?.buildings
  ?.filter{it.type=="market"&&it.level>0&&!it.underConstruction}?.maxOfOrNull{it.level}
 val marketTier=keepMarketArtTier(pack.catalogue,marketLevel)
 val openHistory: () -> Unit = { if(ownerCurrent() && admit()) { lifetime.setOpen(true);present(currentPresentation().openHistory()) } else refused() }
 PhaseEDoorEntry(PhaseEActivity.KEEP_MARKET,canLaunch={ownerCurrent()},onHistory=openHistory,onLaunch=open)
 return FleetCommandOwner(FleetCommandDestination.KEEP_MARKET, available = true, isOpen = presentation.show, open = open, close = close, openHistory = openHistory, openEntry = openEntry) {
  if(model==null)PhaseEDesignedNotice("KEEP MARKET","Market","Saved market storage is unavailable. Its originals have been preserved; restore access before continuing.",close)
  else if(presentation.body == PhaseERegistrationBody.RECEIPTS) PhaseEReceiptHistoryScreen("MARKET RECEIPTS",historyRows,state?.busy==true,state?.error,
   onRefresh={if(historyCurrent())model.refresh()},onCheck={check ->
    if(historyCurrent() && PhaseEReceiptRows.market(model.state.value).any { it.check == check }) {
     if(check.source==PhaseEReceiptSource.SERVER) {
      (model.state.value.history?.get("items") as? JsonArray)?.mapNotNull{it as? JsonObject}
       ?.firstOrNull{(it["id"] as? JsonPrimitive)?.content==check.id}?.let{model.history(it)}
     } else model.select(check.id)
    }
   },onBack=close)
  else gg.pixelkingdomwars.nativeclient.ui.sheets.craft.KeepMarketHomeBody(model,account.selectedBaseId,foreground&&charterActionsAllowed(true,lifetime.snapshot(allowed,pack.ready,pack.manifest?.contentVersion,activeBattle)),client.configured,close,actor.wallet,::ownerCurrent,onHistory=openHistory,
   level=marketLevel,tier=marketTier,entryTab=entryTab,entryItem=entryItem,entryStamp=entryStamp)
 }
}

/** The Market header's art tier from the exported catalogue (constants.ART_V2 tiers / levelsPerTier), the same rule as
 *  scene/SceneMappers.kt:83-87. S1's craftBuildingArtTier is this same rule; a later cleanup should merge the two. */
private fun keepMarketArtTier(catalogue:JsonObject?,level:Int?):Int? {
 if(level==null||level<=0)return null
 val art=((catalogue?.get("constants") as? JsonObject)?.get("ART_V2") as? JsonObject)?:return null
 val tiers=(art["tiers"] as? JsonPrimitive)?.intOrNull?.takeIf{it>0}?:return null
 val levelsPerTier=(art["levelsPerTier"] as? JsonPrimitive)?.intOrNull?.takeIf{it>0}?:return null
 return minOf(tiers,(level-1)/levelsPerTier+1)
}
