package gg.pixelkingdomwars.nativeclient.ui.sheets.account

import androidx.compose.runtime.Immutable
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.outcomeLine
import gg.pixelkingdomwars.nativeclient.ui.kit.priceText
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.SealUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/**
 * Design component: the pure rules of the account cluster (design/final/account/SPEC.md): which primary a surface shows
 * and why, honest money copy (design correction 7), the faucet card's state, the clan roster order and powers, the
 * tournament primary, the tutorial plate's place. No Compose UI, no Android: JVM-tested in
 * app/src/test/kotlin/…/ui/sheets/account/AccountLogicTest.kt.
 */

/**
 * How one primary button looks (label, VT sub-line, face, state and the reason a DISABLED / LOCKED one gives). Feed it
 * to the kit `PrimaryButton(label, onClick, verb = verb, sub = sub, state = state, reason = reason)`.
 */
@Immutable data class PrimaryLook(
    val label: String,
    val sub: String?,
    val verb: Verb,
    val state: CommandState,
    val reason: String?,
)

/** What a tap on a [PrimaryLook] should do: run the action, open Need-more, or say why not. */
enum class PrimaryTap { ACT, NEED_MORE, EXPLAIN, IGNORE }

/** The one routing rule every account primary uses (kit `commandRoute` for buttons that are not commands). */
fun primaryTap(look: PrimaryLook): PrimaryTap = when (look.state) {
    CommandState.ENABLED -> PrimaryTap.ACT
    CommandState.SHORT -> PrimaryTap.NEED_MORE
    CommandState.DISABLED, CommandState.LOCKED -> if (look.reason != null) PrimaryTap.EXPLAIN else PrimaryTap.IGNORE
    CommandState.BUSY -> PrimaryTap.IGNORE
}

// ------------------------------------------------------------------------------------------------------------ wallet copy

/** "7xKp…4f2k" from a full address; a short value is kept whole; blank or null is "…" (never an empty row). */
fun shortAddress(address: String?, head: Int = 4, tail: Int = 4): String {
    val a = address?.trim().orEmpty()
    if (a.isEmpty()) return UNKNOWN
    if (a.length <= head + tail + 1) return a
    return a.take(head) + "…" + a.takeLast(tail)
}

// ------------------------------------------------------------------------------------------------------------------- title

/** What the title card's wallet button is doing (SPEC §1.1: the DS money sequence minus SENT). */
enum class TitleBusy { WALLET_CHECK, WALLET_SENDING, SOCIAL }

/** The wallet button's money stage: gold → stone "Check wallet" → dots. A connect never shows SENT. */
fun titleConnectStage(busy: TitleBusy?): MoneyStage = when (busy) {
    TitleBusy.WALLET_CHECK -> MoneyStage.CHECK_WALLET
    TitleBusy.WALLET_SENDING -> MoneyStage.SENDING
    else -> MoneyStage.READY
}

/** "CONNECT WALLET", or "CONTINUE AS 7xKp…4f2k" for a returning player. */
fun titleConnectLabel(lastWalletLabel: String?): String =
    lastWalletLabel?.takeIf { it.isNotBlank() }?.let { "CONTINUE AS $it" } ?: "CONNECT WALLET"

/** The 2-step code is six digits; anything else is dropped as it is typed. */
fun totpDraft(raw: String, cells: Int = TOTP_CELLS): String = raw.filter { it in '0'..'9' }.take(cells)

/** The six code cells. */
const val TOTP_CELLS = 6

// ------------------------------------------------------------------------------------------------------------------- land

/**
 * The land gate's primary (SPEC §2.1): server off → LOCKED with the server's reason; this wallet already holds its one
 * land → LOCKED; no wallet → gold CONNECT WALLET ("Land is paid from a wallet"); otherwise CHOOSE REALM. Choosing a realm
 * is navigation, so a CHECKING / SHORT / UNAVAILABLE price never blocks it (the realm picker's settle button does).
 */
