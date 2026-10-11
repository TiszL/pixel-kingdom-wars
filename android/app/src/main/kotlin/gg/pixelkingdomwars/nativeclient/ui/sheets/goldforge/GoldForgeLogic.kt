package gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge

import androidx.compose.runtime.Immutable
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.badgeCount
import gg.pixelkingdomwars.nativeclient.ui.kit.outcomeLine
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * The pure rules behind the Gold Forge cluster (design/final/goldforge/SPEC.md): which tab opens, what the hero chip
 * says, what each tab's one primary looks like and does in every state, and the money-outcome copy (design correction 7).
 * No Compose here; JVM-tested in `GoldForgeLogicTest`. Every amount arrives already formatted by the mapper.
 */

/** The Gold Forge tab ids (the `Destination.GoldForge(tab)` values; MS-E's lower-case ids match case-insensitively). */
object GoldForgeTabs {
    const val SMELT = "SMELT"
    const val CLAIM = "CLAIM"
    const val GEMS = "GEMS"
    /** Only while the Ui state carries a [LegacyUi] (custody open, KEEP still owed, or a saved request to recover). */
    const val LEGACY = "LEGACY"
}

/**
 * The tab row (SPEC §1 Tabs): SMELT, CLAIM, GEMS always (a locked CLAIM shows its own locked body, it is never hidden),
 * LEGACY only when [legacy]. CLAIM carries the green "!" while coins are ready; GEMS a red count while a purchase waits
 * for the wallet.
 *
 * Icons (SPEC §1 Tabs, `legacy.png`): the Gold Ingot for SMELT and the storage crate for LEGACY are authored `ui:` art,
 * which the kit `TabStrip` draws at 32 dp; CLAIM and GEMS keep the kit's 24 dp `keep` and `gem`. The two `ui:` names
 * resolve through the kit's `kitDrawable` aliases (`pkw_ui_inv_forge_ingot`, `pkw_ui_gf_storage_crate`).
 */
fun goldForgeTabs(claimReady: Boolean, gemsWaiting: Int, legacy: Boolean): List<TabUi> = listOfNotNull(
    TabUi(GoldForgeTabs.SMELT, "ui:inv-forge-ingot", "SMELT", null, false),
    TabUi(GoldForgeTabs.CLAIM, "keep", "CLAIM", if (claimReady) BadgeUi("!", BadgeTone.READY, "KEEP ready to claim") else null, false),
    TabUi(GoldForgeTabs.GEMS, "gem", "GEMS", badgeCount(gemsWaiting)?.let {
        BadgeUi(it, BadgeTone.COUNT, if (gemsWaiting == 1) "A Gems purchase is waiting for your wallet" else "$gemsWaiting Gems purchases are waiting for your wallet")
    }, false),
    if (legacy) TabUi(GoldForgeTabs.LEGACY, "ui:gf-storage-crate", "LEGACY", null, false) else null,
)

/**
 * The tab a `GoldForge(tab)` destination opens (SPEC §1 Entry): an explicit [requested] tab that exists wins
 * (case-insensitive); otherwise CLAIM when coins are ready to claim; otherwise SMELT; otherwise the first tab.
 */
fun goldForgeDefaultTab(requested: String?, tabs: List<String>, claimReady: Boolean): String? {
    if (requested != null) tabs.firstOrNull { it.equals(requested, ignoreCase = true) }?.let { return it }
    if (claimReady) tabs.firstOrNull { it.equals(GoldForgeTabs.CLAIM, ignoreCase = true) }?.let { return it }
    return tabs.firstOrNull { it.equals(GoldForgeTabs.SMELT, ignoreCase = true) } ?: tabs.firstOrNull()
}

private val AMOUNT = Regex("^\\d{1,3}(,\\d{3})*(\\.\\d+)?$|^\\d+(\\.\\d+)?$")

/** True only for a known, strictly positive formatted amount ("1,240", "0.5"). "…", "0", "0.00", blank → false. */
fun isPositiveAmount(text: String?): Boolean {
    val t = text?.trim() ?: return false
    if (!AMOUNT.matches(t)) return false
    return t.any { it in '1'..'9' }
}

