package gg.pixelkingdomwars.nativeclient.ui.sheets.account.live

import gg.pixelkingdomwars.nativeclient.network.basePurchaseOffer
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.roster.RosterUiState
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.SuppliesUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.SupplyKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.SupplyOfferUi
import java.math.BigDecimal
import java.math.RoundingMode
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Presentation targets only. Existing owners still review, submit, and recover every purchase. */
internal sealed interface SupplyTarget {
    data class BasePurchase(val kind: String, val baseId: String) : SupplyTarget
    data class Item(val itemId: String) : SupplyTarget
}

internal data class SuppliesProjection(
    val ui: SuppliesUi,
    val status: String?,
    val ready: Boolean,
    val targets: Map<String, SupplyTarget>,
)

private fun JsonObject.text(key: String): String? = (get(key) as? JsonPrimitive)?.content
private fun positiveKeep(value: String?): String? = value?.takeIf { it.matches(Regex("[1-9][0-9]{0,31}")) }
private fun wholeBalance(value: String?) = value?.takeIf { it.matches(Regex("0|[1-9][0-9]{0,31}")) }?.toBigIntegerOrNull()

/** Catalogue values are converted only for display. No Gems rail, fixed offer tiers, or wallet balance is inferred. */
internal fun projectSupplies(
    state: RosterUiState,
    wallet: String,
    baseId: String?,
    current: Boolean,
    busy: Boolean,
    refreshed: Boolean,
    selectedId: String?,
    tabs: List<TabUi>,
    readError: String? = null,
): SuppliesProjection {
    val base = state.home.base
    val admitted = current && wallet.isNotBlank() && !baseId.isNullOrBlank() && base != null && base.baseId == baseId &&
        (base.player.wallet == null || base.player.wallet == wallet)
    val empty = SuppliesUi(tabs, "…/…", false, null, null, null, null, emptyList(), null,
        catalogueReady = false, inventorySectionLabel = "ITEMS")
    if (!current || !refreshed || !admitted) return SuppliesProjection(empty,
        when {
            !current -> "Your account or kingdom changed. Open Supplies again."
            !refreshed -> "Loading supplies for this kingdom…"
            state.home.error != null -> state.home.error
            base == null -> "Your kingdom is loading…"
            else -> "Refresh supplies for the selected kingdom."
        }, false, emptyMap())
    requireNotNull(base)
    val inventory = state.domain.inventory
    val catalogue = state.catalogue
    val failure = listOfNotNull(state.home.error, state.domain.error, readError).distinct().joinToString("\n").ifEmpty { null }
    val loading = busy || state.home.loading || state.domain.loading
    val blocking = when {
        failure != null -> failure
        loading -> "Refreshing supplies…"
        catalogue == null -> "Verified game prices are unavailable. Refresh supplies."
        inventory == null -> "Item catalogue is unavailable. Refresh supplies."
        !state.ordersAllowed -> "Install the available app update before buying supplies."
        else -> null
    }
    val ready = blocking == null
    val offers = mutableListOf<SupplyOfferUi>()
    val targets = mutableMapOf<String, SupplyTarget>()
    val unavailableKinds = mutableListOf<String>()
    val constants = catalogue?.get("constants") as? JsonObject
    val caps = constants?.get("CAPS") as? JsonObject
    val buildersMax = caps?.text("buildersMax")?.toIntOrNull()?.takeIf { it > 0 }
    val builders = base.player.builders?.takeIf { it >= 0 }
    val buildersMaxed = builders != null && buildersMax != null && builders >= buildersMax
    val kinds = buildList {
        add("shield")
        if ((base.raw["warzone"] as? JsonObject)?.text("active") == "true") add("warzone_shield")
        add("builder")
        add("energy"); add("energy_pack")
    }
    for (kind in kinds) {
        if (kind == "builder" && buildersMaxed) {
            // SPEC §3 "builder at max → MAX tag": the row stays visible and locked, with no price and no purchase target.
            offers += SupplyOfferUi("base:builder", SupplyKind.BUILDER, "HIRE A BUILDER", "Paid once", "builder",
                PriceUi(Currency.SOL, null, PriceStatus.UNAVAILABLE), "BUY HIRE A BUILDER", null,
                lockedReason = "All builders hired", tag = "MAX")
            continue
        }
        val offer = catalogue?.let { basePurchaseOffer(it, base, kind) }
        if (offer == null || offer.amountLamports.toBigIntegerOrNull()?.signum() != 1) {
            unavailableKinds += kind
            continue
        }
        val price = BigDecimal(offer.amountLamports).movePointLeft(9).stripTrailingZeros().toPlainString()
        val title = when (kind) {
            "shield" -> "SHIELD EXTENSION"
            "warzone_shield" -> "WARZONE SHIELD"
            "builder" -> "HIRE A BUILDER"
            "energy_pack" -> "RAID ENERGY PACK"
            else -> "RAID ENERGY"
        }
        val effect = when (kind) {
            "shield", "warzone_shield" -> "Adds ${fmtDur(requireNotNull(offer.seconds).toLong())}"
            "builder" -> "Paid once"
            else -> "+${requireNotNull(offer.energyQuantity)} raid energy"
        }
        val supplyKind = when (kind) {
            "shield", "warzone_shield" -> SupplyKind.SHIELD
            "builder" -> SupplyKind.BUILDER
            else -> SupplyKind.ENERGY
        }
        val id = "base:$kind"
        offers += SupplyOfferUi(id, supplyKind, title, effect,
            when (supplyKind) { SupplyKind.SHIELD -> "itm_shield"; SupplyKind.BUILDER -> "builder"; else -> "energy" },
            PriceUi(Currency.SOL, price, PriceStatus.OK, description = "$price SOL. The purchase owner checks your wallet."),
            "BUY $title", "$price SOL · $effect", lockedReason = blocking)
        targets[id] = SupplyTarget.BasePurchase(kind, offer.baseId)
    }
    val keep = wholeBalance(state.home.balances?.keep)
    for (item in state.purchasable) {
        val price = positiveKeep(item.costKeep)
        val maxed = item.maxOwned?.let { max -> inventory != null && inventory.quantity(item.id) >= max } == true
        val short = price != null && keep != null && keep < price.toBigInteger()
        val reason = when {
            price == null -> "Price unavailable right now"
            blocking != null -> blocking
            state.itemsBlocked -> "Check your saved item request before buying again."
            maxed -> "Item limit reached"
            keep == null -> "Refresh your KEEP balance before buying."
            else -> null
        }
        val id = "item:${item.id}"
        val title = item.name?.takeIf { it.isNotBlank() } ?: item.id
        val owned = inventory?.quantity(item.id)
        val effect = listOfNotNull(item.text.takeIf { it.isNotBlank() }, owned?.let { "Owned: $it" },
            item.maxOwned?.let { "Limit: $it" }).joinToString(" · ")
        // The footer sub reads "{price} · {effect}" like the SOL rows (shop.png "150 Gems · shield becomes 52h").
        offers += SupplyOfferUi(id, SupplyKind.BOOST, title, effect, item.asset ?: "shop",
            PriceUi(Currency.KEEP, price, when { price == null -> PriceStatus.UNAVAILABLE; short -> PriceStatus.SHORT; else -> PriceStatus.OK }),
            "BUY ${title.uppercase()}", price?.let { listOfNotNull("$it KEEP", item.text.takeIf { text -> text.isNotBlank() }).joinToString(" · ") },
            lockedReason = reason, tag = if (maxed) "MAX" else null)
        if (price != null) targets[id] = SupplyTarget.Item(item.id)
    }
    val energy = base.energy
    val energyMax = energy?.max?.takeIf { it > 0 }
    val energyNow = energy?.used?.takeIf { energyMax != null && it in 0..energyMax }?.let { energyMax!! - it }
    val free = base.freeBuilders.takeIf { base.raw.containsKey("freeBuilders") && builders != null && it in 0..builders }
    val shield = base.raw["shield"] as? JsonObject
    val shieldMillis = shield?.text("remainingMs")?.toBigDecimalOrNull()
        ?: shield?.text("hoursLeft")?.toBigDecimalOrNull()?.multiply(BigDecimal(3_600_000))
    val shieldSeconds = shieldMillis?.takeIf { it.signum() >= 0 }?.let {
        runCatching { it.divide(BigDecimal(1_000), 0, RoundingMode.CEILING).longValueExact() }.getOrNull()
    }
    val shieldLeft = shieldSeconds?.let {
        "${if (shield?.text("suppressedByWarzone") == "true") "suppressed · " else ""}${fmtDur(it)} at refresh"
    }
    val complete = ready && unavailableKinds.isEmpty()
    // The frame's section is BOOSTS with "None on sale today / New boosts show up here" when the server lists nothing. A
    // live list also holds gear and contracts, so a non-empty section keeps the honest ITEMS label.
    val sectionLabel = if (state.purchasable.isEmpty()) "BOOSTS" else "ITEMS"
    return SuppliesProjection(SuppliesUi(tabs, "${free ?: "…"}/${builders ?: "…"}", free != null,
        shieldLeft, builders?.let { "$it hired" }, energyNow, energyMax, offers,
        selectedId?.takeIf { chosen -> offers.any { it.id == chosen } } ?: offers.firstOrNull()?.id,
        catalogueReady = complete, inventorySectionLabel = sectionLabel),
        blocking ?: unavailableKinds.takeIf { it.isNotEmpty() }?.let { "Some supply prices are unavailable. Refresh to check them." },
        ready, targets)
}

/** Re-project immediately at tap time. A stale rendered offer cannot select a changed price or another owner target. */
internal fun suppliesBuyTarget(displayed: SuppliesProjection, current: SuppliesProjection, id: String): SupplyTarget? {
    if (!displayed.ready || !current.ready) return null
    val row = current.ui.offers.singleOrNull { it.id == id } ?: return null
    val shown = displayed.ui.offers.singleOrNull { it.id == id } ?: return null
    if (row != shown || row.lockedReason != null || row.price.status != PriceStatus.OK) return null
    val target = current.targets[id] ?: return null
    return target.takeIf { it == displayed.targets[id] }
}
