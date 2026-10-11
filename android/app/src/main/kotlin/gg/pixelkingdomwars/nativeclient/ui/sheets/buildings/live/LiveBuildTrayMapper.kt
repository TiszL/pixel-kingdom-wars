package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.data.HeroRecruitmentState
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kingdom.priceLabel
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.compactAmount
import gg.pixelkingdomwars.nativeclient.ui.kit.exactAmount
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.PRICE_UNAVAILABLE
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.SAVED_BUILD_PAYMENT
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BUILDING_UNAVAILABLE
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.UPDATING_BUILD_PRICES
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildCardState
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildCardUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildSectionUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildTrayUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.CardTap
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.NeedMoreUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.TRAY_POWDER_ICON
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.cardTap

/*
 * TrayFacts -> BuildTrayUi (the BUILD tray, SPEC §3). Pure.
 *
 * Realm Trade discovery stays visible independently of construction admission. The Keep gate (`requiresKeepLevel`),
 * count contract (`buildCountPresentation`) and prices come from the current catalogue/server. Six tabs in SPEC order:
 * BUILDINGS · DEFENCES · TRAPS · HEROES · SUPPLIES · LAYOUTS. Traps have their own tab (they left DEFENCES). HEROES draws
 * the hero recruitment offers as cards in place when the host has the recruitment state ([liveHeroTray]); without it the
 * tab stays the old recruitment door. LAYOUTS stays the layout editor's door. SHORT is only claimed for a SHARDS price
 * against a known Shards balance; a KEEP-priced card (the second Mine) keeps its price as today and its placement stays
 * on the current dialog (see LivePlacementMapper). NEW marks a type the current Keep level just unlocked and nobody has
 * built ([newlyUnlockedBuildTypes]); there is no "seen" store yet, so NEW lasts until it is built or the Keep moves on.
 */

/** The BUILD tray's sections (presentation grouping of the current two lists). */
internal enum class TrayGroup { ECONOMY, ARMY, CLAN, REALM, DEFENCE, TRAP, WALL }

/** Design identities/order from buildings/build.png; no client cost, cap, unlock or mutation rule. */
internal val realmTradeBuildingTypes = listOf("workshop", "lodge", "berth", "harvester", "market", "goldforge")

/** Short authored card prose from build.png; Workshop keeps the current Codex's Shards/Forge Ingots semantics. */
internal fun realmTradePurpose(type: String): String? = when (type) {
    "workshop" -> "Refines Shards into Forge Ingots"
    "lodge" -> "Sends expeditions to the islands"
    "berth" -> "Docks and services your boats"
    "harvester" -> "Gathers your realm's raw finds"
    "market" -> "Buy and sell with other players"
    "goldforge" -> "Smelts ingots, claims KEEP"
    else -> null
}

/** One discovery card; presentation alone never grants construction permission. */
internal data class TrayCardFact(
    val type: String,
    /** `trayLabel(type)`. */
    val name: String,
    /** The Codex `who` line; blank when none. */
    val purpose: String,
    /** Bundled discovery illustration; never a construction capability. */
    val art: String,
    /** The catalogue price currency code ("SHARDS", "KEEP"). */
    val currency: String,
    /** `fmtN(price.amount)`, as the current card prints it. */
    val amount: String,
    /** The plain decimal amount (shortfall only). */
    val amountRaw: String,
    /** `fmtDur(price.seconds)` when positive. */
    val time: String?,
    /** `BUILD_COSTS[type].requiresKeepLevel`. */
    val requiredKeep: Int?,
    val owned: Int?,
    /** `buildCountPresentation(...).max`; null when the pack has no cap table. */
    val max: Int?,
    /** Traps share one cap: how many traps of any kind are placed. */
    val familyOwned: Int?,
    val atCap: Boolean,
    val trap: Boolean,
    val group: TrayGroup,
    /** A generic availability explanation, independent of the authoritative Keep/cap presentation. */
    val unavailableReason: String? = null,
    /** False for a Phase E type outside the live construction/art admission, even when its catalogue has gates/caps. */
    val constructionAdmitted: Boolean = true,
    /** First future catalogue Keep level with room for another building; null if unknown or server-cap controlled. */
    val nextCapKeep: Int? = null,
)

