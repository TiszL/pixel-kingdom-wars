package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.res.imageResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.Badge
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.CloseSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.insideStepped
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlinx.coroutines.delay
import kotlin.math.roundToInt

/**
 * Design component: the Daily Cache (design/final/hub/SPEC.md R2.1 + critic fix; daily-cache.png), registry row 9,
 * `Destination.DailyCache`. A HALF sheet (top 528, ending at its content, no scrim): the charcoal header (chest 28, PS 13
 * gold-hi "DAILY CACHE", VT 20 muted "day 5 of 7", red close 48), the reward row (a dark gold-rimmed 120 × 104 well with
 * stepped gold sunrays turning 8°/s and the authored chest at 84 dp; "TODAY'S CACHE", Shards 36 + PS 16 "+1,500", "Shards,
 * ready to claim"), YOUR STREAK (seven 62-tall day tiles: claimed green with the flame, today gold-rimmed with the chest
 * (bounces 6 dp once on open), future cream with the chest at 45 %; the last carries the gold "x1.5" bonus badge), the
 * rule line and the gold CLAIM. Opened by the DAILY edge button on Home (shown only while a cache is claimable).
 *
 * Success (after the receipt only): the chest becomes the open chest (3 frames at 12 fps); the Shards fly to the Shards
 * readout (the host sets `ResourceChipUi.gain`), the DAILY edge button hides.
 */

/** Everything the Daily Cache draws (SPEC R2.1 `DailyCacheUi`; fields after `ruleLine` were added with defaults). */
@Immutable data class DailyCacheUi(
    /** "+1,500"; null reads "…". */
    val reward: String?,
    /** The reward's 24 px currency art ("shards"). */
    val currency: String,
    /** Today's streak day (1-based). */
    val day: Int,
    /** Streak length from the pack (`DAILY_CACHE.consistencyStreakDays`); null hides the streak row. */
    val days: Int?,
    /** The last tile's gold badge ("x1.5"); null hides it. */
    val bonusLabel: String?,
    /** A cache is claimable now. */
    val claimable: Boolean,
    /** "14h 20m" until the next cache (after a claim). */
    val nextIn: String?,
    /** "Claim once a day. On day 7 your Mines dig x1.5 for a day. Next cache in 14h after you claim." */
    val ruleLine: String,
    /** Where the claim stands; by default READY when claimable, CLAIMED otherwise. */
    val state: CacheState = if (claimable) CacheState.READY else CacheState.CLAIMED,
    /** The claim receipt: the chest opens only with one (never on a guess). */
    val receiptId: String? = null,
    /** VT 20 under the amount. */
    val rewardLine: String = "Shards, ready to claim",
    /** The primary's sub-line ("+1,500 Shards to your stores"); null draws none. */
    val claimSub: String? = null,
    /** An unavailable cache or invalid server day must not draw an invented streak. */
    val dayKnown: Boolean = true,
    /** The live owner can refuse orders while retaining the server's claimability for display. */
    val claimBlockedReason: String? = null,
    /** The live server counts completed claims, including zero. Null retains design-preview day semantics. */
    val litDays: Int? = null,
)

/** Live tiles use completed claims in both READY and CLAIMED. No current-day highlight is inferred. */
internal fun dailyCacheDays(ui: DailyCacheUi): List<CacheDay>? {
    if (!ui.dayKnown) return null
    val lit = ui.litDays ?: return cacheDays(ui.day, ui.days, claimedToday = ui.state == CacheState.CLAIMED)
    val days = ui.days?.takeIf { it > 0 } ?: return null
    if (lit !in 0..days) return null
    return List(days) { i -> if (i < lit) CacheDay.CLAIMED else CacheDay.FUTURE }
}

/** Daily Cache callbacks (SPEC R2.1 `DailyCacheActions`). CLAIM doubles as RETRY on an uncertain result. */
@Immutable data class DailyCacheActions(
    val onClaim: () -> Unit = {},
    val onClose: () -> Unit = {},
)

/**
 * The Daily Cache half sheet. The host places it at the bottom (top 528 on a 412 × 915 phone), ending at its content.
 *
 * Pointer rule: a HALF sheet with NO scrim: only the painted wood frame and its buttons take touches; a tap on the
 * kingdom above it reaches the scene (the host closes the sheet from the scene's own tap).
 */
