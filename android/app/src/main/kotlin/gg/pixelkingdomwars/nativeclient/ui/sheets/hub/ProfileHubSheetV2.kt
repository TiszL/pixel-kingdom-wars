package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.ProgressBar
import gg.pixelkingdomwars.nativeclient.ui.kit.band
import gg.pixelkingdomwars.nativeclient.ui.kit.drawChunky
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.insideStepped
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.PROFILE_TAB
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.ProfileCard
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.ProfileCardActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.sampleProfileCard
import kotlinx.coroutines.delay

/**
 * Design component: the Profile hub's PROFILE tab, RE-DONE (design/final/hub/SPEC.md part two §D + critic fix; hub.png):
 * RIGHT NOW is now at most THREE situational cards that carry the place's own art, not a five-row GO list: one wide
 * headline card (the top priority, `ready` look: e.g. the Gold Forge t3 at 112 on a sunray well, PS 12 "1,240 KEEP", VT
 * "ready to claim · Gold Forge", a blue GO 64 × 56) and two half cards 126 tall (an art well 68 with the place's art on
 * the card tone `#14121A`, PS 12 title, VT 18 where, a blue GO 58 × 44 on the art's corner). The whole card is the door
 * (the GO is its painted face, so the target is the card, ≥ 48 dp). Priority is unchanged (claim > returned > auction /
 * outbid > idle builder > quest); only the top three show. The stat cards, THIS WEEK and the door row are kept.
 *
 * Replaces: the private `ProfileBody` of `sheets/hub/ProfileHubSheet.kt` (its RIGHT NOW list). Mount it as the PROFILE
 * tab of the account cluster's four-tab `ProfileCard` (`profileTab = { ProfileTabV2(ui, on) }`), which already draws the
 * shared header crop (critic fix: the same 390 × 138 crop on every Profile tab) and the PROFILE · KINGDOMS · WALLET ·
 * ACCOUNT tabs.
 * Motion: cards pop in with a 40 ms stagger on open (none under reduced motion); GO is the host's (card exit 160, camera
 * flies 400 `out`, the building is selected and its plate pulses once).
 */

/** One RIGHT NOW card (part two §D `NowCardUi`). */
@Immutable data class NowCardUi(
    /** The place's own art (`goldforge-t3-idle` 112, `voyage:veh-cargo-cutter-t2`, an island thumbnail, …). */
    val art: String,
    /** "sunrays" (a claim) or anything else for the card tone `#14121A` ([nowArtBg]). */
    val artBg: String,
    /** PS 12 ("1,240 KEEP", "BOAT IS BACK", "AUCTION LIVE"). */
    val title: String,
    /** VT ("ready to claim · Gold Forge", "+40 cargo · Lodge", "Spot 142 · 2h 10m"). */
    val where: String,
    /** Claimable / collectable now: the headline uses the green `ready` look. */
    val ready: Boolean,
    /** Where the card flies (usually `FocusBuilding(type, then = …)`). */
    val destination: HubLink,
)

/** Everything the re-done PROFILE tab draws (the kept parts reuse the committed hub types). */
@Immutable data class ProfileTabV2Ui(
    val league: LeagueStatUi,
    /** Null hides the card (never "0"). */
    val exp: ProgressStatUi?,
    /** Null hides the card (never "0"). */
    val renown: String?,
    /** In priority order (the mapper sorts); drawn through [nowCards] (≤ 3; index 0 = headline). */
    val rightNow: List<NowCardUi>,
    val week: List<WeekRowUi>,
    val clanBadge: BadgeUi?,
    val clanDoor: DoorUi,
    val leagueDoor: DoorUi? = null,
    val historyDoor: DoorUi? = null,
    val inviteDoor: DoorUi? = null,
    /** Loading: card shells with skeleton art; Error: ErrorRow in place of the cards. */
    val load: LoadState = LoadState.Ready,
    /** The one dim card when nothing needs the player (no GO). */
    val quietLine: String = "All quiet. Your builders are busy.",
)

/** The PROFILE tab callbacks (the committed `ProfileHubActions` semantics). */
@Immutable data class ProfileTabV2Actions(
    /** A card / blue door: close the card, fly the camera, select, then open. */
    val onGo: (HubLink) -> Unit = {},
    /** Pages: StatCards, THIS WEEK rows, stone doors. */
    val onOpen: (HubLink) -> Unit = {},
    /** A locked door: show [reason] with a GO to [unlock]. */
    val onLocked: (reason: String, unlock: HubLink?) -> Unit = { _, _ -> },
    val onRetry: () -> Unit = {},
    val onReport: () -> Unit = {},
)