/** The tray's current catalogue/base inputs. */
internal data class TrayFacts(
    val keepLevel: Int?,
    val freeBuilders: Int?,
    val totalBuilders: Int?,
    /** `home.balances.shards` (plain decimal); null while unknown. */
    val shardsBalance: String?,
    val cards: List<TrayCardFact>,
    val busy: Boolean,
)

/** The tray's tab ids (BuildTrayUi.selectedTab). */
internal object LiveTrayTabs {
    const val BUILDINGS = "BUILDINGS"
    const val DEFENCES = "DEFENCES"
    /** Traps, under their shared trap cap. */
    const val TRAPS = "TRAPS"
    /** The hero altar offers as cards (in place when the host passes the recruitment state). */
    const val HEROES = "HEROES"
    /** The whole Supplies sheet, sharing the BUILD frame and tabs. */
    const val SUPPLIES = "SUPPLIES"
    /** Not a card tab: opens the layout editor. */
    const val LAYOUTS = "LAYOUTS"
}

/** The section a type sits in. [trap] / [defence] / [phaseE] come from the catalogue lists the current tray uses. */
internal fun trayGroup(type: String, trap: Boolean, defence: Boolean, phaseE: Boolean): TrayGroup = when {
    type in realmTradeBuildingTypes || phaseE -> TrayGroup.REALM
    type == "wall" -> TrayGroup.WALL
    trap -> TrayGroup.TRAP
    defence -> TrayGroup.DEFENCE
    type == "barracks" || type == "forge" || type == "camp" -> TrayGroup.ARMY
    type == "clanhall" -> TrayGroup.CLAN
    else -> TrayGroup.ECONOMY
}

/** The six tabs in SPEC §3.1 order with the SPEC §5 icons (hammer, shield, powder charge, Vex, chest, layout). A gold NEW
 *  badge sits outside each tab in [newTabs] (a tab holding a just-unlocked building). */
internal fun liveBuildTrayTabs(newTabs: Set<String> = emptySet()): List<TabUi> {
    fun badge(id: String) = if (id in newTabs) BadgeUi("NEW", BadgeTone.REWARD, "New building to build") else null
    return listOf(
        TabUi(LiveTrayTabs.BUILDINGS, "itm_hammer", "BUILDINGS", badge(LiveTrayTabs.BUILDINGS), false),
        TabUi(LiveTrayTabs.DEFENCES, "shield", "DEFENCES", badge(LiveTrayTabs.DEFENCES), false),
        TabUi(LiveTrayTabs.TRAPS, TRAY_POWDER_ICON, "TRAPS", badge(LiveTrayTabs.TRAPS), false),
        TabUi(LiveTrayTabs.HEROES, "hero_vex_portrait", "HEROES", null, false),
        TabUi(LiveTrayTabs.SUPPLIES, "itm_chest", "SUPPLIES", null, false),
        TabUi(LiveTrayTabs.LAYOUTS, "layout", "LAYOUTS", null, false),
    )
}

private val BUILDING_GROUPS = listOf(TrayGroup.REALM, TrayGroup.ECONOMY, TrayGroup.ARMY, TrayGroup.CLAN)
private val DEFENCE_GROUPS = listOf(TrayGroup.DEFENCE, TrayGroup.WALL)
private val TRAP_GROUPS = listOf(TrayGroup.TRAP)

/** The card tab a section sits on. */
internal fun trayTabOf(group: TrayGroup): String = when (group) {
    TrayGroup.DEFENCE, TrayGroup.WALL -> LiveTrayTabs.DEFENCES
    TrayGroup.TRAP -> LiveTrayTabs.TRAPS
    TrayGroup.REALM, TrayGroup.ECONOMY, TrayGroup.ARMY, TrayGroup.CLAN -> LiveTrayTabs.BUILDINGS
}

/**
 * The types the current Keep level just opened and nobody has built yet: `requiresKeepLevel` equals the Keep level, none
 * owned, admitted for construction and not capped. Decision 2026-10-06 (no "seen" store tonight): a card stays NEW until
 * it is built or the Keep levels past it. The Home BUILD badge (mount) and the tray read this same set.
 */
internal fun newlyUnlockedBuildTypes(f: TrayFacts): Set<String> {
    val keep = f.keepLevel ?: return emptySet()
    return f.cards.filter { it.requiredKeep == keep && it.owned == 0 && it.constructionAdmitted && !it.atCap && it.unavailableReason == null }
        .map { it.type }.toSet()
}

