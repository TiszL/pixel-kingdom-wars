package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Identity
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.testToken
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** Binding only: synthetic metadata and no acquisition; no claim of art residency or rendering. */
@OptIn(ExperimentalCoroutinesApi::class)
class PhaseEConstructionArtBindingTest {
    private class Fixture(test: TestScope) {
        val owner = SupervisorJob()
        val accountSession = AccountSession("wallet-a", "https://example.invalid", testToken())
        val account = MutableStateFlow(AccountState(phase = AccountPhase.SIGNED_IN,
            session = accountSession, identity = Identity("wallet-a"), selectedBaseId = "base-a", baseSelectionGeneration = 1))
        val base = MutableStateFlow(BaseState(base = BaseSnapshot.from(Json.parseToJsonElement(
            """{"baseId":"base-a","buildings":[],"player":{"keepLevel":1}}""").jsonObject)))
        val content = MutableStateFlow(ContentState(File("synthetic-not-opened"),
            buildJsonObject { put("synthetic", "catalogue") }, buildJsonObject { put("synthetic", "render") }))
        val selected = MutableStateFlow<String?>(null)
        val interlock = MutableStateFlow(RaidInterlockState(known = true))
        val sink = ConstructionContentAdmissions()
        val token = Any()
        val source = ServiceContentSession(owner, {}) { _, _ -> error("Binding cannot acquire") }
        val updates = mutableListOf<PhaseEConstructionArtInput?>()
        var identityCurrent = true
        var noDemand = false
        val binding = PhaseEConstructionArtBinding(test.backgroundScope, accountSession, owner,
            account, base, content, sink, selected, { selected.value }, interlock, 1,
            requireSession = { check(identityCurrent) }, update = { updates += it },
            demand = { b, c, r, id -> if (noDemand) emptyList() else listOf(
                PhaseEConstructionArtRequest(requireNotNull(b), requireNotNull(c), requireNotNull(r),
                    buildJsonObject { put("synthetic", true) }, "workshop", if (id == null) 1 else 2, id)) })
        fun admit() { sink.beginOwner(token); sink.setSource(token, accountSession, content.value, source); sink.permission(token, true) }
        fun current() = requireNotNull(updates.last())
        fun close() { binding.close(); sink.clear(token); source.close(); owner.cancel() }
    }

    @Test fun `missing or denied content source never produces an input`() = runTest {
        val f = Fixture(this)
        try {
            runCurrent(); assertNull(f.updates.last())
            f.sink.beginOwner(f.token); f.sink.setSource(f.token, f.accountSession, f.content.value, f.source)
            runCurrent(); assertNull(f.updates.last())
            f.sink.permission(f.token, true); runCurrent(); assertNotNull(f.current())
        } finally { f.close() }
    }
    @Test fun `admitted input binds exact actor raw base source and selected demand`() = runTest {
        val f = Fixture(this)
        try {
            f.selected.value = "building-7"; f.admit(); runCurrent()
            val input = f.current(); input.requireCurrent()
            assertSame(f.accountSession, input.account); assertSame(f.owner, input.owner)
            assertSame(f.base.value.base!!.raw, input.base); assertSame(f.source, input.serviceContent)
            assertEquals(1L, input.baseSelectionGeneration)
            assertEquals("building-7", input.requests.single().buildingId)
        } finally { f.close() }
    }
    @Test fun `account and ABA generation changes invalidate before the combine collector runs`() = runTest {
        val f = Fixture(this)
        try {
            f.admit(); runCurrent(); val old = f.current()
            f.account.value = f.account.value.copy(baseSelectionGeneration = 3)
            assertTrue(runCatching { old.requireCurrent() }.isFailure)
            runCurrent(); assertEquals(3L, f.current().baseSelectionGeneration)
            val newer = f.current()
            f.account.value = f.account.value.copy(session = AccountSession("wallet-a", "https://example.invalid", testToken()))
            assertTrue(runCatching { newer.requireCurrent() }.isFailure)
            runCurrent(); assertNull(f.updates.last())
        } finally { f.close() }
    }
    @Test fun `base raw selection and holder changes invalidate synchronously`() = runTest {
        val f = Fixture(this)
        try {
            f.admit(); runCurrent(); val old = f.current()
            f.selected.value = "building-7"
            assertTrue(runCatching { old.requireCurrent() }.isFailure)
            runCurrent(); val selected = f.current()
            f.base.value = f.base.value.copy(base = BaseSnapshot.from(JsonObject(f.base.value.base!!.raw + ("revision" to JsonPrimitive(2)))))
            assertTrue(runCatching { selected.requireCurrent() }.isFailure)
            runCurrent(); val changed = f.current(); f.identityCurrent = false
            assertTrue(runCatching { changed.requireCurrent() }.isFailure)
        } finally { f.close() }
    }
    @Test fun `status-only content changes keep its generation while metadata replacement refuses it`() = runTest {
        val f = Fixture(this)
        try {
            f.admit(); runCurrent(); val old = f.current()
            f.content.value = f.content.value.copy(checking = true, updateNotice = "Checking")
            old.requireCurrent(); runCurrent(); val fresh = f.current()
            f.content.value = f.content.value.copy(renderCatalogue = buildJsonObject { put("synthetic", "replacement") })
            assertTrue(runCatching { fresh.requireCurrent() }.isFailure)
            runCurrent(); assertNull(f.updates.last())
        } finally { f.close() }
    }
    @Test fun `permission revocation sends null synchronously before state collection`() = runTest {
        val f = Fixture(this)
        try {
            f.admit(); runCurrent(); val old = f.current()
            f.sink.permission(f.token, false)
            assertNull(f.updates.last()); assertTrue(runCatching { old.requireCurrent() }.isFailure)
        } finally { f.close() }
    }
    @Test fun `order retirement and unavailable interlock refuse current and future input`() = runTest {
        val f = Fixture(this)
        try {
            f.admit(); runCurrent(); val old = f.current()
            f.content.value = f.content.value.copy(updateMandatoryBlocked = true)
            assertTrue(runCatching { old.requireCurrent() }.isFailure)
            runCurrent(); assertNull(f.updates.last())
            f.content.value = f.content.value.copy(updateMandatoryBlocked = false); runCurrent(); val restored = f.current()
            f.interlock.value = RaidInterlockState(known = false)
            assertTrue(runCatching { restored.requireCurrent() }.isFailure)
            runCurrent(); assertNull(f.updates.last())
        } finally { f.close() }
    }
    @Test fun `empty demand and different selected base never acquire or publish work`() = runTest {
        val f = Fixture(this)
        try {
            f.noDemand = true; f.admit(); runCurrent(); assertNull(f.updates.last())
            f.noDemand = false; f.account.value = f.account.value.copy(selectedBaseId = "base-b")
            runCurrent(); assertNull(f.updates.last())
        } finally { f.close() }
    }
    @Test fun `closing is synchronous idempotent and prevents later republication`() = runTest {
        val f = Fixture(this)
        try {
            f.admit(); runCurrent(); val old = f.current()
            f.binding.close(); f.binding.close()
            assertNull(f.updates.last()); assertTrue(runCatching { old.requireCurrent() }.isFailure)
            val count = f.updates.size
            f.selected.value = "later"; f.sink.permission(f.token, false); f.sink.permission(f.token, true)
            runCurrent(); assertEquals(count, f.updates.size)
        } finally { f.close() }
    }
}
