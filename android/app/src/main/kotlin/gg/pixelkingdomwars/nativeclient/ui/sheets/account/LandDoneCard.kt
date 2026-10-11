package gg.pixelkingdomwars.nativeclient.ui.sheets.account

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.ModalScrim
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.Presence
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubArt
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.drawRays
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.keepPortrait

/**
 * Design component: the land celebration "IRONHOLD IS ON THE MAP" (design/final/account/land-done.png, SPEC §2.4): the
 * realm map under a 62 % scrim, stepped gold rays at 18 %, the gold well 132 with the tiered Keep portrait 112, the gold
 * ribbon, a charcoal plate of three facts (deed sent to your wallet · realm tile · leagues and the Gold Forge open), and
 * the foot blue SEE MAP + gold GO HOME. It plays only after the server credited the entry: [LandDoneUi.receiptId] is
 * required (money moved is money honoured; nothing celebrates without a receipt).
 */

/** One fact line (icon 32 or a realm thumb + VT 20). */
@Immutable data class LandFactUi(val icon: String, val text: String, val thumb: ImageBitmap? = null)

/** Everything the land celebration draws. */
@Immutable data class LandDoneUi(
    /** The server receipt of the credited entry. Required. */
    val receiptId: String,
    /** "IRONHOLD" (the ribbon says "<NAME> IS ON THE MAP"). */
    val kingdomName: String,
    val keepTier: Int?,
    /** Three facts: deed sent, realm + tile, what opened. */
    val facts: List<LandFactUi>,
    val busy: Boolean = false,
    val notice: String? = null,
    val canSeeMap: Boolean = true,
)

/** Land celebration callbacks. */
@Immutable data class LandDoneActions(
    /** SEE MAP: the realm map centred on the new marker. */
    val onSeeMap: () -> Unit = {},
    /** GO HOME: the camera flies back to the base (400 ms). */
    val onGoHome: () -> Unit = {},
)

/**
 * The land celebration. Pass null to dismiss it (it fades out in 120 ms); keep composing it with null through the exit.
 * Enter: the card fades in 160 ms, the ribbon drops 12 dp (`pop`), the rays turn 8°/s (none with reduced motion).
 *
 * Pointer rule: the root and its 62 % scrim exist only while a celebration is shown or fading out (a modal moment, like
 * the Seal); with null nothing is composed and touches reach the map. Only SEE MAP and GO HOME act.
 */
