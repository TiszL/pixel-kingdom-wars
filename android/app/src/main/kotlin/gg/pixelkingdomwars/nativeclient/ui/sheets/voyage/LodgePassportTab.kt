package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage

import android.os.Build
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.tooling.preview.Preview
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.VeilChip
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildingArt
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.drawGrass

/*
 * Design component: Lodge › PASSPORT (design/final/voyage/passport.png; SPEC "E1.1 Lodge PASSPORT tab", registry row 69
 * `Lodge(tab = "PASSPORT")`). The native `RealmPassportScreen` / `GET /renown/me` is a RECORD (completed expeditions,
 * renown, participation days); its own copy says it grants no rewards or access, so stamps here record where your boats
 * went and unlock nothing (a permit or your deed opens a realm). Header: current grass, the Lodge (168 dp) with the
 * realm-passport book 64 beside it, live chip "4 of 8 realms". Body: three 64 dp stat cards (renown · trips · days), the
 * 4 × 2 STAMPS grid (98 dp StampTiles: a 48 frame with a 3 dp gold-lo ring on #FFF3C8 holding the realm's raw resource,
 * the full realm name — "Solana Reach", never shortened, tightened −0.5 px — and "×9"; not yet = dashed frame, icon grey
 * at 40 %, "not yet"; the home realm wears a green HOME tag), the note, and LAST RETURNS (route art 44, name, vehicle ·
 * time, moss STAMPED). Footer: blue SEND A TRIP (no gold: nothing to buy or claim); REFRESH STAMPS only in the error state.
 *
 * Motion: stamp press = ring scale 1.06 for 90 ms; a new stamp pops 0.8 → 1 in 180 ms `pop` (the count ticks up via the
 * host's state). Reduced motion: no scale, no pop.
 *
 * Pointer rule: drawn inside the Lodge sheet's painted panel; only the stamps, the return rows and the footer buttons take
 * touches (each ≥ 48 dp, a scene-input region). The header art is paint only. No scrim.
 */

/** Where the passport records come from (SPEC `SourceState`). */
enum class SourceState { OK, NOT_CONFIGURED, CONFLICT, UNAVAILABLE }

/** One realm stamp (SPEC `StampUi(realmId, name, resourceIcon, trips, home)`). */
@Immutable data class StampUi(
    val realmId: String,
    /** The realm's full display name ("Solana Reach" for `seeker-reach`; never "Seeker R."). */
    val name: String,
    /** The realm's raw resource icon (`voyage:crown-iron-ore`), the craft §4 realm → resource table. */
    val resourceIcon: String,
    /** Completed returns there; 0 = not yet (dashed). */
    val trips: Int,
    /** The home realm wears a green HOME tag. */
    val home: Boolean,
)

/** One recorded return (SPEC `ReturnRowUi(routeId, routeName, vehicle, at)`; fields after `at` were added). */
@Immutable data class ReturnRowUi(
    val routeId: String,
    /** "Glasswake Keys 3". */
    val routeName: String,
    /** "Cutter T2", "Starter boat". */
    val vehicle: String,
    /** "yesterday 21:40". */
    val at: String,
    /** Added: the history id handed back by `onReturn`. */
    val id: String = "$routeId@$at",
    /** Added: the route for its 44 dp art (null draws the sea stand-in). */
    val route: RouteUi? = null,
)

/** Lodge › PASSPORT state (SPEC `PassportUi`; fields after `sourceState` were added). */
@Immutable data class PassportUi(
    /** Renown, server-formatted ("120"; "…" unknown). */
    val renown: String,
    /** Completed returns ("21"). */
    val trips: String,
    /** Participation days ("14"). */
    val days: String,
    /** One per realm (8), in the game's realm order. */
    val stamps: List<StampUi>,
    /** The last recorded returns, newest first. */
    val recent: List<ReturnRowUi>,
    /** "2 min ago"; null = unknown. */
    val refreshedAgo: String?,
    /** OK, NOT_CONFIGURED, CONFLICT or UNAVAILABLE (error copy + REFRESH STAMPS). */
    val sourceState: SourceState,
    /** Added: a refresh is running (2 dp stone line; skeleton stamps when [stamps] is empty). */
    val loading: Boolean = false,
    /** Added: the realm whose stamp was just earned (its ring pops). */
    val newStampRealmId: String? = null,
    /** Added: the Lodge's art tier for the header (`ui:lodge-t{n}-idle`). */
    val lodgeTier: Int = 2,
)

