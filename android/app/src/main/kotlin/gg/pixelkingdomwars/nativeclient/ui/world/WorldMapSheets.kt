package gg.pixelkingdomwars.nativeclient.ui.world

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.layout
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.kit.GoButton
import gg.pixelkingdomwars.nativeclient.ui.kit.IconSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.ArtWell
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.MapColors
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.MapIcon
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.MapRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.MapSectionHeader
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.MapSheetFrame
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.MapTagUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.ParchLine
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.RowText
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.StatCard
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.YouPlate
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.YouPlateUi
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/*
 * c-gap-map (morning push, 2026-10-06): the globe and realm-map panels that still drew the old dark web frame (HudPanel with
 * Silkscreen display text, HudButton, HudRow, the HudRange slider, Material Text) now draw the map half sheet of
 * design/final/map/SPEC.md §1.6: the WoodFrame header on the wood (icon 32, PS 13 gold-hi title, tags, red X), a
 * ParchmentPanel body (section headers with the #C4A464 rule, cream rows, StatCards) and the one primary last. Owner,
 * 2026-10-06: "I should not see any even 1 of old screens there".
 *
 * There is no frame for these four panels in the design packet (the realm panel, the warzone status, the archipelago chain
 * list and MY PARCEL without land), so they are composed from the cluster's own parts (seeker-panel's state card, divine-panel's
 * door rows, map-base's command row) and keep every word the old bodies said. Each reads the same state and calls the same
 * action as before: nothing here reads the server, spends, or decides a rule. A disabled command still answers a tap.
 */

/** The reserved realm: its panel shows the owner allocations instead of kingdoms (the old panel's rule, GlobeHud). */
private const val RESERVED_REALM = "seeker-reach"

/** One StatCard of the realm sheet: icon, PS 11 label and the server's count ("…" until the globe read lands). */
@Immutable internal data class RealmStatUi(val icon: String, val label: String, val value: String)

/**
 * The realm sheet's four counts, in the old panel's order and from the same fields: the server's `/globe/fantasy` realm
 * counts and your owned deeds. An unknown count is "…", never 0. The reserved Solana Reach shows its Genesis and Seeker
 * allocations and no open deed, as the old panel did.
 */
internal fun realmSheetStats(realm: GlobeRealmInfo): List<RealmStatUi> {
    fun n(value: Int?): String = value?.let(RealmHudModel::fmtN) ?: UNKNOWN
    return if (realm.id == RESERVED_REALM) listOf(
        RealmStatUi("itm_deed_earth", "DEEDS", n(realm.deeds)), RealmStatUi("keep", "GENESIS", n(realm.genesis)),
        RealmStatUi("skr", "SEEKER", n(realm.seeker)), RealmStatUi("map", "OPEN DEEDS", n(0)))
    else listOf(
        RealmStatUi("itm_deed_earth", "DEEDS", n(realm.deeds)), RealmStatUi("ui_portrait_keep_t2", "KINGDOMS", n(realm.kingdoms)),
        RealmStatUi("map", "OPEN DEEDS", n(realm.open)), RealmStatUi("ui_portrait_keep_t3", "YOUR BASES", n(realm.mine)))
}

/** One realm CTA as a kit button: caption, face, icon and what a tap does when it cannot act. */
@Immutable internal data class RealmCtaFace(val label: String, val verb: Verb, val state: CommandState, val icon: String?, val refusal: String?)

/** The kit face of one [RealmCta] ([realmCtaRows] decides which exist and which is gold): MY BASE is blue (going somewhere,
 *  DESIGN-SYSTEM §2) unless it is the gold lead; a map still preparing is BUSY (dots, no tap); no map or no open land is
 *  DISABLED and says why on a tap. */
