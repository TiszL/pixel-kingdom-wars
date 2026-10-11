package gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live

import gg.pixelkingdomwars.nativeclient.charter.CharterActivity
import gg.pixelkingdomwars.nativeclient.charter.CharterEnvelope
import gg.pixelkingdomwars.nativeclient.data.CharterJournal
import gg.pixelkingdomwars.nativeclient.data.CharterRecord
import gg.pixelkingdomwars.nativeclient.data.CharterState
import gg.pixelkingdomwars.nativeclient.data.RetirementState
import gg.pixelkingdomwars.nativeclient.model.MyClan
import gg.pixelkingdomwars.nativeclient.model.marketSol
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.phasee.charterSummary
import gg.pixelkingdomwars.nativeclient.ui.phasee.retirementStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.CharterRequestUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.ClanCharterActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.ClanCharterUi
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/**
 * Live mapper of the Clan › CHARTER tab (`K/ui/sheets/account/ClanCharterTab.kt`: `ClanCharterUi` / `ClanCharterActions`,
 * drawn by `ClanCharterBody` inside the hub's `ClanSheet(charter = …)`). Reads the clan (`ClansState.membership?.clan`,
 * passed to today's `CharterScreen` from `ui/phasee/CharterRegistration.kt`), `CharterState` (`CharterViewModel.state`:
 * the saved creation / sale journal and the server activity list) and `RetirementState` (`RetirementViewModel.state`:
 * saved dissolutions). READ-ONLY: charter creation (mint), leadership sale (transfer), INVITE ONLY and dissolution
 * (retire) are money / signing paths, so the captain tools are drawn locked with [MONEY_WIRING_PENDING] and their
 * callbacks only explain it. Saved requests are listed so the player can find them; their recovery stays on today's
 * Charter screen (navigation, no charge).
 */

/** Server statuses after which a charter request no longer needs the player (`CharterProtocol.kt` status enums; a
 *  `cancelled_unpaid` creation still needs its refund, so it is not here). */
private val CHARTER_DONE = setOf("activated", "refunded", "completed", "cancelled")

