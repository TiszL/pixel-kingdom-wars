package gg.pixelkingdomwars.nativeclient.ui.goldforge

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import gg.pixelkingdomwars.nativeclient.data.GemsState
import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.ops.Receipt
import gg.pixelkingdomwars.nativeclient.ui.Copy
import gg.pixelkingdomwars.nativeclient.ui.economy.GemsViewModel
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.exactAmount
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.ArmingButton
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.ForgeAction
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.ForgePrimary
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.ForgePrimaryLook
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.ForgeSeal
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.PayGet
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.RepeatSquare
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.SealButtons
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.SealSide
import kotlinx.serialization.json.jsonPrimitive
import java.math.BigInteger

/*
 * The GEMS tab's CONVERT (design/final/goldforge SPEC §5a.6: "Need Shards? / Gems into Shards" + stone CONVERT, which "opens
 * the existing Gems → SHARDS flow as its own Seal. It is never a second primary.") over the existing ledger owner: the
 * session's GemsRepository through GemsViewModel (review, confirm, check, retry, refresh). Before tonight CONVERT left the
 * forge for the old dark "GEMS WALLET" page (GamePage + Material dialog). Nothing here prices, posts or signs: the owner
 * re-reads and validates the server terms on review and again on confirm, and a saved original is checked or retried with
 * its own request, never a second one. Every line is the old page's own copy or the frames' text.
 */

/** Where the convert Seal stands. */
internal enum class GoldForgeConvertStage { CHOOSE, REVIEW, BUSY, SAVED, OFF }

/** What the convert Seal draws (pure; [goldForgeConvertFace]). */
internal data class GoldForgeConvertFace(
    val stage: GoldForgeConvertStage,
    /** Gems to spend, raw whole number ("…" unknown). */
    val gems: String,
    /** SHARDS to receive, raw ("…" unknown): the reviewed output in REVIEW, the server rate times [gems] before. */
    val shards: String,
    /** "{n} SHARDS per Gem" from the server overview; null unknown. */
    val rate: String?,
    /** Whether [gems] is a whole amount from 1 to what the player has. */
    val amountOk: Boolean,
    /** The saved original's kind and whether its receipt already came back (SAVED). */
    val savedKind: String? = null,
    val savedReceipt: Boolean = false,
    /** The owner's own unavailable line (OFF), or null for the old page's line. */
    val offReason: String? = null,
    /** SAVED: the server's receipt route answered `unknown` for exactly this saved key, so CLOSE is offered (owner 2026-10-06). */
    val savedClosable: Boolean = false,
)

internal const val CONVERT_FINAL = "Credits the selected kingdom. This conversion is final and cannot be reversed."
internal const val CONVERT_SAVED = "Check your original request before starting another conversion."
internal const val CONVERT_OFF = "New Gems actions are unavailable. Saved requests remain recoverable."
internal const val CONVERT_SHORT = "Not enough Gems."

private val WHOLE = Regex("[1-9][0-9]{0,31}")

/** The Gems the player has (server overview first, then the base balance), or null while unknown. */
internal fun goldForgeConvertHave(state: GemsState): BigInteger? =
    (state.overview?.gems ?: state.balances?.gems)?.toBigIntegerOrNull()?.takeIf { it.signum() >= 0 }

/** The amount after a −/+ step, kept within 1..[have]; unchanged while [have] is unknown or below 1. */
internal fun goldForgeConvertStep(input: String, delta: Int, have: BigInteger?): String {
    if (have == null || have < BigInteger.ONE) return input
    val now = input.takeIf(WHOLE::matches)?.toBigInteger() ?: BigInteger.ONE
    return (now + delta.toBigInteger()).max(BigInteger.ONE).min(have).toString()
}

/** A quick pick ("¼", "½", "MAX") as a share of what the player has, at least 1; null while nothing can be converted. */
internal fun goldForgeConvertPick(label: String, have: BigInteger?): String? {
    if (have == null || have < BigInteger.ONE) return null
    val share = when (label) { "¼" -> have / BigInteger.valueOf(4); "½" -> have / BigInteger.valueOf(2); else -> have }
    return share.max(BigInteger.ONE).toString()
}