internal fun realmCtaFace(cta: RealmCta, realmName: String): RealmCtaFace = when (cta.kind) {
    RealmCta.Kind.CHOOSE_LAND -> RealmCtaFace("CHOOSE LAND HERE", if (cta.gold) Verb.GOLD else Verb.STONE, CommandState.ENABLED, "map", null)
    RealmCta.Kind.NO_OPEN_LAND -> RealmCtaFace("NO OPEN LAND", Verb.STONE, CommandState.DISABLED, null, "No open land")
    RealmCta.Kind.MY_BASE -> RealmCtaFace("MY BASE", if (cta.gold) Verb.GOLD else Verb.BLUE, CommandState.ENABLED, "locate", null)
    RealmCta.Kind.ENTER_MAP -> RealmCtaFace("ENTER MAP", if (cta.gold) Verb.GOLD else Verb.STONE, CommandState.ENABLED, "map", null)
    RealmCta.Kind.NO_MAP -> RealmCtaFace("NO MAP YET", Verb.STONE, CommandState.DISABLED, null, "No map for $realmName yet")
    RealmCta.Kind.PREPARING -> RealmCtaFace("Preparing ${cta.percent}%", if (cta.gold) Verb.GOLD else Verb.STONE, CommandState.BUSY, null, null)
}

/**
 * A selected realm on the globe (the old dark realm panel, GlobeHud `RealmPanelBody`): the realm's name in the header with its
 * numeral, a YOU tag where you hold land, the realm's own map thumbnail ([thumb], the rail's decoded copy) beside its region
 * and epithet, the lore, the four counts and the same CTA rows ([realmCtaRows]: Choose land here, My base, Enter map, or why
 * not yet). [onEnterMap] is the panel's Enter map / My base (`browseMap`), [onChooseLand] choose mode's own dive.
 */
@Composable internal fun WorldRealmPlaceSheet(realm: GlobeRealmInfo, mapped: Set<String>, readiness: Pair<String, Float>?, mineCta: Boolean,
    choose: Boolean, thumb: ImageBitmap?, onEnterMap: (String, Boolean) -> Unit, onChooseLand: (String) -> Unit, onClose: () -> Unit,
    modifier: Modifier = Modifier) {
    val mine = realm.mine > 0; val hasMap = realm.id in mapped
    val ready = readiness?.takeIf { it.first == realm.id }?.second
    val rows = realmCtaRows(realm.id, realm.open, mine, hasMap, ready, mineCta, choose)
    val tags = listOfNotNull(realm.numeral?.let { MapTagUi(it, Verb.STONE) }, MapTagUi("YOU", Verb.GOLD).takeIf { mine })
    MapSheetFrame(realm.name.uppercase(), null, onClose, modifier, tags = tags, footer = {
        rows.forEach { row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.Top) {
                row.forEach { cta ->
                    val face = realmCtaFace(cta, realm.name)
                    PrimaryButton(face.label, {
                        when (cta.kind) {
                            RealmCta.Kind.CHOOSE_LAND -> onChooseLand(realm.id)
                            RealmCta.Kind.MY_BASE -> onEnterMap(realm.id, true)
                            RealmCta.Kind.ENTER_MAP -> onEnterMap(realm.id, false)
                            RealmCta.Kind.NO_OPEN_LAND, RealmCta.Kind.NO_MAP -> face.refusal?.let { Toasts.post(it) }
                            RealmCta.Kind.PREPARING -> Unit
                        }
                    }, Modifier.weight(1f), verb = face.verb, state = face.state, icon = face.icon)
                }
            }
        }
    }) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            // The realm's own painting, as the rail shows it (a derived thumbnail, SPEC §9), on the rail's veil face.
            ArtWell(76.dp, PkwTokens.Colors.veil) {
                if (thumb != null) Image(thumb, contentDescription = null, modifier = Modifier.size(72.dp),
                    contentScale = ContentScale.Fit, filterQuality = FilterQuality.None)
                else MapIcon("map", 32.dp)
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                realm.nav?.let { PkwText(it, PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch2, maxLines = 1) }
                realm.epithet?.let { ParchLine(it, maxLines = 2) }
                realm.landscape?.let { ParchLine(it, secondary = true, maxLines = 2) }
            }
        }
        realm.lore?.let { ParchLine(it, secondary = true, maxLines = 4) }
        realmSheetStats(realm).chunked(2).forEach { pair ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                pair.forEach { stat -> StatCard(stat.icon, stat.label, stat.value, Modifier.weight(1f), iconSize = 24.dp) }
            }
        }
        if (realm.id == RESERVED_REALM) MapRow(tint = PkwTokens.Colors.selectedTint) {
            MapIcon("ui:exhausted-status", 32.dp)
            RowText("Reserved allocation", "Genesis and Seeker owner allocations remain reserved. Awards and claims are not open.")
        }
    }
}

