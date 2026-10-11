package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.MailStatus
import gg.pixelkingdomwars.nativeclient.model.WalletFunds
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.hud.HudIds
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.badgeCount
import gg.pixelkingdomwars.nativeclient.ui.kit.compactAmount
import gg.pixelkingdomwars.nativeclient.ui.kit.exactAmount
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.ChipTone
import gg.pixelkingdomwars.nativeclient.ui.model.ChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.DeckButtonUi
import gg.pixelkingdomwars.nativeclient.ui.model.DeckToolUi
import gg.pixelkingdomwars.nativeclient.ui.model.EdgeButtonUi
import gg.pixelkingdomwars.nativeclient.ui.model.HomeHudUi
import gg.pixelkingdomwars.nativeclient.ui.model.ProfileMedallionUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceAccent
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceDrawerUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceGroupLayout
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceGroupUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceRowUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Interim Home HUD binding: the server state HomeScaffold already receives -> the kit's HomeHudUi / ResourceDrawerUi.
 *
 * TODO(MS-C2): replace with Codex's `ui.hud.homeHudUi` / `resourceDrawerUi` (HomeHudMapper.kt + HomeHudMapperTest) when
 * they land. Named differently on purpose so the two can never collide. Rules kept (MOUNT-HUD.md): unknown is "…",
 * never "0"; no invented event/Phase E groups. Shards and supported Gems are game balances; KEEP and SKR
 * come only from the current linked wallet observation supplied by Home. SOL stays in its existing money context.
 */

/** SKR has no registry row of its own: the readout's id only names the drawer row it focuses (MOUNT-HUD.md). */
internal val HUD_SKR = FeatureId("hud.skr")

/** Display projection only; the existing economy owner retains all read/error and transaction ownership. */
internal fun currentHomeWallet(funds: WalletFunds?, sessionCurrent: Boolean, loading: Boolean,
    readErrors: Map<String, String>): WalletFunds? =
    funds.takeIf { sessionCurrent && !loading && !readErrors.containsKey("/wallet/balances") }

