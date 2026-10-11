package gg.pixelkingdomwars.nativeclient.ui.community

import androidx.compose.runtime.Composable
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph

/** Standalone navigation uses the same designed body and existing command owner as Home. */
@Composable fun ClansScreen(
    graph: AppGraph, session: SessionGraph, model: ClansViewModel,
    onBack: () -> Unit, onChat: () -> Unit, onBuyLand: () -> Unit,
    onCharterControls: () -> Unit, onTournamentControls: () -> Unit,
    onReport: () -> Unit = {},
) = ClanHub(graph, session, model, onBack, onChat, onBuyLand, onCharterControls, onTournamentControls, onReport = onReport)
