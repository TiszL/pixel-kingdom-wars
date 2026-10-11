package gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live

import gg.pixelkingdomwars.nativeclient.data.AccountState
import gg.pixelkingdomwars.nativeclient.model.BaseCapabilities
import gg.pixelkingdomwars.nativeclient.model.BaseDirectory
import gg.pixelkingdomwars.nativeclient.model.BaseSummary
import gg.pixelkingdomwars.nativeclient.model.Identity
import gg.pixelkingdomwars.nativeclient.model.SecurityStatus
import gg.pixelkingdomwars.nativeclient.model.WalletFunds
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.FaucetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.KingdomStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.KingdomsMode
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.ProviderKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.WalletTokenRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.kingdomsMode
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Land ownership is the server's entry payment: a player who paid must never be shown the "claim your land" teaser, an
 *  unread account shows "…", money doors only navigate to their existing owners (or explain in player words) and never
 *  charge, and the last sign-in method can never be unlinked. */
class AccountLiveMapperTest {
    private val wallet = "7xKpQ2mN8vR4tY6uW3zA1bC5dE9fG2hJ4f2k"
    private fun base(id: String, slot: Int?, realm: String? = "crownlands", tile: String? = "4812", keep: Int? = 12, deed: String? = "Deed$id") =
        BaseSummary(id = id, status = if (slot != null) "active" else "inactive", keepLevel = keep, slot = slot, deedAssetId = deed,
            landPaidAt = "2030-01-01T00:00:00.000Z",
            fantasyLocation = if (realm == null) null else JsonObject(mapOf("realmId" to JsonPrimitive(realm), "tileId" to JsonPrimitive(tile))))
    private fun directory(vararg bases: BaseSummary, reservations: Boolean = true) =
        BaseDirectory(enabled = true, capabilities = BaseCapabilities(true, true, reservations), bases = bases.toList())
    private fun account(entryPaid: Boolean?, directory: BaseDirectory?, selected: String? = null, name: String? = "Rowan") =
        AccountState(identity = Identity(wallet, name = name, keepLevel = 9, entryPaid = entryPaid), directory = directory, selectedBaseId = selected)
    private fun nav(said: MutableList<String>, selected: MutableList<String> = mutableListOf(), unlinked: MutableList<ProviderKind> = mutableListOf()) =
        AccountLiveNav(selectBase = { selected += it }, seeOnMap = {}, openDeedClaim = {}, copyAddress = {}, openSeekerIsland = {}, openGoldForge = {},
            openHistory = {}, linkWallet = {}, nameDraft = {}, saveName = {}, confirmUnlink = { unlinked += it }, openSecurity = {},
            confirmSignOut = {}, explain = { said += it })

    @Test fun `an unpaid entry is landless with an unknown land price, never a made-up one`() {
        val ui = kingdomsLiveUi(account(entryPaid = false, directory = directory()), null)
        assertTrue(ui.landless)
        assertEquals(PriceStatus.CHECKING, ui.landPrice?.status)
        assertNull(ui.landPrice?.amount)
    }

    @Test fun `an unread account is a row of ellipses, never the claim-your-land teaser`() {
        val unread = kingdomsLiveUi(AccountState(), null)
        assertFalse(unread.landless)
        assertEquals(UNKNOWN, unread.kingdoms.single().name)
        assertEquals(KingdomsMode.ONE, kingdomsMode(unread.landless, unread.kingdoms.size))
        // paid, directory not read yet: still not the teaser
        assertFalse(kingdomsLiveUi(account(entryPaid = true, directory = null), null).landless)
        // an old server without entryPaid falls back to the paid deed in the directory
        assertEquals(true, landOwnedLive(account(entryPaid = null, directory = directory(base("b1", 1)))))
    }

