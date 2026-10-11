package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.GoButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.ProgressBar
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.insideStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.band
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlin.math.ceil
import kotlin.math.roundToInt

/**
 * Design component: the Profile hub (design/final/hub/hub.png, SPEC §2.1), which replaces MENU. "Who am I, what can I do
 * right now, and where?" — it only flies the player to buildings and islands; features stay in their buildings.
 * Destination: `Profile(tab)` (FULL card). Tabs PROFILE · KINGDOMS · WALLET.
 */

/** The League StatCard (SPEC §2.1 item 3). */
@Immutable data class LeagueStatUi(
    /** League crest art ("league-gold"), drawn at 40 dp. */
    val crest: String,
    /** Trophies, formatted ("1,284") or "…". */
    val trophies: String,
    /** VT label ("Gold league"); the card adds " ▸". */
    val label: String,
    /** Where a tap goes (Leagues). */
    val link: HubLink,
)

/** The EXP StatCard (read-only, arch G5). */
@Immutable data class ProgressStatUi(
    /** "LV 7" or "LV …". */
    val level: String,
    /** 0..1 toward the next level; null draws an empty track (never a fake zero). */
    val progress: Float?,
    /** Screen-reader text ("Level 7, 60 percent to level 8"). */
    val description: String,
)

/** RIGHT NOW priority, highest first (SPEC §2.1): claim > collect / returned > auction / outbid > idle builder > quest. */
enum class NowPriority { READY_TO_CLAIM, COLLECT, AUCTION, IDLE_BUILDER, QUEST_REWARD }

/** One RIGHT NOW row: what can be done now, where, and the GO that flies there. */
@Immutable data class NowRowUi(
    /** Stable id (for example "goldforge.claim"). */
    val id: String,
    /** The Well's icon (the place's or the thing's authored art). */
    val icon: String,
    /** VT 20 what ("Ready to claim: 1,240 KEEP"). */
    val title: String,
    /** VT 18 where ("Gold Forge · to your wallet"). */
    val where: String,
    /** Claimable or collectable now: the top row then uses the `ready` look. */
    val ready: Boolean,
    /** Where GO flies (usually `FocusBuilding(type, then = …)`). */
    val destination: HubLink,
    /** Sort key; rows are ordered by [rightNowRows]. */
    val priority: NowPriority,
)

/** One THIS WEEK row (league reward, daily quests): Pips, a trailing note and a Chevron to the page. */
@Immutable data class WeekRowUi(
    val id: String,
    /** The light Well's icon. */
    val icon: String,
    /** "League reward · 3/5 wins". */
    val title: String,
    /** Pips done / total; either null draws no pips. */
    val done: Int?,
    val total: Int?,
    /** VT trailing note ("4d left", "+500"); null draws none. */
    val trailing: String?,
    /** Optional 24 px icon after [trailing] (the bonus shard). */
    val trailingIcon: String? = null,
    /** The page it opens (Leagues, Quests). */
    val destination: HubLink,
)

/** A Door of the bottom door row (LEAGUE, CLAN, HISTORY, INVITE). */
@Immutable data class DoorUi(
    val id: String,
    val icon: String,
    /** PS 11 caption ("CLAN"). */
    val label: String,
    /** STONE opens a page, BLUE flies to a place (CLAN → the Clan Hall). */
    val verb: Verb,
    /** Where it goes; null with [lockedReason] set. */
    val link: HubLink?,
    /** Non-null = locked: charcoal + padlock; a tap says this ("Build a Clan Hall at Keep 6"). */
    val lockedReason: String? = null,
    /** The GO a locked door's toast offers (`BuildShop(BUILDINGS)`). */
    val unlockLink: HubLink? = null,
)

/** One kingdom on the KINGDOMS tab. */
@Immutable data class KingdomRowUi(
    val id: String,
    /** Deed icon ("itm_deed_earth"). */
    val icon: String,
    val name: String,
    /** "Earth realm · Keep 12". */
    val sub: String,
    /** The kingdom being played: `you` row, no SWITCH. */
    val active: Boolean,
)

/** One WALLET StatCard (KEEP, SKR, SOL, Gems). */
@Immutable data class WalletStatUi(
    val id: String,
    val icon: String,
    /** Formatted balance or "…". */
    val value: String,
    val label: String,
    /** The page or place its Chevron opens (KEEP / Gems → Gold Forge, SKR → Seeker Island); null = read-only. */
    val link: HubLink?,
)

