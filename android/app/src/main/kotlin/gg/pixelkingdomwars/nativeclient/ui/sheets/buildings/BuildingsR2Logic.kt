package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings

import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.currencyName
import gg.pixelkingdomwars.nativeclient.ui.kit.priceText
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi

/*
 * The pure rules of the buildings cluster's round 2 (design/final/buildings/SPEC.md "Round 2 additions" R2.1-R2.5 and
 * E1.1-E1.2, with the round 2 critic fixes): the Builders header line and FINISH / HIRE looks, the Need-more door list,
 * the quote primaries shared by the wall row and obstacle REMOVE, the construction plate, the Keep STORES chip line and
 * footer, and the Keep EXPAND primary and table. No Compose here; JVM-tested in BuildingsR2LogicTest.
 */

// ---- Prices (design correction 7) ----

/** What a tap on a priced button or pill does. */
enum class PriceTap {
    /** Open the next step (OK, SERVER_ZERO, and CHECKING: a CHECKING price is enabled navigation; the Seal re-quotes). */
    OPEN,
    /** SHORT: open Need-more; never auto-spends. */
    NEED_MORE,
    /** UNAVAILABLE: disabled; a tap only says why. */
    EXPLAIN,
}

/** The tap route of a price (null = no price = OPEN). */
fun priceTap(price: PriceUi?): PriceTap = when (price?.status) {
    PriceStatus.SHORT -> PriceTap.NEED_MORE
    PriceStatus.UNAVAILABLE -> PriceTap.EXPLAIN
    else -> PriceTap.OPEN
}

// ---- Builders (R2.1) ----

/** The Builders header's right line: "2 working · 1 free", "all free" when nobody works, "…" while unknown. */
fun buildersHeaderLine(owned: Int, free: Int): String {
    if (owned <= 0 || free < 0 || free > owned) return UNKNOWN
    return if (free == owned) "all free" else "${owned - free} working · $free free"
}

/** What the FINISH button on a working builder row shows. */
enum class FinishKind {
    /** Green FINISH with its gem price; a tap opens the Finish-now Seal (CHECKING included: the Seal shows "checking"). */
    FINISH,
    /** Stone + dots: FINISH was pressed and the Seal has not returned. */
    BUSY,
    /** Off face: the price is unavailable; a tap says why. */
    OFF,
    /** SHORT: red pill; a tap opens Need-more (GEMS). */
    NEED_MORE,
}

/** The FINISH look of a builder row: [kind] and whether its job line reads "Being checked" (a lost answer). An uncertain
 *  row keeps FINISH as the recovery action and never says nothing was spent. */
data class FinishLook(val kind: FinishKind, val beingChecked: Boolean)

fun finishLook(price: PriceUi?, busy: Boolean, checking: Boolean): FinishLook {
    val kind = when {
        busy -> FinishKind.BUSY
        else -> when (priceTap(price)) {
            PriceTap.OPEN -> FinishKind.FINISH
            PriceTap.NEED_MORE -> FinishKind.NEED_MORE
            PriceTap.EXPLAIN -> FinishKind.OFF
        }
    }
    return FinishLook(kind, checking && !busy)
}

/** The HIRE primary's VT sub-line: "0.25 SOL once · paid from your wallet" ("…" while the price is checked). */
fun hireSubLine(price: PriceUi): String = "${priceText(price)} ${currencyName(price.currency)} once · paid from your wallet"

/** What the hire primary shows. */
enum class HireKind {
    /** Gold HIRE BUILDER n: opens the money Seal, never pays on tap. */
    HIRE,
    /** The money sequence after the Seal (Check wallet → Sending → SENT / RETRY): the kit MoneyButton. */
    MONEY,
    /** A lost answer: stone "Being checked"; HIRE stays the recovery action. */
    CHECKING,
    /** Not enough SOL: a tap opens Need-more. */
    NEED_MORE,
    /** The hire price is unavailable: off with a reason. */
    OFF,
}

