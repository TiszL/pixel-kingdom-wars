package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.Balances
import gg.pixelkingdomwars.nativeclient.model.BalanceFeatures
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

/** Owner 2026-09-18: "balance of shards didn't update instantly, needed to quit and relaunch after converting KEEP to
 * shards". The Home SHARDS/KEEP chips render `BaseState.balances`; the economy, withdrawal, deposit and mail flows
 * re-read `/balances` only into their own state. The rule pinned here: after any of those mutations is ACCEPTED, the
 * state the Home HUD renders equals the server's new balances, with no relaunch and no waiting for the Kingdom tick —
 * and that extra read can never turn the finished mutation into an interrupted one. Every fixture wires the hook the
 * way AppGraph.buildSession does (`homeHudRefresh { base.refresh() }` appended to the flow's post-acceptance hook). */
class HomeHudRefreshTest {
    // The fixture advertises legacy receipt features. The additive Gems DTO
    // retains that envelope, with no Gems capability, while ignoring its keys.
    private fun expectedBalances(shards: String, keep: String) = Balances(shards, keep, features = BalanceFeatures())

    /** The server's ledger, read by both caches. */
    private class Ledger(var shards: String = "100", var keep: String = "100") {
        fun balances() = JsonObject(balancesJson(shards, keep) + mapOf("features" to json("""{"conversionReceipts":{"version":1},"forgeContributionReceipts":{"version":1}}""")))
    }
    private class Home(val ledger: Ledger, holder: AccountSessionHolder, session: AccountSession, val api: FakeApiClient = FakeApiClient(), var offline: Boolean = false) {
        private val intents = PendingIntentStore(MemoryStore())
        val base = LiveBaseRepository(session, holder, api, intents, ReceiptObserver(intents), { BASE_ID })
        val hud = homeHudRefresh { base.refresh() }
        /** What HomeScaffold's chips render. */
        val chips: Balances? get() = base.state.value.balances
        init {
            api.onGet("/base") { if (offline) throw IOException("home read offline"); baseJson() }
            api.onGet("/balances") { ledger.balances() }
            api.onGet("/tutorial") { tutorialJson() }
        }
    }

    private class Economy(land: Boolean = false) {
        val holder = testHolder(); val session = signedIn(holder); val ledger = Ledger(); val api = FakeApiClient()
        val home = Home(ledger, holder, session, api)
        val disk = MemoryStore(); val intents = PendingIntentStore(disk)
        val events = mutableListOf<String>()
        val repository = LiveEconomyRepository(session, holder, api, { BASE_ID }, { land }, intents, ReceiptObserver(intents),
            refreshAccount = { events += "account"; home.hud(); events += "hud" })
        init {
            api.onGet("/forge") { json("""{"day":"2026-09-12","cycleEndsAt":"2026-09-13T00:00:00Z","dailyEmissionKeep":"100","totalShards":"50","myShards":"10","myShardBalance":"100","goldforgeLevel":1,"myDailyCapShards":"100","claimable":{"totalKeep":"0","count":0}}""") }
        }
        fun accepting(spec: EconomySpec, settle: (String) -> Unit) {
            api.onPost(spec.path) { body ->
                settle(body[if (spec == KeepConversionSpec) "keep" else "shards"]!!.jsonPrimitive.content); events += "accepted"
                json("""{"day":"2026-09-12","myShards":"999","converted":"10","shards":"10","rate":1}""")
            }
            api.onGet("${spec.path}/receipt") { q ->
                val body = JsonObject(q.mapValues { JsonPrimitive(it.value) })
                buildJsonObject {
                    put("version", 1); put("status", "accepted"); put("wallet", session.wallet); put("baseId", body["baseId"] ?: JsonNull); put("request", body)
                    put("receiptId", "65ae967a-bf89-4e01-bcae-52a48ffdc768"); put("acceptedAt", "2026-09-12T00:00:00.000Z")
                    val amount = body[if (spec == KeepConversionSpec) "keep" else "shards"]!!.jsonPrimitive.content
                    put("funding", buildJsonObject { put("currency", if (spec == KeepConversionSpec) "KEEP" else "SHARDS"); put("amount", amount) })
                    put("result", if (spec == KeepConversionSpec) buildJsonObject { put("converted", amount); put("shards", (amount.toBigInteger() * 3.toBigInteger()).toString()); put("rate", 3) }
                        else buildJsonObject { put("day", "2026-09-13"); put("contributedShards", amount) })
                }
            }
        }
    }

    private class Flow(val name: String, val expected: Balances, val run: suspend () -> Balances?)

