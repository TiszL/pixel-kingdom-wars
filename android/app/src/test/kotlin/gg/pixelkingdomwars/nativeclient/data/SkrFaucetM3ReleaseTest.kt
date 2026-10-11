package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.wallet.SkrIdentity
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.util.UUID

/** review 8938311c M3: grant-less unsigned intent release is not a money receipt.
 * Actual P5 vectors remain mandatory; adversarial copies are not acceptance captures. */
class SkrFaucetM3ReleaseTest {
    private fun vector(name: String): JsonObject {
        val input = javaClass.getResourceAsStream("/skr-faucet-discovery-vectors.json")
        assertNotNull("MISSING: actual authenticated P5 discovery route vectors", input)
        return Json.parseToJsonElement(input!!.bufferedReader().use { it.readText() }).jsonObject.getValue(name).jsonObject
    }
    private inner class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient(); val disk = MemoryStore()
        val journal = SkrFaucetJournal(disk, session.wallet, session.origin, "devnet")
        val target = SkrFaucetGrant.from(vector("pendingPage").getValue("items").jsonArray.single().jsonObject)
        val day = Instant.parse(target.requestedAt).atOffset(ZoneOffset.UTC).toLocalDate()
        var base = "11111111-1111-4111-8111-111111111111"
        var pin: SkrIdentity? = SkrIdentity(target.mint, target.decimals)
        var policy: SkrFaucetBounds? = SkrFaucetBounds(5000, "1000", 20)
        var epoch = 0L; var prompts = 0
        fun repository() = SkrFaucetRepository(session, holder, api, journal, { pin }, { policy }, { base },
            { _, _, _ -> prompts++ }, {}, actionEpoch = { epoch })
        val repo = repository()
        fun status(onDay: LocalDate = day, today: JsonObject? = null, reason: String = "ok") =
            JsonObject(vector("beforeClaimStatus") + mapOf("day" to JsonPrimitive(onDay.toString()),
                "nextEligibleAt" to JsonPrimitive("${onDay.plusDays(1)}T00:00:00.000Z"),
                "enabled" to JsonPrimitive(true), "eligible" to JsonPrimitive(today == null && reason == "ok"),
                "today" to (today ?: JsonNull), "reason" to JsonPrimitive(reason)))
        fun pending(claimDay: LocalDate? = day) = journal.beginIfEmpty(base, claimDay?.toString())
        fun nextDay() { api.onGet("/devnet-skr-faucet/status") { status(day.plusDays(1)) } }
        fun page(start: Int, count: Int = 20, more: Boolean = true): JsonObject {
            val rows = (start until start + count).map { n -> JsonObject(target.raw + mapOf(
                "id" to JsonPrimitive(UUID.nameUUIDFromBytes("m3-grant-$n".toByteArray()).toString()),
                "requestedAt" to JsonPrimitive("${day.minusDays(n.toLong())}T12:00:00.000Z"), "attempt" to JsonNull)) }
            return buildJsonObject { put("items", JsonArray(rows)); put("nextCursor", if (more) rows.last().getValue("id") else JsonNull) }
        }
        fun empty() = vector("emptyPage")
        fun assertReadOnly() { assertTrue(api.posts.isEmpty()); assertEquals(0, prompts) }
    }
    @Test fun `definitive claim code and status pairs release only that unsigned intent and require fresh explicit action`() = runBlocking {
        val refusals = mapOf("SKR_FAUCET_DISABLED" to 503, "SKR_FAUCET_UNCONFIGURED" to 503,
            "SKR_FAUCET_MINT_CHANGED" to 503, "SKR_FAUCET_DAY_CHANGED" to 409,
            "SKR_FAUCET_DEED_REQUIRED" to 409, "SKR_FAUCET_INVALID_REQUEST" to 400,
            "DEED_AUTHORITY_UNAVAILABLE" to 503, "DEED_OWNERSHIP_CHANGED" to 409,
            "BASE_NOT_OWNED" to 404, "BASE_ID_REQUIRED" to 409)
        for ((code, status) in refusals) {
            val f = Fixture(); f.api.onGet("/devnet-skr-faucet/status") { f.status() }
            f.api.onPost("/devnet-skr-faucet/claim") { assertNotNull(f.journal.read()); throw ApiException(status, code, "refused") }
            f.repo.claim()
            assertNull(code, f.journal.read()); assertFalse(f.repo.state.value.uncertain); assertFalse(f.repo.state.value.canClaim)
            assertNull(f.repo.state.value.grant); assertNull(f.repo.state.value.discoveryNextCursor)
            assertFalse(f.repo.state.value.error.orEmpty().contains("preserved", ignoreCase = true))
            assertEquals(1, f.api.posts.size); assertEquals(0, f.prompts)
            f.repo.refresh(); assertTrue(f.repo.state.value.canClaim); assertEquals(1, f.api.posts.size)
            f.repo.claim(); assertEquals(2, f.api.posts.size) // New explicit action performs its own fresh status.
            assertEquals(3, f.api.gets.count { it.first == "/devnet-skr-faucet/status" })
        }
    }
    @Test fun `unknown transport uncoded unavailable wrong-status and non-claim codes retain exact intent bytes`() = runBlocking {
        for (error in listOf(IOException("lost reply"), ApiException(503, null, "proxy"),
            ApiException(503, "SKR_FAUCET_UNAVAILABLE", "unknown"), ApiException(409, "FUTURE_CLAIM_CODE", "unknown"),
            ApiException(500, "DEED_AUTHORITY_UNAVAILABLE", "wrong status"), ApiException(409, "SKR_FAUCET_SOL_FOR_FEE", "prepare only"))) {
            val f = Fixture(); var original: String? = null
            f.api.onGet("/devnet-skr-faucet/status") { f.status() }
            f.api.onPost("/devnet-skr-faucet/claim") { original = f.disk.value; throw error }
            f.repo.claim(); assertEquals(original, f.disk.value); assertTrue(f.repo.state.value.uncertain)
            assertFalse(f.repo.state.value.canClaim); assertEquals(1, f.api.posts.size); assertEquals(0, f.prompts)
        }
    }
    @Test fun `daily conflict releases only on exact owned lookup refusal and preserves ambiguous details or lookup errors`() = runBlocking {
        for (case in listOf("owned404", "uncoded404", "unknown404", "transport", "malformed", "nullToday", "mismatch")) {
            val f = Fixture(); var original: String? = null
            f.api.onGet("/devnet-skr-faucet/status") { f.status() }
            f.api.onPost("/devnet-skr-faucet/claim") {
                original = f.disk.value
                val today: JsonElement = when (case) { "malformed" -> JsonPrimitive("bad"); "nullToday" -> JsonNull; else -> f.target.raw }
                throw ApiException(429, "SKR_FAUCET_DAILY_LIMIT", "reserved", details = buildJsonObject { put("today", today) })
            }
            f.api.onGet("/devnet-skr-faucet/grants/${f.target.id}") {
                when (case) {
                    "owned404" -> throw ApiException(404, "SKR_FAUCET_NOT_OWNED", "not owned")
                    "uncoded404" -> throw ApiException(404, null, "route absent")
                    "unknown404" -> throw ApiException(404, "FUTURE_CODE", "unknown")
                    "transport" -> throw IOException("read lost")
                    else -> buildJsonObject { put("grant", JsonObject(f.target.raw + ("id" to JsonPrimitive(UUID.randomUUID().toString())))) }
                }
            }
            f.repo.claim()
            if (case == "owned404") { assertNull(f.journal.read()); assertFalse(f.repo.state.value.uncertain) }
            else { assertEquals(case, original, f.disk.value); assertTrue(f.repo.state.value.uncertain) }
            assertEquals(1, f.api.posts.size); assertFalse(f.repo.state.value.canClaim); assertEquals(0, f.prompts)
        }
    }
    @Test fun `a coded refusal cannot clear evidence replaced while the claim was awaiting or after context changed`() = runBlocking {
        for (replacement in listOf(false, true)) {
            val f = Fixture(); var retained: String? = null
            f.api.onGet("/devnet-skr-faucet/status") { f.status() }
            f.api.onPost("/devnet-skr-faucet/claim") {
                if (replacement) f.journal.begin(f.base, f.day.toString()) else f.epoch++
                retained = f.disk.value; throw ApiException(503, "DEED_AUTHORITY_UNAVAILABLE", "refused")
            }
            f.repo.claim(); assertEquals(retained, f.disk.value); assertNotNull(f.journal.read()); assertEquals(1, f.api.posts.size)
        }
    }
    @Test fun `complete empty list releases a past server-day intent but current action stays nonactionable`() = runBlocking {
        val f = Fixture(); f.pending(); f.nextDay(); f.api.onGet("/devnet-skr-faucet/grants") { f.empty() }
        f.repo.refresh(); assertNull(f.journal.read()); assertFalse(f.repo.state.value.uncertain); assertFalse(f.repo.state.value.canClaim)
        assertNull(f.repo.state.value.grant); assertNull(f.repo.state.value.discoveryNextCursor); f.assertReadOnly()
        f.repo.refresh(); assertTrue(f.repo.state.value.canClaim); f.assertReadOnly()
    }
    // Rewritten 2026-10-06 (night/d-faucet): this pinned review 8938311c's rule that a legacy no-day intent is never released.
    // The owner's later dead-end rule (2993bfa7, "no saved request may block play forever"; notes/d-recovery.md) releases it
    // after a complete guarded scan whose every page holds zero requested grants, and that commit rewrote the rule's other
    // two legacy pins (SkrFaucetDiscoveryTest, SkrFaucetUnknownIntentTest; SkrFaucetNoDayReleaseTest is its own pin). This
    // third pin was missed while the P5 vectors were absent. Same-day and future-day intents, and EVERY intent, dated or
    // legacy, without the policy cap or the pin, are still never released by an empty discovery; the legacy release itself
    // is pinned below as read-only and nonactionable.
    @Test fun `same-day future-day and missing-policy intents cannot be released by empty discovery and a legacy one only by a complete scan`() = runBlocking {
        for (case in listOf("same", "future", "noCap", "noPin", "legacyNoCap", "legacyNoPin")) {
            val legacy = case.startsWith("legacy")
            val f = Fixture(); f.pending(when { legacy -> null; case == "future" -> f.day.plusDays(2); else -> f.day })
            if (case in setOf("noCap", "legacyNoCap")) f.policy = SkrFaucetBounds(5000, "1000")
            if (case in setOf("noPin", "legacyNoPin")) f.pin = null
            f.api.onGet("/devnet-skr-faucet/status") { f.status(if (case == "same") f.day else f.day.plusDays(1)) }
            f.api.onGet("/devnet-skr-faucet/grants") { f.empty() }; val before = f.disk.value
            f.repo.refresh(); assertEquals(case, before, f.disk.value); assertTrue(f.repo.state.value.uncertain); f.assertReadOnly()
        }
        val f = Fixture(); f.pending(null); f.nextDay(); f.api.onGet("/devnet-skr-faucet/grants") { f.empty() }
        f.repo.refresh()
        assertNull(f.journal.read()); assertFalse(f.repo.state.value.uncertain); assertFalse(f.repo.state.value.canClaim)
        assertEquals(1, f.api.gets.count { it.first == "/devnet-skr-faucet/grants" }); f.assertReadOnly()
    }
    @Test fun `complete multi-page no-match proof starts at head and releases only after explicit final page`() = runBlocking {
        val f = Fixture(); f.pending(f.day.minusDays(100)); f.nextDay(); val first = f.page(0); val second = f.page(20)
        val firstCursor = first.getValue("nextCursor").jsonPrimitive.content; val secondCursor = second.getValue("nextCursor").jsonPrimitive.content
        val before = f.disk.value
        f.api.onGet("/devnet-skr-faucet/grants") { query -> when (query["after"]) {
            null -> first; firstCursor -> second; secondCursor -> f.empty(); else -> error("wrong cursor")
        } }
        f.repo.refresh(); assertEquals(before, f.disk.value)
        f.repo.discoverOlder(); assertEquals(before, f.disk.value)
        f.repo.discoverOlder(); assertNull(f.journal.read()); assertFalse(f.repo.state.value.canClaim)
        assertEquals(listOf(emptyMap(), mapOf("after" to firstCursor), mapOf("after" to secondCursor)),
            f.api.gets.filter { it.first == "/devnet-skr-faucet/grants" }.map { it.second }); f.assertReadOnly()
    }
    @Test fun `refresh restarts complete evidence at head and a restarted repository cannot resume an unproven last page`() = runBlocking {
        val f = Fixture(); f.pending(f.day.minusDays(100)); f.nextDay(); val before = f.disk.value
        f.api.onGet("/devnet-skr-faucet/grants") { f.page(0) }; f.repo.refresh()
        f.api.onGet("/devnet-skr-faucet/grants") { f.page(20) }; f.repo.discoverOlder()
        val restarted = f.repository(); val reads = f.api.gets.size
        f.api.onGet("/devnet-skr-faucet/grants") { f.empty() }; restarted.discoverOlder()
        assertEquals(reads, f.api.gets.size); assertEquals(before, f.disk.value)
        f.api.onGet("/devnet-skr-faucet/grants") { f.page(0) }; f.repo.refresh()
        assertTrue(f.api.gets.last().second.isEmpty()); assertEquals(before, f.disk.value); f.assertReadOnly()
    }
    @Test fun `loop overlapping backwards unknown mismatched or truncated pages invalidate the accumulated no-match proof`() = runBlocking {
        for (case in listOf("loop", "overlap", "backwards", "unknownPhase", "mint", "amount", "shortCursor", "transport")) {
            val f = Fixture(); f.pending(f.day.minusDays(100)); f.nextDay(); val before = f.disk.value
            val first = f.page(0); f.api.onGet("/devnet-skr-faucet/grants") { first }; f.repo.refresh()
            f.api.onGet("/devnet-skr-faucet/grants") {
                if (case == "transport") throw IOException("lost page")
                val next = when (case) { "loop" -> first; "backwards" -> f.page(-20); "shortCursor" -> f.page(20, 1); else -> f.page(20) }
                val rows = next.getValue("items").jsonArray.toMutableList()
                rows[0] = when (case) {
                    "overlap" -> first.getValue("items").jsonArray.first()
                    "unknownPhase" -> JsonObject(rows[0].jsonObject + ("attempt" to JsonObject(f.target.raw.getValue("attempt").jsonObject + ("phase" to JsonPrimitive("future")))))
                    "mint" -> JsonObject(rows[0].jsonObject + ("mint" to JsonPrimitive(f.session.wallet)))
                    "amount" -> JsonObject(rows[0].jsonObject + ("amountRaw" to JsonPrimitive("1")))
                    else -> rows[0]
                }
                JsonObject(next + ("items" to JsonArray(rows)))
            }
            f.repo.discoverOlder(); assertEquals(case, before, f.disk.value); assertNull(case, f.repo.state.value.discoveryNextCursor)
            val reads = f.api.gets.size; f.api.onGet("/devnet-skr-faucet/grants") { f.empty() }; f.repo.discoverOlder()
            assertEquals(reads, f.api.gets.size); assertEquals(before, f.disk.value); f.assertReadOnly()
        }
    }
    @Test fun `profile policy base epoch and durable intent changes prevent continuation of earlier page evidence`() = runBlocking {
        for (case in listOf("pin", "policy", "base", "epoch", "intent")) {
            val f = Fixture(); f.pending(f.day.minusDays(100)); f.nextDay()
            f.api.onGet("/devnet-skr-faucet/grants") { f.page(0) }; f.repo.refresh()
            when (case) {
                "pin" -> f.pin = SkrIdentity(f.session.wallet, f.target.decimals)
                "policy" -> f.policy = SkrFaucetBounds(5001, "1000", 20)
                "base" -> f.base = UUID.randomUUID().toString()
                "epoch" -> f.epoch++
                "intent" -> f.journal.begin(f.base, f.day.minusDays(100).toString())
            }
            val before = f.disk.value; val reads = f.api.gets.size
            f.api.onGet("/devnet-skr-faucet/grants") { f.empty() }; f.repo.discoverOlder()
            assertEquals(case, before, f.disk.value); assertEquals(case, reads, f.api.gets.size)
            assertNull(f.repo.state.value.discoveryNextCursor); f.assertReadOnly()
        }
    }
    @Test fun `unknown status and journal replacement while reading cannot clear or adopt unrelated evidence`() = runBlocking {
        for (case in listOf("unknownStatus", "replace")) {
            val f = Fixture(); f.pending(); var before = f.disk.value
            f.api.onGet("/devnet-skr-faucet/status") { f.status(f.day.plusDays(1), reason = if (case == "unknownStatus") "future_reason" else "ok") }
            f.api.onGet("/devnet-skr-faucet/grants") {
                f.journal.begin(f.base, f.day.plusDays(1).toString()); before = f.disk.value; f.empty()
            }
            f.repo.refresh(); assertEquals(before, f.disk.value); assertNotNull(f.journal.read()); f.assertReadOnly()
        }
    }
    @Test fun `known grants signed evidence and in-progress prepare are never released by the M3 no-match rule`() = runBlocking {
        for (case in listOf("grant", "signed", "preparePending")) {
            val f = Fixture(); val initial = f.pending()
            val record = if (case == "preparePending") initial.copy(preparePending = true)
                else initial.copy(grant = f.target, attemptId = f.target.attempt!!.id, signedTransaction = if (case == "signed") "AQ==" else null)
            f.journal.replace(initial, record); val before = f.disk.value; f.nextDay()
            f.api.onGet("/devnet-skr-faucet/grants") { f.empty() }
            f.api.onGet("/devnet-skr-faucet/grants/${f.target.id}") { throw ApiException(404, "SKR_FAUCET_NOT_OWNED", "not owned") }
            f.repo.refresh(); assertEquals(case, before, f.disk.value); f.assertReadOnly()
        }
    }
    @Test fun `prepare and claim actions that release old unknown intent do not continue into a new mutation`() = runBlocking {
        for (prepare in listOf(false, true)) {
            val f = Fixture(); f.pending(); val today = f.page(-1, 1, false).getValue("items").jsonArray.single().jsonObject
            f.api.onGet("/devnet-skr-faucet/status") { f.status(f.day.plusDays(1), if (prepare) today else null,
                if (prepare) "sign_required" else "ok") }
            f.api.onGet("/devnet-skr-faucet/grants") { f.empty() }
            if (prepare) f.repo.prepareAndSign() else f.repo.claim()
            assertNull(f.journal.read()); assertFalse(f.repo.state.value.uncertain); assertFalse(f.repo.state.value.canClaim); f.assertReadOnly()
        }
    }
}