// ---- Hero ----

/** What the foundry is doing (SPEC §1 hero status line). */
enum class HeroStatusKind { FORGING, AT_REST, RECONNECTING, UNDER_CONSTRUCTION }

/** The hero's live chip state. [time] is already formatted with D-070 `fmtDur` ("6h 20m", m:ss below 1 h). */
@Immutable data class HeroStatusUi(
    val kind: HeroStatusKind,
    /** FORGING: time to the next coins; UNDER_CONSTRUCTION: build time left. Null reads "…". */
    val time: String? = null,
    /** AT_REST: the server reason ("upgrading"). */
    val reason: String? = null,
    /** FORGING without the time: the LEGACY tab's chip says "Furnace lit" only (SPEC E1.1, `legacy.png`). */
    val bare: Boolean = false,
)

/** The chip's text, its gold-hi emphasis and the status square's verb. */
data class HeroLine(val text: String, val emphasis: String?, val dot: Verb, val spoken: String)

/** SPEC §1 copy: "Furnace lit · next coins in **6h 20m**" ("Furnace lit" alone when [HeroStatusUi.bare]), "Forge at
 *  rest · {reason}", "Reconnecting to the forge…", "Building · **1h 12m**". The square is gold while forging, stone
 *  otherwise. */
fun heroStatusLine(ui: HeroStatusUi): HeroLine = when (ui.kind) {
    HeroStatusKind.FORGING -> if (ui.bare) HeroLine("Furnace lit", null, Verb.GOLD, "Furnace lit") else {
        val t = ui.time ?: UNKNOWN
        HeroLine("Furnace lit · next coins in", t, Verb.GOLD, "Furnace lit, next coins in $t")
    }
    HeroStatusKind.AT_REST -> {
        val text = ui.reason?.takeIf { it.isNotBlank() }?.let { "Forge at rest · $it" } ?: "Forge at rest"
        HeroLine(text, null, Verb.STONE, text.replace(" · ", ", "))
    }
    HeroStatusKind.RECONNECTING -> HeroLine("Reconnecting to the forge…", null, Verb.STONE, "Reconnecting to the forge")
    HeroStatusKind.UNDER_CONSTRUCTION -> {
        val t = ui.time ?: UNKNOWN
        HeroLine("Building ·", t, Verb.STONE, "Building, $t left")
    }
}

// ---- Primaries ----

/** What a tab's primary does when tapped. */
enum class ForgeAction { SMELT, FIND_RAID, CLAIM, CONTINUE, RETRY, BUY, CONFIRM, GET_GEMS, EXPLAIN_LOCK, NONE }

/**
 * One primary's look (a [ForgePrimary] face): [label] in the display face (or a VT [sentence] such as "Check wallet"),
 * an optional [sub] line inside the face ([subAccent] = gold-hi, the locked CLAIM's "opens Wed 14 Oct"), and a [reason]
 * line under a DISABLED face. BUSY draws dots and never calls back.
 */
@Immutable data class ForgePrimaryLook(
    val label: String,
    val verb: Verb,
    val state: CommandState,
    val action: ForgeAction,
    val sub: String? = null,
    val reason: String? = null,
    val icon: String? = null,
    val sentence: Boolean = false,
    val subAccent: Boolean = false,
)

/** An unfinished money result (design correction 7). */
enum class MoneyFailure {
    /** The wallet or the server answered no: nothing moved, and the copy may say so. */
    REFUSED,
    /** Timed out, lost answer, process death mid-sign: it is being checked; keep the recovery surface. */
    UNCERTAIN,
}

/**
 * The toast after an unfinished money step. Only [MoneyFailure.REFUSED] may say nothing moved; an uncertain result says
 * it is being checked (SPEC §4 states, design correction 7). [action] is "claim", "purchase" or "finish".
 */
fun forgeOutcomeLine(action: String, failure: MoneyFailure, serverReason: String? = null): String = when {
    action == "claim" && failure == MoneyFailure.REFUSED && serverReason.isNullOrBlank() -> "Wallet said no. Nothing was sent."
    action == "claim" && failure == MoneyFailure.UNCERTAIN -> "Checking whether the claim went through…"
    else -> outcomeLine(action, failure == MoneyFailure.REFUSED, serverReason)
}