/**
 * The re-done PROFILE tab body (the account `ProfileCard`'s `profileTab` slot).
 *
 * Pointer rule: only the painted cards, rows and doors take touches; nothing here is full-screen or a scrim (the FULL-card
 * scrim is the SheetHost's).
 */
@Composable fun ColumnScope.ProfileTabV2(ui: ProfileTabV2Ui, on: ProfileTabV2Actions) {
    val view = boardView(ui.load, ui.rightNow.isNotEmpty())
    Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        val asOf = when (val load = ui.load) { is LoadState.Stale -> load.asOf; is LoadState.Error -> load.asOf; else -> null }
        if (asOf != null) StatusTag("as of $asOf", Verb.STONE)
        StatRow(ui, on)
        SectionHeader("RIGHT NOW", note = "GO flies you there")
        when (view) {
            BoardView.SKELETON -> CardShells()
            BoardView.ERROR_KEPT, BoardView.ERROR_EMPTY -> (ui.load as? LoadState.Error)?.let { ErrorRow(it, on.onRetry, on.onReport) }
            else -> {
                val cards = nowCards(ui.rightNow)
                if (cards.isEmpty()) CardRow(variant = RowVariant.DIM, height = 64.dp) { RowText(ui.quietLine, null) }
                cards.firstOrNull()?.let { HeadlineCard(it, 0) { on.onGo(it.destination) } }
                if (cards.size > 1) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    cards.drop(1).forEachIndexed { i, c -> HalfCard(c, i + 1, Modifier.weight(1f)) { on.onGo(c.destination) } }
                    if (cards.size == 2) Box(Modifier.weight(1f))
                }
            }
        }
        if (ui.week.isNotEmpty()) SectionHeader("THIS WEEK", Modifier.padding(top = 2.dp), note = "rewards you are building")
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
    Row(Modifier.fillMaxWidth().padding(top = 10.dp), horizontalArrangement = Arrangement.SpaceAround) {
        listOfNotNull(ui.leagueDoor, ui.clanDoor, ui.historyDoor, ui.inviteDoor).forEach { door ->
            val locked = door.lockedReason
            val isClan = door.id == ui.clanDoor.id
            DoorButton(door.icon, door.label, door.verb, onClick = {
                val link = door.link
                when {
                    locked != null -> on.onLocked(locked, door.unlockLink)
                    // A door must never do nothing: an unrouted door says so instead of swallowing the tap.
                    link == null -> on.onLocked("This is not open yet.", null)
                    door.verb == Verb.BLUE -> on.onGo(link)
                    else -> on.onOpen(link)
                }
            }, locked = locked != null, badge = if (isClan) ui.clanBadge else null,
                description = listOfNotNull(door.label, locked, if (isClan) ui.clanBadge?.description else null).joinToString(". "))
        }
    }
}

/** League · EXP · Renown StatCards (kept from hub.png). */
@Composable private fun StatRow(ui: ProfileTabV2Ui, on: ProfileTabV2Actions) {
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
}

/** The card's pop-in (scale 0 → 1 after a 40 ms × [index] stagger, `pop`); none under reduced motion or in previews. */
@Composable private fun Modifier.cardPop(index: Int): Modifier {
    val still = LocalReducedMotion.current || LocalInspectionMode.current
    val s = remember { Animatable(if (still) 1f else 0f) }
    LaunchedEffect(Unit) {
        if (!still) { delay(index * HubMotion.PIP_STAGGER.toLong()); s.animateTo(1f, tween(PkwTokens.Motion.BADGE_POP, easing = PkwTokens.Motion.Pop)) }
    }
    return graphicsLayer { scaleX = s.value; scaleY = s.value; alpha = s.value.coerceIn(0f, 1f) }
}

/** A clickable card shell: ink S rim, [face] body with the 3 dp cream-lo band; [rim] a 3 dp inner rim (ready = green). */
private fun Modifier.cardShell(face: Color, rim: Color?): Modifier = drawBehind {
    val w = size.width; val h = size.height; val i = 2.dp.toPx()
    fillStepped(0f, 0f, w, h, CornerProfiles.S, PkwTokens.Colors.ink)
    insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
        drawRect(face)
        band(i, w - i, h - i - 3.dp.toPx(), 3.dp.toPx(), PkwTokens.Colors.creamLo)
        if (rim != null) {
            val r = 3.dp.toPx()
            band(i, w - i, i, r, rim); band(i, w - i, h - i - r, r, rim)
            drawRect(rim, Offset(i, i), androidx.compose.ui.geometry.Size(r, h - 2 * i))
            drawRect(rim, Offset(w - i - r, i), androidx.compose.ui.geometry.Size(r, h - 2 * i))
        }
    }
}