@Composable fun DailyCacheSheet(ui: DailyCacheUi, on: DailyCacheActions, modifier: Modifier = Modifier) {
    val streak = dailyCacheDays(ui)
    Plate(PlateKind.WOOD, modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Plate(PlateKind.CHARCOAL, Modifier.weight(1f).heightIn(min = 48.dp).semantics(mergeDescendants = true) { heading() },
                    contentPadding = PaddingValues(start = 10.dp, top = 6.dp, end = 12.dp, bottom = 8.dp), blocksScene = false) {
                    Row(Modifier.fillMaxWidth().align(Alignment.CenterStart), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        R2HubArt("r2:cache-chest", 28.dp)
                        PkwText("DAILY CACHE", PkwTokens.Type.title, Modifier.weight(1f), color = PkwTokens.Colors.gold.hi, outline = 1.dp)
                        if (ui.days != null) PkwText("day ${if (ui.dayKnown) ui.day else UNKNOWN} of ${ui.days}", PkwTokens.Type.body, color = PkwTokens.Colors.muted)
                    }
                }
                CloseSquare(on.onClose)
            }
            Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth(), blocksScene = false) {
                Column(Modifier.fillMaxWidth().padding(2.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    RewardRow(ui)
                    if (streak != null) {
                        HubSectionLine("YOUR STREAK", Modifier.padding(top = 2.dp))
                        StreakTiles(streak, ui.bonusLabel)
                    }
                    PkwText(if (ui.days == null) "Game content update needed" else ui.ruleLine, PkwTokens.Type.small, Modifier.fillMaxWidth(),
                        color = PkwTokens.Colors.textOnParch, maxLines = 3)
                    CacheFooter(ui, on)
                }
            }
        }
    }
}

/** The reward row: the sunray well with the chest (or the opening chest after the receipt) and the amount column. */
@Composable private fun RewardRow(ui: DailyCacheUi) {
    val amount = if (ui.state == CacheState.LOADING) UNKNOWN else ui.reward?.takeIf { it.isNotBlank() } ?: UNKNOWN
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        ChestWell(ui.receiptId)
        Column(Modifier.weight(1f).clearAndSetSemantics { contentDescription = "Today's cache: $amount. ${ui.rewardLine}" },
            verticalArrangement = Arrangement.spacedBy(4.dp)) {
            PkwText("TODAY'S CACHE", PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch2)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PkwIcon(ui.currency, 36.dp)
                PkwText(amount, PkwTokens.Type.numeralL, color = PkwTokens.Colors.textOnParch)
            }
            PkwText(ui.rewardLine, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch, maxLines = 2)
        }
    }
}

/** The dark gold-rimmed 120 × 104 well: stepped sunrays at 8°/s (still under reduced motion) and the chest at 84 dp
 *  (k = 3 of the 28 px `loot.png`); after a receipt the open chest plays its 3 frames at 12 fps and holds. */
@Composable private fun ChestWell(receiptId: String?) {
    val reduced = LocalReducedMotion.current
    val inspection = LocalInspectionMode.current
    val spinning = !reduced && !inspection
    val degrees by produceState(0f, spinning) {
        if (!spinning) return@produceState
        val start = System.nanoTime()
        while (true) {
            delay(1000L / 15L)
            value = ((System.nanoTime() - start) / 1_000_000_000f * PkwTokens.Motion.RAYS_DEG_PER_S) % 360f
        }
    }
    val frame by produceState(0, receiptId) {
        if (receiptId == null) { value = 0; return@produceState }
        val start = System.nanoTime()
        while (true) {
            val f = openChestFrame((System.nanoTime() - start) / 1_000_000L)
            value = f
            if (f >= 3) break
            delay(1000L / 12L)
        }
    }
    Box(Modifier.size(120.dp, 104.dp).background(PkwTokens.Colors.ink).padding(3.dp).background(PkwTokens.Colors.gold.face).padding(3.dp)
        .clipToBounds().drawBehind { drawSunrayStage(Offset(size.width / 2f, size.height / 2f), degrees, HubColors.stageTop, HubColors.stageBottom) }
        .clearAndSetSemantics { contentDescription = if (receiptId != null) "The cache is open" else "A treasure chest" },
        contentAlignment = Alignment.Center) {
        if (frame == 0) R2HubArt("r2:cache-chest", 84.dp) else R2HubArt("r2:cache-open-$frame", 96.dp)
    }
}

/** Seven day tiles (62 tall, ink S rim): claimed green flame, today gold-rimmed chest (bounces 6 dp once), future cream
 *  chest at 45 %; the last tile wears the bonus badge. */
