package gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.ProgressBar
import gg.pixelkingdomwars.nativeclient.ui.kit.priceDescription
import gg.pixelkingdomwars.nativeclient.ui.kit.priceText
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/**
 * Design component: the Gem spend / speed-up Seal used across the game (design/final/goldforge/SPEC.md §6;
 * `speedup.png`, `speedup-short.png`): one consent for every Gems spend (finish a build, upgrade, training, research,
 * craft or recovery; buy supplies). Title by kind ("FINISH NOW?", "BUY {item}?", "SKIP WAIT?"), the subject in a 72 dp
 * grass well with its progress and time left, "Gems you spend" → "NOW / {left} saved", "You have {gems} Gems · {after}
 * after", BACK + the GOLD confirm that arms over 450 ms (pass 2: every money consent is gold).
 *
 * The price is live: when [GemSpendUi.quotedAtMs] changes while the Seal is open, the price cross-fades and the arming
 * restarts ([quoteArmStart]). A server zero reads "FREE" and does not arm. Short: the price and the line turn
 * `#A3261A` and the primary becomes blue GET GEMS (`GoldForge(GEMS, prefill = short)` as a sheet replace); it never
 * auto-spends. Refused → RETRY; uncertain → "Checking…" (design correction 7: never "nothing was spent" unless refused).
 *
 * Pointer rule: compose it always from the OverlayHost; it is full-screen (55 % scrim) only while [GemSpendUi] is set
 * and while it animates out. A scrim tap is BACK (never confirm), ignored while finishing.
 */
@Immutable data class GemSpendUi(
    val kind: GemSpendKind,
    /** "FINISH NOW?", "BUY {item}?", "SKIP WAIT?". */
    val title: String,
    /** The subject's CURRENT sprite (the construction frame for an upgrade), a troop portrait or an item icon. */
    val subjectArt: String,
    /** "WORKSHOP". */
    val subjectName: String,
    /** "Lv 2 › 3". */
    val subjectLine: String,
    /** 0..1 done (green); null draws an unknown (empty) track. */
    val progress: Float?,
    /** "2h 14m"; null reads "…". */
    val timeLeft: String?,
    /** The live Gems price (currency GEMS). CHECKING "…", UNAVAILABLE "unavailable", SERVER_ZERO "FREE". */
    val price: PriceUi,
    /** Gems owned ("1,250"); "…" while unknown. */
    val have: String,
    /** Gems after ("1,130"); null hides it. */
    val after: String?,
    /** Gems missing ("120"); non-null = short. */
    val short: String?,
    /** Wall-clock ms of the current server quote (re-quoted every 60 s, and on arming if older than 10 s). */
    val quotedAtMs: Long,
    val stage: MoneyStage,
    /** Wall-clock ms the Seal was raised. */
    val armedAtMs: Long = quotedAtMs,
    /** With [stage] FAILED: refused or uncertain (null = uncertain). */
    val failure: MoneyFailure? = null,
    /** The reason under an UNAVAILABLE price. */
    val unavailableReason: String? = null,
    /** Presentation-only verb for an existing reviewed action, such as an instant hero upgrade. */
    val confirmLabel: String? = null,
    /** Instant upgrades have no timer or time-saving claim. Existing speed-up callers retain both. */
    val showTiming: Boolean = true,
    /** Original consent identity and bounds, visible in a bounded scroll region. */
    val consentDetails: String? = null,
)

/** Speed-up callbacks (SPEC; [onRetry] added with a default). */
@Immutable data class GemSpendActions(
    /** The armed confirm. */
    val onConfirm: () -> Unit = {},
    /** BACK, a scrim tap. */
    val onBack: () -> Unit = {},
    /** GET GEMS with the shortfall: open `GoldForge(GEMS, section = "buy", prefill = short)`; the origin re-opens this Seal. */
    val onGetGems: (short: String) -> Unit = {},
    /** Red RETRY after an authoritative refusal. */
    val onRetry: () -> Unit = {},
)

/** The speed-up Seal. Pass null to dismiss (it animates out). Pointer rule: full-screen with its 55 % scrim only while
 *  [ui] is set or animating out (the scrim takes taps only while shown; a tap is BACK); with nothing shown nothing is
 *  composed, so touches reach the kingdom. */