internal fun homeHudState(home: BaseState, mail: MailStatus?, unreadRaids: Int, chatEnabled: Boolean, chatUnread: Int,
    chatMentions: Int, selectionOpen: Boolean, tools: List<DeckToolUi> = emptyList(), toolsOpen: Boolean = false,
    wallet: WalletFunds? = null, walletLinked: Boolean = false,
    herald: gg.pixelkingdomwars.nativeclient.ui.model.HeraldUi? = null, eventButton: EdgeButtonUi? = null): HomeHudUi {
    val snapshot = home.base
    val player = snapshot?.player
    val level = player?.keepLevel?.toString() ?: UNKNOWN
    val free = snapshot?.freeBuilders
    val total = player?.builders
    val shield = hudShield(home, unreadRaids)
    val balances = home.balances
    val gemsOn = balances?.features?.gems?.supported == true
    val tokens = wallet.takeIf { walletLinked }?.tokens
    val claimable = home.quests?.quests?.count { it.completed && !it.claimed } ?: 0
    val army = snapshot?.armyStatus
    return HomeHudUi(
        profile = ProfileMedallionUi(HudIds.PROFILE, level, null, "Menu and profile, Keep level $level"),
        builders = ChipUi(HudIds.BUILDERS, "builder", if (free != null && total != null) "$free/$total" else UNKNOWN,
            "Builders: ${free ?: UNKNOWN} of ${total ?: UNKNOWN} free", dot = (free ?: 0) > 0),
        shield = ChipUi(HudIds.SHIELD, "shield", shield, "Shield $shield. Opens the defence log",
            tone = if (unreadRaids > 0) ChipTone.DANGER else ChipTone.NORMAL),
        resources = buildList {
            add(ResourceChipUi(HudIds.SHARDS, "shards", compactAmount(balances?.shards), hudMineFraction(home), false, null,
                name = "Shards", accent = ResourceAccent.SHARDS, exactDescription = "Shards ${exactAmount(balances?.shards)}"))
            if (gemsOn) add(ResourceChipUi(HudIds.GEMS, "gem", compactAmount(balances?.gems), null, false, null,
                name = "Gems", accent = ResourceAccent.GEMS, exactDescription = "Gems ${exactAmount(balances?.gems)}"))
            if (walletLinked) add(ResourceChipUi(HudIds.KEEP, "keep", compactAmount(tokens?.get("KEEP")), null, false, null,
                name = "KEEP", accent = ResourceAccent.KEEP, exactDescription = "Wallet KEEP ${exactAmount(tokens?.get("KEEP"))}"))
            add(ResourceChipUi(HUD_SKR, "skr", compactAmount(tokens?.get("SKR")), null, false, null, name = "SKR", accent = ResourceAccent.SKR,
                drawerHandle = true, exactDescription = "Wallet SKR ${exactAmount(tokens?.get("SKR"))}"))
        },
        rightEdge = buildList {
            add(EdgeButtonUi(HudIds.QUESTS, "quest", "QUESTS", badgeCount(claimable)?.let { BadgeUi(it, BadgeTone.COUNT, "$claimable quests ready to claim") }, false))
            if (home.mine?.cache?.claimable == true) add(EdgeButtonUi(HudIds.DAILY_CACHE, "shape:chest", "DAILY", BadgeUi("!", BadgeTone.READY, "Daily cache ready"), false))
            // Founding Kingdoms: only while the server's campaign is live (homeEventEdgeButton decides).
            eventButton?.let { add(it) }
        },
        leftEdge = buildList {
            val unread = mail?.unread ?: 0
            // Mail is a door, not only a notice: it stays on the edge once the base is loaded, so an empty inbox still opens.
            val mailBadge = badgeCount(unread)?.let { BadgeUi(it, BadgeTone.COUNT, "$unread unread letters") }
            if (snapshot != null || mailBadge != null) add(EdgeButtonUi(HudIds.MAIL, "shape:envelope", "Mail", mailBadge, false))
            if (chatEnabled) add(EdgeButtonUi(HudIds.CHAT, "shape:speech", "Chat", when {
                chatMentions > 0 -> BadgeUi("@$chatMentions", BadgeTone.REWARD, "$chatMentions mentions")
                else -> badgeCount(chatUnread)?.let { BadgeUi(it, BadgeTone.COUNT, "$chatUnread unread messages") }
            }, false))
        },
        herald = herald,
        deck = listOf(
            DeckButtonUi(HudIds.ATTACK, "attack", "ATTACK", true, null, null, verb = Verb.RED),
            DeckButtonUi(HudIds.ARMY, "ui_portrait_highlander_t2", "ARMY", false, null,
                army?.takeIf { it.campCapacityPts > 0 }?.let { it.readyPts to it.campCapacityPts }, verb = Verb.CHARCOAL),
            DeckButtonUi(HudIds.MAP, "map", "MAP", false, null, null, verb = Verb.BLUE),
            // home.png BUILD: the authored hammer (pkw_web_item_hammer, 32 px art at 32), not the drawn 12-cell glyph.
            DeckButtonUi(HudIds.BUILD, "itm_hammer", "BUILD", true, null, null, verb = Verb.GREEN),
        ),
        deckVisible = !selectionOpen,
        trophies = player?.trophies?.let { ChipUi(HudIds.LEAGUES, homeLeagueCrest(player?.league), compactAmount(it), "${exactAmount(it)} trophies. Opens leagues") },
        tools = tools,
        toolsOpen = toolsOpen,
    )
}

/**
 * The deck's tools shelf: KingdomScreen's former LAYOUT · EXPAND · FIT dock row with its exact rules. LAYOUT and EXPAND
 * exist only while the deed allows base actions ([deedActionsAllowed], the row hid them otherwise); LAYOUT is off while
 * the kingdom is busy or no base is loaded, EXPAND while no base is loaded; FIT always works. KingdomScreen re-checks
 * the same rules when it runs the request.
 */