/** Lodge › PASSPORT callbacks (SPEC: onStamp, onRefreshStamps, onSendTrip, onReturn). */
@Immutable data class PassportActions(
    /** A stamp → that realm's trips list (half sheet). */
    val onStamp: (realmId: String) -> Unit = {},
    /** REFRESH STAMPS (error state only). */
    val onRefreshStamps: () -> Unit = {},
    /** SEND A TRIP → the SEND tab. */
    val onSendTrip: () -> Unit = {},
    /** A return row → History. */
    val onReturn: (id: String) -> Unit = {},
)

/** The PASSPORT header: current-grass stand-in, the Lodge at 168 dp, the passport book 64 and the "4 of 8 realms" chip.
 *  Paint only (SheetFrame draws the title plate, History and close over it). */
@Composable fun BoxScope.PassportHeader(ui: PassportUi) {
    Box(Modifier.matchParentSize().drawBehind { drawGrass() })
    // passport.html: the Lodge at (196, −26) 168 dp in the 398 × 136 header (right edge 34 in, bottom 6 under), the book
    // at (126, 30) 64 dp, and the live chip with ready-status.
    BuildingArt("ui:lodge-t${ui.lodgeTier.coerceIn(1, 4)}-idle", 168.dp, Modifier.align(Alignment.BottomEnd).offset(x = (-34).dp, y = 6.dp))
    VoyageIcon("voyage:realm-passport", 64.dp, Modifier.align(Alignment.TopStart).offset(x = 126.dp, y = 30.dp), contentDescription = "Realm passport")
    VeilChip(passportRealmsLine(ui.stamps), Modifier.align(Alignment.BottomStart).padding(start = 6.dp, bottom = 6.dp), icon = "ui:ready-status")
}

/** The PASSPORT body: stats, stamps, note, last returns. */
@Composable fun ColumnScope.PassportBody(ui: PassportUi, on: PassportActions) {
    val c = PkwTokens.Colors
    RefreshLine(ui.loading)
    passportSourceLine(ui.sourceState)?.let { line ->
        VoyageRow(rim = c.gold.face) { PkwText(line, PkwTokens.Type.body, Modifier.weight(1f).padding(horizontal = 6.dp), color = c.textOnParch, maxLines = 2) }
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        StatCard("ui:renown", ui.renown, "renown", Modifier.weight(1f))
        StatCard("ui:lodge-menu", ui.trips, "trips", Modifier.weight(1f))
        StatCard("ui:exp", ui.days, "days", Modifier.weight(1f))
    }
    VoyageLabel("STAMPS", "one per realm your boats reached")
    val stamps: List<StampUi?> = if (ui.stamps.isEmpty() && ui.loading) List(8) { null } else ui.stamps
    // passport.html `.stamps`: a 4-column grid, 6 apart both ways.
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        stamps.chunked(4).forEach { row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                row.forEach { s -> if (s == null) SkeletonStamp(Modifier.weight(1f)) else StampTile(s, s.realmId == ui.newStampRealmId, on.onStamp, Modifier.weight(1f)) }
                repeat(4 - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
    PkwText(if (passportIsEmpty(ui)) "Your first trip stamps your home realm."
        else "A record of your trips. Stamps unlock nothing: a permit or your deed opens a realm.",
        PkwTokens.Type.small, color = c.textOnParch2, maxLines = 3)
    if (ui.recent.isNotEmpty()) {
        VoyageLabel("LAST RETURNS", "recorded by the realm")
        // passport.html: 56 dp IngredientRows, 4 apart.
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            ui.recent.forEach { r ->
                VoyageRow(minHeight = 56.dp, description = "${r.routeName}, ${r.vehicle}, ${r.at}, stamped", onClick = { on.onReturn(r.id) }) {
                    SeaWell(Modifier.padding(start = 4.dp).size(44.dp)) { r.route?.let { LocalVoyageArt.current.routeCard(it, Modifier.size(40.dp)) } }
                    Column(Modifier.weight(1f)) {
                        PkwText(r.routeName, PkwTokens.Type.body, color = c.textOnParch)
                        PkwText("${r.vehicle} · ${r.at}", PkwTokens.Type.small, color = c.textOnParch2)
                    }
                    Tag("STAMPED", Verb.MOSS, Modifier.padding(end = 4.dp))
                }
            }
        }
    }
}

/** The PASSPORT footer: blue SEND A TRIP ("to a realm without a stamp"); in the error state stone REFRESH STAMPS beside it. */
@Composable fun ColumnScope.PassportFooter(ui: PassportUi, on: PassportActions) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (passportShowsRefresh(ui.sourceState)) SecondaryButton("REFRESH STAMPS", on.onRefreshStamps, Modifier.weight(1f),
            contentDescription = "Refresh the passport stamps")
        PrimaryButton("SEND A TRIP", on.onSendTrip, Modifier.weight(if (passportShowsRefresh(ui.sourceState)) 1.2f else 1f), verb = Verb.BLUE,
            sub = "to a realm without a stamp")
    }
}