/** The tab that holds the first NEW type (BUILD opens there, SPEC §3 entry); null when nothing is new. */
internal fun newlyUnlockedTab(f: TrayFacts): String? {
    val new = newlyUnlockedBuildTypes(f)
    return f.cards.firstOrNull { it.type in new }?.let { trayTabOf(it.group) }
}

/** The HEROES tab's cards and, when there are none, the line it shows instead (never an empty grid). */
internal data class LiveHeroTray(val cards: List<BuildCardUi>, val emptyLine: String?)

internal fun liveBuildTrayUi(f: TrayFacts, selectedTab: String, focusType: String? = null, heroes: LiveHeroTray? = null,
    newTypes: Set<String> = emptySet()): BuildTrayUi {
    val tab = when (selectedTab) {
        LiveTrayTabs.DEFENCES, LiveTrayTabs.TRAPS, LiveTrayTabs.SUPPLIES -> selectedTab
        // Without the recruitment state HEROES is still the old door, so the card grid stays on BUILDINGS.
        LiveTrayTabs.HEROES -> if (heroes != null) LiveTrayTabs.HEROES else LiveTrayTabs.BUILDINGS
        else -> LiveTrayTabs.BUILDINGS
    }
    val groups = when (tab) {
        LiveTrayTabs.DEFENCES -> DEFENCE_GROUPS
        LiveTrayTabs.TRAPS -> TRAP_GROUPS
        LiveTrayTabs.HEROES -> emptyList<TrayGroup>()
        else -> BUILDING_GROUPS
    }
    val sections = if (tab == LiveTrayTabs.HEROES && heroes != null) {
        listOf(BuildSectionUi("HEROES", "HERO ALTARS", "hero_vex_portrait",
            "${heroes.cards.size} ${if (heroes.cards.size == 1) "hero" else "heroes"}", heroes.cards))
    } else groups.map { group ->
        val cards = f.cards.filter { it.group == group }.map { buildCard(it, f, newTypes) }
        BuildSectionUi(group.name, sectionTitle(group), sectionIcon(group), "${cards.size} ${if (cards.size == 1) "building" else "buildings"}", cards)
    }
    val newTabs = f.cards.filter { it.type in newTypes }.map { trayTabOf(it.group) }.toSet() - tab
    return BuildTrayUi(
        tabs = liveBuildTrayTabs(newTabs),
        selectedTab = tab,
        builders = "${f.freeBuilders?.toString() ?: UNKNOWN}/${f.totalBuilders?.toString() ?: UNKNOWN}",
        buildersFree = f.freeBuilders?.let { it > 0 } == true,
        spend = ResourceChipUi(FeatureId("hud.shards"), "shards", compactAmount(f.shardsBalance), null, false, null, name = "Shards",
            exactDescription = f.shardsBalance?.let { "Shards ${exactAmount(it)}" } ?: ""),
        sections = sections,
        // The current tray always says how it works ("Choose a building, then tap its location"); so does this one.
        firstTimeHint = tab != LiveTrayTabs.HEROES,
        focusType = focusType,
        emptyLine = if (tab == LiveTrayTabs.HEROES && heroes != null && heroes.cards.isEmpty()) heroes.emptyLine else null,
    )
}

/** Non-admission wins: catalogue gates/caps must not promise a building the server is not offering. */
internal fun cardState(c: TrayCardFact, f: TrayFacts): BuildCardState = when {
    !c.constructionAdmitted -> BuildCardState.UNAVAILABLE
    c.requiredKeep != null && f.keepLevel != null && f.keepLevel < c.requiredKeep -> BuildCardState.LOCKED
    c.atCap -> BuildCardState.MAX
    c.unavailableReason != null -> BuildCardState.UNAVAILABLE
    c.currency.equals("SHARDS", ignoreCase = true) && shortfall(f.shardsBalance, c.amountRaw) != null -> BuildCardState.SHORT
    else -> BuildCardState.AVAILABLE
}