internal fun homeDeckTools(baseLoaded: Boolean, deedActionsAllowed: Boolean, busy: Boolean): List<DeckToolUi> = buildList {
    if (deedActionsAllowed) {
        val layout = baseLoaded && !busy
        add(DeckToolUi(HudIds.TOOL_LAYOUTS, "layout", "LAYOUT", layout,
            if (layout) "Base layout" else if (!baseLoaded) "Base layout, waiting for your base" else "Base layout, waiting for the last order"))
        add(DeckToolUi(HudIds.TOOL_EXPAND, "plus", "EXPAND", baseLoaded,
            if (baseLoaded) "Expand base" else "Expand base, waiting for your base"))
    }
    add(DeckToolUi(HudIds.TOOL_FIT, "locate", "FIT", true, "Fit base to screen"))
}

/** A tools-shelf id -> the base tool KingdomScreen runs; null for any other id. */
internal fun homeBaseTool(id: FeatureId): HomeBaseTool? = when (id) {
    HudIds.TOOL_LAYOUTS -> HomeBaseTool.LAYOUT
    HudIds.TOOL_EXPAND -> HomeBaseTool.EXPAND
    HudIds.TOOL_FIT -> HomeBaseTool.FIT
    else -> null
}

// Rule 7: the stricter ui.hud.resourceDrawerUi (ResourceDrawerProducer.kt) has no live ResourceRow source; this mounted
// binding is the one extended. Flag that producer for cleanup or wiring once a ResourceRow registry exists.
/**
 * The drawer: EVERY DAY (the rows the HUD shows, unchanged), then the caller's [materials] strips (HARVESTERS / WORKSHOP
 * from `drawerMaterialGroups`, this wallet's view of this base only; LODGE's Renown from `drawerLodgeGroup` when served)
 * with the tint legend under them. SKR carries no BID: auctions have no system yet.
 */
internal fun homeResourceDrawer(home: BaseState, focusRowId: String?, wallet: WalletFunds? = null,
    walletLinked: Boolean = false, materials: List<ResourceGroupUi> = emptyList()): ResourceDrawerUi {
    val balances = home.balances
    val gemsOn = balances?.features?.gems?.supported == true
    val tokens = wallet.takeIf { walletLinked }?.tokens
    val rows = buildList {
        add(ResourceRowUi("shards", "shards", "SHARDS", exactAmount(balances?.shards), "Builds and upgrades everything.", "Mine", FeatureId("mine.collect")))
        if (gemsOn) add(ResourceRowUi("gems", "gem", "GEMS", exactAmount(balances?.gems), "Finishes timers and buys supplies.", "Gold Forge", FeatureId("goldforge.gems")))
        if (walletLinked) add(ResourceRowUi("keep", "keep", "KEEP", exactAmount(tokens?.get("KEEP")), "On-chain KEEP in your linked wallet.", "Wallet KEEP", FeatureId("goldforge.open")))
        add(ResourceRowUi("skr", "skr", "SKR", exactAmount(tokens?.get("SKR")), "Bids for spots on Seeker Island.", "Wallet SKR", null))
    }
    val everyDay = ResourceGroupUi("everyday", "", "EVERY DAY", "always on your top bar", null, rows, ResourceGroupLayout.WIDE_ROWS)
    val strips = materials.filter { it.layout == ResourceGroupLayout.TILE_STRIP && it.rows.isNotEmpty() }
    return ResourceDrawerUi(listOf(everyDay) + strips, focusRowId,
        footnote = if (strips.isNotEmpty()) gg.pixelkingdomwars.nativeclient.ui.hud.DRAWER_MATERIALS_FOOTNOTE else null)
}

/** home.png status chip: the crest of the league the server names (`player.league`, pkw_web_league_<tier>); the trophy
 *  cup when it names no known tier, so the crest never claims a league the player is not in. */
internal fun homeLeagueCrest(league: String?): String = when (val tier = league?.trim()?.lowercase()) {
    "bronze", "silver", "gold", "sol" -> "league-$tier"
    else -> "trophy"
}

/** A readout id ("hud.shards") -> the drawer row it focuses ("shards"); null for the plain drawer. */
internal fun hudDrawerRow(id: FeatureId?): String? = id?.value?.takeIf { it != HudIds.RESOURCES.value }?.removePrefix("hud.")