fun landGatePrimary(walletLinked: Boolean, alreadyOwned: Boolean, serverOffReason: String?): PrimaryLook = when {
    serverOffReason != null -> PrimaryLook("CHOOSE REALM", null, Verb.GOLD, CommandState.LOCKED, serverOffReason)
    alreadyOwned -> PrimaryLook("CHOOSE REALM", null, Verb.GOLD, CommandState.LOCKED, "One land per wallet. This wallet has its land.")
    !walletLinked -> PrimaryLook("CONNECT WALLET", "Land is paid from a wallet", Verb.GOLD, CommandState.ENABLED, null)
    else -> PrimaryLook("CHOOSE REALM", null, Verb.GOLD, CommandState.ENABLED, null)
}

/** Why a realm card cannot be chosen; NONE = it can. */
enum class RealmLock { NONE, FULL, SKR_UNLOCK }

/**
 * The realm picker's SETTLE primary (SPEC §2.2). A CHECKING price stays enabled (it navigates to the Seal, which shows
 * "…"; design correction 7); an UNAVAILABLE price disables it; a SHORT price opens Need-more.
 */
fun settleLook(realmName: String?, lock: RealmLock?, price: PriceUi): PrimaryLook {
    val sub = "${priceText(price)} SOL · one land per wallet"
    return when {
        realmName == null -> PrimaryLook("SETTLE", null, Verb.GOLD, CommandState.DISABLED, "Pick a realm first")
        lock == RealmLock.FULL -> PrimaryLook("SETTLE IN ${realmName.uppercase()}", sub, Verb.GOLD, CommandState.DISABLED, "$realmName is full right now")
        lock == RealmLock.SKR_UNLOCK -> PrimaryLook("SETTLE IN ${realmName.uppercase()}", sub, Verb.GOLD, CommandState.LOCKED, "Seeker tiles open with SKR")
        price.status == PriceStatus.UNAVAILABLE -> PrimaryLook("SETTLE IN ${realmName.uppercase()}", null, Verb.GOLD, CommandState.DISABLED, "Land price unavailable right now")
        price.status == PriceStatus.SHORT -> PrimaryLook("SETTLE IN ${realmName.uppercase()}", sub, Verb.GOLD, CommandState.SHORT, "Not enough SOL")
        else -> PrimaryLook("SETTLE IN ${realmName.uppercase()}", sub, Verb.GOLD, CommandState.ENABLED, null)
    }
}

/** Where a sent land payment stands after the Seal. */
enum class PaymentOutcome {
    /** The money sequence is running (Check wallet → Sending → SENT). */
    IN_FLIGHT,
    /** Timed out or the answer was lost: we do not know yet. Keep the recovery surface; never say nothing was spent. */
    CHECKING,
    /** The server or the wallet refused, authoritatively. Only this may say nothing was spent. */
    REFUSED,
}

/** The line under the land payment (design correction 7). Null while in flight. */
fun landPaymentLine(outcome: PaymentOutcome, serverReason: String? = null): String? = when (outcome) {
    PaymentOutcome.IN_FLIGHT -> null
    PaymentOutcome.CHECKING -> "We are checking your payment. Your land is safe if it went through."
    PaymentOutcome.REFUSED -> outcomeLine("land purchase", authoritative = true, serverReason = serverReason)
}

/**
 * The BUY LAND Seal (SPEC §2.3): pay [price] (SOL, from wallet) → get the Kingdom Deed. The network fee lives in the
 * fine print (last line), never on the main surface.
 */
fun landSealUi(realmName: String, price: PriceUi, armedAtMs: Long): SealUi = SealUi(
    title = "BUY LAND IN ${realmName.uppercase()}?",
    lines = listOf(
        "Paid from your wallet. You sign once.",
        "Your base gets a tile in $realmName and a deed you own.",
        "One land per wallet. The network fee is shown in your wallet.",
    ),
    price = price,
    confirmLabel = "BUY LAND",
    armedAtMs = armedAtMs,
    gets = PriceUi(Currency.ITEM, "DEED", PriceStatus.OK, icon = "itm_deed_earth", description = "Kingdom Deed"),
)

/** The land herald shows on the first three sessions of a landless player, then lives only as the KINGDOMS badge. */
fun landHeraldShown(landless: Boolean, sessionNumber: Int, maxSessions: Int = LAND_HERALD_SESSIONS): Boolean =
    landless && sessionNumber in 1..maxSessions

/** How many sessions the land herald shows for (SPEC §1.2). */
const val LAND_HERALD_SESSIONS = 3

/**
 * The tutorial plate's top edge (px): under the target when it fits, else above it, never off the top. The plate must
 * never cover the building the step asks the player to tap.
 */
