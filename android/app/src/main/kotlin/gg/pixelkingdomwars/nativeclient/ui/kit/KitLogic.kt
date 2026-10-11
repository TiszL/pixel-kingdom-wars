package gg.pixelkingdomwars.nativeclient.ui.kit

import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.ToastUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import java.util.Locale

/*
 * The pure rules behind the kit (no Compose): what a price, badge or count reads as, how the toast queue merges, when a
 * seal accepts, how the money button looks per stage, where the primary command sits, and the stepped-corner polygon.
 * JVM-tested in `KitLogicTest`; composables only call these.
 */

/** The ellipsis every unknown value renders as (DESIGN-SYSTEM §9). Never "0". */
const val UNKNOWN = "…"

/** A count badge's text: null for nothing to show (≤ 0), "99+" above 99. */
fun badgeCount(count: Int): String? = when {
    count <= 0 -> null
    count > 99 -> "99+"
    else -> count.toString()
}

/** The GameArt name of a currency's 24 px icon; an ITEM price must carry its own [override]. */
fun currencyIcon(currency: Currency, override: String? = null): String = override ?: when (currency) {
    Currency.SHARDS -> "shards"
    Currency.GEMS -> "gem"
    Currency.KEEP -> "keep"
    Currency.SKR -> "skr"
    Currency.SOL -> "sol"
    Currency.ITEM -> "shape:unknown"
}

/** A currency's spoken name. */
fun currencyName(currency: Currency): String = when (currency) {
    Currency.SHARDS -> "Shards"
    Currency.GEMS -> "Gems"
    Currency.KEEP -> "KEEP"
    Currency.SKR -> "SKR"
    Currency.SOL -> "SOL"
    Currency.ITEM -> "items"
}

/**
 * What a cost pill reads (DESIGN-SYSTEM §6 CostPill, M48 rule): CHECKING is "…", UNAVAILABLE is "unavailable", a
 * missing amount is "…", and "0" appears only when the server said zero.
 */
fun priceText(price: PriceUi): String = when (price.status) {
    PriceStatus.CHECKING -> UNKNOWN
    PriceStatus.UNAVAILABLE -> "unavailable"
    PriceStatus.SERVER_ZERO -> price.amount ?: "0"
    PriceStatus.OK, PriceStatus.SHORT -> price.amount?.takeIf { it.isNotBlank() } ?: UNKNOWN
}

/** What a screen reader says for a price. */
fun priceDescription(price: PriceUi): String = price.description ?: run {
    val name = currencyName(price.currency)
    when (price.status) {
        PriceStatus.CHECKING -> "$name price: checking"
        PriceStatus.UNAVAILABLE -> "$name price unavailable"
        PriceStatus.SHORT -> "Costs ${priceText(price)} $name, not enough"
        PriceStatus.SERVER_ZERO, PriceStatus.OK -> "Costs ${priceText(price)} $name"
    }
}

/**
 * A HUD readout value in at most 6 glyphs (DESIGN-SYSTEM §6 ResourceChip content rule): "40,943", "123.4K", "1.2M".
 * Rounds down, so a readout never shows more than the player has. Null is "…".
 */
fun readoutValue(value: Long?): String {
    if (value == null) return UNKNOWN
    if (value < 0) return "-" + readoutValue(-value)
    return when {
        value < 100_000 -> String.format(Locale.US, "%,d", value)
        value < 1_000_000 -> scaled(value, 1_000, "K")
        value < 1_000_000_000 -> scaled(value, 1_000_000, "M")
        else -> scaled(value, 1_000_000_000, "B")
    }
}

/** A drawer tile count in at most 4 glyphs: "120", "2K", "2.5K", "48K", "1.2M". Rounds down. Null is "…". */
fun tileCount(value: Long?): String {
    if (value == null) return UNKNOWN
    if (value < 0) return "-" + tileCount(-value)
    return when {
        value < 1_000 -> value.toString()
        value < 10_000 -> scaled(value, 1_000, "K")
        value < 1_000_000 -> "${value / 1_000}K"
        value < 10_000_000 -> scaled(value, 1_000_000, "M")
        value < 1_000_000_000 -> "${value / 1_000_000}M"
        else -> "${value / 1_000_000_000}B"
    }
}

