package gg.pixelkingdomwars.nativeclient.ui.hud

import androidx.compose.runtime.Immutable
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId

/**
 * Design component: the callbacks of the Home HUD and its resource drawer (UX-ARCHITECTURE §7.1 `HomeHud(ui, on)`,
 * DESIGN-SYSTEM §6 HUD and Resource drawer).
 *
 * Every door hands back a [FeatureId] and the Feature Registry decides where it goes, so the HUD never routes. The HUD
 * never closes the drawer by itself after a GO: the caller does it as part of the navigation (DESIGN-SYSTEM §7 "GO:
 * drawer closes, camera flies 400 ms to the place").
 */
@Immutable data class HomeHudActions(
    /** A door was tapped: level badge (Profile), a status segment (Leagues / Builders / Defence log), an edge button or
     *  tab, the "+n" overflow (the hub row, [gg.pixelkingdomwars.nativeclient.ui.model.HomeHudUi.rightEdgeOverflow]),
     *  a deck button, the herald, the context chip, or a GO / BID / group GO inside the drawer. */
    val openFeature: (FeatureId) -> Unit,
    /** Kept for source compatibility (631dff90). The kit successor no longer calls it directly: the HUD calls
     *  [openDrawerAt], whose default forwards here with the focus (or [HudIds.RESOURCES] when there is none). */
    val openDrawer: (FeatureId) -> Unit,
    /** A drawer row or tile was tapped: show it in the drawer's info card (the caller sets
     *  [gg.pixelkingdomwars.nativeclient.ui.model.ResourceDrawerUi.focusRowId] to this row id). */
    val focusResource: (String) -> Unit,
    /** Close the drawer: its X, a tap on the scrim outside it, or Back. */
    val closeDrawer: () -> Unit,
    /**
     * Open the resource drawer (design ruling 092decf3 item 1). The dispatched registry row is ALWAYS [HudIds.RESOURCES]
     * (`hud.resources`, destination `Resources(resourceId)`); [focus] is the optional row to show first: the tapped
     * readout's [gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi.id] (the SKR readout passes the id naming the
     * SKR row), or null for the plain drawer. The caller maps the focus to `Resources(resourceId)`; the HUD never
     * routes. Default: forwards to [openDrawer] (focus, else `hud.resources`), so a 631dff90 caller keeps working.
     */
    val openDrawerAt: (focus: FeatureId?) -> Unit = { focus -> openDrawer(focus ?: HudIds.RESOURCES) },
    /** Open (true) or close (false) the deck's tools shelf: a long-press on BUILD toggles it (the caller owns
     *  [gg.pixelkingdomwars.nativeclient.ui.model.HomeHudUi.toolsOpen]). A tool tap is an [openFeature] with the tool's id;
     *  the caller closes the shelf as part of running it. Default: no shelf. */
    val toggleTools: (open: Boolean) -> Unit = {},
) {
    companion object {
        /** No-op actions for previews and tests. */
        val None = HomeHudActions(openFeature = {}, openDrawer = {}, focusResource = {}, closeDrawer = {})
    }
}

/**
 * The canonical HUD registry rows the HUD itself dispatches or names (MS-B REGISTRY-CORRECTIONS, 110 rows; design ruling
 * 092decf3 item 1). Mappers may use them for the [gg.pixelkingdomwars.nativeclient.ui.model.HomeHudUi] ids; the
 * registry, not this object, decides where each goes.
 */
object HudIds {
    /** Row 107, `TR_RESOURCES`: the drawer. Every readout and the drawer caret dispatch this (with a focus). */
    val RESOURCES = FeatureId("hud.resources")
    /** Row 9, `RE_DAILY_CACHE` (icon `shape:chest`). MOUNT-HUD's prototype `hud.daily` is wrong. */
    val DAILY_CACHE = FeatureId("hud.dailyCache")
    /** Rows 5-7: the readouts' own rows, used as drawer FOCUS names (the tap still dispatches [RESOURCES]). */
    val SHARDS = FeatureId("hud.shards")
    val GEMS = FeatureId("hud.gems")
    val KEEP = FeatureId("hud.keep")
    /** Rows 1-4, 8, 10-16. */
    val PROFILE = FeatureId("hud.profile")
    val LEAGUES = FeatureId("hud.leagues")
    val BUILDERS = FeatureId("hud.builders")
    val SHIELD = FeatureId("hud.shield")
    val QUESTS = FeatureId("hud.quests")
    val EVENT = FeatureId("hud.event")
    val MAIL = FeatureId("hud.mail")
    val CHAT = FeatureId("hud.chat")
    val ATTACK = FeatureId("hud.attack")
    val ARMY = FeatureId("hud.army")
    val MAP = FeatureId("hud.map")
    val BUILD = FeatureId("hud.build")
    /** The deck tools shelf (the folded LAYOUT · EXPAND · FIT dock row). LAYOUTS is registry row 58 (`build.layouts`)
     *  and EXPAND the Keep's row; FIT has no registry row yet (design home: Settings › HELP "fit base"), so its id is
     *  HUD-local until the registry names one. */
    val TOOL_LAYOUTS = FeatureId("build.layouts")
    val TOOL_EXPAND = FeatureId("keep.expand")
    val TOOL_FIT = FeatureId("hud.fit")
}