/** Everything the Profile hub draws (SPEC §2.1 State; fields after `selectedTab` were added with defaults). */
@Immutable data class ProfileHubUi(
    /** PS 13 gold-hi ("IRONHOLD"). */
    val kingdomName: String,
    /** VT 20 ("Rowan"). */
    val playerName: String,
    /** The level badge text ("12" or "…"). */
    val keepLevel: String,
    /** Keep tier 1..4 for `pkw_web_portrait_keep_t{tier}`. */
    val keepTier: Int,
    /** "SEEKER #142" lime tag, or null when not Seeker-admitted. */
    val seekerMember: String?,
    /** Parked-world crop around the Keep at 1:1 world zoom; null draws the stone fallback. */
    val headerSnapshot: ImageBitmap?,
    val league: LeagueStatUi,
    /** Null hides the card (never "0"). */
    val exp: ProgressStatUi?,
    /** Null hides the card (never "0"). */
    val renown: String?,
    /** RIGHT NOW candidates; drawn through [rightNowRows] (≤ 4). */
    val rightNow: List<NowRowUi>,
    /** THIS WEEK rows (league reward, daily quests). */
    val week: List<WeekRowUi>,
    /** The CLAN door's red count badge (clan unread). */
    val clanBadge: BadgeUi?,
    /** The CLAN door: blue fly-there to the Clan Hall, or locked with a reason when there is none. */
    val clanDoor: DoorUi,
    /** "PROFILE", "KINGDOMS" or "WALLET". */
    val selectedTab: String,
    /** The three tabs (icons per SPEC). */
    val tabs: List<TabUi> = profileHubTabs(keepTier),
    /** The LEAGUE door (stone, opens Leagues). */
    val leagueDoor: DoorUi? = null,
    /** The HISTORY door; null hides it (no history at all, arch row 22). */
    val historyDoor: DoorUi? = null,
    /** The INVITE door; null while the referrals feature is off. */
    val inviteDoor: DoorUi? = null,
    /** KINGDOMS tab rows. */
    val kingdoms: List<KingdomRowUi> = emptyList(),
    /** "ADD A KINGDOM" green row button; null while the server feature is off. */
    val addKingdom: HubLink? = null,
    /** "YOUR LAND" chevron row. */
    val yourLand: HubLink? = null,
    /** WALLET tab StatCards. */
    val wallet: List<WalletStatUi> = emptyList(),
    /** The linked wallet address, shortened ("7xKX…9fQa"); null hides the row. */
    val walletAddress: String? = null,
    /** "Get devnet SOL" row; null while the faucet is off. */
    val faucet: HubLink? = null,
    /** WALLET › HISTORY row. */
    val walletHistory: HubLink? = null,
    /** The PROFILE tab's data state (Loading = "…" + 2 skeleton rows; Error = ErrorRow + "as of" tag). */
    val load: LoadState = LoadState.Ready,
    /** The single dim row when RIGHT NOW is empty. */
    val quietLine: String = "All quiet. Your builders are busy.",
)

/** The Profile hub's tabs: PROFILE (keep portrait) · KINGDOMS (deed) · WALLET (SOL). */
fun profileHubTabs(keepTier: Int): List<TabUi> = listOf(
    TabUi("PROFILE", keepPortrait(keepTier), "PROFILE", null, false),
    TabUi("KINGDOMS", "itm_deed_earth", "KINGDOMS", null, false),
    TabUi("WALLET", "sol", "WALLET", null, false),
)

/** The Profile hub's callbacks. Every card's Actions include [onClose]; Back follows arch §8.1. */
@Immutable data class ProfileHubActions(
    val onTab: (String) -> Unit = {},
    /** GO / blue doors: close the card, fly the camera, select, then open (`then`). */
    val onGo: (HubLink) -> Unit = {},
    /** Pages: StatCards, THIS WEEK rows, stone doors, Chevron rows. */
    val onOpen: (HubLink) -> Unit = {},
    /** The header gear: Settings(GAME). */
    val onSettings: () -> Unit = {},
    val onClose: () -> Unit = {},
    /** A locked door was tapped: show [reason] with a GO to [unlock]. */
    val onLocked: (reason: String, unlock: HubLink?) -> Unit = { _, _ -> },
    /** KINGDOMS: SWITCH to this kingdom id. */
    val onSwitchKingdom: (String) -> Unit = {},
    /** WALLET: COPY the address (toast "Address copied"). */
    val onCopyAddress: () -> Unit = {},
    /** The ErrorRow's RETRY and Report. */
    val onRetry: () -> Unit = {},
    val onReport: () -> Unit = {},
)