/** value / unit with one truncated decimal, dropping ".0". */
private fun scaled(value: Long, unit: Long, suffix: String): String {
    val tenths = value / (unit / 10)
    val whole = tenths / 10
    val frac = tenths % 10
    return if (frac == 0L) "$whole$suffix" else "$whole.$frac$suffix"
}

private val GROUPED = Regex("^\\d{1,3}(,\\d{3})*$")
private val PLAIN = Regex("^\\d+$")

/**
 * The text a readout shows [t] (0..1) of the way through its 600 ms count-up from [from] to [to]. Only plain or
 * comma-grouped whole numbers count up; anything else ("312.5", "1.2M", "…") switches straight to [to].
 */
fun countUpText(from: String, to: String, t: Float): String {
    if (t >= 1f || from == to) return to
    val grouped = GROUPED.matches(to)
    if (!(grouped || PLAIN.matches(to)) || !(GROUPED.matches(from) || PLAIN.matches(from))) return to
    val a = from.replace(",", "").toLongOrNull() ?: return to
    val b = to.replace(",", "").toLongOrNull() ?: return to
    val k = t.coerceIn(0f, 1f).toDouble()
    val v = a + ((b - a) * k).toLong()
    return if (grouped) String.format(Locale.US, "%,d", v) else v.toString()
}

/** Toast queue rules (DESIGN-SYSTEM §6 Toast): the same key merges, at most [PkwTokens.Budget.MAX_TOASTS], 4 s each. */
object ToastQueue {
    /** Posts [toast] at [nowMs]: a toast with the same key is replaced in place and its timer restarts; otherwise it is
     *  appended and the oldest are dropped beyond [max]. */
    fun post(current: List<ToastUi>, toast: ToastUi, nowMs: Long, max: Int = PkwTokens.Budget.MAX_TOASTS): List<ToastUi> {
        val index = current.indexOfFirst { it.key == toast.key }
        if (index >= 0) {
            val merged = toast.copy(postedAtMs = nowMs, revision = current[index].revision + 1)
            return current.toMutableList().also { it[index] = merged }
        }
        return (current + toast.copy(postedAtMs = nowMs)).takeLast(max.coerceAtLeast(1))
    }

    /** Drops the toasts whose hold has passed at [nowMs]. */
    fun expire(current: List<ToastUi>, nowMs: Long, holdMs: Int = PkwTokens.Motion.TOAST_HOLD): List<ToastUi> =
        current.filter { nowMs - it.postedAtMs < holdMs }

    /** When the next toast expires, or null when the queue is empty: the host's single timer. */
    fun nextExpiry(current: List<ToastUi>, holdMs: Int = PkwTokens.Motion.TOAST_HOLD): Long? =
        current.minOfOrNull { it.postedAtMs + holdMs }
}

/** How far (0..1) a seal raised at [armedAtMs] has armed at [nowMs]. */
fun sealArmFraction(nowMs: Long, armedAtMs: Long, armMs: Int = PkwTokens.Motion.SEAL_ARM): Float =
    ((nowMs - armedAtMs).toFloat() / armMs).coerceIn(0f, 1f)

/** Whether a seal's primary accepts a tap at [nowMs] (DESIGN-SYSTEM §6 Seal: it arms over 450 ms first). */
fun sealAccepts(nowMs: Long, armedAtMs: Long, armMs: Int = PkwTokens.Motion.SEAL_ARM): Boolean = nowMs - armedAtMs >= armMs

/** How a money button looks at one stage. [sentence] = VT text without outline; [dots] = the busy dots. */
data class MoneyLook(val verb: Verb, val text: String, val sentence: Boolean, val dots: Boolean, val accepts: Boolean)