/** The face for the owner's [state] and the chosen [amount]. A saved original always comes first (one request at a time). */
internal fun goldForgeConvertFace(state: GemsState, running: Boolean, amount: String): GoldForgeConvertFace {
    val overview = state.overview
    val have = goldForgeConvertHave(state)
    val rate = overview?.shardsPerGem
    val chosen = amount.takeIf(WHOLE::matches)?.toBigInteger()
    val ok = chosen != null && have != null && chosen <= have
    val preview = if (chosen != null && rate != null) (chosen * BigInteger.valueOf(rate)).toString() else UNKNOWN
    val review = state.review?.takeIf { it.intent.kind == IntentKind.GEMS_TO_SHARDS }
    val saved = state.pending.firstOrNull()
    val base = GoldForgeConvertFace(GoldForgeConvertStage.CHOOSE, chosen?.toString() ?: UNKNOWN, preview,
        rate?.let { "${exactAmount(it.toString())} SHARDS per Gem" }, ok)
    return when {
        state.busy || running -> base.copy(stage = GoldForgeConvertStage.BUSY)
        saved != null -> base.copy(stage = GoldForgeConvertStage.SAVED, savedKind = saved.kind, savedReceipt = saved.receipt != null,
            savedClosable = saved.receipt == null && state.serverUnknownKeys[saved.kind] == saved.idempotencyKey)
        review != null -> base.copy(stage = GoldForgeConvertStage.REVIEW,
            gems = runCatching { review.intent.body.getValue("gems").jsonPrimitive.content }.getOrNull() ?: base.gems,
            shards = review.output, amountOk = true)
        overview == null -> base.copy(stage = GoldForgeConvertStage.OFF, offReason = state.unavailable)
        else -> base
    }
}

/** What the host composes: [open] raises the Seal, [reviewOpen] holds the sheet while it is up, [overlay] draws it. */
internal class GoldForgeConvert(val open: () -> Unit, val reviewOpen: Boolean, val overlay: @Composable () -> Unit)

/**
 * The convert Seal over [model] (the session's Gems owner). [generation] is the base selection generation (a change closes
 * the Seal and drops the review, as the old page did); [actionsAllowed] the game-orders interlock; [current] the host's
 * session, identity and lifecycle witness. [onExplain] carries refusals and the owner's notices to the forge's toast zone.
 */
