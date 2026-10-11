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
import gg.pixelkingdomwars.nativeclient.data.equipmentClient
import gg.pixelkingdomwars.nativeclient.ordinaryequipment.EquipmentPolicy
import gg.pixelkingdomwars.nativeclient.ui.chrome.GamePage
import gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandDestination
import gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandOwner
import kotlinx.coroutines.awaitCancellation

/** One owned equipment mount; existing starter/crafting surfaces stay intact. N-C5 GAMEPLAY-UI-A: returns its command owner
 *  to the common Home root (no nested content, no UI of its own); the model/lifetime owner is unchanged. */
@Composable fun EquipmentRegistration(graph:AppGraph,session:SessionGraph,admit:() -> Boolean = { true }): FleetCommandOwner {
 val account by graph.account.state.collectAsState();val content by graph.content.state.collectAsState();val interlock by session.interlock.state.collectAsState();val battle by session.battle.state.collectAsState()
 val lifetime=remember(session){CharterViewLifetime()};var show by rememberSaveable(session.session.wallet,session.session.origin){mutableStateOf(false)}
    var historyOnly by rememberSaveable(session.session.wallet, session.session.origin) { mutableStateOf(false) }
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
 val opened=remember(lifetime){runCatching{graph.equipmentClient(session){val c=graph.content.state.value;val b=session.battle.state.value;lifetime.snapshot(c.allowsGameOrders(graph.versionCode)&&session.interlock.state.value.actionsAllowed,c.ready,c.manifest?.contentVersion,b.battleVisible||b.replay!=null||b.spectator!=null,"${graph.account.state.value.baseSelectionGeneration}:${graph.account.state.value.selectedBaseId}")}}}
 val model=opened.getOrNull()?.let{viewModel<EquipmentViewModel>(key="equipment-${System.identityHashCode(lifetime)}",factory=viewModelFactory{initializer{EquipmentViewModel(it)}})}
 val state=model?.state?.collectAsState()?.value
 val historyRows=state?.let(PhaseEReceiptRows::equipment).orEmpty()
 DisposableEffect(lifetime,model,lifecycle){lifetime.setOpen(presentation.show);if(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED))lifetime.start();val observer=LifecycleEventObserver{_,event->when(event){Lifecycle.Event.ON_START->{lifetime.start();foreground=true};Lifecycle.Event.ON_STOP->{lifetime.stop();foreground=false;model?.dismiss()};else->Unit}};lifecycle.addObserver(observer);onDispose{lifecycle.removeObserver(observer);lifetime.dispose();model?.dismiss()}}
 val battleActive=battle.battleVisible||battle.replay!=null||battle.spectator!=null;val orders=content.allowsGameOrders(graph.versionCode)&&interlock.actionsAllowed;val policy=EquipmentPolicy.catalogue(content.catalogue)
 LaunchedEffect(model,lifecycle,show,content.ready,content.manifest?.contentVersion,orders,battleActive,account.baseSelectionGeneration){lifetime.invalidate();model?.dismiss();if(presentation.show)lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED){model?.foreground();awaitCancellation()}}
 val close={lifetime.setOpen(false);model?.dismiss();present(currentPresentation().close())};val allowed=foreground&&charterActionsAllowed(policy!=null,lifetime.snapshot(orders,content.ready,content.manifest?.contentVersion,battleActive))
 fun ownerCurrent() = graph.sessionGraph.value === session && lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
 val presentedBase=account.selectedBaseId;val presentedGeneration=account.baseSelectionGeneration
 val presentedContent=content.manifest;val presentedReady=content.ready
 val equipmentIdentity=remember(session){gg.pixelkingdomwars.nativeclient.starter.StarterIdentity(graph.origin.trimEnd('/'),graph.cluster.id,actor.wallet)}
 fun equipmentPresentationCurrent():Boolean {
  val a=graph.account.state.value;val c=graph.content.state.value;val b=session.battle.state.value
  return ownerCurrent()&&currentPresentation().body==PhaseERegistrationBody.LIVE&&
   a.selectedBaseId==presentedBase&&a.baseSelectionGeneration==presentedGeneration&&
   c.manifest===presentedContent&&c.ready==presentedReady&&!b.battleVisible&&b.replay==null&&b.spectator==null
 }
 fun historyCurrent() = ownerCurrent() && currentPresentation().body == PhaseERegistrationBody.RECEIPTS
 val open: () -> Unit = {if(ownerCurrent() && admit()){lifetime.setOpen(true);present(currentPresentation().openLive())}}
 val openHistory: () -> Unit = {if(ownerCurrent() && admit()){lifetime.setOpen(true);present(currentPresentation().openHistory())}}
 PhaseEDoorEntry(PhaseEActivity.WORKSHOP,canLaunch={ownerCurrent()},onHistory=openHistory,onLaunch=open)
 return FleetCommandOwner(FleetCommandDestination.EQUIPMENT, available = true, isOpen = presentation.show, open = open, close = close, openHistory = openHistory) {
  if(model==null)PhaseEDesignedNotice("EXPEDITION EQUIPMENT","Equipment","Saved equipment storage is unavailable. Restore access to recover its originals.",close)
  else if(presentation.body == PhaseERegistrationBody.RECEIPTS) PhaseEReceiptHistoryScreen("EQUIPMENT RECEIPTS",historyRows,state?.busy==true,state?.error,
   onRefresh={if(historyCurrent())model.refresh()},onCheck={check ->
    if(historyCurrent() && PhaseEReceiptRows.equipment(model.state.value).any { it.check == check })model.select(check.id)
   },onBack=close)
  else EquipmentScreen(model,presentedBase,allowed,close,equipmentIdentity,presentedGeneration,presentedContent,
   ::equipmentPresentationCurrent,openHistory)
 }
}