@Composable private fun StreakTiles(days: List<CacheDay>, bonusLabel: String?) {
    val reduced = LocalReducedMotion.current || LocalInspectionMode.current
    val bounce = remember { Animatable(0f) }
    LaunchedEffect(Unit) {
        if (!reduced) {
            bounce.animateTo(-6f, tween(PkwTokens.Motion.BADGE_POP / 2, easing = PkwTokens.Motion.Out))
            bounce.animateTo(0f, tween(PkwTokens.Motion.BADGE_POP / 2, easing = PkwTokens.Motion.Pop))
        }
    }
    // daily-cache.html: the seven tiles sit 4 dp apart; the bonus badge overhangs the last tile by 2 dp right, 12 dp up.
    Row(Modifier.fillMaxWidth().padding(top = if (bonusLabel != null) 8.dp else 0.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        days.forEachIndexed { i, d ->
            val n = i + 1
            val said = when (d) {
                CacheDay.CLAIMED -> "Day $n, claimed"
                CacheDay.TODAY -> "Day $n, today"
                CacheDay.FUTURE -> "Day $n, coming"
            } + if (i == days.lastIndex && bonusLabel != null) ", bonus $bonusLabel" else ""
            Box(Modifier.weight(1f).graphicsLayer { if (d == CacheDay.TODAY) translationY = bounce.value.dp.toPx() }) {
                Column(Modifier.fillMaxWidth().height(62.dp).clearAndSetSemantics { contentDescription = said }.drawBehind {
                    val w = size.width; val h = size.height; val ink = 2.dp.toPx()
                    fillStepped(0f, 0f, w, h, CornerProfiles.S, PkwTokens.Colors.ink)
                    insideStepped(ink, ink, w - ink, h - ink, CornerProfiles.S) {
                        val (face, rim) = when (d) {
                            CacheDay.CLAIMED -> HubColors.rowReady to PkwTokens.Colors.green.face
                            CacheDay.TODAY -> PkwTokens.Colors.selectedTint to PkwTokens.Colors.gold.face
                            CacheDay.FUTURE -> PkwTokens.Colors.cream to null
                        }
                        drawRect(face)
                        if (rim != null) {
                            val r = 3.dp.toPx()
                            drawRect(rim, Offset(ink, ink), Size(w - 2 * ink, r)); drawRect(rim, Offset(ink, h - ink - r), Size(w - 2 * ink, r))
                            drawRect(rim, Offset(ink, ink), Size(r, h - 2 * ink)); drawRect(rim, Offset(w - ink - r, ink), Size(r, h - 2 * ink))
                        }
                    }
                }, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                    when (d) {
                        CacheDay.CLAIMED -> PkwIcon("streak", 24.dp)
                        CacheDay.TODAY -> R2HubArt("r2:cache-chest", 28.dp)
                        CacheDay.FUTURE -> FutureChest()
                    }
                    PkwText("D$n", PkwTokens.Type.caption, color = if (d == CacheDay.CLAIMED) PkwTokens.Colors.green.lo else PkwTokens.Colors.textOnParch)
                }
                if (i == days.lastIndex && bonusLabel != null) {
                    Badge(BadgeUi(bonusLabel, BadgeTone.REWARD, "Bonus $bonusLabel on day $n"), Modifier.align(Alignment.TopEnd).offset(x = 2.dp, y = (-12).dp))
                }
            }
        }
    }
}

/** A coming day's chest: grayscale at 45 % (SPEC R2.1 "chest grayscale 45%"; daily-cache.html `filter: grayscale(1);
 *  opacity: .45`), drawn at a whole art scale like [R2HubArt]. */
@Composable private fun FutureChest() {
    val id = hubR2Drawable("r2:cache-chest")
    if (id == null) { R2HubArt("r2:cache-chest", 28.dp, alpha = 0.45f); return }
    val bitmap = ImageBitmap.imageResource(id)
    val grey = remember { ColorFilter.colorMatrix(ColorMatrix().apply { setToSaturation(0f) }) }
    Canvas(Modifier.size(28.dp)) {
        val k = minOf(fitArtScale(size.width, bitmap.width), fitArtScale(size.height, bitmap.height))
        val w = bitmap.width * k; val h = bitmap.height * k
        drawImage(bitmap, IntOffset.Zero, IntSize(bitmap.width, bitmap.height),
            IntOffset(((size.width - w) / 2f).roundToInt(), ((size.height - h) / 2f).roundToInt()), IntSize(w, h),
            alpha = 0.45f, colorFilter = grey, filterQuality = FilterQuality.None)
    }
}

/** CLAIM by state: gold CLAIM (Shards 36 + "+1,500 Shards to your stores"), stone dots while loading / claiming, moss
 *  CLAIMED TODAY (off) + "Next cache in …", or "Being checked" with CLAIM kept as RETRY. */
@Composable private fun CacheFooter(ui: DailyCacheUi, on: DailyCacheActions) {
    if (ui.state == CacheState.READY && ui.claimBlockedReason != null) {
        PrimaryButton("CLAIM", {}, Modifier.fillMaxWidth(), state = CommandState.DISABLED, reason = ui.claimBlockedReason)
        return
    }
    when (ui.state) {
        CacheState.READY -> PrimaryButton(cacheClaimLabel(ui.state), on.onClaim, Modifier.fillMaxWidth(), icon = ui.currency, sub = ui.claimSub)
        CacheState.LOADING, CacheState.CLAIMING -> PrimaryButton(cacheClaimLabel(ui.state), {}, Modifier.fillMaxWidth(), state = CommandState.BUSY)
        CacheState.CLAIMED -> {
            ChunkyBox(PkwTokens.ramp(Verb.MOSS), {}, "Claimed today. ${nextCacheLine(ui.nextIn)}",
                Modifier.fillMaxWidth().heightIn(min = PkwTokens.Dims.sheetPrimaryH), enabled = false) {
                PkwText(cacheClaimLabel(ui.state), PkwTokens.Type.primary, color = PkwTokens.Colors.label, outline = 2.dp)
            }
            PkwText(nextCacheLine(ui.nextIn), PkwTokens.Type.small, Modifier.fillMaxWidth(), color = PkwTokens.Colors.textOnParch2,
                textAlign = TextAlign.Center)
        }
        CacheState.CHECKING -> {
            PkwText("Being checked", PkwTokens.Type.small, Modifier.fillMaxWidth(), color = PkwTokens.Colors.textOnParch2, textAlign = TextAlign.Center)
            PrimaryButton(cacheClaimLabel(ui.state), on.onClaim, Modifier.fillMaxWidth(), sub = "the server is checking your claim")
        }
    }
}

// ---- Previews (daily-cache.png numbers; every number is a placeholder) ----

private val sampleCache = DailyCacheUi("+1,500", "shards", day = 5, days = 7, bonusLabel = "x1.5", claimable = true, nextIn = null,
    ruleLine = "Claim once a day. On day 7 your Mines dig x1.5 for a day. Next cache in 14h after you claim.",
    claimSub = "+1,500 Shards to your stores")

@Composable private fun HalfHost(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Color(0xFF2F4A2A)).padding(horizontal = 4.dp),
        contentAlignment = Alignment.BottomCenter) { content() }
}