fun coachPlateTop(targetTop: Float, targetBottom: Float, plateHeight: Float, areaHeight: Float, gap: Float): Float {
    val below = targetBottom + gap
    return if (below + plateHeight <= areaHeight) below else (targetTop - gap - plateHeight).coerceAtLeast(0f)
}

// ---------------------------------------------------------------------------------------------------------------- profile

/** The KINGDOMS tab's layout. */
enum class KingdomsMode {
    /** No land yet: the whole tab is the land teaser + gold CLAIM YOUR LAND. */
    LANDLESS,
    /** One kingdom: no SWITCH, the ADD card is prominent. */
    ONE,
    /** Two or more: SWITCH on the others. */
    MANY,
}

fun kingdomsMode(landless: Boolean, kingdomCount: Int): KingdomsMode = when {
    landless || kingdomCount == 0 -> KingdomsMode.LANDLESS
    kingdomCount == 1 -> KingdomsMode.ONE
    else -> KingdomsMode.MANY
}

/**
 * The ADD A KINGDOM card's sub-line. "Free" only from a server zero (honest numbers); a priced second land shows its SOL
 * price; an unknown price is "…".
 */
fun addKingdomSub(price: PriceUi): String = when (price.status) {
    PriceStatus.SERVER_ZERO -> "Your second land is free"
    PriceStatus.OK, PriceStatus.SHORT -> "Another land: ${priceText(price)} SOL"
    PriceStatus.CHECKING -> "Another land: $UNKNOWN SOL"
    PriceStatus.UNAVAILABLE -> "Land price unavailable right now"
}

/** "2 need you · 41 done" ("…" for unknown counts; the "need you" half drops at zero). */
fun historyLine(needsYou: Int?, done: Int?): String {
    val doneText = "${done?.toString() ?: UNKNOWN} done"
    return when {
        needsYou == null -> "$UNKNOWN need you · $doneText"
        needsYou <= 0 -> doneText
        else -> "$needsYou need you · $doneText"
    }
}

/** The ways to sign in. */
enum class ProviderKind { WALLET, GOOGLE, X, EMAIL }

/** A sign-in method can be unlinked only while another one stays linked (SPEC §4.3: never lock a player out). */
fun canUnlink(linked: Map<ProviderKind, Boolean>, kind: ProviderKind): Boolean =
    linked[kind] == true && linked.count { it.value } > 1

/** SAVE is live only for a changed, non-blank name and never while a save is in flight. */
fun nameSaveEnabled(draft: String, saved: String, saving: Boolean): Boolean {
    val d = draft.trim()
    return !saving && d.isNotEmpty() && d != saved.trim()
}

/** The letter in a provider's well: there is no authored Google or X mark (SPEC §4.3), so a PS letter stands in. */
fun providerLetter(kind: ProviderKind): String = when (kind) {
    ProviderKind.WALLET -> ""
    ProviderKind.GOOGLE -> "G"
    ProviderKind.X -> "X"
    ProviderKind.EMAIL -> "@"
}

// ----------------------------------------------------------------------------------------------------------------- faucet

/** What the faucet card's button does. */
enum class FaucetButton { CLAIM, GET_LAND, RECHECK, NONE }

/** How the faucet card draws one [FaucetUi] state. */
@Immutable data class FaucetLook(
    /** Green rim (claimable now). */
    val rim: Boolean,
    /** Locked look: greyed token + padlock. */
    val locked: Boolean,
    /** PS 16 headline ("+1,000 SKR"). */
    val headline: String,
    /** VT 18 line. */
    val line: String,
    val button: FaucetButton,
    /** The CLAIM button's money stage (READY until claimed). */
    val stage: MoneyStage = MoneyStage.READY,
    /** The CLAIM label ("CLAIM 1,000"). */
    val claimLabel: String = "CLAIM",
    /** The claimed-today timer text ("7h 12m"). */
    val nextIn: String? = null,
)

/**
 * The faucet card (SPEC §6.1). Hidden (mainnet / flag off) draws nothing (null). A lost response is CHECKING: the card
 * stays and says it is checking, never that nothing was spent. The fee line is the button's own sub-line (the one place
 * the owner asked for it).
 *
 * [dailyAmount] is the catalogue's daily grant, formatted (`SKR_FAUCET.devnet.grantSkr`, "1,000"); unknown is "…", never a
 * literal amount. The ready line drops the frame's "Free" (public wording never sells "free"; owner rule, night of
 * 2026-10-06): "Once a day for deed holders. Test SKR, no real value."
 */