fun hireKind(price: PriceUi, stage: MoneyStage, checking: Boolean): HireKind = when {
    checking -> HireKind.CHECKING
    stage != MoneyStage.READY -> HireKind.MONEY
    else -> when (priceTap(price)) {
        PriceTap.OPEN -> HireKind.HIRE
        PriceTap.NEED_MORE -> HireKind.NEED_MORE
        PriceTap.EXPLAIN -> HireKind.OFF
    }
}

// ---- Need more (R2.2) ----

/** At most this many door buttons in one shortfall block (SPEC R2.2: 1-2). */
const val MAX_BLOCK_DOORS = 2

/** A block's own door buttons: the server's best door is the primary and is never repeated as a block button. */
fun blockDoors(doors: List<NeedMoreDoorUi>, best: NeedMoreDoorUi?): List<NeedMoreDoorUi> =
    doors.filter { best == null || it.destination != best.destination }.take(MAX_BLOCK_DOORS)

/** "have 40,943 · need 52,400" (unknowns read "…"). */
fun haveNeedLine(have: String?, need: String?): String = "have ${have?.ifBlank { null } ?: UNKNOWN} · need ${need?.ifBlank { null } ?: UNKNOWN}"

// ---- Quotes: wall ROW and obstacle REMOVE (R2.4, R2.5) ----

/** The quote primary's kind. */
enum class QuoteKind {
    /** Green commit (UPGRADE n / REMOVE): the only kind that may send. */
    COMMIT,
    /** Stone + dots "Checking price": only the commit waits; the price pill stays enabled navigation. */
    WAIT_PRICE,
    /** Off commit + blue GET <CURRENCY> (Need-more). */
    NEED_MORE,
    /** Off commit + stone BUILDERS "Free in …". */
    NEED_BUILDER,
    /** Stone + dots "Starting…": the request is out. */
    STARTING,
    /** A lost answer: "Being checked", the primary kept as RETRY (critic fix 2026-10-03; never "Nothing was spent"). */
    RETRY,
    /** Off with a reason (nothing to do, read-only base, price unavailable). */
    OFF,
}

/** The quote primary: its [kind], whether a tap may call the commit, and the reason / note line. */
data class QuoteLook(val kind: QuoteKind, val sends: Boolean, val reason: String?)

/**
 * The commit primary of a quote half sheet. [nothingToDo] (every wall already at the next level) wins with [emptyReason].
 * VERIFYING becomes RETRY ("Being checked" + RETRY, SPEC R2.4 / R2.5), unlike the single UPGRADE sheet; ERROR returns to
 * the READY look (the error toast is the OverlayHost's).
 */
fun quoteLook(state: UpgradeState, price: PriceUi, reason: String?, nothingToDo: Boolean = false, emptyReason: String? = null): QuoteLook {
    if (nothingToDo) return QuoteLook(QuoteKind.OFF, false, emptyReason ?: reason ?: "Nothing to do here")
    if (state == UpgradeState.VERIFYING) return QuoteLook(QuoteKind.RETRY, true, reason ?: BEING_CHECKED)
    val look = upgradePrimaryLook(state, price, reason)
    val kind = when (look.kind) {
        UpgradePrimaryKind.UPGRADE -> QuoteKind.COMMIT
        UpgradePrimaryKind.WAIT_PRICE -> QuoteKind.WAIT_PRICE
        UpgradePrimaryKind.NEED_MORE -> QuoteKind.NEED_MORE
        UpgradePrimaryKind.NEED_BUILDER -> QuoteKind.NEED_BUILDER
        UpgradePrimaryKind.STARTING -> QuoteKind.STARTING
        UpgradePrimaryKind.VERIFYING -> QuoteKind.RETRY
        UpgradePrimaryKind.OFF -> QuoteKind.OFF
    }
    return QuoteLook(kind, look.sends || kind == QuoteKind.RETRY, look.reason)
}