@Preview(name = "Daily Cache (daily-cache.png)", widthDp = 412, heightDp = 915)
@Composable private fun DailyCachePreview() { HalfHost { DailyCacheSheet(sampleCache, DailyCacheActions()) } }

@Preview(name = "Daily Cache: claimed today (receipt, open chest)", widthDp = 412, heightDp = 915)
@Composable private fun DailyCacheClaimedPreview() {
    HalfHost { DailyCacheSheet(sampleCache.copy(claimable = false, state = CacheState.CLAIMED, nextIn = "14h 20m", receiptId = "rcpt-1"), DailyCacheActions()) }
}

@Preview(name = "Daily Cache: loading / claiming", widthDp = 412, heightDp = 915)
@Composable private fun DailyCacheBusyPreview() {
    HalfHost {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            DailyCacheSheet(sampleCache.copy(reward = null, state = CacheState.LOADING), DailyCacheActions())
            DailyCacheSheet(sampleCache.copy(state = CacheState.CLAIMING), DailyCacheActions())
        }
    }
}

@Preview(name = "Daily Cache: uncertain (being checked, RETRY) / pack constant missing", widthDp = 412, heightDp = 915)
@Composable private fun DailyCacheUncertainPreview() {
    HalfHost {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            DailyCacheSheet(sampleCache.copy(state = CacheState.CHECKING), DailyCacheActions())
            DailyCacheSheet(sampleCache.copy(days = null, bonusLabel = null), DailyCacheActions())
            Spacer(Modifier.height(1.dp))
        }
    }
}