    @Test fun `after each accepted KEEP or Shards mutation the Home HUD shows the server's new balances without a relaunch`() = runBlocking {
        val flows = listOf(
            Flow("KEEP to Shards conversion", expectedBalances("130", "90")) {
                val f = Economy(); f.home.base.refresh(); assertEquals(expectedBalances("100", "100"), f.home.chips)
                f.accepting(KeepConversionSpec) { keep -> f.ledger.keep = (f.ledger.keep.toBigInteger() - keep.toBigInteger()).toString(); f.ledger.shards = (f.ledger.shards.toBigInteger() + keep.toBigInteger() * 3.toBigInteger()).toString() }
                f.repository.confirm(f.repository.review(EconomyAction.CONVERT, "10"))
                assertEquals("The HUD is re-read only after the server accepted, and before the result is published", listOf("accepted", "account", "hud"), f.events)
                assertNull("The proven intent is retired", f.disk.value); f.home.chips
            },
            Flow("Forge contribution", expectedBalances("90", "100")) {
                val f = Economy(land = true); f.home.base.refresh()
                f.accepting(ForgeContributionSpec) { shards -> f.ledger.shards = (f.ledger.shards.toBigInteger() - shards.toBigInteger()).toString() }
                f.repository.confirm(f.repository.review(EconomyAction.CONTRIBUTE, "10")); f.home.chips
            },
            Flow("withdrawal unwind (KEEP returned)", expectedBalances("3520", "1000")) {
                val f = WithdrawalUnwindFixture(); val ledger = Ledger("3520", "900")
                val home = Home(ledger, f.holder, f.session); home.base.refresh(); assertEquals("900", home.chips!!.keep)
                val compensate = f.postHandler
                f.postHandler = { path, body -> compensate(path, body).also { ledger.keep = "1000"; f.balance = balancesJson(keep = "1000") } }
                f.onAccount = { home.hud() }
                f.unwind(WithdrawalUnwindAction.CANCEL); assertNull(f.saved()); home.chips
            },
            Flow("mail reward claim", expectedBalances("140", "100")) {
                val holder = testHolder(); val session = signedIn(holder); val ledger = Ledger(); val api = FakeApiClient()
                val home = Home(ledger, holder, session, api); home.base.refresh()
                val store = PendingIntentStore(MemoryStore()); val id = "eee0575f-6df7-4672-91ea-33f497d2e1d6"
                fun mail(claimed: Boolean) = json("""{"id":"$id","sender":"system","kind":"reward","subject":"Gift","body":"Enjoy your reward",
                    "attachments":[{"kind":"SHARDS","amount":"40"}],"rewardState":"${if (claimed) "claimed" else "pending"}","claimBaseId":${if (claimed) "\"$BASE_ID\"" else "null"},
                    "createdAt":"2026-09-12T00:00:00Z","expiresAt":"2026-10-12T00:00:00Z","readAt":null,"archivedAt":null,
                    "claimedAt":${if (claimed) "\"2026-09-12T00:00:01Z\"" else "null"},"expiredAt":null}""")
                var message = mail(false)
                api.onGet("/mail/$id") { message }; api.onGet("/mail/status") { json("""{"total":1,"unread":1,"pendingRewards":1}""") }
                api.onPost("/mail/$id/claim") { ledger.shards = "140"; message = mail(true); message }
                val mailbox = LiveCommunityRepository(session, holder, api, store, ReceiptObserver(store), { BASE_ID }, { MailBounds(20, 50) }, home.hud)
                mailbox.openMail(id); mailbox.claim(id, BASE_ID)
                assertNull(store.get(IntentKind.MAIL_CLAIM, WALLET)); home.chips
            },
        )
        for (flow in flows) assertEquals(flow.name, flow.expected, flow.run())
    }

    @Test fun `a failed Home read after acceptance never strands the accepted mutation`() = runBlocking {
        val f = Economy(); f.home.base.refresh(); f.home.offline = true
        f.accepting(KeepConversionSpec) { f.ledger.keep = "90"; f.ledger.shards = "130" }
        f.repository.confirm(f.repository.review(EconomyAction.CONVERT, "10"))
        assertEquals("The conversion is published as accepted", "30", f.repository.state.value.accepted!!.outputShards)
        assertNull("and its intent retired, not left 'interrupted' behind a best-effort HUD read", f.disk.value)
        assertEquals("The Economy screen has the new amount; the HUD keeps its last one until the next read", expectedBalances("130", "90"), f.repository.state.value.balances)
        f.home.offline = false; f.home.hud(); assertEquals(expectedBalances("130", "90"), f.home.chips)
    }

    @Test fun `the hook swallows a failed or superseded Home read but never a revoked session or real cancellation`() = runBlocking {
        homeHudRefresh { throw IOException("offline") }()
        homeHudRefresh { throw IllegalStateException("The selected base changed. Refresh your kingdom again.") }()
        // LiveBaseRepository reports a superseded read as a CancellationException; the caller's coroutine is still active.
        homeHudRefresh { throw CancellationException("Home balances superseded") }()
        val expired = runCatching { homeHudRefresh { throw ApiException(401, "SESSION_EXPIRED", "Expired") }() }.exceptionOrNull()
        assertEquals(401, (expired as ApiException).status)
        var reached = false
        val job = launch(Dispatchers.Default) { homeHudRefresh { awaitCancellation() }(); reached = true }
        delay(50); job.cancelAndJoin()
        assertFalse("A cancelled action does not continue past the hook", reached)
    }
}