/** The words of an uncertain result (design correction 7). */
const val BEING_CHECKED = "Being checked"

/** The wall-row hint. The second sentence is unverified copy (SPEC R2.4): only when the server keeps walls up. */
fun wallRowHint(wallsStayUp: Boolean): String =
    "Tap a wall in the row to leave it out." + if (wallsStayUp) " Walls stay up while they upgrade." else ""

/** "7 × 1,500" for the unit pill; "…" while the unit price is not known. */
fun unitTimesCount(count: Int, unit: PriceUi): String? =
    if (unit.status == PriceStatus.CHECKING || unit.status == PriceStatus.UNAVAILABLE || unit.amount.isNullOrBlank()) null
    else "$count × ${unit.amount}"

/** The commit's sub line, "10,500 Shards in all" ("… Shards in all" while checking). */
fun inAllLine(total: PriceUi): String = "${priceText(total)} ${currencyName(total.currency)} in all"

// ---- Under construction (R2.3) ----

/** The construction meter's tone. */
enum class PlateTone { STRIPE, SOLID }

/** Within this many seconds the meter turns solid green (SPEC R2.3 "finishing within 10 s"). */
const val FINISHING_SECONDS = 10L

/** The plate's time and meter tone: STRIPE while building, SOLID in the last [FINISHING_SECONDS] (the time then reads "9s",
 *  D-070: m:ss only on the battle clock); an unknown time reads "…". */
data class PlateLook(val text: String, val tone: PlateTone)

fun constructionPlateLook(secondsLeft: Long?, formatted: String?): PlateLook {
    val finishing = secondsLeft != null && secondsLeft in 0..FINISHING_SECONDS
    val text = when {
        finishing -> "${secondsLeft}s"
        !formatted.isNullOrBlank() -> formatted
        else -> UNKNOWN
    }
    return PlateLook(text, if (finishing) PlateTone.SOLID else PlateTone.STRIPE)
}

// ---- Keep STORES (E1.1) ----

/** The four Keep STORES tabs (their ids are the `Destination.KeepStores(tab)` values). */
enum class StoresTab { BAG, MATERIALS, KITS, COLLECTION }

/** The header chip: "14 in your bag" (the count of the active tab), "…" when any count is unknown. */
fun storesChipLine(tab: StoresTab, groups: List<StoreGroupUi>): String {
    var total = 0L
    for (item in groups.flatMap { it.items }) {
        val n = item.count.replace(",", "").trim().toLongOrNull() ?: return "$UNKNOWN ${storesNoun(tab)}"
        total += n
    }
    return "$total ${storesNoun(tab)}"
}

private fun storesNoun(tab: StoresTab): String = when (tab) {
    StoresTab.BAG -> "in your bag"
    StoresTab.MATERIALS -> "materials"
    StoresTab.KITS -> "kits"
    StoresTab.COLLECTION -> "in your collection"
}

/** "×3", or "…" while unknown (never "0" for an unknown count). */
fun storesCount(count: String): String = if (count.isBlank() || count == UNKNOWN) UNKNOWN else "×$count"

/** The STORES footer layout (SPEC E1.1): blue GO + gold USE, a full-width blue GO alone, or nothing. */
enum class StoresFooter { GO_AND_USE, GO_ONLY, USE_ONLY, NONE }

fun storesFooter(primary: CommandUi?, go: CommandUi?): StoresFooter = when {
    primary != null && go != null -> StoresFooter.GO_AND_USE
    go != null -> StoresFooter.GO_ONLY
    primary != null -> StoresFooter.USE_ONLY
    else -> StoresFooter.NONE
}

// ---- Keep EXPAND (E1.2) ----