    @Test fun `active deeds become kingdoms, the selected one plays, inactive deeds stay off the list`() {
        val ui = kingdomsLiveUi(account(true, directory(base("b2", 2, realm = "seeker-reach"), base("b1", 1), base("b3", null)), selected = "b1"), null)
        assertEquals(listOf("b1", "b2"), ui.kingdoms.map { it.id })
        assertEquals(KingdomStatus.PLAYING, ui.kingdoms[0].status)
        assertEquals(KingdomStatus.AVAILABLE, ui.kingdoms[1].status)
        assertEquals("Solana Reach", ui.kingdoms[1].realmName)
        assertEquals("SLOT 1", ui.activeName)
        assertEquals("4,812", ui.tile)
        assertEquals(UNKNOWN, ui.shield)
        assertTrue(ui.kingdoms[0].hasDeed)
    }

    @Test fun `add a kingdom shows only where land reservations are served and is never free without a server zero`() {
        val on = kingdomsLiveUi(account(true, directory(base("b1", 1))), null)
        assertEquals(PriceStatus.CHECKING, on.addPrice?.status)
        assertNull(kingdomsLiveUi(account(true, directory(base("b1", 1), reservations = false)), null).addPrice)
    }

    @Test fun `wallet amounts come from the server read, a missing token is the ellipsis, the faucet row is hidden`() {
        val funds = WalletFunds(sol = "0.84", tokens = mapOf("KEEP" to "312.5", "SKR" to null), asOf = 1)
        val ui = walletLiveUi(account(true, directory()), funds, devnet = true, walletApp = "Seed Vault")
        assertEquals("0.84", ui.sol)
        assertEquals("312.5", ui.keep)
        assertEquals(UNKNOWN, ui.skr)
        assertEquals("SEED VAULT", ui.walletName)
        assertEquals("7xKp…4f2k", ui.shortAddress)
        assertEquals(FaucetUi.Hidden, ui.faucet)
        assertEquals(UNKNOWN, walletLiveUi(account(true, directory()), null, true, null).sol)
        // mainnet never shows a test faucet row, whatever the faucet lane says
        assertEquals(FaucetUi.Hidden, walletLiveUi(account(true, directory()), funds, devnet = false, walletApp = null, faucet = FaucetUi.NeedsDeed).faucet)
        assertEquals(FaucetUi.NeedsDeed, walletLiveUi(account(true, directory()), funds, devnet = true, walletApp = null, faucet = FaucetUi.NeedsDeed).faucet)
    }

    // Rewritten 2026-10-06 (Profile land + faucet doors). This case used to pin that CLAIM YOUR LAND, ADD A KINGDOM and
    // DAILY TEST SKR only explained MONEY_WIRING_PENDING. They now open their existing owners (the designed land gate, the
    // SKR faucet sheet) when the host binds them, exactly once per tap; an unbound door tells the player where to go in
    // plain words, never "MS-M3" jargon. Nothing here can charge: AccountLiveNav carries navigation only, and no SWITCH
    // (selectBase) is triggered by a money door.
    @Test fun `bound land and faucet doors navigate once and unbound ones explain in player words without charging`() {
        val said = mutableListOf<String>()
        val selected = mutableListOf<String>()
        var land = 0
        var faucet = 0
        val bound = nav(said, selected).copy(openLand = { land++ }, openSkrFaucet = { faucet++ })
        kingdomsLiveActions(bound, kingdomsLiveUi(account(false, directory()), null)).onClaimLand()
        kingdomsLiveActions(bound, kingdomsLiveUi(account(true, directory(base("b1", 1))), null)).onAddKingdom()
        walletLiveActions(bound).onClaimFaucet()
        assertEquals(2, land)
        assertEquals(1, faucet)
        assertTrue(said.isEmpty())

        val unbound = nav(said, selected)
        val kingdoms = kingdomsLiveActions(unbound, kingdomsLiveUi(account(false, directory()), null))
        kingdoms.onClaimLand(); kingdoms.onAddKingdom()
        walletLiveActions(unbound).onClaimFaucet()
        assertEquals(listOf(PROFILE_LAND_UNBOUND, PROFILE_LAND_UNBOUND, PROFILE_SKR_FAUCET_CLOSED), said)
        assertTrue(said.none { it.contains("MS-M3") || it == MONEY_WIRING_PENDING })
        assertEquals(2, land)
        assertEquals(1, faucet)
        assertTrue(selected.isEmpty())
    }