/** The money sequence (DESIGN-SYSTEM §6): gold label → stone "Check wallet" → stone dots "Sending" → moss SENT, or red
 *  RETRY. Only READY and FAILED take a tap; nothing can be sent twice from the button. */
fun moneyLook(stage: MoneyStage, label: String, retryLabel: String = "RETRY"): MoneyLook = when (stage) {
    MoneyStage.READY -> MoneyLook(Verb.GOLD, label, sentence = false, dots = false, accepts = true)
    MoneyStage.CHECK_WALLET -> MoneyLook(Verb.STONE, "Check wallet", sentence = true, dots = false, accepts = false)
    MoneyStage.SENDING -> MoneyLook(Verb.STONE, "Sending", sentence = true, dots = true, accepts = false)
    MoneyStage.SENT -> MoneyLook(Verb.MOSS, "SENT", sentence = false, dots = false, accepts = false)
    MoneyStage.FAILED -> MoneyLook(Verb.RED, retryLabel, sentence = false, dots = false, accepts = true)
}

/**
 * The command bar order (DESIGN-SYSTEM §3: INFO first, then secondaries, then the primary last under the right thumb):
 * the given order is kept, the one primary moves to the end, a second primary is demoted, and the bar never exceeds
 * [max] commands (the primary is always kept).
 */
fun orderCommands(commands: List<CommandUi>, max: Int = PkwTokens.Budget.MAX_COMMANDS): List<CommandUi> {
    val primary = commands.firstOrNull { it.primary }
    val rest = commands.filter { it !== primary }.map { if (it.primary) it.copy(primary = false) else it }
    return if (primary == null) rest.take(max) else rest.take((max - 1).coerceAtLeast(0)) + primary
}

/** The two stepped corner profiles (DESIGN-SYSTEM §4 Shape), as (x, y) dp pairs from the left edge to the top edge of
 *  the top-left corner. S cuts 4 dp in 2 steps; M cuts 8 dp in 3 steps (common.css `--px-s` / `--px-m`). */
object CornerProfiles {
    val S = floatArrayOf(0f, 4f, 2f, 4f, 2f, 2f, 4f, 2f, 4f, 0f)
    val M = floatArrayOf(0f, 8f, 2f, 8f, 2f, 4f, 4f, 4f, 4f, 2f, 8f, 2f, 8f, 0f)
    /** The left edge of an edge tab is square; only its screen-side (right) corners are cut. */
    val NONE = floatArrayOf(0f, 0f)
}

/**
 * The closed polygon (x0, y0, x1, y1, …) of a [width] × [height] box whose four corners are cut by [profile] (a
 * top-left corner profile, mirrored to the other three). A box smaller than two corners scales the profile down so the
 * outline never crosses itself.
 */
fun steppedPolygon(width: Float, height: Float, profile: FloatArray): FloatArray {
    require(profile.size >= 2 && profile.size % 2 == 0) { "profile must be (x, y) pairs" }
    val n = profile.size / 2
    val cut = maxOf(profile.maxOrNull() ?: 0f, 0f)
    val k = if (cut <= 0f) 1f else minOf(1f, width / (2 * cut), height / (2 * cut)).coerceAtLeast(0f)
    val out = FloatArray(n * 8)
    var i = 0
    fun add(x: Float, y: Float) { out[i++] = x; out[i++] = y }
    fun px(j: Int) = profile[2 * j] * k
    fun py(j: Int) = profile[2 * j + 1] * k
    for (j in 0 until n) add(px(j), py(j))
    for (j in n - 1 downTo 0) add(width - px(j), py(j))
    for (j in 0 until n) add(width - px(j), height - py(j))
    for (j in n - 1 downTo 0) add(px(j), height - py(j))
    return out
}