fun faucetLook(ui: FaucetUi, dailyAmount: String = UNKNOWN): FaucetLook? = when (ui) {
    FaucetUi.Hidden -> null
    FaucetUi.NeedsDeed -> FaucetLook(rim = false, locked = true, headline = "$dailyAmount SKR a day",
        line = "Needs a Kingdom Deed. Buy land once, then claim every day.", button = FaucetButton.GET_LAND)
    is FaucetUi.Ready -> FaucetLook(rim = true, locked = false, headline = "+${ui.amount} SKR",
        line = "Once a day for deed holders. Test SKR, no real value.", button = FaucetButton.CLAIM, claimLabel = "CLAIM ${ui.amount}")
    is FaucetUi.Claiming -> FaucetLook(rim = true, locked = false, headline = "+${ui.amount} SKR",
        line = "Once a day for deed holders. Test SKR, no real value.", button = FaucetButton.CLAIM, stage = ui.stage,
        claimLabel = "CLAIM ${ui.amount}")
    is FaucetUi.ClaimedToday -> FaucetLook(rim = false, locked = false, headline = "Claimed",
        line = "Claimed · next in ${ui.nextIn}", button = FaucetButton.NONE, nextIn = ui.nextIn)
    is FaucetUi.Unavailable -> FaucetLook(rim = false, locked = false, headline = "Daily test SKR", line = ui.reason, button = FaucetButton.NONE)
    FaucetUi.Checking -> FaucetLook(rim = false, locked = false, headline = "Daily test SKR",
        line = "We are checking your claim. Your SKR is safe if it went through.", button = FaucetButton.RECHECK)
}

/** The WALLET tab's one-line faucet row ("+1,000 ready today"); null hides the row. */
fun faucetRowLine(ui: FaucetUi): String? = when (ui) {
    FaucetUi.Hidden -> null
    FaucetUi.NeedsDeed -> "Needs a Kingdom Deed"
    is FaucetUi.Ready -> "+${ui.amount} ready today"
    is FaucetUi.Claiming -> "+${ui.amount} on its way"
    is FaucetUi.ClaimedToday -> "Claimed · next in ${ui.nextIn}"
    is FaucetUi.Unavailable -> ui.reason
    FaucetUi.Checking -> "Checking your claim"
}

// -------------------------------------------------------------------------------------------------------------------- shop

/**
 * Where the scrolling stacked tab strip scrolls to (SPEC §0.3): the active tab is always fully in view and, when a tab
 * follows it, [peekPx] of that next tab shows at the right edge so the player sees there is more. Clamped to the strip.
 */
fun stackedTabScrollTarget(widthsPx: List<Float>, gapPx: Float, active: Int, viewportPx: Float, peekPx: Float, currentPx: Float = 0f): Float {
    if (widthsPx.isEmpty() || viewportPx <= 0f) return 0f
    val i = active.coerceIn(0, widthsPx.lastIndex)
    val total = widthsPx.sum() + gapPx * widthsPx.lastIndex
    val maxScroll = (total - viewportPx).coerceAtLeast(0f)
    val start = widthsPx.take(i).sum() + gapPx * i
    val end = start + widthsPx[i]
    val wantedEnd = if (i < widthsPx.lastIndex) end + gapPx + peekPx else end
    var target = currentPx.coerceIn(0f, maxScroll)
    if (wantedEnd > target + viewportPx) target = wantedEnd - viewportPx
    if (start < target) target = start
    return target.coerceIn(0f, maxScroll)
}

/** A stacked tab's width in the scrolling strip (dp): the label at ~10 dp a glyph plus padding, at least 72. */
fun scrollingTabWidthDp(label: String): Int = maxOf(72, label.length * 10 + 26)

/** The supply sections, in the order the shop draws them (SPEC §3). */
enum class SupplyKind { SHIELD, BUILDER, ENERGY, BOOST }

