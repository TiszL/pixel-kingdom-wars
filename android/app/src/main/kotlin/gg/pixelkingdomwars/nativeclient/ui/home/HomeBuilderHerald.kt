package gg.pixelkingdomwars.nativeclient.ui.home

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.network.trayLabel
import gg.pixelkingdomwars.nativeclient.ui.hud.HudIds
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.model.HeraldUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.titleCase
import kotlinx.coroutines.delay

/*
 * The builder-finished herald (hub SPEC §3.1, toasts.png top: "Builder finished: Workshop Lv 3"). The server's own base
 * read is the only source: a building whose level rose, or whose construction ended, between two reads of the same base
 * has been finished by a builder. Nothing is predicted from a timer, so the herald never says "finished" before the server
 * does. A tap opens the builders surface (HudIds.BUILDERS, the HUD's own builders chip).
 */

/** The herald's authored icon (PkwIcon "builder" = pkw_web_builder, the art in toasts.png). */
internal const val BUILDER_HERALD_ICON = "builder"

/**
 * One herald per building finished between [previous] and [current], in [current]'s order. Empty unless both reads are
 * present and belong to the same known base: the first read of a base (nothing to compare with) and a base switch (a
 * different kingdom's levels) raise nothing. A building counts once even when its level rose and its construction ended
 * together; a building new in [current] was only just placed, so it raises nothing either. The name is the game's own
 * display copy for the type ([trayLabel]), never the raw id.
 */
internal fun homeBuilderFinishedHeralds(previousBaseId: String?, previous: List<Building>?, baseId: String?, current: List<Building>?): List<HeraldUi> {
    if (previous == null || current == null || baseId == null || previousBaseId != baseId) return emptyList()
    val before = previous.associateBy { it.id }
    return current.mapNotNull { now ->
        val then = before[now.id] ?: return@mapNotNull null
        val finished = now.level > then.level || (then.underConstruction && !now.underConstruction)
        if (!finished) null
        else HeraldUi(key = "builder:${now.id}:${now.level}", icon = BUILDER_HERALD_ICON,
            text = "Builder finished: ${titleCase(trayLabel(now.type))} Lv ${now.level}", target = HudIds.BUILDERS)
    }
}

/**
 * The last base read the herald compares with. A read with no buildings (a refresh in flight, an unreadable answer)
 * neither raises nor replaces the last good read, so a finish that lands across a refresh is still announced.
 */
internal class HomeBuilderReads {
    private var baseId: String? = null
    private var buildings: List<Building>? = null

    /** The heralds [buildings] raises against the last read, which it then becomes. */
    fun next(baseId: String?, buildings: List<Building>?): List<HeraldUi> {
        if (buildings == null) return emptyList()
        val raised = homeBuilderFinishedHeralds(this.baseId, this.buildings, baseId, buildings)
        this.baseId = baseId; this.buildings = buildings
        return raised
    }
}

/**
 * The builder herald to show now, or null. SPEC §3.1: one at a time, queued, each for the kit's banner hold (4 s), then
 * the next. A base switch drops the queue (its heralds belong to the other kingdom) and the first read of a base raises
 * nothing. Each finish is announced once per base while Home stays composed, even if a stale read repeats it.
 */
@Composable internal fun rememberHomeBuilderHerald(buildings: List<Building>?, baseId: String?): HeraldUi? {
    val reads = remember { HomeBuilderReads() }
    val queue = remember(baseId) { mutableStateListOf<HeraldUi>() }
    val announced = remember(baseId) { mutableSetOf<String>() }
    LaunchedEffect(baseId, buildings) {
        queue.addAll(reads.next(baseId, buildings).filter { announced.add(it.key) })
    }
    val showing = queue.firstOrNull()
    LaunchedEffect(baseId, showing?.key) {
        val shown = showing ?: return@LaunchedEffect
        delay(PkwTokens.Motion.BANNER_HOLD.toLong())
        queue.remove(shown)
    }
    return showing
}