/**
 * The Profile hub card (hub.png). [modifier] is the FULL-card area (x 8..404, y 14 to bottom − 14; see [HubCard]).
 *
 * Pointer rule: the root is the plain [HubCard] Column; only the painted wood frame, rows and buttons take touches. The
 * 60 % scrim under a FULL card is the SheetHost's, composed only while the card is shown.
 */
@Composable fun ProfileHubSheet(ui: ProfileHubUi, on: ProfileHubActions, modifier: Modifier = Modifier) {
    HubCard(modifier, tabs = ui.tabs, selectedTab = ui.selectedTab, onTab = on.onTab,
        header = { ProfileHeader(ui, on) }) {
        when (ui.selectedTab) {
            "KINGDOMS" -> KingdomsBody(ui, on)
            "WALLET" -> WalletBody(ui, on)
            else -> ProfileBody(ui, on)
        }
    }
}

@Composable private fun ProfileHeader(ui: ProfileHubUi, on: ProfileHubActions) {
    LivingHeader(on.onClose, stage = HeaderStage.NONE, onGear = on.onSettings) {
        val snapshot = ui.headerSnapshot
        if (snapshot != null) SnapshotCover(snapshot, Modifier.fillMaxSize())
        else Box(Modifier.fillMaxSize().background(PkwTokens.Colors.charcoal))
        // Ink 55 % band over the bottom 62 dp, under the name.
        Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(62.dp).background(PkwTokens.Colors.ink.copy(alpha = 0.55f)))
        Row(Modifier.align(Alignment.BottomStart).padding(start = 12.dp, bottom = 10.dp), verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box {
                Box(Modifier.size(68.dp).drawBehind {
                    val w = size.width; val h = size.height; val i = 3.dp.toPx()
                    fillStepped(0f, 0f, w, h, CornerProfiles.S, PkwTokens.Colors.ink)
                    insideStepped(i, i, w - i, h - i, CornerProfiles.S) { drawRect(PkwTokens.Colors.gold.face) }
                    val j = 6.dp.toPx()
                    fillStepped(j, j, w - j, h - j, CornerProfiles.S, HubColors.wellDark)
                }, contentAlignment = Alignment.Center) { HubArt(keepPortrait(ui.keepTier), 56.dp) }
                LevelBadge(ui.keepLevel, Modifier.align(Alignment.TopEnd).offset(x = 14.dp, y = (-14).dp))
            }
            Column(Modifier.padding(bottom = 2.dp).clearAndSetSemantics {
                contentDescription = listOfNotNull(ui.kingdomName, ui.playerName, "Keep level ${ui.keepLevel}", ui.seekerMember).joinToString(", ")
            }) {
                PkwText(ui.kingdomName, PkwTokens.Type.title, color = PkwTokens.Colors.gold.hi, outline = 1.dp)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PkwText(ui.playerName, PkwTokens.Type.body, color = PkwTokens.Colors.text, outline = 1.dp)
                    ui.seekerMember?.let { StatusTag(it, Verb.GOLD, lime = true) }
                }
            }
        }
    }
}

/** The 36 dp blue level badge that overlaps the portrait's top-right. Paint only. */
@Composable private fun LevelBadge(level: String, modifier: Modifier) {
    Box(modifier.size(36.dp).drawBehind {
        val w = size.width; val h = size.height; val i = 2.dp.toPx()
        fillStepped(0f, 0f, w, h, CornerProfiles.S, PkwTokens.Colors.ink)
        insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
            drawRect(PkwTokens.Colors.blue.face)
            band(i, w - i, i, 3.dp.toPx(), PkwTokens.Colors.blue.hi)
            band(i, w - i, h - i - 4.dp.toPx(), 4.dp.toPx(), PkwTokens.Colors.blue.lo)
        }
    }, contentAlignment = Alignment.Center) { PkwText(level, PkwTokens.Type.label, color = PkwTokens.Colors.label, outline = 1.dp) }
}