/** A 64 dp stat card (passport.html `.ptile`): icon 32, PS 13 value, VT 18 word, 6 in from the 2 dp rim. Paint only. */
@Composable private fun StatCard(icon: String, value: String, word: String, modifier: Modifier) {
    val c = PkwTokens.Colors
    Plate(PlateKind.CREAM, modifier.heightIn(min = 64.dp).clearAndSetSemantics { contentDescription = "$value $word" },
        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp), blocksScene = false) {
        Row(Modifier.align(Alignment.CenterStart), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            VoyageIcon(icon, 32.dp)
            Column {
                PkwText(value, PkwTokens.Type.title, color = c.textOnParch)
                PkwText(word, PkwTokens.Type.small, color = c.textOnParch2)
            }
        }
    }
}

/** One 98 dp StampTile: the 48 frame (gold-lo ring on #FFF3C8, or dashed + grey icon at 40 %), name, "×9" / "not yet",
 *  HOME tag. Press: ring 1.06 for 90 ms; a new stamp pops 0.8 → 1 in 180 ms `pop`. Its own ≥ 48 dp target. */
@Composable private fun StampTile(s: StampUi, isNew: Boolean, onClick: (String) -> Unit, modifier: Modifier) {
    val c = PkwTokens.Colors
    val reached = stampReached(s)
    val reduced = LocalReducedMotion.current
    val still = reduced || LocalInspectionMode.current
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val press by animateFloatAsState(if (pressed && !reduced) 1.06f else 1f, tween(PkwTokens.Motion.RELEASE), label = "stampPress")
    val pop = remember(s.realmId, isNew) { Animatable(if (isNew && !still) 0.8f else 1f) }
    LaunchedEffect(s.realmId, isNew) { if (isNew && !still) pop.animateTo(1f, tween(PkwTokens.Motion.BADGE_POP, easing = PkwTokens.Motion.Pop)) }
    val nameStyle = if (stampNameNeedsTightTracking(s.name)) PkwTokens.Type.small.copy(letterSpacing = (-0.5).sp) else PkwTokens.Type.small
    Box(modifier) {
        // passport.html `.stp.no`: a stamp not yet earned sits on parchment, not cream, so the earned ones stand out.
        Plate(PlateKind.CREAM, Modifier.fillMaxWidth().heightIn(min = 98.dp).sceneInputRegion()
            .clearAndSetSemantics {
                contentDescription = "${s.name}${if (s.home) ", home" else ""}, ${if (reached) "${s.trips} trips" else "not yet"}"
                role = Role.Button
                this.onClick(label = null, action = { onClick(s.realmId); true })
            }
            .clickable(interactionSource = interaction, indication = null, role = Role.Button) { onClick(s.realmId) },
            contentPadding = PaddingValues(start = 2.dp, top = 8.dp, end = 2.dp, bottom = 6.dp), tint = if (reached) null else c.parchment) {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Box(Modifier.size(48.dp).graphicsLayer { val k = press * pop.value; scaleX = k; scaleY = k }
                    .drawBehind {
                        val w = size.width; val h = size.height; val r = 3.dp.toPx()
                        if (reached) {
                            drawRect(c.gold.lo)
                            drawRect(c.selectedTint, Offset(r, r), Size(w - 2 * r, h - 2 * r))
                        } else {
                            // A 2 dp dashed parch-dk frame (`.stp.no .ring`).
                            val d = 2.dp.toPx()
                            drawRect(c.parchmentLo, Offset(d / 2, d / 2), Size(w - d, h - d),
                                style = Stroke(d, pathEffect = PathEffect.dashPathEffect(floatArrayOf(5.dp.toPx(), 4.dp.toPx()))))
                        }
                    }, contentAlignment = Alignment.Center) {
                    VoyageIcon(s.resourceIcon, 32.dp, if (reached) Modifier else Modifier.greyed(), alpha = if (reached) 1f else 0.4f)
                }
                PkwText(s.name, nameStyle, color = c.textOnParch, textAlign = TextAlign.Center)
                // "×9" is PS 11 in ink-2; "not yet" VT 18 ink-2 (`.stp .ct`).
                PkwText(stampCaption(s), if (reached) PkwTokens.Type.caption else PkwTokens.Type.small, color = c.textOnParch2)
            }
        }
        // `.stp .home`: the green HOME tag rides the tile's top-right corner.
        if (s.home) Tag("HOME", Verb.GREEN, Modifier.align(Alignment.TopEnd).offset(x = (-1).dp, y = 1.dp))
    }
}