/** The look of a stage that is not READY (shared by CLAIM, GEMS and the seals' sheet primaries), or null for READY. */
private fun moneyStageLook(stage: MoneyStage, failure: MoneyFailure?, sentLabel: String): ForgePrimaryLook? = when (stage) {
    MoneyStage.READY -> null
    // The sheet stays honest while the wallet asks; a tap reopens the recovery surface (the Seal at its Wallet step).
    MoneyStage.CHECK_WALLET -> ForgePrimaryLook("Check wallet", Verb.STONE, CommandState.ENABLED, ForgeAction.CONTINUE, sentence = true)
    MoneyStage.SENDING -> ForgePrimaryLook("Sending", Verb.STONE, CommandState.BUSY, ForgeAction.NONE, sentence = true)
    MoneyStage.SENT -> ForgePrimaryLook(sentLabel, Verb.MOSS, CommandState.ENABLED, ForgeAction.NONE, icon = "shape:check")
    MoneyStage.FAILED -> if (failure == MoneyFailure.REFUSED) ForgePrimaryLook("RETRY", Verb.RED, CommandState.ENABLED, ForgeAction.RETRY)
        // An unknown failure is treated as uncertain: never claim nothing moved without an authoritative answer.
        else ForgePrimaryLook("Checking…", Verb.STONE, CommandState.ENABLED, ForgeAction.CONTINUE, sentence = true)
}

/** SMELT's primary (SPEC §3): null in QUALIFIED (a payout plate, nothing to press). */
fun smeltPrimaryLook(state: SmeltState, primary: CommandUi): ForgePrimaryLook? = when (state) {
    SmeltState.QUALIFIED -> null
    SmeltState.LOADING -> ForgePrimaryLook("Checking", Verb.STONE, CommandState.BUSY, ForgeAction.NONE, sentence = true)
    SmeltState.SENDING -> ForgePrimaryLook("Sending", Verb.STONE, CommandState.BUSY, ForgeAction.NONE, sentence = true)
    else -> {
        val action = when {
            primary.state == CommandState.BUSY || primary.state == CommandState.DISABLED || primary.state == CommandState.LOCKED -> ForgeAction.NONE
            state == SmeltState.HELD -> ForgeAction.FIND_RAID
            state == SmeltState.ERROR -> ForgeAction.RETRY
            else -> ForgeAction.SMELT
        }
        ForgePrimaryLook(primary.caption, if (primary.verb == Verb.STONE) Verb.GOLD else primary.verb, primary.state, action,
            sub = primary.sub, reason = primary.reason, icon = primary.icon.takeIf { it.isNotBlank() })
    }
}

/**
 * The SMELT primary a mapper builds (SPEC §3a / §3c copy): gold "SMELT / {n} items"; stone "Pick what to smelt" while
 * the basket is empty; off "New smelting is paused" (PAUSED); locked "Build the mining buildings first" (NOT_READY); red
 * "FIND A RAID" (HELD); "PAYOUT IN {t}" (QUALIFIED, drawn as a plate); stone "TRY AGAIN" (ERROR).
 */
fun smeltPrimaryCommand(state: SmeltState, items: Int, payoutIn: String? = null, reason: String? = null): CommandUi {
    val id = FeatureId("goldforge.smelt")
    return when (state) {
        SmeltState.HELD -> CommandUi(id, "attack", "FIND A RAID", null, true, CommandState.ENABLED, null, null, verb = Verb.RED)
        SmeltState.QUALIFIED -> CommandUi(id, "timer", "PAYOUT IN ${payoutIn ?: UNKNOWN}", null, true, CommandState.ENABLED, null, null)
        SmeltState.PAUSED -> CommandUi(id, "", "SMELT", null, true, CommandState.DISABLED, reason ?: "New smelting is paused", null)
        SmeltState.NOT_READY -> CommandUi(id, "", "SMELT", null, true, CommandState.LOCKED, reason ?: "Build the mining buildings first", null)
        SmeltState.ERROR -> CommandUi(id, "", "TRY AGAIN", null, true, CommandState.ENABLED, null, null, verb = Verb.STONE)
        SmeltState.LOADING, SmeltState.SENDING -> CommandUi(id, "", "SMELT", null, true, CommandState.BUSY, null, null)
        SmeltState.CHOOSING, SmeltState.REVIEW ->
            if (items <= 0) CommandUi(id, "", "SMELT", null, true, CommandState.DISABLED, reason ?: "Tap what to smelt first", null)
            else CommandUi(id, "", "SMELT", null, true, CommandState.ENABLED, null, null, sub = if (items == 1) "1 item" else "$items items")
    }
}