/** The parked-world snapshot, covering the header at a whole-number scale (FilterQuality.None). */
@Composable private fun SnapshotCover(bitmap: ImageBitmap, modifier: Modifier) {
    Canvas(modifier) {
        val k = maxOf(1, ceil(maxOf(size.width / bitmap.width, size.height / bitmap.height)).toInt())
        val w = bitmap.width * k; val h = bitmap.height * k
        drawImage(bitmap, srcOffset = IntOffset.Zero, srcSize = IntSize(bitmap.width, bitmap.height),
            dstOffset = IntOffset(((size.width - w) / 2f).roundToInt(), ((size.height - h) / 2f).roundToInt()), dstSize = IntSize(w, h),
            filterQuality = FilterQuality.None)
    }
}

@Composable private fun ColumnScope.ProfileBody(ui: ProfileHubUi, on: ProfileHubActions) {
    val view = boardView(ui.load, ui.rightNow.isNotEmpty())
    Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        val asOf = when (val load = ui.load) { is LoadState.Stale -> load.asOf; is LoadState.Error -> load.asOf; else -> null }
        if (asOf != null) StatusTag("as of $asOf", Verb.STONE)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            StatCard(Modifier.weight(1f), "${ui.league.label}, ${ui.league.trophies} trophies. Opens Leagues", onClick = { on.onOpen(ui.league.link) }) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    HubArt(ui.league.crest, 40.dp)
                    PkwText(ui.league.trophies, PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
                }
                PkwText("${ui.league.label} ▸", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
            }
            ui.exp?.let { exp ->
                StatCard(Modifier.weight(1f), "EXP, ${exp.description}") {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        HubArt("ui:exp", 32.dp)
                        PkwText(exp.level, PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
                    }
                    ProgressBar(exp.progress, exp.description, Modifier.padding(horizontal = 6.dp), verb = Verb.BLUE)
                    PkwText("EXP", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
                }
            }
            ui.renown?.let { renown ->
                StatCard(Modifier.weight(1f), "Renown $renown") {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        HubArt("ui:renown", 32.dp)
                        PkwText(renown, PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
                    }
                    PkwText("Renown", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
                }
            }
        }

        SectionHeader("RIGHT NOW", note = "GO flies you there")
        when (view) {
            BoardView.SKELETON -> repeat(2) { SkeletonRow(height = 64.dp) }
            BoardView.ERROR_KEPT, BoardView.ERROR_EMPTY -> (ui.load as? LoadState.Error)?.let { ErrorRow(it, on.onRetry, on.onReport) }
            else -> {
                val rows = rightNowRows(ui.rightNow)
                if (rows.isEmpty()) CardRow(variant = RowVariant.DIM) { RowText(ui.quietLine, null) }
                rows.forEachIndexed { index, row ->
                    CardRow(variant = if (nowRowReady(index, row)) RowVariant.READY else RowVariant.PLAIN, height = 64.dp) {
                        Well(row.icon, iconSize = if (row.icon.startsWith("ui:")) 32.dp else 36.dp)
                        RowText(row.title, row.where)
                        GoButton({ on.onGo(row.destination) }, contentDescription = "Go: ${row.title}, ${row.where}", modifier = Modifier.width(58.dp))
                    }
                }
            }
        }

        if (ui.week.isNotEmpty()) SectionHeader("THIS WEEK", note = "rewards you are building")
        ui.week.forEach { row ->
            CardRow(onClick = { on.onOpen(row.destination) }, description = listOfNotNull(row.title, row.trailing).joinToString(", "), height = 58.dp) {
                Well(row.icon, light = true)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    PkwText(row.title, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch)
                    pipFills(row.done, row.total)?.let { Pips(it, fractionText(row.done, row.total), Modifier.width(150.dp)) }
                }
                row.trailing?.let { PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2) }
                row.trailingIcon?.let { HubArt(it, 24.dp) }
                RowChevron()
            }
        }
    }
    // Door row, pinned at the bottom (space-around).
    Row(Modifier.fillMaxWidth().padding(top = 10.dp), horizontalArrangement = Arrangement.SpaceAround) {
        listOfNotNull(ui.leagueDoor, ui.clanDoor, ui.historyDoor, ui.inviteDoor).forEach { door ->
            val locked = door.lockedReason
            DoorButton(door.icon, door.label, door.verb, onClick = {
                val link = door.link
                when {
                    locked != null -> on.onLocked(locked, door.unlockLink)
                    link == null -> Unit
                    door.verb == Verb.BLUE -> on.onGo(link)
                    else -> on.onOpen(link)
                }
            }, locked = locked != null, badge = if (door.id == ui.clanDoor.id) ui.clanBadge else null,
                description = listOfNotNull(door.label, locked, if (door.id == ui.clanDoor.id) ui.clanBadge?.description else null).joinToString(". "))
        }
    }
}

