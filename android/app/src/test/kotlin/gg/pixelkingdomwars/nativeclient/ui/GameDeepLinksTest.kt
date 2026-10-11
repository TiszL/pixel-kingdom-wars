package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.data.AccountPhase
import gg.pixelkingdomwars.nativeclient.data.AccountState
import gg.pixelkingdomwars.nativeclient.data.EntryRecovery
import gg.pixelkingdomwars.nativeclient.data.PendingAdmission
import gg.pixelkingdomwars.nativeclient.data.SeekerIdentityStatus
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.testToken
import gg.pixelkingdomwars.nativeclient.ui.nav.*
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class GameDeepLinksTest {
    private val origin = "https://play.pixelkingdomwars.com"
    private val view = "android.intent.action.VIEW"
    private val session = AccountSession("wallet-a", origin, testToken())
    private val signedIn = AccountState(phase = AccountPhase.SIGNED_IN, session = session, selectedBaseId = "base-a")
    private val safe = GameLinkEntry(resumed = true, onHome = true, admitted = true, selectedBaseId = "base-a",
        hydratedBaseId = "base-a", recoveryComplete = true, blocked = false)
    private fun PendingGameLinks.capture(screen: String, account: AccountState = signedIn, current: AccountSession? = session,
                                         restored: Boolean = false): Boolean =
        capture(view, "$origin/?screen=$screen", restored, account, current, origin, offline = false)

    @Test fun `canonical push targets and mobile launch qualifier are accepted without choosing any wallet`() {
        for (screen in GameLinkScreen.entries) {
            assertEquals(screen, GameLinkContract.parse(view, "$origin/?screen=${screen.query}"))
            assertEquals(screen, GameLinkContract.parse(view, "$origin/?client=solana-mobile&screen=${screen.query}"))
        }
        assertEquals(GameLinkScreen.MAIL, GameLinkContract.parse(view, "$origin?screen=ma%69l"))
    }

    @Test fun `scheme origin path and authority must all be the production game root`() {
        for (url in listOf("http://play.pixelkingdomwars.com/?screen=mail", "https://evil.example/?screen=mail",
            "https://play.pixelkingdomwars.com.evil.example/?screen=mail", "https://user@play.pixelkingdomwars.com/?screen=mail",
            "$origin:443/?screen=mail", "$origin:/?screen=mail", "$origin/mail?screen=mail", "$origin//?screen=mail",
            "$origin/%2f?screen=mail", "$origin/../?screen=mail", "$origin/?screen=mail#base", "//$origin/?screen=mail",
            "https://play.pixelkingdomwars.com\\@evil.example/?screen=mail", " $origin/?screen=mail")) {
            assertNull(url, GameLinkContract.parse(view, url))
        }
    }

    @Test fun `query cannot select arbitrary routes accounts deeds or duplicate ambiguous keys`() {
        for (query in listOf("screen=withdraw", "screen=admin", "screen=MAIL", "screen=", "screen", "screen=mail&screen=base",
            "screen=mail&%73creen=bases", "screen=mail&wallet=other", "screen=mail&baseId=other", "screen=mail&ref=code",
            "screen=mail&client=browser", "client=solana-mobile", "screen=mail&", "screen=%", "screen=mail%00", "screen=mail+")) {
            assertNull(query, GameLinkContract.parse(view, "$origin/?$query"))
        }
    }

    @Test fun `launcher and wallet OAuth return intents are never interpreted as navigation`() {
        assertNull(GameLinkContract.parse("android.intent.action.MAIN", "$origin/?screen=mail"))
        assertNull(GameLinkContract.parse(null, "$origin/?screen=mail"))
        assertNull(GameLinkContract.parse(view, null))
        assertNull(GameLinkContract.parse(view, "pixelkingdomwars://oauth/callback?screen=mail"))
        assertNull(GameLinkContract.parse(view, "solana-wallet://v1/associate?screen=mail"))
        val links = PendingGameLinks(); links.capture("bases")
        assertFalse(links.capture(view, "pixelkingdomwars://oauth/callback?screen=mail", false, signedIn, session, origin, false))
        assertEquals("Callback remains the SDK's responsibility and cannot replace a pending game target", GameLinkScreen.BASES, links.pending.value)
    }

    @Test fun `local backend and offline preview never gain live navigation from a production link`() {
        val links = PendingGameLinks()
        assertFalse(links.capture(view, "$origin/?screen=mail", false, signedIn, session, "https://localhost:18443", false))
        assertFalse(links.capture(view, "$origin/?screen=mail", false, signedIn, session, origin, true))
        assertNull(links.pending.value)
    }

    @Test fun `cold launch waits through restoration and login then consumes only the hydrated admitted identity`() {
        val links = PendingGameLinks(); val restoring = AccountState()
        assertTrue(links.capture("mail", restoring, null))
        assertNull(links.take(restoring, null, safe))
        val title = AccountState(phase = AccountPhase.SIGNED_OUT)
        links.observeIdentity(title, null)
        assertNull(links.take(title, null, safe))
        assertEquals(GameLinkScreen.MAIL, links.pending.value)
        assertNull(links.take(signedIn, session, safe.copy(hydratedBaseId = null)))
        assertEquals(GameLinkScreen.MAIL, links.take(signedIn, session, safe))
        assertNull("Subsequent hydration and recomposition never route twice", links.take(signedIn, session, safe))
    }

    @Test fun `warm duplicate delivery queues one target and newest valid tap wins`() {
        val links = PendingGameLinks()
        repeat(3) { assertTrue(links.capture("raidlog")) }
        assertEquals(GameLinkScreen.RAIDLOG, links.pending.value)
        assertTrue(links.capture("bases"))
        assertFalse(links.capture("security"))
        assertEquals(GameLinkScreen.BASES, links.take(signedIn, session, safe))
        assertNull(links.take(signedIn, session, safe))
    }

    @Test fun `duplicate on an already visible page cannot reopen it after Back`() {
        val links = PendingGameLinks()
        for (screen in listOf(GameLinkScreen.RAIDLOG, GameLinkScreen.MAIL, GameLinkScreen.BASES)) {
            links.capture(screen.query)
            links.acknowledgeVisible(signedIn, session, screen, resumed = true)
            assertNull(links.pending.value)
            assertNull("Back returns Home normally", links.take(signedIn, session, safe))
        }
    }

    @Test fun `warm capture on the currently visible target is satisfied synchronously before immediate Back`() {
        val links = PendingGameLinks(); var visible: GameLinkScreen? = GameLinkScreen.MAIL
        links.visibleScreen = { visible }
        links.capture("mail")
        assertNull("No Compose effect needs to win the race with Back", links.pending.value)
        visible = null
        assertNull(links.take(signedIn, session, safe))
        links.capture("mail")
        assertEquals("A fresh explicit tap after leaving the page still works", GameLinkScreen.MAIL, links.take(signedIn, session, safe))
    }

    @Test fun `a different warm target waits through the current screen and wallet return`() {
        val links = PendingGameLinks(); links.capture("bases")
        links.acknowledgeVisible(signedIn, session, GameLinkScreen.MAIL, true)
        assertNull(links.take(signedIn, session, safe.copy(onHome = false)))
        assertNull("PAUSE without STOP still blocks a translucent wallet handoff", links.take(signedIn, session, safe.copy(resumed = false)))
        assertEquals(GameLinkScreen.BASES, links.take(signedIn, session, safe))
    }

    @Test fun `configuration restoration retains memory but never recaptures the stripped launch and process death drops pending`() {
        val links = PendingGameLinks(); links.capture("raidlog")
        assertFalse(links.capture("mail", restored = true))
        assertEquals(GameLinkScreen.RAIDLOG, links.take(signedIn, session, safe))
        val afterProcessDeath = PendingGameLinks()
        assertFalse(afterProcessDeath.capture("raidlog", restored = true))
        assertNull(afterProcessDeath.pending.value)
        assertTrue("An actual later onNewIntent is an explicit new tap", afterProcessDeath.capture("mail"))
        assertEquals(GameLinkScreen.MAIL, afterProcessDeath.take(signedIn, session, safe))
    }

    @Test fun `content alpha admission land gate wrong base and unfinished hydration never consume`() {
        val links = PendingGameLinks(); links.capture("mail")
        for (entry in listOf(safe.copy(admitted = false), safe.copy(onHome = false), safe.copy(selectedBaseId = null),
            safe.copy(hydratedBaseId = "other-base"), safe.copy(hydratedBaseId = null), safe.copy(recoveryComplete = false))) {
            assertNull(links.take(signedIn, session, entry))
            assertEquals(GameLinkScreen.MAIL, links.pending.value)
        }
        assertNull(links.take(signedIn.copy(busy = true), session, safe))
        assertEquals(GameLinkScreen.MAIL, links.take(signedIn, session, safe))
    }

    @Test fun `battle scout replay watch and order recovery block delivery even while Home route is still composing`() {
        val links = PendingGameLinks(); links.capture("raidlog")
        assertNull("A still-visible Home destination cannot override an active scene or pending order", links.take(signedIn, session, safe.copy(blocked = true)))
        assertEquals(GameLinkScreen.RAIDLOG, links.pending.value)
        assertEquals(GameLinkScreen.RAIDLOG, links.take(signedIn, session, safe))
    }

    @Test fun `failed march read stays blocking and successful history recovery can release without replaying any order`() = runBlocking {
        val links = PendingGameLinks(); links.capture("mail")
        val recovery = EntryRecoveryState()
        assertNull(recovery.check("base-a") { throw java.io.IOException("offline") })
        assertNull(links.take(signedIn, session, safe.copy(recoveryComplete = recovery.completedFor("base-a"))))
        assertEquals(EntryRecovery.HISTORY, recovery.check("base-a") { EntryRecovery.HISTORY })
        assertEquals(GameLinkScreen.MAIL, links.take(signedIn, session, safe.copy(recoveryComplete = recovery.completedFor("base-a"))))
        assertFalse("A new selected deed does not inherit another deed's recovery", recovery.completedFor("base-b"))
    }

    @Test fun `Back closes the existing confirmation before queued navigation and cannot fire a payment`() {
        val links = PendingGameLinks(); links.capture("mail")
        val registry = BackRegistry(); var confirmationsClosed = 0
        registry.register(BackPriority.HOME) { error("The confirmation owns Back") }
        lateinit var confirm: BackRegistry.Registration
        confirm = registry.register(BackPriority.CONFIRM) { confirmationsClosed++; registry.unregister(confirm) }
        val before = registry.changes.value
        assertNull(links.take(signedIn, session, safe.copy(blocked = registry.active()!!.priority > BackPriority.HOME)))
        assertTrue(registry.dispatch()); assertEquals(1, confirmationsClosed)
        assertTrue("No polling: closing the interaction wakes the pending link", registry.changes.value > before)
        assertEquals(GameLinkScreen.MAIL, links.take(signedIn, session, safe.copy(blocked = registry.active()!!.priority > BackPriority.HOME)))
    }

    @Test fun `an editor or temporarily enabled sheet owns navigation until released`() {
        val links = PendingGameLinks(); links.capture("bases")
        val registry = BackRegistry()
        val sheet = registry.register(BackPriority.SHEET, enabled = false) { }
        val before = registry.changes.value
        sheet.enabled = true
        assertTrue(registry.changes.value > before)
        assertNull(links.take(signedIn, session, safe.copy(blocked = registry.active() != null)))
        registry.unregister(sheet)
        val editor = registry.register(BackPriority.LAYOUT_EDITOR) { }
        assertNull(links.take(signedIn, session, safe.copy(blocked = registry.active() != null)))
        registry.unregister(editor)
        assertEquals(GameLinkScreen.BASES, links.take(signedIn, session, safe.copy(blocked = registry.active() != null)))
    }

    @Test fun `logout and a new epoch of the same wallet discard old targets before any later base can receive them`() {
        for (replaceDirectly in listOf(false, true)) {
            val links = PendingGameLinks(); links.capture("mail")
            val next = AccountSession(session.wallet, origin, testToken())
            if (!replaceDirectly) links.observeIdentity(AccountState(phase = AccountPhase.SIGNED_OUT), null)
            assertNull(links.take(signedIn.copy(session = next), next, safe))
            assertNull(links.pending.value)
        }
    }

    @Test fun `a fresh intent during logout publication cannot follow a new account or same wallet epoch`() {
        for (replacement in listOf(null, AccountSession("wallet-b", origin, testToken()), AccountSession(session.wallet, origin, testToken()))) {
            val links = PendingGameLinks()
            links.capture("mail", signedIn, replacement)
            assertNull("The old AccountState remains an identity fence even after the holder changed", links.pending.value)
            val next = replacement ?: AccountSession("wallet-b", origin, testToken())
            assertNull(links.take(signedIn.copy(session = next), next, safe))
        }
    }

    @Test fun `pending TOTP and admission can continue the same wallet but never cross to another`() {
        val admission = PendingAdmission(session.wallet, testToken(), SeekerIdentityStatus(false, null, null, null, null, null, false, 0, false))
        for (pending in listOf(AccountState(phase = AccountPhase.TOTP, pendingWallet = session.wallet),
            AccountState(phase = AccountPhase.ALPHA, admission = admission))) {
            val links = PendingGameLinks(); links.capture("mail", pending, null)
            assertNull(links.take(pending, null, safe))
            assertEquals(GameLinkScreen.MAIL, links.take(signedIn, session, safe))
            links.capture("bases", pending, null)
            val other = AccountSession("wallet-b", origin, testToken())
            assertNull(links.take(signedIn.copy(session = other), other, safe))
            assertNull(links.pending.value)
            links.capture("mail", pending, null)
            links.observeIdentity(AccountState(phase = AccountPhase.SIGNED_OUT), null)
            assertNull(links.pending.value)
        }
    }

    @Test fun `stale account state cannot authorize delivery with a new holder`() {
        val links = PendingGameLinks(); val next = AccountSession("wallet-b", origin, testToken())
        links.capture("mail", AccountState(phase = AccountPhase.SIGNED_OUT), null)
        assertNull(links.take(signedIn, next, safe))
        assertEquals(GameLinkScreen.MAIL, links.pending.value)
        assertEquals(GameLinkScreen.MAIL, links.take(signedIn.copy(session = next), next, safe))
    }

    @Test fun `base is consumed once as a local Kingdom selection rather than opening another account or base`() {
        val links = PendingGameLinks(); links.capture("base")
        links.acknowledgeVisible(signedIn, session, GameLinkScreen.BASE, true)
        assertEquals("Home may be on another tab, so base still needs its local selection", GameLinkScreen.BASE, links.pending.value)
        assertEquals(GameLinkScreen.BASE, links.take(signedIn, session, safe))
        assertNull(links.take(signedIn, session, safe))
    }

    @Test fun `unsupported canonical referral queries retain their exact URL for deliberate browser handoff`() {
        val links = PendingGameLinks()
        for (suffix in listOf("?ref=original%2Bcode&client=solana-mobile", "?screen=mail&ref=original", "?screen=future&x=a+b#context", "")) {
            val url = "$origin/$suffix"
            assertFalse(links.capture(view, url, false, signedIn, session, origin, false))
            assertTrue(links.offerBrowser(view, url, false, false))
            assertEquals("Never normalize away attribution or future web parameters", url, links.browser.value?.url)
            assertNull(links.pending.value)
        }
    }

    @Test fun `browser fallback cannot become an arbitrary external URL launcher or catch a wallet callback`() {
        val links = PendingGameLinks()
        for (url in listOf("https://evil.example/?ref=x", "http://play.pixelkingdomwars.com/?ref=x", "$origin/other?ref=x",
            "https://user@play.pixelkingdomwars.com/?ref=x", "$origin:443/?ref=x", "pixelkingdomwars://callback?ref=x", "solana-wallet://callback")) {
            assertFalse(url, links.offerBrowser(view, url, false, false))
        }
        assertFalse(links.offerBrowser("android.intent.action.MAIN", "$origin/?ref=x", false, false))
        assertFalse(links.offerBrowser(view, "$origin/?ref=x", true, false))
        assertFalse(links.offerBrowser(view, "$origin/?ref=x", false, true))
        assertNull(links.browser.value)
    }

    @Test fun `missing browser preserves original URL for retry or explicit copy and stale completion cannot clear a newer link`() {
        val links = PendingGameLinks()
        links.offerBrowser(view, "$origin/?ref=original", false, false)
        val original = requireNotNull(links.browser.value)
        links.browserFailed(original)
        val failed = requireNotNull(links.browser.value)
        assertEquals(original.url, failed.url); assertTrue(failed.unavailable)
        links.offerBrowser(view, "$origin/?ref=newer", false, false)
        links.closeBrowser(failed)
        assertEquals("$origin/?ref=newer", links.browser.value?.url)
        links.closeBrowser(requireNotNull(links.browser.value))
        assertNull(links.browser.value)
    }

    @Test fun `only enabled exported external browser components are eligible so association never loops into this app`() {
        val own = "gg.pixelkingdomwars.twa"
        val browser = GameBrowserActivity("browser.app", "BrowserActivity", true, true)
        val candidates = listOf(browser, browser, GameBrowserActivity(own, "MainActivity", true, true),
            GameBrowserActivity("wallet.app", "WalletActivity", true, true), browser.copy(activityName = "Private", exported = false),
            browser.copy(activityName = "Disabled", enabled = false))
        assertEquals(listOf(browser), externalGameBrowsers(setOf(own, "browser.app"), candidates, own))
        assertTrue(externalGameBrowsers(emptySet(), candidates, own).isEmpty())
    }

    @Test fun `new explicit native or browser target replaces only the older navigation request`() {
        val links = PendingGameLinks(); links.capture("mail")
        links.offerBrowser(view, "$origin/?ref=original", false, false)
        assertNull(links.pending.value)
        val oldBrowser = requireNotNull(links.browser.value)
        links.capture("bases")
        links.browserFailed(oldBrowser)
        assertNull(links.browser.value)
        assertEquals(GameLinkScreen.BASES, links.take(signedIn, session, safe))
    }

    @Test fun `manifest exposes only fixed HTTPS root and retains separate Privy callback ownership`() {
        val document = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }.newDocumentBuilder().parse(File("src/main/AndroidManifest.xml"))
        val activities = document.getElementsByTagName("activity")
        val android = "http://schemas.android.com/apk/res/android"
        val main = (0 until activities.length).map { activities.item(it) as org.w3c.dom.Element }.single { it.getAttributeNS(android, "name") == ".MainActivity" }
        val links = main.getElementsByTagName("data")
        assertEquals(1, links.length)
        val link = links.item(0) as org.w3c.dom.Element
        assertEquals("https", link.getAttributeNS(android, "scheme")); assertEquals("\${nativeLinkHost}", link.getAttributeNS(android, "host"))
        val build = File("build.gradle.kts").readText()
        assertTrue("Release link origin remains production; only the candidate debug block overrides it",
            build.contains("manifestPlaceholders[\"nativeLinkHost\"] = \"play.pixelkingdomwars.com\""))
        assertEquals("/", link.getAttributeNS(android, "path")); assertFalse(link.hasAttributeNS(android, "pathPrefix"))
        val privy = (0 until activities.length).map { activities.item(it) as org.w3c.dom.Element }.single { it.getAttributeNS(android, "name") == "io.privy.sdk.oAuth.PrivyRedirectActivity" }
        assertEquals("pixelkingdomwars", (privy.getElementsByTagName("data").item(0) as org.w3c.dom.Element).getAttributeNS(android, "scheme"))
        assertEquals("singleTask", privy.getAttributeNS(android, "launchMode"))
    }
}