/** The CLAIM tab body (SPEC §4 states table). */
enum class ClaimPhase { LOADING, LOCKED, READY, COLLECTED, ERROR }

/** CLAIM's primary (SPEC §4a-4d and the states table). A closed owner with a [ClaimUi.closedReason] keeps the ready
 *  face's CLAIM in place, off, with that reason ([claimClosedLook]). */
fun claimPrimaryLook(ui: ClaimUi): ForgePrimaryLook =
    claimClosedLook(ui) ?: claimPrimaryLookAdmitted(ui).withOwnerGate(ui.actionsAllowed)

/** Collecting is not open, so no owner can act here: an off CLAIM with the amount line (only for a known positive
 *  amount) and the reason under the face. EXPLAIN_LOCK, so a tap says why instead of doing nothing. A saved claim and
 *  every money stage past READY keep their own looks (receipt evidence is never replaced by this line). */
private fun claimClosedLook(ui: ClaimUi): ForgePrimaryLook? {
    val reason = ui.closedReason?.takeIf { it.isNotBlank() } ?: return null
    if (ui.actionsAllowed || ui.canResumeSaved || ui.stage != MoneyStage.READY ||
        (ui.phase != ClaimPhase.READY && ui.phase != ClaimPhase.COLLECTED)) return null
    return ForgePrimaryLook("CLAIM", Verb.OFF, CommandState.DISABLED, ForgeAction.EXPLAIN_LOCK,
        sub = if (isPositiveAmount(ui.ready)) "${ui.ready} KEEP to your wallet" else null, reason = reason)
}

private fun claimPrimaryLookAdmitted(ui: ClaimUi): ForgePrimaryLook {
    when (ui.phase) {
        ClaimPhase.LOADING -> return ForgePrimaryLook("Checking", Verb.STONE, CommandState.BUSY, ForgeAction.NONE, sentence = true)
        ClaimPhase.ERROR -> return ForgePrimaryLook("CLAIM", Verb.OFF, CommandState.DISABLED, ForgeAction.NONE, sub = "waiting for the server")
        ClaimPhase.LOCKED -> return ForgePrimaryLook("CLAIM", Verb.CHARCOAL, CommandState.LOCKED, ForgeAction.EXPLAIN_LOCK,
            sub = ui.lock?.date?.let { "opens $it" } ?: "opens soon", subAccent = true)
        else -> Unit
    }
    moneyStageLook(ui.stage, ui.failure, "IN YOUR WALLET")?.let { return it }
    if (ui.canResumeSaved) return ForgePrimaryLook("CONTINUE CLAIM", Verb.GOLD, CommandState.ENABLED, ForgeAction.CONTINUE)
    if (ui.phase == ClaimPhase.COLLECTED || !isPositiveAmount(ui.ready)) return ForgePrimaryLook("CLAIM", Verb.OFF, CommandState.DISABLED,
        ForgeAction.NONE, reason = ui.nextCoinsIn?.let { "Next coins in $it" } ?: "Nothing to collect yet")
    return ForgePrimaryLook("CLAIM", Verb.GOLD, CommandState.ENABLED, ForgeAction.CLAIM, sub = "${ui.ready} KEEP to your wallet")
}

/** The GEMS tab body (SPEC §5 states table). */
enum class GemsPhase { LOADING, OFF, READY, ERROR }

