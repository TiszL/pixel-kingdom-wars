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
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.ui.chrome.*

internal fun fragmentEntryAvailable(state:DivineFragmentState?)=state?.available==true||state?.journal?.commands?.isNotEmpty()==true

/** Original recovery remains reachable independently of issuer admission. */
@Composable fun DivineFragmentRegistration(graph:AppGraph,session:SessionGraph,bases:@Composable ()->Unit){
 val account by graph.account.state.collectAsState();val content by graph.content.state.collectAsState();val interlock by session.interlock.state.collectAsState()
 // divine-fragments #155 names the kingdom ("into Ironhold's stores"): the selected base's own snapshot, never another kingdom's.
 val base by session.base.state.collectAsState();val kingdomName=base.base?.takeIf{account.selectedBaseId!=null&&it.baseId==account.selectedBaseId}?.player?.name?.takeIf{it.isNotBlank()}
 val lifetime=remember(session){CharterViewLifetime()};var show by rememberSaveable(session.session.wallet,session.session.origin){mutableStateOf(false)}
 val lifecycle=LocalLifecycleOwner.current.lifecycle;var foreground by remember(lifecycle){mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED))}
 val opened=remember(lifetime){runCatching{graph.divineFragmentClient(session){val c=graph.content.state.value;lifetime.snapshot(c.allowsGameOrders(graph.versionCode)&&session.interlock.state.value.actionsAllowed,c.ready,c.manifest?.contentVersion,!session.battle.activationAllowed()||session.battle.state.value.loading,"${graph.account.state.value.baseSelectionGeneration}:${graph.account.state.value.selectedBaseId}")}}}
 val model=opened.getOrNull()?.let{viewModel<DivineFragmentViewModel>(key="fragments-${System.identityHashCode(lifetime)}",factory=viewModelFactory{initializer{DivineFragmentViewModel(it)}})}
 DisposableEffect(lifetime,model,lifecycle){lifetime.setOpen(show);if(foreground)lifetime.start();val observer=LifecycleEventObserver{_,e->when(e){Lifecycle.Event.ON_START->{foreground=true;lifetime.start();model?.foreground()};Lifecycle.Event.ON_STOP->{foreground=false;lifetime.stop();model?.dismiss()};else->Unit}};lifecycle.addObserver(observer);onDispose{lifecycle.removeObserver(observer);lifetime.dispose();model?.dismiss()}}
 LaunchedEffect(account.baseSelectionGeneration,content.manifest?.contentVersion,interlock.actionsAllowed,foreground){lifetime.invalidate();model?.dismiss()}
 val state=model?.state?.collectAsState()?.value
 LaunchedEffect(model,foreground){if(foreground)model?.foreground()}
 val close={lifetime.setOpen(false);model?.dismiss();show=false}
 // The designed sheet is the home body and confirms DELIVER on its Seal; the original screen keeps saved outcomes and history.
 if(show){if(model==null)PhaseEDesignedNotice("CRYSTAL FRAGMENTS","Crystal fragments","Saved fragment storage cannot be opened. Restore access; no new request was sent.",close)else DivineFragmentsHome(model,account.selectedBaseId,foreground&&content.allowsGameOrders(graph.versionCode)&&interlock.actionsAllowed,close,kingdomName)}
 else Column(Modifier.fillMaxSize()){if(fragmentEntryAvailable(state))PhaseEActivityEntry(PhaseEActivity.FRAGMENTS, onClick = {lifetime.setOpen(true);show=true;model?.local()});Box(Modifier.weight(1f)){bases()}}
}