/** The scrim alpha of a sheet size (TOKENS.json `color.scrim`): a half sheet has none. */
fun sheetScrimAlpha(size: gg.pixelkingdomwars.nativeclient.ui.model.SheetSize): Float = when (size) {
    gg.pixelkingdomwars.nativeclient.ui.model.SheetSize.HALF -> PkwTokens.Scrim.SHEET_HALF
    gg.pixelkingdomwars.nativeclient.ui.model.SheetSize.TALL -> PkwTokens.Scrim.SHEET_TALL
    gg.pixelkingdomwars.nativeclient.ui.model.SheetSize.FULL -> PkwTokens.Scrim.FULL_CARD
}

/**
 * The whole number of device pixels per art pixel nearest to fitting [art] art px into [targetPx] device px (at least
 * 1): pixel art only ever draws at an integer scale (DESIGN-SYSTEM §4 Pixel art). Nearest, not floor: on the Seeker
 * (2.625 px per dp) a 24 px icon in a 24 dp box draws at 3× (27 dp), not 2× (18 dp); the art may overhang its box by
 * under half a step, centred.
 */
fun integerArtScale(targetPx: Float, art: Int): Int = if (art <= 0) 1 else maxOf(1, (targetPx / art + 0.5f).toInt())

// ---- Kit successor (2026-10-03; MS-M receipt 744b8482, design ruling 092decf3 and 5ed31eb8). Additive only. ----

/** A canonical amount split into its whole digits (no leading zeros, "0" for none) and fraction digits (no trailing
 *  zeros), plus its sign. Null when the text is not a canonical decimal. */
private data class DecimalParts(val negative: Boolean, val whole: String, val fraction: String) {
    val isZero: Boolean get() = whole == "0" && fraction.isEmpty()
}

private val CANONICAL_DECIMAL = Regex("^([+-]?)(\\d*)(?:\\.(\\d*))?$")

/**
 * Reads [amount] as a canonical decimal string ("40943", "312.5") or, with [decimals] > 0, a base-unit integer string
 * ("312500000" with 6 decimals = 312.5) and shifts it by [decimals] places, all by string arithmetic: no Long, no
 * floating point, any length. Commas, spaces, exponents and blank text are not canonical and give null.
 */
private fun decimalParts(amount: String?, decimals: Int): DecimalParts? {
    if (amount == null || decimals < 0) return null
    val match = CANONICAL_DECIMAL.matchEntire(amount.trim()) ?: return null
    val int = match.groupValues[2]
    val frac = match.groupValues[3]
    if (int.isEmpty() && frac.isEmpty()) return null
    val digits = int + frac
    val pointAt = int.length - decimals
    val whole = if (pointAt <= 0) "" else digits.take(pointAt)
    val fraction = if (pointAt <= 0) "0".repeat(-pointAt) + digits else digits.drop(pointAt)
    val w = whole.trimStart('0').ifEmpty { "0" }
    val f = fraction.trimEnd('0')
    val parts = DecimalParts(match.groupValues[1] == "-", w, f)
    return if (parts.isZero) parts.copy(negative = false) else parts
}

/** "1234567" → "1,234,567". */
private fun groupThousands(whole: String): String =
    whole.reversed().chunked(3).joinToString(",").reversed()

/** The scale suffixes a compact amount may take, smallest first: (digits dropped, suffix). */
private val COMPACT_UNITS = listOf(3 to "K", 6 to "M", 9 to "B", 12 to "T")

/**
 * A HUD / pill amount in at most [maxGlyphs] glyphs, from a canonical decimal or base-unit string (see [decimalParts];
 * design ruling 092decf3 item 2). Decimal-safe: no Long and no float, so SKR / KEEP / SOL base units of any size and
 * any number of decimals are exact. It always rounds DOWN, so a readout never shows more than the player has:
 * - unknown, blank or not canonical → "…" ([UNKNOWN]); never "0";
 * - exactly zero → "0";
 * - tiny but not zero (below 0.01) → "<0.01";
 * - below 1 → up to two decimals ("0.5", "0.12");
 * - when the grouped whole number fits → "40,943", with up to two decimals while they still fit ("312.5", "12.34");
 * - otherwise the largest of K / M / B / T that leaves 1-3 whole digits, with one decimal when it fits and is not 0
 *   ("123.4K", "1.2M", "1M"; at 4 glyphs "48K"). Above 999T the T figure grows past the cap rather than lie.
 * For whole numbers this matches [readoutValue] (6 glyphs) and [tileCount] (4 glyphs) exactly.
 */