    // K-night-A5. The QA chain lane's server adds a game-cluster row (test SKR) beside the catalogue's WALLET_HUB.tokens, and
    // the owner must see that balance in the Wallet tab, not only inside the auction. The client knows no symbol or mint: a
    // row is extra only because the catalogue does not list it, it keeps the server's order, and its amount reads exactly like
    // the tiles' (held, "0" not held, "…" unread).
    private val catalogue = Json.parseToJsonElement("""{"constants":{"WALLET_HUB":{"tokens":[{"symbol":"KEEP","cluster":"game","mint":"k"},
        {"symbol":"SKR","cluster":"mainnet","mint":"s"},{"symbol":"USDC","cluster":"mainnet","mint":"c"},
        {"symbol":"USDT","cluster":"mainnet","mint":"t"}]}}}""").jsonObject
    private fun read(tokens: String) = WalletFunds.from(Json.parseToJsonElement("""{"sol":0.84,"tokens":$tokens,"asOf":1}""").jsonObject)

    @Test fun `an extra game token row sent by the server is shown after the catalogue rows`() {
        val funds = read("""{"KEEP":312.5,"SKR":25,"USDC":null,"USDT":0,"tSKR":1000,"tGOLD":null,"tZERO":0}""")
        val ui = walletLiveUi(account(true, directory()), funds, devnet = true, walletApp = null, catalogue = catalogue)
        assertEquals(listOf(WalletTokenRowUi("tSKR", "1,000"), WalletTokenRowUi("tGOLD", UNKNOWN), WalletTokenRowUi("tZERO", "0")), ui.extraTokens)
        assertEquals(walletAmount("1000"), ui.extraTokens.first().amount)
        // the catalogue tiles keep their own reads; an extra row never replaces one
        assertEquals("25", ui.skr); assertEquals("312.5", ui.keep)
        // server order is kept even when an extra row arrives before the catalogue rows
        val early = read("""{"tSKR":5,"KEEP":1,"SKR":2,"tB":7}""")
        assertEquals(listOf("tSKR", "tB"), walletLiveUi(account(true, directory()), early, true, null, catalogue = catalogue).extraTokens.map { it.symbol })
        // "after": the tab draws the extra rows below the SKR and KEEP tiles (and above the SOL row), and the live Profile
        // hands the mapper the catalogue that tells the two apart
        val tab = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/sheets/account/ProfileWalletTab.kt").readText()
            .substringAfter("private fun LinkedWallet(")
        val keepTile = tab.indexOf("ValueTile(\"keep\""); val extra = tab.indexOf("ui.extraTokens.forEach"); val sol = tab.indexOf("\"\${ui.sol} SOL\"")
        assertTrue(keepTile in 0 until extra); assertTrue(extra < sol)
        val hub = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/profile/ProfileHub.kt").readText().replace(Regex("\\s+"), "")
        assertTrue(hub.substringAfter("valwalletUi=walletLiveUi(").substringBefore("valnameError").contains("catalogue=content.catalogue"))
    }