@Composable fun GemSpendSeal(ui: GemSpendUi?, on: GemSpendActions, modifier: Modifier = Modifier,
    clock: () -> Long = { System.currentTimeMillis() }, onExitFinished: () -> Unit = {}) {
    val c = PkwTokens.Colors
    ForgeSeal(ui, { it.title }, { s -> if (s.stage != MoneyStage.SENDING) on.onBack() }, modifier, onExitFinished) { s, active ->
        val short = s.short != null || s.price.status == PriceStatus.SHORT
        SubjectRow(s)
        PayGet(left = {
            GfIcon("gf:gem_48", 48.dp)
            PriceText(s.price, short)
            PkwText("Gems you spend", PkwTokens.Type.small, color = c.textOnParch2)
        }, right = {
            CheckMedallion()
            PkwText("NOW", PkwTokens.Type.title, color = c.textOnParch)
            if (s.showTiming) PkwText("${s.timeLeft ?: "…"} saved", PkwTokens.Type.small, color = c.textOnParch2)
        })
        if (short) PkwText("You have ${s.have} Gems. Need ${s.short ?: s.price.amount ?: "…"} more.", PkwTokens.Type.small,
            color = c.shortText, textAlign = TextAlign.Center, maxLines = 2)
        else PkwText("You have ${s.have} Gems" + (s.after?.let { " · $it after" } ?: ""), PkwTokens.Type.small,
            color = c.textOnParch2, textAlign = TextAlign.Center)
        if (s.stage == MoneyStage.FAILED) PkwText(forgeOutcomeLine("finish", s.failure ?: MoneyFailure.UNCERTAIN), PkwTokens.Type.body,
            color = c.textOnParch, textAlign = TextAlign.Center, maxLines = 2)
        s.consentDetails?.let { details ->
            Box(Modifier.fillMaxWidth().heightIn(max = 96.dp).verticalScroll(rememberScrollState())) {
                PkwText(details, PkwTokens.Type.small, Modifier.fillMaxWidth(), color = c.textOnParch2, maxLines = Int.MAX_VALUE)
            }
        }
        val look = gemSpendPrimaryLook(s).let { look ->
            if (s.confirmLabel != null && (look.action == ForgeAction.CONFIRM || look.state == CommandState.DISABLED))
                look.copy(label = s.confirmLabel) else look
        }
        val firstQuote = remember { s.quotedAtMs }
        val quoteSeen = remember(s.quotedAtMs) { if (s.quotedAtMs == firstQuote) Long.MIN_VALUE else clock() }
        SealButtons(active && s.stage != MoneyStage.SENDING, on.onBack) {
            when (look.action) {
                ForgeAction.CONFIRM -> ArmingButton(look.label, quoteArmStart(s.armedAtMs, quoteSeen), active, on.onConfirm, clock, Modifier.weight(1f),
                    armMs = if (gemSpendArms(s)) PkwTokens.Motion.SEAL_ARM else 0)
                ForgeAction.GET_GEMS -> ForgePrimary(look, { if (active) on.onGetGems(s.short ?: s.price.amount ?: "") }, Modifier.weight(1f))
                ForgeAction.RETRY -> ForgePrimary(look, { if (active) on.onRetry() }, Modifier.weight(1f))
                else -> ForgePrimary(look, {}, Modifier.weight(1f))
            }
        }
    }
}

/** The subject: a 72 × 72 grass well with the current sprite at 56 dp, name + level line, progress and time left. */
@Composable private fun SubjectRow(s: GemSpendUi) {
    val c = PkwTokens.Colors
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.size(72.dp).drawBehind {
            drawRect(c.ink)
            val i = 2.dp.toPx()
            drawRect(GoldForgeColors.grassFrame, Offset(i, i), Size(size.width - 2 * i, size.height - 2 * i))
            val j = 4.dp.toPx()
            drawRect(GoldForgeColors.grassFace, Offset(j, j), Size(size.width - 2 * j, size.height - 2 * j))
        }, contentAlignment = Alignment.Center) { GfIcon(s.subjectArt, 56.dp, contentDescription = s.subjectName) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                PkwText(s.subjectName, PkwTokens.Type.label, color = c.textOnParch)
                PkwText(s.subjectLine, PkwTokens.Type.small, color = c.textOnParch2)
            }
            if (s.showTiming) {
                ProgressBar(s.progress, "${s.subjectName}: ${s.timeLeft ?: "…"} left", verb = Verb.GREEN, height = 16.dp)
                Row(Modifier.clearAndSetSemantics { contentDescription = "${s.timeLeft ?: "…"} left" }, verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    PkwIcon("timer", 24.dp)
                    PkwText(s.timeLeft ?: "…", PkwTokens.Type.caption, color = c.textOnParch)
                    PkwText("left", PkwTokens.Type.small, color = c.textOnParch2)
                }
            }
        }
    }
}