@Composable private fun ColumnScope.KingdomsBody(ui: ProfileHubUi, on: ProfileHubActions) {
    Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        SectionHeader("YOUR KINGDOMS")
        ui.kingdoms.forEach { kingdom ->
            CardRow(variant = if (kingdom.active) RowVariant.YOU else RowVariant.PLAIN, height = 58.dp) {
                Well(kingdom.icon, light = true)
                RowText(kingdom.name, kingdom.sub) { if (kingdom.active) StatusTag("YOU", Verb.GOLD) }
                if (!kingdom.active) SecondaryButton("SWITCH", { on.onSwitchKingdom(kingdom.id) }, contentDescription = "Switch to ${kingdom.name}")
            }
        }
        if (ui.kingdoms.isEmpty()) CardRow(variant = RowVariant.DIM) { RowText(UNKNOWN, null) }
        ui.addKingdom?.let { link -> SecondaryButton("ADD A KINGDOM", { on.onOpen(link) }, Modifier.fillMaxWidth(), verb = Verb.GREEN, icon = "itm_deed_earth") }
        ui.yourLand?.let { link ->
            CardRow(onClick = { on.onOpen(link) }, description = "Your land") { Well("locate", light = true); RowText("YOUR LAND", "Deeds and parcels"); RowChevron() }
        }
    }
}

@Composable private fun ColumnScope.WalletBody(ui: ProfileHubUi, on: ProfileHubActions) {
    Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        SectionHeader("BALANCES", note = "read from your wallet")
        ui.wallet.chunked(2).forEach { pair ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                pair.forEach { stat ->
                    val link = stat.link
                    val open: (() -> Unit)? = if (link != null) ({ on.onOpen(link) }) else null
                    StatCard(Modifier.weight(1f), "${stat.label} ${stat.value}", onClick = open) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            HubArt(stat.icon, if (stat.icon.startsWith("ui:")) 32.dp else 24.dp)
                            PkwText(stat.value, PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
                            if (link != null) RowChevron()
                        }
                        PkwText(stat.label, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
                    }
                }
                if (pair.size == 1) Spacer(Modifier.weight(1f))
            }
        }
        ui.walletAddress?.let { address ->
            CardRow { Well("sol", light = true, iconSize = 24.dp); RowText("Wallet", address); SecondaryButton("COPY", on.onCopyAddress, contentDescription = "Copy wallet address") }
        }
        ui.faucet?.let { link -> CardRow(onClick = { on.onOpen(link) }, description = "Get devnet SOL") { Well("sol", light = true, iconSize = 24.dp); RowText("Get devnet SOL", "Test SOL for this alpha"); RowChevron() } }
        ui.walletHistory?.let { link -> CardRow(onClick = { on.onOpen(link) }, description = "History") { Well("replay", light = true, iconSize = 24.dp); RowText("HISTORY", "Claims, purchases and trips"); RowChevron() } }
    }
}

// ---- Previews (hub.png numbers) ----