    // Production sends only the catalogue rows. The tab must stay exactly what it was before extra rows existed: the same
    // tiles, and no row for a catalogue token the design does not draw (USDC, USDT), whatever their read says.
    @Test fun `no extra row leaves the wallet tab identical`() {
        val funds = read("""{"KEEP":312.5,"SKR":null,"USDC":null,"USDT":0}""")
        val before = walletLiveUi(account(true, directory()), funds, devnet = true, walletApp = "Seed Vault")
        val after = walletLiveUi(account(true, directory()), funds, devnet = true, walletApp = "Seed Vault", catalogue = catalogue)
        assertEquals(before, after)
        assertTrue(after.extraTokens.isEmpty())
        assertEquals("312.5", after.keep); assertEquals(UNKNOWN, after.skr); assertEquals("0.84", after.sol)
        // with the catalogue unread no row can be told apart from a catalogue row, so none is drawn as extra
        assertTrue(walletLiveUi(account(true, directory()), read("""{"KEEP":1,"USDC":5,"tSKR":9}"""), true, null).extraTokens.isEmpty())
        assertEquals(listOf("KEEP", "SKR", "USDC", "USDT"), walletHubSymbols(catalogue))
        assertNull(walletHubSymbols(null)); assertNull(walletHubSymbols(JsonObject(emptyMap())))
    }

    // A host misconfiguration must cost one row, not the wallet: one unparsable amount used to fail the whole read, so the tab
    // lost SKR, KEEP and SOL with it. A symbol outside the server's own extra-row rule is not drawn either.
    @Test fun `a malformed extra row is skipped, not fatal`() {
        val funds = read("""{"KEEP":312.5,"SKR":25,"USDC":null,"USDT":0,"tBAD":"abc","tNEG":-1,"tOBJ":{"a":1},"tARR":[1],"tYES":true,
            "t SKR":5,"tSKR":1000}""")
        val ui = walletLiveUi(account(true, directory()), funds, devnet = true, walletApp = null, catalogue = catalogue)
        assertEquals(listOf(WalletTokenRowUi("tSKR", "1,000")), ui.extraTokens)
        assertEquals("25", ui.skr); assertEquals("312.5", ui.keep); assertEquals("0.84", ui.sol)
    }

    @Test fun `live wallet exposes unavailable reasons for held History and test SOL doors while Seeker Island is live`() {
        val funds = WalletFunds(sol = "0.84", tokens = mapOf("KEEP" to "312.5", "SKR" to "25"), asOf = 1)
        for (observed in listOf(null, funds)) {
            val ui = walletLiveUi(account(true, directory()), observed, devnet = true, walletApp = "Seed Vault")

            // Owner 2026-10-06: SEEKER ISLAND opens the globe on the island panel (WorldEntry.SeekerIsland); never "not open".
            assertNull(ui.seekerUnavailable)
            // Rewritten 2026-10-06: History is no longer held unconditionally. A host that routes `profile.history` to the
            // designed WalletHistory card passes historyAvailable = true and the door opens; without that route (the
            // default) it stays the designed UNAVAILABLE row rather than promising a page that would not open.
            assertNotNull(ui.historyUnavailable)
            assertNotNull(walletLiveUi(account(true, directory()), observed, devnet = true, walletApp = "Seed Vault",
                historyAvailable = false).historyUnavailable)
            assertNull(walletLiveUi(account(true, directory()), observed, devnet = true, walletApp = "Seed Vault",
                historyAvailable = true).historyUnavailable)
            assertNotNull(ui.testSolUnavailable)
        }
    }

    @Test fun `Seeker Island is a live door and the faucet row carries the faucet lane state on devnet only`() {
        // The globe's Seeker Island panel (D-172, the auction host in pinned builds) backs the door on every cluster:
        // the tile must offer SEEKER ISLAND, never the old "not open yet" (owner 2026-10-06, the bidding demo).
        val ui = walletLiveUi(account(true, directory()), null, devnet = true, walletApp = null)
        assertNull(ui.seekerUnavailable)
        // Every faucet state the lane can produce reaches the row unchanged on devnet (NeedsDeed and Unavailable included,
        // so the row taps through to the faucet sheet that explains them); mainnet never draws the row.
        for (state in listOf(FaucetUi.NeedsDeed, FaucetUi.Unavailable("Paused for today"), FaucetUi.Ready("1,000"), FaucetUi.Checking)) {
            assertEquals(state, walletLiveUi(account(true, directory()), null, devnet = true, walletApp = null, faucet = state).faucet)
            assertEquals(FaucetUi.Hidden, walletLiveUi(account(true, directory()), null, devnet = false, walletApp = null, faucet = state).faucet)
        }
    }

