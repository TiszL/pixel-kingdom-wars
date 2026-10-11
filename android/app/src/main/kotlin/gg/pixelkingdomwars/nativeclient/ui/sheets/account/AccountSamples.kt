package gg.pixelkingdomwars.nativeclient.ui.sheets.account

import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ClanUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.clanTabs

/**
 * Preview-only sample data for the account cluster's @Preview functions: the numbers of the design/final/account PNGs
 * (mock player Rowan, kingdom IRONHOLD, Keep 12, Crownlands, Seeker #142, clan Iron Wardens). Every number is a
 * placeholder exactly as in the mockups; nothing reads these outside previews.
 */

internal val sampleLandPrice = PriceUi(Currency.SOL, "0.2", PriceStatus.OK)

internal val sampleProfileTabs = profileCardTabs(3, kingdomsBadge = BadgeUi("!", BadgeTone.READY, "A kingdom needs you"))

internal val sampleKingdoms = KingdomsUi(
    kingdoms = listOf(
        KingdomCardUi("k1", "Ironhold", "Crownlands", null, "12", 3, KingdomStatus.PLAYING, hasDeed = true),
        KingdomCardUi("k2", "Frosthollow", "Frostveil", null, "5", 2, KingdomStatus.AVAILABLE, hasDeed = true, needsYou = "Workshop batch ready"),
    ),
    landless = false,
    addPrice = PriceUi(Currency.SOL, "0", PriceStatus.SERVER_ZERO),
    activeName = "Ironhold", tile = "4,812", tileThumb = null, shield = "4h",
)

internal val sampleWallet = WalletUi(
    linked = true, walletName = "SEED VAULT", shortAddress = "7xKp…4f2k", deviceNote = "this phone", devnet = true,
    skr = "1,240", keep = "312.5", sol = "0.84", faucet = FaucetUi.Ready("1,000"), historyNeedsYou = 2, historyDone = 41,
)

internal val sampleAccount = AccountUi(
    nameDraft = "Rowan", savedName = "Rowan", nameError = null, nameSaving = false,
    providers = listOf(
        ProviderRowUi(ProviderKind.WALLET, "Seed Vault · 7xKp…4f2k", linked = true),
        ProviderRowUi(ProviderKind.GOOGLE, "t•••@gmail.com", linked = true),
        ProviderRowUi(ProviderKind.X, "not linked", linked = false),
    ),
    totpEnabled = true, backupCodesLeft = 8,
)

internal val sampleProfileCard = ProfileCardUi(
    header = ProfileHeaderUi("IRONHOLD", "Rowan", "12", 3, "SEEKER #142", null),
    selectedTab = KINGDOMS_TAB, kingdoms = sampleKingdoms, wallet = sampleWallet, account = sampleAccount, tabs = sampleProfileTabs,
)

private val realmNames = listOf("crownlands" to "Crownlands", "frostveil" to "Frostveil", "elderwood" to "Elderwood", "sunscar" to "Sunscar",
    "stormcairn" to "Stormcairn", "cinderfall" to "Cinderfall", "thornwake" to "Thornwake", "seeker-reach" to "Solana Reach")

internal val sampleLandGate = LandGateUi(
    price = sampleLandPrice, alreadyOwned = false, walletLinked = true,
    realms = realmNames.map { (id, name) -> RealmChipUi(id, name, null) },
)

internal val sampleRealmPicker = RealmPickerUi(
    realms = listOf(
        RealmCardUi("crownlands", "Crownlands", "3,112 kingdoms", null),
        RealmCardUi("frostveil", "Frostveil", "1,846 kingdoms", null),
        RealmCardUi("elderwood", "Elderwood", "2,204 kingdoms", null),
        RealmCardUi("sunscar", "Sunscar", "1,377 kingdoms", null),
        RealmCardUi("stormcairn", "Stormcairn", "958 kingdoms", null),
        RealmCardUi("cinderfall", "Cinderfall", "1,120 kingdoms", null),
        RealmCardUi("thornwake", "Thornwake", "1,489 kingdoms", null),
        RealmCardUi("seeker-reach", "Solana Reach", "…", null, RealmLock.SKR_UNLOCK),
    ),
    selectedId = "crownlands", price = sampleLandPrice,
)