/** hub.html splits the headline's where line at its " · ": the state ("ready to claim", ink) over the place ("Gold Forge",
 *  ink-2). A where line without a separator stays one ink line. */
internal fun headlineWhere(where: String): Pair<String, String?> {
    val cut = where.indexOf(" · ")
    return if (cut < 0) where to null else where.substring(0, cut) to where.substring(cut + 3).takeIf { it.isNotBlank() }
}

/** The headline card (100 tall, hub.html): the art well 100 × 84 (sunrays or card tone, the art at 112 cropped), PS 12
 *  title, the VT 18 state line (ink) and place line (ink-2), and the painted blue GO 64 × 56. The whole card is the door. */
@Composable private fun HeadlineCard(card: NowCardUi, index: Int, onGo: () -> Unit) {
    val (state, place) = headlineWhere(card.where)
    Row(Modifier.fillMaxWidth().heightIn(min = 100.dp).cardPop(index).sceneInputRegion()
        .clearAndSetSemantics { contentDescription = "Go: ${card.title}, ${card.where}"; role = Role.Button; this.onClick(label = null, action = { onGo(); true }) }
        .clickable(role = Role.Button, onClick = onGo)
        .cardShell(if (card.ready) HubColors.rowReady else PkwTokens.Colors.cream, if (card.ready) PkwTokens.Colors.green.face else null)
        .padding(start = 8.dp, end = 10.dp, top = 6.dp, bottom = 7.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        ArtWell(card, Modifier.size(100.dp, 84.dp), 112.dp)
        Column(Modifier.weight(1f)) {
            PkwText(card.title, PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
            PkwText(state, PkwTokens.Type.small, Modifier.padding(top = 4.dp), color = PkwTokens.Colors.textOnParch)
            place?.let { PkwText(it, PkwTokens.Type.small, Modifier.padding(top = 2.dp), color = PkwTokens.Colors.textOnParch2) }
        }
        PaintedGo(Modifier.size(64.dp, 56.dp))
    }
}

/** A half card (126 tall, padding 8): the art well 68 (full width) with the painted GO 58 × 44 on its bottom-right
 *  corner, PS 12 title 6 dp below, VT 18 where. The whole card is the door. */
@Composable private fun HalfCard(card: NowCardUi, index: Int, modifier: Modifier, onGo: () -> Unit) {
    Column(modifier.heightIn(min = 126.dp).cardPop(index).sceneInputRegion()
        .clearAndSetSemantics { contentDescription = "Go: ${card.title}, ${card.where}"; role = Role.Button; this.onClick(label = null, action = { onGo(); true }) }
        .clickable(role = Role.Button, onClick = onGo)
        .cardShell(if (card.ready) HubColors.rowReady else PkwTokens.Colors.cream, null)
        .padding(8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Box(Modifier.fillMaxWidth().height(68.dp)) {
            ArtWell(card, Modifier.fillMaxSize(), 112.dp)
            PaintedGo(Modifier.align(Alignment.BottomEnd).size(58.dp, 44.dp))
        }
        PkwText(card.title, PkwTokens.Type.label, Modifier.padding(top = 4.dp), color = PkwTokens.Colors.textOnParch)
        PkwText(card.where, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
    }
}

/** The art well: sunrays (a claim) or the card tone `#14121A`; the art at [artSize], bottom-aligned, cropped to the well. */
@Composable private fun ArtWell(card: NowCardUi, modifier: Modifier, artSize: Dp, content: (@Composable BoxScope.() -> Unit)? = null) {
    val bg = nowArtBg(card.artBg)
    Box(modifier.background(PkwTokens.Colors.ink).padding(2.dp).clipToBounds().drawBehind {
        if (bg == NowArtBg.SUNRAYS) drawSunrayStage(Offset(size.width / 2f, size.height * 0.6f), 0f) else drawRect(NOW_CARD_TONE)
    }, contentAlignment = Alignment.BottomCenter) {
        R2HubArt(card.art, artSize)
        content?.invoke(this)
    }
}

/** The blue GO face, painted (the card is the target, so this is not a second button). */
@Composable private fun PaintedGo(modifier: Modifier) {
    Box(modifier.clearAndSetSemantics { }.drawBehind { drawChunky(PkwTokens.Colors.blue, 0f) }, contentAlignment = Alignment.Center) {
        PkwText("GO", PkwTokens.Type.caption, Modifier.padding(bottom = 4.dp), color = PkwTokens.Colors.label, outline = 1.dp)
    }
}

/** Critic fix: both RIGHT NOW art wells use the card tone `#14121A` (the off-token sea blues are gone). */
private val NOW_CARD_TONE = Color(0xFF14121A)

/** Loading: one headline shell and two half shells with skeleton art. */
@Composable private fun CardShells() {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.fillMaxWidth().heightIn(min = 92.dp).cardShell(PkwTokens.Colors.cream, null).padding(8.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            SkeletonBlock(Modifier.size(100.dp, 76.dp), dark = true)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SkeletonBlock(Modifier.fillMaxWidth(0.6f).height(14.dp)); SkeletonBlock(Modifier.fillMaxWidth(0.8f).height(12.dp))
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            repeat(2) {
                Column(Modifier.weight(1f).heightIn(min = 126.dp).cardShell(PkwTokens.Colors.cream, null).padding(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    SkeletonBlock(Modifier.fillMaxWidth().height(68.dp), dark = true)
                    SkeletonBlock(Modifier.fillMaxWidth(0.7f).height(12.dp))
                }
            }
        }
    }
}

// ---- Previews (hub.png numbers; every number is a placeholder) ----

private val sampleTabV2 = ProfileTabV2Ui(
    league = LeagueStatUi("league-gold", "1,284", "Gold league", sampleLink("hud.leagues")),
    exp = ProgressStatUi("LV 7", 0.6f, "Level 7, 60 percent to level 8"), renown = "340",
    rightNow = listOf(
        NowCardUi("goldforge-t3-idle", "sunrays", "1,240 KEEP", "ready to claim · Gold Forge", true, sampleLink("goldforge.claim")),
        NowCardUi("voyage:veh-survey-balloon-t2", "card", "BOAT IS BACK", "+40 cargo · Lodge", true, sampleLink("lodge.expedition")),
        NowCardUi("site:seeker-active", "card", "AUCTION LIVE", "Spot 142 · 2h 10m", false, sampleLink("island.seeker")),
    ),
    week = listOf(
        WeekRowUi("league", "league-gold", "League reward · 3/5 wins", 3, 5, "4d left", destination = sampleLink("hud.leagues")),
        WeekRowUi("quests", "quest", "Daily quests · 4/6", 4, 6, "+500", "shards", sampleLink("hud.quests")),
    ),
    clanBadge = BadgeUi("4", BadgeTone.COUNT, "4 unread clan messages"),
    clanDoor = DoorUi("clan", "itm_banner", "CLAN", Verb.BLUE, sampleLink("clan.open")),
    leagueDoor = DoorUi("league", "trophy", "LEAGUE", Verb.STONE, sampleLink("hud.leagues")),
    historyDoor = DoorUi("history", "replay", "HISTORY", Verb.STONE, sampleLink("profile.history")),
    inviteDoor = DoorUi("invite", "referral", "INVITE", Verb.STONE, sampleLink("profile.invite")),
)

@Preview(name = "Profile: RIGHT NOW cards (hub.png)", widthDp = 412, heightDp = 915)
@Composable private fun ProfileTabV2Preview() {
    HubPreviewStage {
        ProfileCard(sampleProfileCard.copy(selectedTab = PROFILE_TAB), ProfileCardActions(), Modifier.fillMaxSize(),
            profileTab = { ProfileTabV2(sampleTabV2, ProfileTabV2Actions()) })
    }
}

@Preview(name = "Profile RIGHT NOW: two cards / all quiet", widthDp = 412, heightDp = 915)
@Composable private fun ProfileTabV2QuietPreview() {
    HubPreviewStage {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            ProfileCard(sampleProfileCard.copy(selectedTab = PROFILE_TAB), ProfileCardActions(), Modifier.weight(1f),
                profileTab = { ProfileTabV2(sampleTabV2.copy(rightNow = sampleTabV2.rightNow.take(2)), ProfileTabV2Actions()) })
            ProfileCard(sampleProfileCard.copy(selectedTab = PROFILE_TAB), ProfileCardActions(), Modifier.weight(1f),
                profileTab = { ProfileTabV2(sampleTabV2.copy(rightNow = emptyList()), ProfileTabV2Actions()) })
        }
    }
}

@Preview(name = "Profile RIGHT NOW: loading shells / error", widthDp = 412, heightDp = 915)
@Composable private fun ProfileTabV2StatesPreview() {
    HubPreviewStage {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            ProfileCard(sampleProfileCard.copy(selectedTab = PROFILE_TAB), ProfileCardActions(), Modifier.weight(1f),
                profileTab = { ProfileTabV2(sampleTabV2.copy(rightNow = emptyList(), load = LoadState.Loading), ProfileTabV2Actions()) })
            ProfileCard(sampleProfileCard.copy(selectedTab = PROFILE_TAB), ProfileCardActions(), Modifier.weight(1f),
                profileTab = { ProfileTabV2(sampleTabV2.copy(load = LoadState.Error("Can't reach your kingdom's news.", asOf = "14:02")), ProfileTabV2Actions()) })
        }
    }
}