/** The warzone headline, in the old status panel's words (WarzoneClock). */
internal fun warzoneHeadline(status: WorldWarzone): String = when {
    status.mode == "off" -> "WARZONES OFF"
    status.active && status.mode == "purge" -> "PURGE WARZONE ACTIVE"
    status.active -> "WARZONE ACTIVE"
    status.mode == "purge" -> "NO WARZONE ACTIVE"
    else -> "NEXT WARZONE"
}

/** The line where the server gave no boundary time, in the old panel's words. */
internal fun warzoneNoClockLine(status: WorldWarzone): String = when {
    status.mode == "off" -> "No active window"
    status.mode == "purge" && !status.active -> "Purges are unannounced"
    else -> "Boundary time unavailable"
}

/** The rule line under the clock, in the old panel's words; the cooldown sentence only when the catalogue names it. */
internal fun warzoneRuleLine(active: Boolean, cooldownHours: Int?): String =
    if (active) "Ordinary loss and purchase shields are suppressed. Only a Warzone shield protects." +
        (cooldownHours?.let { " A defender can be hit again after ${it}H." } ?: "")
    else "Ordinary shields protect normally. During a Warzone they keep counting down but do not block attacks."

/**
 * The warzone status (the globe's WARZONE panel and the realm map's WARZONE chip panel, F16), the old WarzoneBody as a map
 * half sheet: a seeker-panel state card (timer, the headline, the server's own countdown) and the old rule lines. [status]
 * null is still reading ("Reading current warzone status…"); [error] is the read's own words with RETRY. REFRESH re-reads
 * without blanking what is shown; SHIELDS (the old "Warzone shield options") opens the shop while a warzone is active.
 */
@Composable internal fun WorldWarzoneSheet(status: WorldWarzone?, error: String?, cooldownHours: Int?, onShop: (() -> Unit)?,
    onRefresh: () -> Unit, onClose: () -> Unit, modifier: Modifier = Modifier) {
    var now by remember { mutableLongStateOf(System.nanoTime()) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val deadline = status?.deadline
    // the countdown ticks once a second while the app is started, and only while a boundary is shown
    LaunchedEffect(deadline, lifecycle) {
        if (deadline != null) lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { while (true) { now = System.nanoTime(); delay(1_000) } }
    }
    val active = status?.active == true
    val tags = when {
        status == null -> emptyList()
        active -> listOf(MapTagUi("ACTIVE", Verb.RED))
        status.mode == "off" -> listOf(MapTagUi("OFF", Verb.STONE))
        else -> emptyList()
    }
    MapSheetFrame("WARZONE", "attack", onClose, modifier, tags = tags, footer = {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.Top) {
            SecondaryButton(if (error != null) "RETRY" else "REFRESH", onRefresh, Modifier.weight(1f).heightIn(min = 60.dp),
                verb = if (error != null) Verb.BLUE else Verb.STONE, icon = "replay")
            if (active && onShop != null) PrimaryButton("SHIELDS", onShop, Modifier.weight(1.4f), sub = "Warzone shield options", icon = "shield")
        }
    }) {
        Plate(PlateKind.CREAM, Modifier.fillMaxWidth().heightIn(min = 66.dp).clearAndSetSemantics {
            contentDescription = listOfNotNull(status?.let(::warzoneHeadline) ?: "Reading current warzone status…",
                deadline?.let { worldDuration(it.remaining(now)) }, error).joinToString(", ")
        }, blocksScene = false) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PkwIcon(if (status?.mode == "off") "ui:exhausted-status" else "timer", 36.dp)
                Column(Modifier.weight(1f)) {
                    when {
                        status == null && error == null -> ParchLine("Reading current warzone status…")
                        status == null -> PkwText(error ?: "", PkwTokens.Type.body, color = PkwTokens.Colors.shortText, maxLines = 3)
                        else -> {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                PkwText(warzoneHeadline(status), PkwTokens.Type.label, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch, maxLines = 2)
                                if (deadline != null) PkwText(worldDuration(deadline.remaining(now)), PkwTokens.Type.label,
                                    color = if (active) PkwTokens.Colors.shortText else PkwTokens.Colors.textOnParch)
                            }
                            PkwText(if (deadline != null) (if (active) "TIME REMAINING" else "STARTS IN") else warzoneNoClockLine(status),
                                PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
                        }
                    }
                }
            }
        }
        // a failed refresh keeps the status already shown and says so under it
        if (status != null && error != null) ParchLine(error, maxLines = 3)
        if (status != null) {
            ParchLine(warzoneRuleLine(active, cooldownHours), secondary = true, maxLines = 4)
            ParchLine("Raid loot, stars, trophies and damage rules do not change. A loss shield earned during the window only protects " +
                "afterward if time remains.", secondary = true, maxLines = 4)
        }
    }
}