internal val sampleLandDone = LandDoneUi(
    receiptId = "preview-receipt", kingdomName = "Ironhold", keepTier = 1,
    facts = listOf(
        LandFactUi("itm_deed_earth", "Kingdom Deed sent to your wallet"),
        LandFactUi("map", "Crownlands · tile 4,812"),
        LandFactUi("trophy", "Leagues and the Gold Forge are open"),
    ),
)

private val buildTabs = listOf(
    TabUi("BUILDINGS", "ui_portrait_keep_t3", "BUILDINGS", null, false),
    TabUi("DEFENCES", "shield", "DEFENCE", null, false),
    TabUi("TRAPS", "attack", "TRAPS", null, false),
    TabUi("HEROES", "hero_vex_portrait", "HEROES", null, false),
    TabUi(SUPPLIES_TAB, "itm_chest", "SUPPLIES", null, false),
    TabUi("LAYOUTS", "layout", "LAYOUTS", null, false),
)

private fun gems(amount: String) = PriceUi(Currency.GEMS, amount, PriceStatus.OK)

internal val sampleSupplies = SuppliesUi(
    tabs = buildTabs, builders = "1/2", buildersFree = true, shieldLeft = "4h left", buildersHired = "2 hired", energyNow = 2, energyMax = 5,
    offers = listOf(
        SupplyOfferUi("shield-1d", SupplyKind.SHIELD, "1 DAY", "adds 24h", "itm_shield", gems("100"), "BUY 1-DAY SHIELD", "100 Gems · shield becomes 28h"),
        SupplyOfferUi("shield-2d", SupplyKind.SHIELD, "2 DAYS", "adds 48h", "itm_shield", gems("150"), "BUY 2-DAY SHIELD", "150 Gems · shield becomes 52h"),
        SupplyOfferUi("shield-7d", SupplyKind.SHIELD, "7 DAYS", "once a week", "itm_shield", gems("500"), "BUY 7-DAY SHIELD", "500 Gems · shield becomes 172h"),
        SupplyOfferUi("builder-3", SupplyKind.BUILDER, "3RD BUILDER", "Paid once", "builder", PriceUi(Currency.SOL, "0.1", PriceStatus.OK),
            "HIRE 3RD BUILDER", "0.1 SOL · paid once"),
        SupplyOfferUi("energy-refill", SupplyKind.ENERGY, "REFILL TO 5", "", "energy", gems("60"), "REFILL ENERGY", "60 Gems · 5 of 5"),
    ),
    selectedId = "shield-2d",
)

private fun member(id: String, name: String, role: ClanRole, keep: Int, seen: String, online: Boolean, trophies: Long, crest: String,
    you: Boolean = false, new: Boolean = false) = ClanMemberUi(id, name, role, you, new, "$keep", if (keep >= 13) 4 else if (keep >= 9) 3 else 2,
    seen, online, trophies, "%,d".format(trophies), (trophies / 180).toInt(), crest)

internal val sampleMembers = ClanMembersUi(
    sort = MemberSort.TROPHIES,
    members = listOf(
        member("m1", "Mira", ClanRole.LEADER, 14, "online now", true, 2140, "league-gold"),
        member("m2", "Seraphine", ClanRole.ELDER, 13, "seen 2h ago", false, 1980, "league-gold"),
        member("m3", "Rowan", ClanRole.MEMBER, 12, "online now", true, 1284, "league-gold", you = true),
        member("m4", "Old Bramble", ClanRole.MEMBER, 10, "seen 1d ago", false, 1102, "league-silver"),
        member("m5", "Harrowgate", ClanRole.MEMBER, 9, "seen 5h ago", false, 944, "league-silver"),
        member("m6", "Wren", ClanRole.MEMBER, 4, "online now", true, 310, "league-bronze", new = true),
    ),
    myRole = ClanRole.MEMBER, expandedId = "m2",
)