/** The price, cross-faded when the server re-quotes (120 ms; reduced motion: the same fade). "FREE" for a server zero. */
@Composable private fun PriceText(price: PriceUi, short: Boolean) {
    val c = PkwTokens.Colors
    val text = if (price.status == PriceStatus.SERVER_ZERO) "FREE" else priceText(price)
    val reduced = LocalReducedMotion.current
    Crossfade(text, Modifier.clearAndSetSemantics { contentDescription = priceDescription(price) },
        animationSpec = tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else PkwTokens.Motion.TAB_SWITCH), label = "price") { t ->
        PkwText(t, if (price.status == PriceStatus.UNAVAILABLE) PkwTokens.Type.body else PkwTokens.Type.primary,
            color = if (short) c.shortText else c.textOnParch)
    }
}

/** The green 48 dp check medallion on the get side. */
@Composable private fun CheckMedallion() {
    val c = PkwTokens.Colors
    Box(Modifier.size(48.dp).drawBehind {
        drawRect(c.ink)
        val i = 3.dp.toPx()
        drawRect(c.green.face, Offset(i, i), Size(size.width - 2 * i, size.height - 2 * i))
        drawRect(c.green.hi, Offset(i, i), Size(size.width - 2 * i, 3.dp.toPx()))
    }, contentAlignment = Alignment.Center) { PkwIcon("shape:check", 32.dp, tint = c.label) }
}

@Preview(name = "Speed-up seal", widthDp = 412, heightDp = 640)
@Composable private fun GemSpendPreview() = GemSpendSeal(GoldForgeSamples.gemSpend, GemSpendActions(), clock = { 300L })

@Preview(name = "Speed-up seal: not enough Gems", widthDp = 412, heightDp = 640)
@Composable private fun GemSpendShortPreview() = GemSpendSeal(GoldForgeSamples.gemSpend.copy(have = "80", after = null, short = "40",
    price = PriceUi(Currency.GEMS, "120", PriceStatus.SHORT)), GemSpendActions())

@Preview(name = "Speed-up seal: quote loading", widthDp = 412, heightDp = 640)
@Composable private fun GemSpendCheckingPreview() = GemSpendSeal(GoldForgeSamples.gemSpend.copy(price = PriceUi(Currency.GEMS, null, PriceStatus.CHECKING),
    after = null), GemSpendActions())

@Preview(name = "Speed-up seal: price unavailable", widthDp = 412, heightDp = 640)
@Composable private fun GemSpendUnavailablePreview() = GemSpendSeal(GoldForgeSamples.gemSpend.copy(price = PriceUi(Currency.GEMS, null, PriceStatus.UNAVAILABLE),
    after = null, unavailableReason = "Finishing is paused for this building"), GemSpendActions())

@Preview(name = "Speed-up seal: free (server zero)", widthDp = 412, heightDp = 640)
@Composable private fun GemSpendFreePreview() = GemSpendSeal(GoldForgeSamples.gemSpend.copy(price = PriceUi(Currency.GEMS, "0", PriceStatus.SERVER_ZERO),
    after = "1,250"), GemSpendActions())

@Preview(name = "Speed-up seal: finishing", widthDp = 412, heightDp = 640)
@Composable private fun GemSpendBusyPreview() = GemSpendSeal(GoldForgeSamples.gemSpend.copy(stage = MoneyStage.SENDING), GemSpendActions())

@Preview(name = "Speed-up seal: refused (RETRY)", widthDp = 412, heightDp = 640)
@Composable private fun GemSpendRefusedPreview() = GemSpendSeal(GoldForgeSamples.gemSpend.copy(stage = MoneyStage.FAILED, failure = MoneyFailure.REFUSED),
    GemSpendActions())