private val sampleProfile = ProfileHubUi(
    kingdomName = "IRONHOLD", playerName = "Rowan", keepLevel = "12", keepTier = 3, seekerMember = "SEEKER #142", headerSnapshot = null,
    league = LeagueStatUi("league-gold", "1,284", "Gold league", sampleLink("hud.leagues")),
    exp = ProgressStatUi("LV 7", 0.6f, "Level 7, 60 percent to level 8"), renown = "340",
    rightNow = listOf(
        NowRowUi("lodge", "ui:lodge-menu", "Expedition is back", "Exploration Lodge", true, sampleLink("lodge.expedition"), NowPriority.COLLECT),
        NowRowUi("claim", "keep", "Ready to claim: 1,240 KEEP", "Gold Forge · to your wallet", true, sampleLink("goldforge.claim"), NowPriority.READY_TO_CLAIM),
        NowRowUi("spot", "ui:seeker-navigation", "Auction live · 2h 10m", "Seeker Island · Spot 142", false, sampleLink("island.seeker"), NowPriority.AUCTION),
        NowRowUi("builder", "builder", "1 builder is free", "Pick a building to upgrade", false, sampleLink("hud.builders"), NowPriority.IDLE_BUILDER),
        NowRowUi("quest", "quest", "Quest reward waiting", "Quests", false, sampleLink("hud.quests"), NowPriority.QUEST_REWARD),
    ),
    week = listOf(
        WeekRowUi("league", "league-gold", "League reward · 3/5 wins", 3, 5, "4d left", destination = sampleLink("hud.leagues")),
        WeekRowUi("quests", "quest", "Daily quests · 4/6", 4, 6, "+500", "shards", sampleLink("hud.quests")),
    ),
    clanBadge = BadgeUi("4", BadgeTone.COUNT, "4 unread clan messages"),
    clanDoor = DoorUi("clan", "itm_banner", "CLAN", Verb.BLUE, sampleLink("clan.open")),
    selectedTab = "PROFILE",
    leagueDoor = DoorUi("league", "trophy", "LEAGUE", Verb.STONE, sampleLink("hud.leagues")),
    historyDoor = DoorUi("history", "replay", "HISTORY", Verb.STONE, sampleLink("profile.history")),
    inviteDoor = DoorUi("invite", "referral", "INVITE", Verb.STONE, sampleLink("profile.invite")),
    kingdoms = listOf(
        KingdomRowUi("k1", "itm_deed_earth", "Ironhold", "Earth realm · Keep 12", active = true),
        KingdomRowUi("k2", "itm_deed_earth", "Saltmarsh", "Earth realm · Keep 4", active = false),
    ),
    addKingdom = sampleLink("profile.freeKingdom"), yourLand = sampleLink("profile.land"),
    wallet = listOf(
        WalletStatUi("keep", "keep", "312.5", "KEEP", sampleLink("goldforge.open")),
        WalletStatUi("skr", "skr", "240", "SKR", sampleLink("island.seeker")),
        WalletStatUi("sol", "sol", "0.84", "SOL", null),
        WalletStatUi("gems", "gem", "1,250", "Gems", sampleLink("goldforge.gems")),
    ),
    walletAddress = "7xKX…9fQa", faucet = sampleLink("profile.faucet"), walletHistory = sampleLink("profile.history"),
)

@Preview(name = "Profile hub (hub.png)", widthDp = 412, heightDp = 915)
@Composable private fun ProfileHubPreview() { HubPreviewStage { ProfileHubSheet(sampleProfile, ProfileHubActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Profile hub: loading (header and stats …, 2 skeleton rows)", widthDp = 412, heightDp = 915)
@Composable private fun ProfileHubLoadingPreview() {
    HubPreviewStage {
        ProfileHubSheet(sampleProfile.copy(kingdomName = UNKNOWN, playerName = UNKNOWN, keepLevel = UNKNOWN, seekerMember = null,
            league = sampleProfile.league.copy(trophies = UNKNOWN), exp = ProgressStatUi("LV …", null, "Level unknown"), renown = UNKNOWN,
            rightNow = emptyList(), load = LoadState.Loading), ProfileHubActions(), Modifier.fillMaxSize())
    }
}

@Preview(name = "Profile hub: error (ErrorRow, stats as of 14:02)", widthDp = 412, heightDp = 915)
@Composable private fun ProfileHubErrorPreview() {
    HubPreviewStage {
        ProfileHubSheet(sampleProfile.copy(load = LoadState.Error("Can't reach your kingdom's news.", asOf = "14:02")), ProfileHubActions(), Modifier.fillMaxSize())
    }
}

@Preview(name = "Profile hub: all quiet, no Clan Hall (locked door)", widthDp = 412, heightDp = 915)
@Composable private fun ProfileHubQuietPreview() {
    HubPreviewStage {
        ProfileHubSheet(sampleProfile.copy(rightNow = emptyList(), clanBadge = null, historyDoor = null,
            clanDoor = DoorUi("clan", "itm_banner", "CLAN", Verb.BLUE, null, "Build a Clan Hall at Keep 6", sampleLink("hud.build"))),
            ProfileHubActions(), Modifier.fillMaxSize())
    }
}

@Preview(name = "Profile hub: KINGDOMS tab", widthDp = 412, heightDp = 915)
@Composable private fun ProfileHubKingdomsPreview() {
    HubPreviewStage { ProfileHubSheet(sampleProfile.copy(selectedTab = "KINGDOMS"), ProfileHubActions(), Modifier.fillMaxSize()) }
}

@Preview(name = "Profile hub: WALLET tab", widthDp = 412, heightDp = 915)
@Composable private fun ProfileHubWalletPreview() {
    HubPreviewStage { ProfileHubSheet(sampleProfile.copy(selectedTab = "WALLET"), ProfileHubActions(), Modifier.fillMaxSize()) }
}