internal val sampleClanShell = ClanUi(
    name = "IRON WARDENS", tag = "[IRN]", hallTier = 2, members = "18/30 members", inviteMode = "OPEN", rank = "12", chestEndsIn = "4d 6h",
    chest = null, top = emptyList(), inviteCode = null, tabs = clanTabs(), selectedTab = "CLAN", chatUnread = 3, noClan = null,
    requiresLand = false, load = LoadState.Ready,
)

internal val sampleCharter = ClanCharterUi(
    registered = true, clanName = "Iron Wardens", bannerIcon = "itm_banner", captainName = "Mira", captainTier = 4, joining = "Open to all",
    founded = "12 Sep", roster = "18 of 30", amCaptain = false, inviteOnly = false,
)

internal val sampleTourney = ClanTourneyUi(
    eventId = "w41", weekLine = "Week 41 · 16 clans", phase = TourneyPhase.ENTRY, entered = true, enteredBy = "Mira", enteredByTier = 4,
    rosterLine = "Roster locked: 12 of 18. You are in.", inRoster = true, amCaptain = false,
    prizes = listOf(
        ItemTileUi("crystal", "ui:crystal-fragments", "40", "Crystal fragments, 40"),
        ItemTileUi("kit", "ui:expedition-kit", "12", "Expedition kits, 12"),
        ItemTileUi("renown", "ui:renown", "300", "Renown, 300"),
        ItemTileUi("nav", "ui:navigation-kit", "6", "Navigation kits, 6"),
    ),
    fightsUsed = 0, fightsMax = 3, opensIn = "Battles open Thu 18:00 UTC · 1d 4h",
    lastTitle = "Last time: 4th of 16", lastSub = "You won 2 of 3 · prize collected",
)

internal val sampleFinder = ClanFinderUi(
    tab = "FIND",
    search = ClanSearchUi(query = "", filter = "FOR_YOU", codeDraft = "", results = listOf(
        ClanListingUi("c1", "Iron Wardens", "[IRN]", "itm_banner", "Crownlands", null, "18/30", "league-gold", "1,000+", ClanJoinMode.OPEN, bestMatch = true),
        ClanListingUi("c2", "Ember Oath", "[EMB]", "itm_crest", "Cinderfall", null, "27/30", "league-gold", "1,200+", ClanJoinMode.OPEN),
        ClanListingUi("c3", "Frost Pact", "[FRP]", "itm_crest", "Frostveil", null, "11/30", "league-silver", "600+", ClanJoinMode.ASK),
        ClanListingUi("c4", "Thorn Guard", "[THG]", "itm_banner", "Thornwake", null, "30/30", "league-silver", "800+", ClanJoinMode.FULL),
    )),
    create = ClanCreateUi(name = "Iron Wardens", tag = "IRN", inviteOnly = false, bannerId = "itm_banner",
        banners = listOf("itm_banner", "itm_crest"), minTrophies = 600, minTrophiesText = "600",
        price = PriceUi(Currency.SOL, "0.05", PriceStatus.OK), captainName = "Rowan"),
    invites = listOf(ClanInviteUi("i1", "Iron Wardens", "[IRN]", "itm_banner", "Mira")),
    hallTier = 1,
)

internal val sampleTitle = TitleUi(
    version = "0.6.5 (31)", walletAdapterAvailable = true, lastWalletLabel = null,
    socialProviders = listOf(
        SignInProviderUi("google", "Continue with Google", "G"),
        SignInProviderUi("x", "Continue with X", "X"),
        SignInProviderUi("email", "Continue with email", "@"),
    ),
)