/** One archipelago chain as the EXPLORE sheet lists it: catalogue id, name and island count. */
@Immutable internal data class ExploreChainUi(val id: String, val name: String, val islands: Int)

/** The catalogue's chains (presentation `chains`), in catalogue order; a chain without an id is not offered (it cannot be
 *  opened), and an unnamed one reads "Islands" as the old list did. */
internal fun exploreChains(chains: List<JsonObject>): List<ExploreChainUi> = chains.mapNotNull { c ->
    val id = c.string("id") ?: return@mapNotNull null
    ExploreChainUi(id, c.string("name") ?: "Islands", (c["islands"] as? JsonArray)?.size ?: 0)
}

/** An island row in the EXPLORE list, named as the archipelago sheet it opens names it ("Aurora Isle 2"; that sheet's
 *  header is the same words in capitals, archipelagoPanelUi), so the row and the sheet never disagree. [index] is 0-based. */
internal fun exploreIslandTitle(chainId: String, chainName: String?, index: Int): String = "${chainName ?: chainId} Isle ${index + 1}"

/**
 * EXPLORE (the old chain list, ExploreBody): with no [chainId] the archipelago chains as cream rows with a blue GO each; with
 * one, that chain's lore and its islands, each opening the designed archipelago-panel ([onIsland] with `<chain>/<slot>`), and
 * ALL ARCHIPELAGOS back. Islands cannot be owned; the Lodge sends expeditions (the old list's words).
 */
@Composable internal fun WorldExploreSheet(chains: List<JsonObject>, chainId: String?, onChain: (String?) -> Unit, onIsland: (String) -> Unit,
    onClose: () -> Unit, modifier: Modifier = Modifier) {
    val list = remember(chains) { exploreChains(chains) }
    val chain = list.firstOrNull { it.id == chainId }
    val raw = chains.firstOrNull { it.string("id") == chainId }
    val lore = raw?.string("lore"); val rawName = raw?.string("name")
    val back: (@Composable ColumnScope.() -> Unit)? = if (chain == null) null else { {
        SecondaryButton("ALL ARCHIPELAGOS", { onChain(null) }, Modifier.fillMaxWidth(), icon = "map")
    } }
    MapSheetFrame(chain?.name?.uppercase() ?: "EXPLORE", "ui:lodge-menu", onClose, modifier, footer = back) {
        ParchLine(lore ?: "Island chains lie beyond the realm coastlines. These gameplay destinations cannot be owned.", secondary = chain != null, maxLines = 4)
        if (chain == null) {
            MapSectionHeader("ARCHIPELAGOS")
            if (list.isEmpty()) ParchLine("No island chains on this server yet", secondary = true)
            list.forEach { c ->
                MapRow(description = "${c.name}, ${c.islands} islands", onClick = { onChain(c.id) }) {
                    MapIcon("ui:lodge-menu", 32.dp)
                    RowText(c.name, "${c.islands} islands")
                    GoButton({ onChain(c.id) }, "Open ${c.name}", Modifier.size(58.dp, 48.dp))
                }
            }
        } else {
            MapSectionHeader("ISLANDS · ${chain.islands}")
            for (index in 0 until chain.islands) {
                val title = exploreIslandTitle(chain.id, rawName, index)
                MapRow(description = title, onClick = { onIsland("${chain.id}/$index") }) {
                    MapIcon("ui:navigation-kit", 32.dp)
                    RowText(title, "Your Lodge sends expeditions here")
                    GoButton({ onIsland("${chain.id}/$index") }, "Open $title", Modifier.size(58.dp, 48.dp))
                }
            }
        }
    }
}