/** What the EXPAND footer shows. */
enum class ExpandPrimaryKind {
    /** All expansions bought: no band, no pill, no EXPAND. */
    HIDDEN,
    /** Read-only base / no deed: EXPAND off with the server reason. */
    READ_ONLY,
    /** A lost answer: "Being checked · the land grows when the realm confirms it" + CHECK. */
    CHECK,
    /** The money sequence after the Seal (Check wallet → Sending → SENT / RETRY). */
    MONEY,
    /** Keep too low: charcoal padlock "Needs Keep Lv 14" + blue GO KEEP UPGRADE. */
    LOCKED,
    /** Price unavailable: EXPAND off + "Expansion price unavailable". */
    UNAVAILABLE,
    /** SOL short: the pill is SHORT and opens Need-more; never auto-spends. */
    NEED_MORE,
    /** Gold EXPAND (OK or CHECKING: CHECKING is navigation into the Seal, which re-quotes). */
    EXPAND,
}

fun expandPrimary(ui: ExpandUi): ExpandPrimaryKind = when {
    ui.sizeNext == null || ui.index >= ui.max -> ExpandPrimaryKind.HIDDEN
    ui.readOnly != null -> ExpandPrimaryKind.READ_ONLY
    ui.saved?.uncertain == true -> ExpandPrimaryKind.CHECK
    ui.saved != null && ui.saved.stage != MoneyStage.READY -> ExpandPrimaryKind.MONEY
    ui.reqKeepLevel != null && ui.keepLevel < ui.reqKeepLevel -> ExpandPrimaryKind.LOCKED
    else -> when (priceTap(ui.price)) {
        PriceTap.OPEN -> ExpandPrimaryKind.EXPAND
        PriceTap.NEED_MORE -> ExpandPrimaryKind.NEED_MORE
        PriceTap.EXPLAIN -> ExpandPrimaryKind.UNAVAILABLE
    }
}

/** One row of the "WHAT YOU GET" table. */
data class ExpandRow(val icon: String, val label: String, val now: String?, val after: String)

/**
 * The table (SPEC E1.2): Land size "14×14 ▸ 16×16", Room to build "+60 tiles" (the new ring's area), Trees and rocks to
 * clear "+9" ("…" unknown), Next one "at Keep Lv 14". Full size keeps Land size only. The sheet says "room to build",
 * never "more buildings": building counts are capped by Keep level, not by land.
 */
fun expandRows(ui: ExpandUi): List<ExpandRow> {
    val now = "${ui.sizeNow}×${ui.sizeNow}"
    val next = ui.sizeNext ?: return listOf(ExpandRow(LAND_ICON, "Land size", null, now))
    val room = ui.newTiles ?: (next * next - ui.sizeNow * ui.sizeNow)
    return listOfNotNull(
        ExpandRow(LAND_ICON, "Land size", now, "${next}×${next}"),
        ExpandRow("layout", "Room to build", null, "+$room tiles"),
        ExpandRow("shards", "Trees and rocks to clear", null, ui.obstaclesInRing?.let { "+$it" } ?: UNKNOWN),
        ui.nextReqKeepLevel?.let { ExpandRow("ui_portrait_keep_t3", "Next one", null, "at Keep Lv $it") },
    )
}

private const val LAND_ICON = "map"

/** The header tag: "KEEP LV 12 ✓" (green) when the Keep is high enough, else "Needs Keep Lv 14" (ink-2). */
data class KeepTag(val text: String, val met: Boolean)

fun expandKeepTag(ui: ExpandUi): KeepTag {
    val req = ui.reqKeepLevel
    return if (req == null || ui.keepLevel >= req) KeepTag("KEEP LV ${ui.keepLevel} ✓", true) else KeepTag("Needs Keep Lv $req", false)
}

/** "1 OF 6" on the header well (expansions done so far, the next one counted). */
fun expandIndexTag(index: Int, max: Int): String = if (index >= max) "$max OF $max" else "${index + 1} OF $max"

// ---- Shared ----

/** The currency word used on GET buttons ("GET SHARDS"). */
fun getLabel(currency: Currency): String = "GET ${currencyName(currency).uppercase()}"