private fun JsonObject.text(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

private fun envelopeOf(r: CharterRecord): CharterEnvelope? = r.envelope?.let { runCatching { CharterEnvelope.from(it) }.getOrNull() }

/** The clan id a saved charter request is about (`state.original.clanId`); null while the server has not answered. */
private fun clanIdOf(e: CharterEnvelope): String? = runCatching { e.original.text("clanId") }.getOrNull()

/**
 * True when the server shows this clan's charter exists: a creation ACTIVATED or a leadership sale COMPLETED for
 * [clanId], in the activity list or in a saved receipt. A clan registered through the existing-clan migration is not
 * visible in charter state: the host passes [migrated] from `MigrationState` (see HOOKUP-charter-live.md).
 */
internal fun charterRegistered(clanId: String, activity: CharterActivity?, journal: CharterJournal?, migrated: Boolean = false): Boolean {
    if (migrated) return true
    val listed = activity?.items.orEmpty().any { item ->
        item.text("clanId") == clanId && when (item.text("kind")) {
            "creation" -> item.text("status") == "activated"
            "sale" -> item.text("status") == "completed"
            else -> false
        }
    }
    if (listed) return true
    return journal?.records.orEmpty().mapNotNull(::envelopeOf).any { e ->
        clanIdOf(e) == clanId && ((e.kind == "creation" && e.status == "activated") || (e.kind == "sale" && e.status == "completed"))
    }
}

/** Why the captain tools are locked: orders paused, then the server's own pause (`newActions.sale == false`), then the
 *  money wiring this lane does not do. Null only when MS-M3 has wired the tools and nothing pauses them. */
internal fun charterPausedReason(allowed: Boolean, activity: CharterActivity?, moneyWired: Boolean): String? {
    val newActions = activity?.raw?.get("newActions") as? JsonObject
    val salePaused = (newActions?.get("sale") as? JsonPrimitive)?.booleanOrNull == false
    return when {
        !allowed -> "Game orders are paused. History stays available."
        salePaused -> "Charter changes are paused"
        !moneyWired -> MONEY_WIRING_PENDING
        else -> null
    }
}

/** One saved charter request as a pending row, or null when it no longer needs the player. */
internal fun charterPendingRow(r: CharterRecord, wallet: String): CharterRequestUi? {
    val e = envelopeOf(r)
    if (!r.held && e != null && e.terminal != null && e.status != "cancelled_unpaid") return null
    if (!r.held && e != null && e.status in CHARTER_DONE && e.status != "cancelled_unpaid") return null
    val buyer = e?.original?.text("buyer") ?: r.request?.text("buyer")
    val title = when (r.kind) {
        "creation" -> "Register " + (r.request?.text("name") ?: "a clan")
        else -> when (buyer) {
            null -> "Leadership sale"
            wallet -> "Take over leadership"
            else -> "Hand over leadership"
        }
    }
    val state = when {
        r.held -> "Outcome being checked"
        e == null -> "Saved · outcome unknown"
        e.status == "cancelled_unpaid" -> "Cancelled before payment · refund to check"
        else -> sentenceCase(charterSummary(e))
    }
    val price = (e?.original?.text("priceLamports") ?: r.request?.text("priceLamports"))
        ?.let { runCatching { marketSol(it) }.getOrNull() }?.let { " · $it SOL" }.orEmpty()
    return CharterRequestUi("charter:${r.localKey}", title, state + price)
}

/** Requests that still need the player, saved on this device first, then server activity not saved here (another
 *  device), then saved dissolutions that are not finished. */
internal fun charterPending(charter: CharterState?, retirement: RetirementState?, wallet: String, clanName: String): List<CharterRequestUi> {
    val records = charter?.journal?.records.orEmpty()
    val saved = records.mapNotNull { charterPendingRow(it, wallet) }
    val known = records.flatMap { listOfNotNull(it.localKey, it.serverKey) }.toSet()
    val elsewhere = charter?.activity?.items.orEmpty().mapNotNull { item ->
        val key = item.text("key") ?: return@mapNotNull null
        if (key in known || item.text("status") in CHARTER_DONE) return@mapNotNull null
        val what = if (item.text("kind") == "creation") "Clan creation" else "Leadership sale"
        CharterRequestUi("charter:$key", what, "Saved elsewhere · " + sentenceCase((item.text("status") ?: UNKNOWN).replace('_', ' ')))
    }
    val dissolutions = retirement?.journal?.records.orEmpty().filter { !it.terminal }.map { r ->
        CharterRequestUi("retirement:${r.key}", "Dissolve $clanName", sentenceCase(retirementStatus(r)))
    }
    return saved + elsewhere + dissolutions
}

/**
 * The CHARTER tab, or null when the player is in no clan (the hub's no-clan state covers that).
 *
 * @param clan `ClansState.membership?.clan`.
 * @param wallet the session wallet (captain = `clan.leaderWallet == wallet`).
 * @param charter `CharterViewModel.state.value`; null while the Charter client is unavailable.
 * @param retirement `RetirementViewModel.state.value`; null while unavailable.
 * @param captainTier the captain's keep art tier (1..4) from the catalogue art map; null draws tier 1.
 * @param rosterMax the server's clan member cap; null reads "…".
 * @param allowed today's `charterActionsAllowed(...)` (orders, content, battle).
 * @param migrated the clan was registered through the existing-clan migration (`MigrationState`).
 * @param moneyWired false until MS-M3 wires the captain tools; while false they are locked with [MONEY_WIRING_PENDING].
 */
internal fun charterLiveUi(
    clan: MyClan?,
    wallet: String,
    charter: CharterState?,
    retirement: RetirementState?,
    captainTier: Int?,
    rosterMax: Int?,
    allowed: Boolean,
    migrated: Boolean = false,
    moneyWired: Boolean = false,
): ClanCharterUi? {
    clan ?: return null
    val captain = clan.roster.firstOrNull { it.wallet == clan.leaderWallet }
    return ClanCharterUi(
        registered = charterRegistered(clan.id, charter?.activity, charter?.journal, migrated),
        clanName = clan.name,
        bannerIcon = "itm_banner",
        captainName = captain?.name?.takeIf { it.isNotBlank() } ?: UNKNOWN,
        captainTier = captainTier ?: 1,
        joining = if (clan.inviteMode == "invite") "By invite" else "Open to all",
        founded = UNKNOWN,
        roster = "${clan.roster.size} of ${rosterMax?.toString() ?: UNKNOWN}",
        amCaptain = clan.leaderWallet == wallet,
        inviteOnly = clan.inviteMode == "invite",
        pending = charterPending(charter, retirement, wallet, clan.name),
        pausedReason = charterPausedReason(allowed, charter?.activity, moneyWired),
    )
}

/**
 * The CHARTER callbacks (Actions stub for MS-C3). REGISTER (mint), HAND OVER (transfer), INVITE ONLY and every saved
 * request's money step stay with MS-M3: the three tools only post [MONEY_WIRING_PENDING]. "Charter history" and a pending
 * row open today's Charter screen (`CharterRegistration` → `CharterScreen`), where saved requests are checked and
 * recovered under that screen's own gates; nothing is charged from this tab.
 *
 * @param openHistory open today's Charter screen (history + saved-request recovery).
 * @param explain show a reason toast.
 */
internal fun charterLiveActions(openHistory: () -> Unit, explain: (String) -> Unit): ClanCharterActions = ClanCharterActions(
    onHandOver = { explain(MONEY_WIRING_PENDING) },
    onInviteOnly = { _ -> explain(MONEY_WIRING_PENDING) },
    onHistory = openHistory,
    onRegister = { explain(MONEY_WIRING_PENDING) },
    onPending = { _ -> openHistory() },
    onExplain = explain,
)