/** A first-load skeleton stamp: a cream 98 dp tile with a dashed frame and "…". Paint only. */
@Composable private fun SkeletonStamp(modifier: Modifier) {
    Plate(PlateKind.CREAM, modifier.heightIn(min = 98.dp), blocksScene = false) {
        PkwText("…", PkwTokens.Type.body, Modifier.align(Alignment.Center), color = PkwTokens.Colors.textOnParch2)
    }
}

/** Grey the content (saturation 0) where the platform supports it (API 29+); below that only the caller's alpha shows. */
private fun Modifier.greyed(): Modifier = this
    .graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen)
    .drawWithContent {
        drawContent()
        if (Build.VERSION.SDK_INT >= 29) drawRect(Color.Gray, blendMode = BlendMode.Saturation)
    }

// ---------------------------------------------------------------------------------------------------------------- previews

private fun passportLodge(p: PassportUi) = VoyageR2Samples.lodgePassport.copy(passport = p)

@Preview(name = "Lodge › PASSPORT (passport.png)", widthDp = 412, heightDp = 915)
@Composable private fun PassportPreview() = LodgeR2PreviewHost(passportLodge(VoyageR2Samples.passport))

@Preview(name = "Lodge › PASSPORT, a new stamp (pop)", widthDp = 412, heightDp = 915)
@Composable private fun PassportNewStampPreview() = LodgeR2PreviewHost(passportLodge(VoyageR2Samples.passport.copy(newStampRealmId = "thornwake")))

@Preview(name = "Lodge › PASSPORT, empty (no trips yet)", widthDp = 412, heightDp = 915)
@Composable private fun PassportEmptyPreview() = LodgeR2PreviewHost(passportLodge(VoyageR2Samples.passport.copy(renown = "0", trips = "0", days = "0",
    stamps = VoyageR2Samples.passport.stamps.map { it.copy(trips = 0) }, recent = emptyList())))

@Preview(name = "Lodge › PASSPORT, first load (skeleton stamps)", widthDp = 412, heightDp = 915)
@Composable private fun PassportLoadingPreview() = LodgeR2PreviewHost(passportLodge(VoyageR2Samples.passport.copy(renown = "…", trips = "…", days = "…",
    stamps = emptyList(), recent = emptyList(), loading = true)))

@Preview(name = "Lodge › PASSPORT, records unavailable (REFRESH STAMPS)", widthDp = 412, heightDp = 915)
@Composable private fun PassportErrorPreview() = LodgeR2PreviewHost(passportLodge(VoyageR2Samples.passport.copy(sourceState = SourceState.UNAVAILABLE)))