fun compactAmount(amount: String?, decimals: Int = 0, maxGlyphs: Int = 6): String {
    val parts = decimalParts(amount, decimals) ?: return UNKNOWN
    if (parts.isZero) return "0"
    val sign = if (parts.negative) "-" else ""
    val whole = parts.whole
    val fraction = parts.fraction
    if (whole == "0") {
        val two = fraction.take(2).padEnd(2, '0')
        if (two == "00") return sign + "<0.01"
        return sign + "0." + two.trimEnd('0')
    }
    val grouped = groupThousands(whole)
    if (grouped.length <= maxGlyphs) {
        val room = maxGlyphs - grouped.length - 1
        val shown = if (room <= 0) "" else fraction.take(minOf(2, room)).trimEnd('0')
        return sign + if (shown.isEmpty()) grouped else "$grouped.$shown"
    }
    val (drop, suffix) = COMPACT_UNITS.lastOrNull { whole.length > it.first } ?: COMPACT_UNITS.first()
    val head = whole.dropLast(drop)
    val tenth = whole[whole.length - drop]
    val withTenth = "$head.$tenth$suffix"
    val plain = "$head$suffix"
    return sign + if (tenth != '0' && withTenth.length <= maxGlyphs) withTenth else plain
}

/**
 * The exact amount for a screen reader and for the drawer's info card ([gg.pixelkingdomwars.nativeclient.ui.model
 * .ResourceChipUi.exactDescription]): every digit, grouped, trailing fraction zeros dropped ("1,234,567.000001").
 * Unknown or not canonical → "…". String arithmetic only.
 */
fun exactAmount(amount: String?, decimals: Int = 0): String {
    val parts = decimalParts(amount, decimals) ?: return UNKNOWN
    val sign = if (parts.negative) "-" else ""
    val grouped = groupThousands(parts.whole)
    return sign + if (parts.fraction.isEmpty()) grouped else "$grouped.${parts.fraction}"
}

/** Sheet geometry on the 412 × 915 reference phone, in dp (DESIGN-SYSTEM §6 Sheet; design ruling 092decf3 item 3). */
object SheetGeometry {
    /** A TALL sheet runs from y 104 to the screen bottom. */
    const val TALL_TOP_DP = 104
    /** A FULL sheet runs from y 60 to 14 dp above the gesture inset. */
    const val FULL_TOP_DP = 60
    const val FULL_BOTTOM_DP = 14
    /** The default living header and the Gold Forge hero header. */
    const val HEADER_DP = 136
    const val GOLD_FORGE_HEADER_DP = 204
}

/** The top and bottom gaps (dp) a sheet of [size] keeps on screen, the bottom including [gestureInsetDp]; null for a
 *  HALF sheet, which wraps its content from the bottom (≤ 50 % of the height) and has no fixed top. */
fun sheetEdgesDp(size: gg.pixelkingdomwars.nativeclient.ui.model.SheetSize, gestureInsetDp: Int): Pair<Int, Int>? = when (size) {
    gg.pixelkingdomwars.nativeclient.ui.model.SheetSize.HALF -> null
    gg.pixelkingdomwars.nativeclient.ui.model.SheetSize.TALL -> SheetGeometry.TALL_TOP_DP to gestureInsetDp.coerceAtLeast(0)
    gg.pixelkingdomwars.nativeclient.ui.model.SheetSize.FULL ->
        SheetGeometry.FULL_TOP_DP to SheetGeometry.FULL_BOTTOM_DP + gestureInsetDp.coerceAtLeast(0)
}