    @Test fun `mainnet wallet keeps held doors unavailable and never exposes devnet or faucet state`() {
        val ui = walletLiveUi(account(true, directory()), null, devnet = false, walletApp = null,
            faucet = FaucetUi.NeedsDeed)

        assertFalse(ui.devnet)
        assertEquals(FaucetUi.Hidden, ui.faucet)
        assertNull("Seeker Island is the globe's island panel on every cluster", ui.seekerUnavailable)
        assertNotNull(ui.historyUnavailable)
        assertNotNull(ui.testSolUnavailable)
    }

    @Test fun `TEST SOL opens a supplied existing owner once and is available only on devnet`() {
        val devnet = walletLiveUi(account(true, directory()), null, devnet = true, walletApp = null,
            testSolAvailable = true)
        assertNull(devnet.testSolUnavailable)
        assertNull(devnet.seekerUnavailable)
        assertNotNull(devnet.historyUnavailable)
        assertEquals(FaucetUi.Hidden, devnet.faucet)
        val mainnet = walletLiveUi(account(true, directory()), null, devnet = false, walletApp = null,
            testSolAvailable = true)
        assertFalse(mainnet.devnet)
        assertNotNull(mainnet.testSolUnavailable)
        assertEquals(FaucetUi.Hidden, mainnet.faucet)

        var opened = 0
        val said = mutableListOf<String>()
        walletLiveActions(nav(said).copy(openTestSol = { opened++ })).onTestSol()
        assertEquals(1, opened)
        assertTrue(said.isEmpty())
        walletLiveActions(nav(said)).onTestSol()
        assertEquals(1, opened)
        assertEquals(listOf(MONEY_WIRING_PENDING), said)
    }

    @Test fun `switch only moves to another active kingdom that is not already loading`() {
        val selected = mutableListOf<String>()
        val ui = kingdomsLiveUi(account(true, directory(base("b1", 1), base("b2", 2), base("b3", 3)), selected = "b1"), null, switchingId = "b3")
        val on = kingdomsLiveActions(nav(mutableListOf(), selected), ui)
        on.onSwitch("b1"); on.onSwitch("b3"); on.onSwitch("b2"); on.onSwitch("nope")
        assertEquals(listOf("b2"), selected)
    }

    @Test fun `the last sign-in method is never unlinked, the header and 2-step read what the server said`() {
        val said = mutableListOf<String>()
        val unlinked = mutableListOf<ProviderKind>()
        val state = account(true, directory()).copy(security = SecurityStatus(totpEnabled = true))
        val ui = accountLiveUi(state, draft = null, saving = false, nameError = null, signingOut = false, walletApp = "Seed Vault")
        accountLiveActions(nav(said, unlinked = unlinked), ui).onUnlink(ProviderKind.WALLET)
        assertTrue(unlinked.isEmpty())
        assertEquals(1, said.size)
        assertEquals("Rowan", ui.nameDraft)
        assertEquals(true, ui.totpEnabled)
        assertNull(accountLiveUi(account(true, directory()), null, false, null, false, null).totpEnabled)
        val withSocial = accountLiveUi(state, null, false, null, false, null, socialKind = ProviderKind.GOOGLE, socialLabel = "t•••@gmail.com")
        accountLiveActions(nav(said, unlinked = unlinked), withSocial).onUnlink(ProviderKind.GOOGLE)
        assertEquals(listOf(ProviderKind.GOOGLE), unlinked)
        val header = profileHeaderLiveUi(account(true, directory(), name = null), homeKeepLevel = null, seekerMemberNumber = null, catalogue = null, snapshot = null)
        assertEquals(UNKNOWN, header.playerName)
        assertEquals("9", header.keepLevel)
        assertNull(header.seekerMember)
    }
}
