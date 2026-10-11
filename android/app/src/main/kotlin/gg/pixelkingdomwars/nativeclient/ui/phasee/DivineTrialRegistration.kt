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
import gg.pixelkingdomwars.nativeclient.divine.*

/** Exclusive Bases child: an ordinary battle surface is never mounted under a trial. */
@Composable fun DivineTrialRegistration(graph:AppGraph,session:SessionGraph,bases:@Composable ()->Unit) {
 val account by graph.account.state.collectAsState();val content by graph.content.state.collectAsState();val interlock by session.interlock.state.collectAsState();val battle by session.battle.state.collectAsState()
 val live=battle.coordinator?.state?.collectAsState()?.value
 val lifetime=remember(session){CharterViewLifetime()};var show by rememberSaveable(session.session.wallet,session.session.origin){mutableStateOf(false)}
 val lifecycle=LocalLifecycleOwner.current.lifecycle;var foreground by remember(lifecycle){mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED))}
 val opened=remember(lifetime){runCatching{graph.divineTrialClient(session){val c=graph.content.state.value;lifetime.snapshot(c.allowsGameOrders(graph.versionCode)&&session.interlock.state.value.actionsAllowed,c.ready,c.manifest?.contentVersion,!session.battle.activationAllowed()||session.battle.state.value.loading,"${graph.account.state.value.baseSelectionGeneration}:${graph.account.state.value.selectedBaseId}")}}}
 val model=opened.getOrNull()?.let{viewModel<DivineTrialViewModel>(key="divine-${System.identityHashCode(lifetime)}",factory=viewModelFactory{initializer{DivineTrialViewModel(it)}})}
 DisposableEffect(lifetime,model,lifecycle){lifetime.setOpen(show);if(foreground)lifetime.start();val observer=LifecycleEventObserver{_,e->when(e){Lifecycle.Event.ON_START->{foreground=true;lifetime.start();model?.local()};Lifecycle.Event.ON_STOP->{foreground=false;lifetime.stop();model?.dismiss()};else->Unit}};lifecycle.addObserver(observer);onDispose{lifecycle.removeObserver(observer);lifetime.dispose();model?.dismiss()}}
 val ordinary=battle.loading||!session.battle.activationAllowed()||live?.creating==true
 val rules=DivineRules.catalogue(content.catalogue);val allowed=foreground&&rules!=null&&content.allowsGameOrders(graph.versionCode)&&interlock.actionsAllowed&&!ordinary
 LaunchedEffect(account.baseSelectionGeneration,content.manifest?.contentVersion,ordinary,foreground){lifetime.invalidate();model?.dismiss()}
 val close={lifetime.setOpen(false);model?.dismiss();show=false}
 // The designed sheet is the home body; the original screen remains the review owner.
 if(show){if(model==null)PhaseEDesignedNotice("DIVINE TRIALS","Divine trials","Saved trials cannot be opened. Restore local storage access; no new request was sent.",close)
  else DivineTrialsHome(model,account.selectedBaseId,allowed,foreground&&!ordinary,content,"${account.baseSelectionGeneration}:${content.manifest?.contentVersion}",close)
 }else Column(Modifier.fillMaxSize()){
  if(rules!=null||opened.isFailure||model!=null)PhaseEActivityEntry(PhaseEActivity.DIVINE_TRIALS, onClick = {lifetime.setOpen(true);show=true;model?.local()})
  Box(Modifier.weight(1f)){bases()}
 }
}