private fun buildCard(c: TrayCardFact, f: TrayFacts, newTypes: Set<String>): BuildCardUi {
    val state = cardState(c, f)
    val currency = currencyOf(c.currency)
    return BuildCardUi(
        type = c.type,
        name = c.name.uppercase(),
        purpose = c.purpose,
        art = c.art,
        count = when {
            c.trap && c.max != null -> "${c.familyOwned ?: 0}/${c.max}"
            c.max != null || c.group == TrayGroup.REALM -> "${c.owned?.toString() ?: UNKNOWN}/${c.max?.toString() ?: UNKNOWN}"
            else -> c.owned?.toString() ?: UNKNOWN
        },
        countTone = when (state) { BuildCardState.LOCKED -> Verb.STONE; BuildCardState.MAX -> Verb.GREEN; else -> Verb.BLUE },
        state = state,
        // A currency the kit cannot draw stays "…" (never a guessed icon or a zero).
        price = currency?.let { PriceUi(it, c.amount, PriceStatus.OK) },
        time = c.time,
        reason = when (state) {
            BuildCardState.LOCKED -> "Unlocks at Keep ${c.requiredKeep}"
            BuildCardState.MAX -> c.nextCapKeep?.let { "more at Keep $it" } ?: if (c.trap) "Trap limit reached" else "All built"
            BuildCardState.UNAVAILABLE -> c.unavailableReason ?: BUILDING_UNAVAILABLE
            else -> null
        },
        isNew = c.type in newTypes,
        requires = null,
    )
}

/**
 * The HEROES tab from the hero recruitment state, card by card in the old recruitment menu's rules: an altar already
 * placed is MAX ("one per kingdom"), a Keep below the hero's level is LOCKED, recruitment off / unsupported / a saved
 * request / a request in flight is UNAVAILABLE with the repository's own words, otherwise AVAILABLE (a tap starts
 * placement; the band's PLACE opens the HeroAltarConfirm review). The price is the offer's own words ([priceLabel]), shown
 * as the purpose line; there is no single amount to put on a pill.
 */
internal fun liveHeroTray(h: HeroRecruitmentState): LiveHeroTray {
    val base = h.base
    val blocked = heroRecruitmentBlock(h)
    val cards = h.offers.map { offer ->
        val d = offer.definition
        val placed = offer.recruited || base?.buildings?.any { it.type == d.type } == true
        val (state, reason) = when {
            placed -> BuildCardState.MAX to "one per kingdom"
            blocked != null -> BuildCardState.UNAVAILABLE to blocked
            base == null -> BuildCardState.UNAVAILABLE to "Loading buildings…"
            base.player.keepLevel < d.keepLevel -> BuildCardState.LOCKED to "Unlocks at Keep ${d.keepLevel}"
            else -> BuildCardState.AVAILABLE to null
        }
        BuildCardUi(
            type = d.type,
            name = d.name.uppercase(),
            purpose = offer.priceLabel(),
            art = if (d.type == "heroaltar") "hero_vex_portrait" else "hero_theo_portrait",
            count = if (placed) "1/1" else "0/1",
            countTone = when (state) { BuildCardState.LOCKED -> Verb.STONE; BuildCardState.MAX -> Verb.GREEN; else -> Verb.BLUE },
            state = state,
            price = null,
            time = d.buildSec.toLong().takeIf { it > 0 }?.let(::fmtDur),
            reason = reason,
            isNew = false,
            requires = null,
            priceInPurpose = true,
        )
    }
    val empty = when {
        cards.isNotEmpty() -> null
        blocked != null -> blocked
        else -> "Loading heroes…"
    }
    return LiveHeroTray(cards, empty)
}

/** A HEROES card tap: AVAILABLE starts placement for that hero ([onHeroPick]); LOCKED / MAX explain and focus the Keep or
 *  the altar (the tray's own route); anything else says why. Never a spend: the review is the consent. */
internal fun dispatchHeroCard(card: BuildCardUi?, busy: Boolean, onHeroPick: (String) -> Unit, onGoToBuilding: (BuildCardUi) -> Unit,
    explain: (String) -> Unit) {
    if (card == null) return
    when (cardTap(card.state)) {
        CardTap.PLACE -> if (busy) explain("Working…") else onHeroPick(card.type)
        CardTap.EXPLAIN_LOCKED, CardTap.EXPLAIN_MAX -> onGoToBuilding(card)
        else -> explain(card.reason ?: BUILDING_UNAVAILABLE)
    }
}

/** The Need-more sheet for a SHORT card (null when nothing is missing). */
internal fun liveTrayNeedMore(f: TrayFacts, type: String, mine: MineFact): NeedMoreUi? {
    val card = f.cards.firstOrNull { it.type == type } ?: return null
    if (!card.currency.equals("SHARDS", ignoreCase = true)) return null
    return liveShardsNeedMore(titleCase(card.name), f.shardsBalance, card.amount, card.amountRaw, mine)
}