/** GEMS' primary (SPEC §5a, §5c, states table); null when Gems are off (the empty state has no primary). */
fun gemsPrimaryLook(ui: GemsUi): ForgePrimaryLook? =
    gemsPrimaryLookAdmitted(ui)?.withOwnerGate(ui.actionsAllowed)

private fun gemsPrimaryLookAdmitted(ui: GemsUi): ForgePrimaryLook? {
    when (ui.phase) {
        GemsPhase.OFF -> return null
        GemsPhase.LOADING -> return ForgePrimaryLook("Checking", Verb.STONE, CommandState.BUSY, ForgeAction.NONE, sentence = true)
        GemsPhase.ERROR -> return ForgePrimaryLook("RETRY", Verb.RED, CommandState.ENABLED, ForgeAction.RETRY)
        GemsPhase.READY -> Unit
    }
    moneyStageLook(ui.stage, ui.failure, "SENT")?.let { return it }
    if (ui.pendingRecovery) return ForgePrimaryLook("CONTINUE", Verb.GOLD, CommandState.ENABLED, ForgeAction.CONTINUE)
    if (ui.walletShort) return ForgePrimaryLook("BUY ${ui.amount} GEMS", Verb.OFF, CommandState.DISABLED, ForgeAction.NONE,
        reason = "Your wallet has ${ui.walletKeep} KEEP")
    if (ui.amount == UNKNOWN || ui.pay == UNKNOWN) return ForgePrimaryLook("Checking", Verb.STONE, CommandState.BUSY, ForgeAction.NONE, sentence = true)
    return ForgePrimaryLook("BUY ${ui.amount} GEMS", Verb.GOLD, CommandState.ENABLED, ForgeAction.BUY,
        sub = "paid with ${ui.pay} KEEP from your wallet")
}

/** Keep real loading/receipt evidence and all admitted behavior; a closed gate removes action intent.
 * This selector does not create a Seal or grant signing/payment permission. */
private fun ForgePrimaryLook.withOwnerGate(actionsAllowed: Boolean): ForgePrimaryLook =
    if (actionsAllowed || action == ForgeAction.NONE || action == ForgeAction.EXPLAIN_LOCK) this
    else copy(verb = Verb.OFF, state = CommandState.DISABLED, action = ForgeAction.NONE,
        reason = "This Gold Forge view is read-only.")

/** What a Gems spend is (SPEC §6). */
enum class GemSpendKind { FINISH, BUY, SKIP }

/** The speed-up Seal's confirm word by kind. */
fun gemSpendConfirmLabel(kind: GemSpendKind): String = when (kind) {
    GemSpendKind.FINISH -> "FINISH"
    GemSpendKind.BUY -> "BUY"
    GemSpendKind.SKIP -> "SKIP"
}

/**
 * The speed-up Seal's primary (SPEC §6 states): CHECKING price → stone "Checking"; UNAVAILABLE → off + reason; short →
 * blue "GET GEMS / at the Gold Forge" (never auto-spends); busy → dots "Finishing"; refused → red RETRY; uncertain →
 * stone "Checking…"; otherwise the gold confirm that arms (CONFIRM). A server zero is free: no arming ([gemSpendArms]).
 */
fun gemSpendPrimaryLook(ui: GemSpendUi): ForgePrimaryLook {
    val confirm = gemSpendConfirmLabel(ui.kind)
    return when {
        ui.stage == MoneyStage.SENDING || ui.stage == MoneyStage.CHECK_WALLET ->
            ForgePrimaryLook("Finishing", Verb.STONE, CommandState.BUSY, ForgeAction.NONE, sentence = true)
        ui.stage == MoneyStage.SENT -> ForgePrimaryLook("DONE", Verb.MOSS, CommandState.ENABLED, ForgeAction.NONE, icon = "shape:check")
        ui.stage == MoneyStage.FAILED && ui.failure == MoneyFailure.REFUSED -> ForgePrimaryLook("RETRY", Verb.RED, CommandState.ENABLED, ForgeAction.RETRY)
        ui.stage == MoneyStage.FAILED -> ForgePrimaryLook("Checking…", Verb.STONE, CommandState.BUSY, ForgeAction.NONE, sentence = true)
        ui.price.status == PriceStatus.CHECKING -> ForgePrimaryLook("Checking", Verb.STONE, CommandState.BUSY, ForgeAction.NONE, sentence = true)
        ui.price.status == PriceStatus.UNAVAILABLE -> ForgePrimaryLook(confirm, Verb.OFF, CommandState.DISABLED, ForgeAction.NONE,
            reason = ui.unavailableReason ?: "The price is unavailable right now")
        ui.short != null || ui.price.status == PriceStatus.SHORT ->
            ForgePrimaryLook("GET GEMS", Verb.BLUE, CommandState.ENABLED, ForgeAction.GET_GEMS, sub = "at the Gold Forge")
        else -> ForgePrimaryLook(confirm, Verb.GOLD, CommandState.ENABLED, ForgeAction.CONFIRM)
    }
}