/** MY PARCEL with no land shown (the old PARCEL_HELP panel), in its own words; the primary opens Your Bases. */
@Composable internal fun WorldParcelHelpSheet(loading: Boolean, onOpenBases: () -> Unit, onClose: () -> Unit, modifier: Modifier = Modifier) {
    MapSheetFrame("MY PARCEL", "locate", onClose, modifier, footer = {
        PrimaryButton("YOUR BASES", onOpenBases, Modifier.fillMaxWidth(), sub = "Open your bases", icon = "ui_portrait_keep_t3")
    }) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ArtWell(56.dp, MapColors.snowWell) { MapIcon("itm_deed_earth", 32.dp) }
            Column(Modifier.weight(1f)) {
                PkwText(if (loading) "Finding your land…" else "No assigned parcel shown", PkwTokens.Type.label,
                    color = PkwTokens.Colors.textOnParch, maxLines = 2)
                ParchLine("Open Your Bases to review your deeds or inspect available land on the globe.", secondary = true, maxLines = 3)
            }
        }
    }
}

/** The keep-level filter's bounds: the realm filter's own defaults (RealmFilter's 1..20), never a second copy. */
private val LEVEL_FLOOR = RealmFilter().lo
private val LEVEL_CEILING = RealmFilter().hi

/**
 * The LV chip's range (SPEC §1.4 "LV opens a 2-thumb range half sheet"; the old HudRange slider panel): MIN and MAX as
 * stone − / + steppers around a cream value (the BidStepper grammar, SPEC §3.4), each step one level through [onLevel]
 * (index 0 = MIN, 1 = MAX; RealmFilter.withLevel keeps them from crossing), ALL LEVELS ([onAll]: every level, and the
 * sheet closes) and DONE ([onClose]).
 */
@Composable internal fun WorldLevelSheet(lo: Int, hi: Int, onLevel: (Int, Int) -> Unit, onAll: () -> Unit, onClose: () -> Unit,
    modifier: Modifier = Modifier) {
    MapSheetFrame("KEEP LEVEL", "ui_portrait_keep_t2", onClose, modifier, footer = {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.Top) {
            // never a dead door: at the full range it still answers (the host shows every level and closes the sheet)
            SecondaryButton("ALL LEVELS", onAll, Modifier.weight(1f).heightIn(min = 60.dp))
            PrimaryButton("DONE", onClose, Modifier.weight(1f))
        }
    }) {
        ParchLine("Kingdoms outside this keep level range are hidden on the map.", secondary = true)
        for ((index, label) in listOf("MIN", "MAX").withIndex()) {
            val value = if (index == 0) lo else hi
            val name = if (index == 0) "minimum" else "maximum"
            MapRow {
                PkwText(label, PkwTokens.Type.caption, Modifier.width(44.dp), color = PkwTokens.Colors.textOnParch2)
                IconSquare("shape:minus", Verb.STONE, { onLevel(index, value - 1) }, "Lower the $name keep level", enabled = value > LEVEL_FLOOR)
                Plate(PlateKind.CREAM, Modifier.weight(1f).heightIn(min = 48.dp).clearAndSetSemantics { contentDescription = "${label.lowercase()} level $value" },
                    blocksScene = false) {
                    PkwText("LV $value", PkwTokens.Type.primary, Modifier.align(Alignment.Center), color = PkwTokens.Colors.textOnParch,
                        textAlign = TextAlign.Center)
                }
                IconSquare("shape:plus", Verb.STONE, { onLevel(index, value + 1) }, "Raise the $name keep level", enabled = value < LEVEL_CEILING)
            }
        }
    }
}

/**
 * Your kingdom on the realm map (map-realm.png, map-base.png; SPEC §2.2 "yours: a gold YOU plate ... on a 4 dp ink stem
 * above your base, in place of your NameTag"): the kit's YOU plate, with the shield icon when the map's read says your
 * kingdom is shielded (the time is not on the map's read, so the plate reads plain "YOU"). It takes the box the label
 * placement gave your name tag, [w] × [h] dp ([RealmHudModel.tagW]), centred on it with the stem's foot on the tag's
 * bottom, so it stands over your base where the tag stood (the plate and stem rise about 14 dp above that box).
 */
@Composable internal fun RealmYouPlate(shielded: Boolean, w: Double, h: Double) {
    YouPlate(YouPlateUi("YOU", shielded), Modifier.layout { measurable, _ ->
        val plate = measurable.measure(Constraints())
        val boxW = w.dp.roundToPx(); val boxH = h.dp.roundToPx()
        layout(boxW, boxH) { plate.place((boxW - plate.width) / 2, boxH - plate.height) }
    })
}