private fun sectionTitle(group: TrayGroup): String = when (group) {
    TrayGroup.ECONOMY -> "ECONOMY"; TrayGroup.ARMY -> "ARMY"; TrayGroup.CLAN -> "CLAN"; TrayGroup.REALM -> "REALM TRADE"
    TrayGroup.DEFENCE -> "DEFENCES"; TrayGroup.TRAP -> "TRAPS"; TrayGroup.WALL -> "WALLS"
}

private fun sectionIcon(group: TrayGroup): String = when (group) {
    TrayGroup.ECONOMY -> "shards"; TrayGroup.ARMY -> "army"; TrayGroup.CLAN -> "trophy"; TrayGroup.REALM -> "ui:workshop-menu"
    TrayGroup.DEFENCE -> "shield"; TrayGroup.TRAP -> TRAY_POWDER_ICON; TrayGroup.WALL -> "shield"
}

/** Guarded host entry; the original Keep/cap precedence and non-Shards review route remain. Hero cards carry no
 *  projection (H1: recruitment is reviewed by HeroAltarConfirm), so only a saved construction payment can close them. */
internal fun liveBuildTrayUi(f: TrayFacts, selectedTab: String, costs: LiveBuildingCosts, focusType: String? = null,
    heroes: LiveHeroTray? = null, newTypes: Set<String> = emptySet()): BuildTrayUi {
    val projections = f.cards.associate { it.type to costs.build(it.type) }
    // The header has the same admitted funds as the cards; raw presentation strings cannot become a balance.
    val admittedBalance = projections.values.firstNotNullOfOrNull { it?.balanceShards }
    val original = liveBuildTrayUi(f.copy(shardsBalance = admittedBalance), selectedTab, focusType, heroes, newTypes)
    val savedPayment = costs.savedPaymentBlocked()
    return original.copy(sections = original.sections.map { section ->
        section.copy(cards = section.cards.map { card ->
            val cost = projections[card.type]
            val gated = card.state == BuildCardState.LOCKED || card.state == BuildCardState.MAX
            if (savedPayment && !gated) card.copy(price = cost?.price ?: card.price,
                state = BuildCardState.UNAVAILABLE, reason = SAVED_BUILD_PAYMENT)
            // A money projection cannot promote a discovery-only card to a construction offer.
            else if (card.state == BuildCardState.UNAVAILABLE) card.copy(price = cost?.price ?: card.price)
            else if (cost == null) card
            else if (!gated && cost.held) card.copy(state = BuildCardState.CHECKING, priceHeld = true,
                price = PriceUi(Currency.SHARDS, cost.amountRaw?.let(::exactAmount), PriceStatus.CHECKING,
                    description = "Last confirmed price: ${cost.amountRaw?.let(::exactAmount)} Shards. $UPDATING_BUILD_PRICES"),
                reason = UPDATING_BUILD_PRICES)
            else {
                val state = when {
                    gated -> card.state
                    cost.price.status == PriceStatus.UNAVAILABLE -> BuildCardState.UNAVAILABLE
                    cost.price.status == PriceStatus.CHECKING -> BuildCardState.CHECKING
                    cost.price.status == PriceStatus.SHORT -> BuildCardState.SHORT
                    else -> BuildCardState.AVAILABLE
                }
                card.copy(price = cost.price, state = state,
                    reason = if (state == BuildCardState.UNAVAILABLE) PRICE_UNAVAILABLE else card.reason)
            }
        })
    })
}

internal fun liveTrayNeedMore(f: TrayFacts, type: String, mine: MineFact, costs: LiveBuildingCosts): NeedMoreUi? {
    val card = f.cards.singleOrNull { it.type == type } ?: return null
    val cost = costs.build(type)?.takeIf { it.price.status == PriceStatus.SHORT } ?: return null
    return liveShardsNeedMore(titleCase(card.name), cost.balanceShards, cost.price.amount ?: return null, cost.amountRaw, mine)
}

internal fun liveBuildTrayUi(f: LiveBuildTrayFacts, selectedTab: String, focusType: String? = null, heroes: LiveHeroTray? = null,
    newTypes: Set<String> = emptySet()): BuildTrayUi =
    liveBuildTrayUi(f.facts, selectedTab, f.costs, focusType, heroes, newTypes)
internal fun liveTrayNeedMore(f: LiveBuildTrayFacts, type: String, mine: MineFact): NeedMoreUi? =
    liveTrayNeedMore(f.facts, type, mine, f.costs)