/**
 * The state a command or primary is DRAWN in after its price (design correction 7, design ruling 5ed31eb8 item 2):
 * - a CHECKING price stays ENABLED: it is navigation into the existing review sheet (no quote, signing or mutation);
 * - an UNAVAILABLE price draws DISABLED (with the command's reason);
 * - a SHORT price draws SHORT (red pill; the tap opens the review or Need-more sheet).
 * Any state other than ENABLED is kept as the mapper set it (BUSY, LOCKED, DISABLED, SHORT).
 */
fun commandDrawState(ui: CommandUi): gg.pixelkingdomwars.nativeclient.ui.model.CommandState {
    if (ui.state != gg.pixelkingdomwars.nativeclient.ui.model.CommandState.ENABLED) return ui.state
    return when (ui.price?.status) {
        PriceStatus.UNAVAILABLE -> gg.pixelkingdomwars.nativeclient.ui.model.CommandState.DISABLED
        PriceStatus.SHORT -> gg.pixelkingdomwars.nativeclient.ui.model.CommandState.SHORT
        else -> gg.pixelkingdomwars.nativeclient.ui.model.CommandState.ENABLED
    }
}

/** What the caller does with a command tap (see [commandRoute]). */
enum class CommandRoute {
    /** Run or open it (ENABLED, including a CHECKING price: navigation only). */
    OPEN,
    /** Open the review / Need-more sheet with where to earn the shortfall; never auto-spend (SHORT). */
    NEED_MORE,
    /** Show the reason (DISABLED, an UNAVAILABLE price, or LOCKED: the reason sheet). The locked PRIMARY keeps its
     *  visual primary designation; executability is only this state (design ruling 5ed31eb8 item 3). */
    EXPLAIN,
    /** Nothing: BUSY never calls back, so nothing can be sent twice. */
    IGNORE,
}

/** Where a tap on [ui] goes, from [commandDrawState]. */
fun commandRoute(ui: CommandUi): CommandRoute = when (commandDrawState(ui)) {
    gg.pixelkingdomwars.nativeclient.ui.model.CommandState.ENABLED -> CommandRoute.OPEN
    gg.pixelkingdomwars.nativeclient.ui.model.CommandState.SHORT -> CommandRoute.NEED_MORE
    gg.pixelkingdomwars.nativeclient.ui.model.CommandState.DISABLED,
    gg.pixelkingdomwars.nativeclient.ui.model.CommandState.LOCKED -> CommandRoute.EXPLAIN
    gg.pixelkingdomwars.nativeclient.ui.model.CommandState.BUSY -> CommandRoute.IGNORE
}

/**
 * The one sentence after a spend that did not complete (design correction 7, design ruling 5ed31eb8 item 5). Only an
 * [authoritative] refusal (the server or the wallet answered no) may say that nothing was spent; a timeout or a lost
 * answer says it is being checked, and the caller keeps the existing recovery surface until the outcome is known.
 */
fun outcomeLine(action: String, authoritative: Boolean, serverReason: String? = null): String {
    if (!authoritative) return "Checking whether the $action went through."
    val why = serverReason?.trim()?.trimEnd('.')?.takeIf { it.isNotEmpty() }
    return if (why == null) "The $action didn't happen. Nothing was spent." else "$why. Nothing was spent."
}

/**
 * The [KIT_GLYPHS] key a `shape:<name>` icon draws: the name itself, a registry alias ([GLYPH_ALIASES]: `envelope`,
 * `speech`, `chevron-up`), or "unknown" (the visible "?" glyph) for anything else, so a missing shape never draws
 * nothing. Accepts the name with or without the `shape:` prefix.
 */
fun glyphKey(name: String): String {
    val bare = name.removePrefix("shape:")
    val key = GLYPH_ALIASES[bare] ?: bare
    return if (KIT_GLYPHS.containsKey(key)) key else "unknown"
}