@Composable internal fun rememberGoldForgeConvert(model: GemsViewModel, generation: Long, actionsAllowed: Boolean,
    current: () -> Boolean, onExplain: (String) -> Unit): GoldForgeConvert {
    val state by model.state.collectAsState()
    val running by model.busy.collectAsState()
    val notice by model.notice.collectAsState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val isCurrent by rememberUpdatedState(current)
    val allowed by rememberUpdatedState(actionsAllowed)
    val explain by rememberUpdatedState(onExplain)
    var shown by remember(model) { mutableStateOf(false) }
    var amount by remember(model) { mutableStateOf("1") }
    var line by remember(model) { mutableStateOf<String?>(null) }
    var armedAt by remember(model) { mutableStateOf<Long?>(null) }
    // The receipt already in the owner when the Seal opened; a newer one closes the Seal with its line.
    var seenReceipt by remember(model) { mutableStateOf(state.receipt?.receiptId) }
    val close: () -> Unit = { shown = false; armedAt = null; line = null; model.dismiss() }
    DisposableEffect(model, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) { shown = false; model.dismiss() } }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); model.dismiss() }
    }
    LaunchedEffect(model, generation) { if (shown) { shown = false; model.dismiss() } }
    LaunchedEffect(notice) { notice?.let { line = it.message; explain(it.message); model.dismissNotice() } }
    val review = state.review?.takeIf { it.intent.kind == IntentKind.GEMS_TO_SHARDS }
    LaunchedEffect(review) { armedAt = if (review != null) System.currentTimeMillis() else null }
    val receipt = state.receipt?.takeIf { it.kind == IntentKind.GEMS_TO_SHARDS }
    LaunchedEffect(receipt?.receiptId) {
        if (receipt != null && receipt.receiptId != seenReceipt) {
            seenReceipt = receipt.receiptId
            if (shown) { shown = false; armedAt = null; line = null }
            explain("+${exactAmount(receipt.amount)} ${receipt.currency}")
        }
    }
    BackHandlerAt(BackPriority.CONFIRM, shown) { if (!model.state.value.busy && !model.busy.value) close() }
    fun admitted(): Boolean = (isCurrent() && allowed).also { if (!it) explain(GEMS_WAIT) }
    val open: () -> Unit = {
        if (admitted()) {
            model.dismiss(); line = null; armedAt = null
            seenReceipt = model.state.value.receipt?.receiptId
            val have = goldForgeConvertHave(model.state.value)
            amount = if (have != null && have >= java.math.BigInteger.ONE) "1" else amount
            shown = true
            if (model.state.value.overview == null) model.refresh()
        }
    }
    val face = goldForgeConvertFace(state, running, amount)
    val have = goldForgeConvertHave(state)
    val overlay: @Composable () -> Unit = {
        ForgeSeal(if (shown) face else null, { "GEMS INTO SHARDS" }, { f -> if (f.stage != GoldForgeConvertStage.BUSY) close() }) { f, active ->
            val c = PkwTokens.Colors
            PayGet(left = { SealSide("gf:gem_48", if (f.gems == UNKNOWN) UNKNOWN else exactAmount(f.gems), "Gems you spend") },
                right = { SealSide("shards", if (f.shards == UNKNOWN) UNKNOWN else exactAmount(f.shards), "SHARDS") })
            f.rate?.let { PkwText(it, PkwTokens.Type.small, color = c.textOnParch2, textAlign = TextAlign.Center) }
            when (f.stage) {
                GoldForgeConvertStage.CHOOSE -> {
                    Row(Modifier.fillMaxWidth().heightIn(min = 60.dp), horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        RepeatSquare("shape:minus", "Fewer Gems", { amount = goldForgeConvertStep(amount, -1, goldForgeConvertHave(model.state.value)) },
                            Modifier.size(48.dp, 60.dp), enabled = active)
                        Plate(PlateKind.CREAM, Modifier.weight(1f).heightIn(min = 60.dp)
                            .clearAndSetSemantics { contentDescription = "${f.gems} Gems" }) {
                            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                                PkwText(if (f.gems == UNKNOWN) UNKNOWN else exactAmount(f.gems), PkwTokens.Type.primary,
                                    color = if (f.amountOk) c.textOnParch else c.shortText)
                                PkwText("Gems", PkwTokens.Type.small, color = c.textOnParch2)
                            }
                        }
                        RepeatSquare("shape:plus", "More Gems", { amount = goldForgeConvertStep(amount, 1, goldForgeConvertHave(model.state.value)) },
                            Modifier.size(48.dp, 60.dp), enabled = active)
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (label in listOf("¼", "½", "MAX")) SecondaryButton(label, {
                            val pick = goldForgeConvertPick(label, goldForgeConvertHave(model.state.value))
                            if (pick != null) amount = pick else line = CONVERT_SHORT
                        }, Modifier.weight(1f), enabled = active && have != null && have >= java.math.BigInteger.ONE,
                            contentDescription = if (label == "MAX") "All your Gems" else "$label of your Gems")
                    }
                    PkwText(CONVERT_FINAL, PkwTokens.Type.small, Modifier.fillMaxWidth(), color = c.textOnParch2, textAlign = TextAlign.Center)
                    line?.let { PkwText(it, PkwTokens.Type.small, Modifier.fillMaxWidth(), color = c.shortText, textAlign = TextAlign.Center, maxLines = 3) }
                    SealButtons(active, close) {
                        ForgePrimary(ForgePrimaryLook("CONVERT", Verb.GOLD, if (f.amountOk) CommandState.ENABLED else CommandState.DISABLED,
                            ForgeAction.CONFIRM, reason = if (f.amountOk) null else CONVERT_SHORT), {
                            val now = goldForgeConvertFace(model.state.value, model.busy.value, amount)
                            when {
                                !now.amountOk -> line = CONVERT_SHORT
                                !admitted() -> Unit
                                model.review(IntentKind.GEMS_TO_SHARDS, now.gems) == null -> explain(GEMS_WAIT)
                                else -> line = null
                            }
                        }, Modifier.weight(1f))
                    }
                }
                GoldForgeConvertStage.REVIEW -> {
                    PkwText(CONVERT_FINAL, PkwTokens.Type.body, Modifier.fillMaxWidth(), color = c.textOnParch, textAlign = TextAlign.Center)
                    SealButtons(active, { model.dismiss() }) {
                        ArmingButton("CONVERT", armedAt, active, {
                            val reviewed = model.state.value.review
                            if (reviewed != null && reviewed === review && admitted()) {
                                if (model.confirm(reviewed) == null) explain(GEMS_WAIT)
                            } else if (reviewed == null || reviewed !== review) line = "Review Gems again after the account or base changed."
                        }, { System.currentTimeMillis() }, Modifier.weight(1f))
                    }
                }
                GoldForgeConvertStage.BUSY -> SealButtons(false, {}) {
                    ForgePrimary(ForgePrimaryLook("Checking", Verb.STONE, CommandState.BUSY, ForgeAction.NONE, sentence = true), {}, Modifier.weight(1f))
                }
                GoldForgeConvertStage.SAVED -> {
                    PkwText(CONVERT_SAVED, PkwTokens.Type.body, Modifier.fillMaxWidth(), color = c.textOnParch, textAlign = TextAlign.Center)
                    (line ?: if (f.savedClosable) Copy.observation(Receipt.Absent) else null)?.let {
                        PkwText(it, PkwTokens.Type.small, Modifier.fillMaxWidth(), color = c.textOnParch2, textAlign = TextAlign.Center, maxLines = 3) }
                    val kind = f.savedKind
                    SecondaryButton("CHECK ORIGINAL RECEIPT", { if (kind != null && admitted() && model.check(kind) == null) explain(GEMS_WAIT) },
                        Modifier.fillMaxWidth(), enabled = active && kind != null)
                    if (!f.savedReceipt) SecondaryButton("RETRY SAME REQUEST", { if (kind != null && admitted() && model.retry(kind) == null) explain(GEMS_WAIT) },
                        Modifier.fillMaxWidth(), enabled = active && kind != null)
                    // Owner 2026-10-06: once the receipt route answered `unknown` for this saved key, the owner's CLOSE (one more
                    // GET, then forgotten on this device; nothing is sent) is the way out, so a conversion is never dead-ended.
                    if (f.savedClosable) SecondaryButton(Copy.CLOSE_REQUEST.uppercase(), {
                        if (kind != null && admitted() && model.close(kind) == null) explain(GEMS_WAIT)
                    }, Modifier.fillMaxWidth(), enabled = active && kind != null, contentDescription = "Close saved request")
                    SecondaryButton("BACK", close, Modifier.fillMaxWidth(), enabled = active)
                }
                GoldForgeConvertStage.OFF -> {
                    PkwText(f.offReason ?: CONVERT_OFF, PkwTokens.Type.body, Modifier.fillMaxWidth(), color = c.textOnParch,
                        textAlign = TextAlign.Center, maxLines = 4)
                    SealButtons(active, close) {
                        ForgePrimary(ForgePrimaryLook("TRY AGAIN", Verb.STONE, CommandState.ENABLED, ForgeAction.RETRY), {
                            if (admitted() && model.refresh() == null) explain(GEMS_WAIT)
                        }, Modifier.weight(1f))
                    }
                }
            }
        }
    }
    return GoldForgeConvert(open, shown, overlay)
}
