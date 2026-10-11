package gg.pixelkingdomwars.nativeclient.ui.phasee

import androidx.compose.runtime.*
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.RealmPassportRepository
import kotlinx.coroutines.awaitCancellation

/** Passport is account history; current deed/content admission never supplies its authority. */
@Composable fun RealmPassportRegistration(graph: AppGraph, session: SessionGraph, bases: @Composable () -> Unit) {
    // 5162b8bf: the same account owner now lives in HomePassportScope above Home/Bases.
    // Lodge PASSPORT is the designed record entry; this wrapper must not create another owner or legacy form.
    bases()
}