/** The BUY primary for the selected offer (SPEC §3): its own label + sub-line; SHORT opens Need-more. */
fun supplyBuyLook(label: String?, sub: String?, price: PriceUi?, lockedReason: String?): PrimaryLook = when {
    label == null || price == null -> PrimaryLook("BUY", null, Verb.GOLD, CommandState.DISABLED, "Pick a supply first")
    lockedReason != null -> PrimaryLook(label, null, Verb.GOLD, CommandState.LOCKED, lockedReason)
    price.status == PriceStatus.UNAVAILABLE -> PrimaryLook(label, null, Verb.GOLD, CommandState.DISABLED, "Price unavailable right now")
    price.status == PriceStatus.SHORT -> PrimaryLook(label, sub, Verb.GOLD, CommandState.SHORT, "Not enough to buy this")
    else -> PrimaryLook(label, sub, Verb.GOLD, CommandState.ENABLED, null)
}

// ------------------------------------------------------------------------------------------------------------------- clans

/** A clan member's role. */
enum class ClanRole { LEADER, ELDER, MEMBER }

/** The MEMBERS sort chips. */
enum class MemberSort { TROPHIES, WINS, ONLINE }

/**
 * The roster order for a sort chip: TROPHIES / WINS highest first (unknown last), ONLINE puts online members first and
 * then by trophies; ties keep the server's order (stable sort).
 */
fun sortMembers(members: List<ClanMemberUi>, sort: MemberSort): List<ClanMemberUi> = when (sort) {
    MemberSort.TROPHIES -> members.sortedWith(byTrophies)
    MemberSort.WINS -> members.sortedWith(compareBy<ClanMemberUi, Int?>(nullsLast(reverseOrder<Int>())) { it.wins })
    MemberSort.ONLINE -> members.sortedWith(compareBy<ClanMemberUi> { !it.online }.then(byTrophies))
}

private val byTrophies: Comparator<ClanMemberUi> = compareBy<ClanMemberUi, Long?>(nullsLast(reverseOrder<Long>())) { it.trophies }

/** What the viewer may do to one member (SPEC §5.1: leader / elder promote, only the leader removes). */
@Immutable data class MemberPowers(val canPromote: Boolean, val canKick: Boolean)

fun memberPowers(myRole: ClanRole, target: ClanMemberUi): MemberPowers {
    if (target.isYou) return MemberPowers(canPromote = false, canKick = false)
    val promote = when (myRole) {
        ClanRole.LEADER -> target.role != ClanRole.LEADER
        ClanRole.ELDER -> target.role == ClanRole.MEMBER
        ClanRole.MEMBER -> false
    }
    val kick = myRole == ClanRole.LEADER && target.role != ClanRole.LEADER
    return MemberPowers(promote, kick)
}

/** The clan name rule shown under the field (SPEC §5.4: 3 to 16 letters); null = fine. The server has the final say. */
fun clanNameError(name: String): String? {
    val n = name.trim()
    return when {
        n.isEmpty() -> null
        n.length !in 3..16 -> "3 to 16 letters"
        !n.all { it.isLetterOrDigit() || it == ' ' } -> "Letters, numbers and spaces only"
        else -> null
    }
}

/** The clan tag rule (3-4 letters or numbers); null = fine. */
fun clanTagError(tag: String): String? {
    val t = tag.trim()
    return when {
        t.isEmpty() -> null
        t.length !in 3..4 -> "3 or 4 letters"
        !t.all { it.isLetterOrDigit() } -> "Letters and numbers only"
        else -> null
    }
}

/** The tag field keeps upper-case letters and digits, at most four. */
fun clanTagDraft(raw: String): String = raw.filter { it.isLetterOrDigit() }.uppercase().take(4)

/** One stepper press on MIN TROPHIES, clamped to [min]..[max]. */
fun stepMinTrophies(value: Int, delta: Int, step: Int, min: Int, max: Int): Int =
    (value + delta * step).coerceIn(min, maxOf(min, max))

/**
 * CREATE CLAN (SPEC §5.4): no Clan Hall → LOCKED with its reason; a bad name / tag → DISABLED; an unknown price stays
 * enabled navigation into the review Seal (correction 7); UNAVAILABLE → DISABLED; SHORT → Need-more.
 */