/** Whether the confirm arms over 450 ms: every priced spend does; a server zero ("FREE") does not (SPEC §6a). */
fun gemSpendArms(ui: GemSpendUi): Boolean = ui.price.status != PriceStatus.SERVER_ZERO

// ---- SMELT copy ----

/** "Free furnace" / "Deed furnace" from the server pool id (SPEC §3a.1); an unknown id is shown as sent. */
fun furnaceLabel(pool: String): String = when (pool.trim().lowercase()) {
    "free" -> "Free furnace"
    "deed" -> "Deed furnace"
    "" -> UNKNOWN
    else -> pool
}

/** The load label (SPEC §3a.2): the green "+{basket}" part (only while choosing a non-empty basket) and the rest. */
data class LoadText(val basket: String?, val rest: String)

/** "+1,800 of 5,000" while choosing; "1,800 of 5,000" once held; "Uncapped today" without a cap. */
fun furnaceLoadText(state: SmeltState, committed: String, basketValue: String?, cap: String?): LoadText {
    val choosing = state == SmeltState.CHOOSING || state == SmeltState.REVIEW
    val basket = basketValue?.takeIf { choosing && isPositiveAmount(it) }?.let { "+$it" }
    return when {
        cap == null -> LoadText(basket, if (basket != null) " · Uncapped today" else "Uncapped today")
        basket != null -> LoadText(basket, " of $cap")
        else -> LoadText(null, "$committed of $cap")
    }
}

/** The held strip (SPEC §3c.4): at most 3 tiles, then a "+n" tile for the rest. Returns (shown, hidden count). */
fun heldStrip(held: List<SmeltTileUi>, max: Int = 3): Pair<List<SmeltTileUi>, Int> =
    if (held.size <= max) held to 0 else held.take(max - 1) to (held.size - (max - 1))

/** The basket icons a SMELT seal shows on its pay side (SPEC §3b): the first two chosen tiles. */
fun smeltSealIcons(tiles: List<SmeltTileUi>): List<String> = tiles.filter { it.chosen > 0 }.take(2).map { it.icon }

/** The number of chosen units across the basket. */
fun basketCount(tiles: List<SmeltTileUi>): Int = tiles.sumOf { it.chosen.coerceAtLeast(0) }

/** A 24 px currency icon draws at 36 dp on a tile; 64 px item art at 32 dp (SPEC §2 ItemTile). */
fun tileIconDp(icon: String): Int = if (icon in SMALL_ART) 36 else 32

private val SMALL_ART = setOf("shards", "shard", "gem", "keep", "skr", "sol", "gf:keep_24", "gf:gem_24", "craft:keep_24")

/** The step chip states (SPEC §2 StepRow). */
enum class StepState { DONE, NOW, TODO }

/** The arming start of a consent-gated seal (SPEC §3b): nothing arms until consent; then it arms from whichever is
 *  later, the moment the seal was raised or the moment consent was given. */
fun consentArmStart(armedAtMs: Long, consentAtMs: Long?): Long? = consentAtMs?.let { maxOf(it, armedAtMs) }

/** The arming start of a re-quoted seal (SPEC §6a "the arming restarts"): the later of raise and last quote change. */
fun quoteArmStart(armedAtMs: Long, quoteSeenAtMs: Long): Long = maxOf(armedAtMs, quoteSeenAtMs)