@Composable fun LandDoneCard(ui: LandDoneUi?, on: LandDoneActions, modifier: Modifier = Modifier) {
    Presence(ui, PkwTokens.Motion.PLATE_IN, PkwTokens.Motion.SEAL_OUT) { party, progress, active, reduced ->
        val inspection = LocalInspectionMode.current
        val still = reduced || inspection
        val spin = if (still) null else rememberInfiniteTransition(label = "landRays").animateFloat(0f, 360f,
            infiniteRepeatable(tween((360f / PkwTokens.Motion.RAYS_DEG_PER_S * 1000).toInt(), easing = LinearEasing), RepeatMode.Restart), label = "spin")
        val drop = remember(party.receiptId) { Animatable(if (still) 1f else 0f) }
        LaunchedEffect(party.receiptId) { drop.animateTo(1f, tween(PkwTokens.Motion.RIBBON_DROP, easing = PkwTokens.Motion.Pop)) }
        Box(modifier.fillMaxSize().semantics { paneTitle = "${party.kingdomName} is on the map" }) {
            ModalScrim(LAND_DONE_SCRIM * progress(), onTap = {})
            Box(Modifier.fillMaxSize().graphicsLayer { alpha = progress() }.drawBehind {
                drawRays(Offset(size.width / 2f, size.height * 0.33f), spin?.value ?: 0f, PkwTokens.Colors.gold.face.copy(alpha = 0.18f))
            })
            Column(Modifier.fillMaxSize().graphicsLayer { alpha = progress() }.padding(horizontal = 16.dp),
                horizontalAlignment = Alignment.CenterHorizontally) {
                Spacer(Modifier.weight(0.9f))
                Box(contentAlignment = Alignment.BottomCenter) {
                    GoldWell(Modifier.padding(bottom = 30.dp), size = 132.dp) {
                        HubArt(party.keepTier?.let(::keepPortrait) ?: "itm_deed_earth", if (party.keepTier == null) 64.dp else 112.dp)
                    }
                    Ribbon("${party.kingdomName.uppercase()} IS ON THE MAP", Modifier.graphicsLayer { translationY = -12.dp.toPx() * (1f - drop.value) })
                }
                Plate(PlateKind.CHARCOAL, Modifier.padding(top = 12.dp).widthIn(max = 340.dp).fillMaxWidth()
                    .semantics { liveRegion = LiveRegionMode.Polite },
                    contentPadding = PaddingValues(start = 14.dp, top = 12.dp, end = 14.dp, bottom = 14.dp)) {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        party.facts.forEach { fact ->
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                if (fact.thumb != null) RealmThumb(fact.thumb, fact.text, Modifier.size(32.dp))
                                else HubArt(fact.icon, 32.dp)
                                PkwText(fact.text, PkwTokens.Type.body, color = PkwTokens.Colors.text, maxLines = 2)
                            }
                        }
                        party.notice?.let { PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.text, maxLines = 3) }
                    }
                }
                Spacer(Modifier.weight(1.4f))
                Row(Modifier.fillMaxWidth().padding(bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Bottom) {
                    if (party.canSeeMap) SecondaryButton("SEE MAP", { if (active && !party.busy) on.onSeeMap() }, Modifier.width(132.dp).heightIn(min = 60.dp), verb = Verb.BLUE,
                        enabled = !party.busy, contentDescription = "See the map")
                    PrimaryButton("GO HOME", { if (active && !party.busy) on.onGoHome() }, Modifier.weight(1f),
                        state = if (party.busy) CommandState.BUSY else CommandState.ENABLED)
                }
                Spacer(Modifier.navigationBarsPadding())
            }
        }
    }
}

/** The celebration's scrim (SPEC §2.4: 62 %). */
private const val LAND_DONE_SCRIM = 0.62f

/** The gold ribbon (notched ends, ink outline, 4 dp lip): PS 12 ink text. Drawn in code (no ribbon art exists). */
@Composable internal fun Ribbon(text: String, modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    Box(modifier.heightIn(min = 46.dp).clearAndSetSemantics { contentDescription = text }.drawBehind {
        val w = size.width; val h = size.height; val notch = 14.dp.toPx(); val o = 3.dp.toPx()
        fun banner(inset: Float) = Path().apply {
            moveTo(inset, inset); lineTo(w - inset, inset); lineTo(w - notch - inset / 2f, h / 2f); lineTo(w - inset, h - inset)
            lineTo(inset, h - inset); lineTo(notch + inset / 2f, h / 2f); close()
        }
        drawPath(banner(0f), c.ink)
        drawPath(banner(o), c.gold.face)
        drawRect(c.gold.hi, Offset(notch, o), androidx.compose.ui.geometry.Size(w - 2 * notch, 3.dp.toPx()))
        drawRect(c.gold.lo, Offset(notch, h - o - 4.dp.toPx()), androidx.compose.ui.geometry.Size(w - 2 * notch, 4.dp.toPx()))
    }.padding(horizontal = 36.dp, vertical = 8.dp), contentAlignment = Alignment.Center) {
        PkwText(text, PkwTokens.Type.label, color = c.ink)
    }
}

@Preview(name = "Land done (land-done.png)", widthDp = 412, heightDp = 915)
@Composable private fun LandDonePreview() {
    Box(Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Color(0xFF3B5A33))) {
        LandDoneCard(sampleLandDone, LandDoneActions())
    }
}

@Preview(name = "Ribbon", widthDp = 412, heightDp = 80)
@Composable private fun RibbonPreview() { Box(Modifier.fillMaxSize().background(PkwTokens.Colors.wood).padding(8.dp)) { Ribbon("TILE 1,204 UNLOCKED") } }