fun clanCreateLook(hallLockedReason: String?, name: String, tag: String, price: PriceUi?): PrimaryLook {
    val ready = clanNameError(name) == null && clanTagError(tag) == null && name.isNotBlank() && tag.isNotBlank()
    return when {
        hallLockedReason != null -> PrimaryLook("CREATE CLAN", null, Verb.GOLD, CommandState.LOCKED, hallLockedReason)
        !ready -> PrimaryLook("CREATE CLAN", null, Verb.GOLD, CommandState.DISABLED, "Give the clan a name and a tag")
        price?.status == PriceStatus.UNAVAILABLE -> PrimaryLook("CREATE CLAN", null, Verb.GOLD, CommandState.DISABLED, "Price unavailable right now")
        price?.status == PriceStatus.SHORT -> PrimaryLook("CREATE CLAN", null, Verb.GOLD, CommandState.SHORT, "Not enough SOL")
        else -> PrimaryLook("CREATE CLAN", null, Verb.GOLD, CommandState.ENABLED, null)
    }
}

/** A tournament's phase. */
enum class TourneyPhase { ENTRY, BATTLES, RESULTS, CLOSED }

/** One square of the ENTRY → BATTLES → RESULTS track. */
enum class StepTone { DONE, CURRENT, TODO }

/** The three-step track: done steps green, the current / next step gold, later steps empty. */
fun tourneySteps(phase: TourneyPhase, entered: Boolean): List<StepTone> = when (phase) {
    TourneyPhase.ENTRY -> if (entered) listOf(StepTone.DONE, StepTone.CURRENT, StepTone.TODO) else listOf(StepTone.CURRENT, StepTone.TODO, StepTone.TODO)
    TourneyPhase.BATTLES -> listOf(StepTone.DONE, StepTone.CURRENT, StepTone.TODO)
    TourneyPhase.RESULTS -> listOf(StepTone.DONE, StepTone.DONE, StepTone.CURRENT)
    TourneyPhase.CLOSED -> listOf(StepTone.DONE, StepTone.DONE, StepTone.DONE)
}

/**
 * The TOURNEY primary (SPEC §5.3). FIND MATCH is the red attack primary only while battles are open, the player is on
 * the roster and has fights left; otherwise it keeps its place, locked, with the reason (correction 7). A captain of a
 * clan not yet entered gets gold ENTER CLAN; claimable prizes get gold CLAIM PRIZE.
 */
fun tourneyLook(phase: TourneyPhase, entered: Boolean, amCaptain: Boolean, inRoster: Boolean, fightsUsed: Int?, fightsMax: Int?,
    opensIn: String?, prizeClaimable: Boolean): PrimaryLook = when {
    prizeClaimable -> PrimaryLook("CLAIM PRIZE", null, Verb.GOLD, CommandState.ENABLED, null)
    phase == TourneyPhase.CLOSED -> PrimaryLook("FIND MATCH", null, Verb.RED, CommandState.LOCKED, "This tournament is over")
    !entered && phase == TourneyPhase.ENTRY && amCaptain -> PrimaryLook("ENTER CLAN", "As clan captain", Verb.GOLD, CommandState.ENABLED, null)
    !entered -> PrimaryLook("FIND MATCH", null, Verb.RED, CommandState.LOCKED,
        if (phase == TourneyPhase.ENTRY) "Your captain enters the clan" else "Your clan is not in this tournament")
    !inRoster -> PrimaryLook("FIND MATCH", null, Verb.RED, CommandState.LOCKED, "You joined after the roster locked")
    phase == TourneyPhase.ENTRY -> PrimaryLook("FIND MATCH", null, Verb.RED, CommandState.LOCKED, opensIn ?: "Battles open soon")
    phase == TourneyPhase.RESULTS -> PrimaryLook("FIND MATCH", null, Verb.RED, CommandState.LOCKED, "Battles are over. See the rankings.")
    fightsUsed != null && fightsMax != null && fightsUsed >= fightsMax ->
        PrimaryLook("FIND MATCH", null, Verb.RED, CommandState.DISABLED, "You used all $fightsMax fights")
    else -> PrimaryLook("FIND MATCH", null, Verb.RED, CommandState.ENABLED, null)
}

/** Why the charter's captain tools are locked for this viewer; null = live (the captain, not paused). */
fun charterToolsLock(amCaptain: Boolean, pausedReason: String?): String? = pausedReason ?: if (amCaptain) null else "captain"
