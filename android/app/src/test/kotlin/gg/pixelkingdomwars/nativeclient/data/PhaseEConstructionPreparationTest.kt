package gg.pixelkingdomwars.nativeclient.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.File

/** Additive real binder/provider tests; fake lease handles establish no file residency or pixels. */
@OptIn(ExperimentalCoroutinesApi::class)
class PhaseEConstructionPreparationTest {
    @Before fun main() { Dispatchers.setMain(StandardTestDispatcher()) }
    @After fun reset() { Dispatchers.resetMain() }

    @Test fun `fresh input explicitly prepares before acquiring and ready follows complete acquisition`() = runTest {
        val h = ConstructionDraftHarness(this)
        try {
            h.main()
            val preparing = requireNotNull(h.provider.preparation.value)
            assertEquals(PhaseEConstructionPreparation.PREPARING, preparing.phase)
            assertTrue(requireNotNull(preparing.context).isCurrent())
            assertSame(h.base.state.value.base!!.raw, preparing.base)
            assertNull(h.provider.constructionArt.value); assertTrue(h.acquired.isEmpty())
            h.ready()
            val ready = requireNotNull(h.provider.preparation.value)
            assertEquals(PhaseEConstructionPreparation.READY, ready.phase)
            assertSame(preparing.context, ready.context)
            assertTrue(h.acquired.isNotEmpty())
        } finally { h.close() }
    }

    @Test fun `same base refresh and selection preserve context while exact art generations change`() = runTest {
        val h = ConstructionDraftHarness(this)
        try {
            h.ready(); val context = h.context(); val art = requireNotNull(h.provider.constructionArt.value)
            val gate = h.beginRefresh()
            assertSame(context, h.context()); assertTrue(context.isCurrent())
            assertNull(h.provider.constructionArt.value)
            h.finish(gate); h.ready()
            assertSame(context, h.context()); assertNotSame(art, h.provider.constructionArt.value)
            h.model.selectBuilding("facility"); h.settle()
            assertSame(context, h.context()); assertTrue(context.isCurrent())
            assertTrue(h.model.state.value.constructionAvailable("workshop", 2, "facility"))
        } finally { h.close() }
    }

    @Test fun `equivalent status content preserves context status callback and retained leases`() = runTest {
        val h = ConstructionDraftHarness(this)
        try {
            h.ready(); val context = h.context(); val art = h.provider.constructionArt.value
            val status = h.provider.preparation.value; val acquired = h.acquired.size
            h.content.set { it.copy(assets = File(requireNotNull(it.assets).path), checking = true, updateNotice = "Synthetic status only") }
            h.settle()
            assertSame(context, h.context()); assertSame(art, h.provider.constructionArt.value)
            assertSame(status, h.provider.preparation.value)
            assertEquals(acquired, h.acquired.size); assertTrue(h.released.isEmpty())
        } finally { h.close() }
    }

    @Test fun `terminal current preparation refusal retires context and explicit later refresh uses a new one`() = runTest {
        val h = ConstructionDraftHarness(this)
        try {
            h.ready(); val context = h.context()
            val gate = h.beginRefresh(fail = true); h.finish(gate)
            assertEquals(PhaseEConstructionPreparation.REFUSED, h.provider.preparation.value?.phase)
            assertSame(context, h.provider.preparation.value?.context)
            assertFalse(context.isCurrent()); assertNull(h.provider.constructionArt.value)
            h.refresh(); h.ready()
            assertNotSame(context, h.context()); assertFalse(context.isCurrent())
        } finally { h.close() }
    }

    @Test fun `late failed old worker cannot retire a newer ready generation sharing current context`() = runTest {
        val h = ConstructionDraftHarness(this)
        try {
            h.ready(); val context = h.context()
            val old = h.beginRefresh(fail = true)
            h.refresh(); h.main(); h.worker.drain(); h.main()
            val newerStatus = requireNotNull(h.provider.preparation.value)
            val newerArt = requireNotNull(h.provider.constructionArt.value)
            assertEquals(PhaseEConstructionPreparation.READY, newerStatus.phase)
            assertSame(context, newerStatus.context); assertTrue(context.isCurrent())
            h.finish(old)
            assertSame(newerStatus, h.provider.preparation.value)
            assertSame(newerArt, h.provider.constructionArt.value)
            assertTrue(context.isCurrent())
        } finally { h.close() }
    }

    @Test fun `permission or owner retirement during held acquisition clears synchronously before worker cleanup`() = runTest {
        for (cancelOwner in listOf(false, true)) {
            val h = ConstructionDraftHarness(this)
            try {
                h.ready(); val context = h.context(); val gate = h.beginRefresh()
                if (cancelOwner) h.owner.cancel() else h.sink.permission(h.token, false)
                assertFalse(context.isCurrent())
                assertNull(h.provider.constructionArt.value)
                assertNull(h.provider.preparation.value)
                assertFalse("Worker is deliberately still held", requireNotNull(gate.task).done.isDone)
                h.finish(gate)
                assertNull(h.provider.constructionArt.value); assertNull(h.provider.preparation.value)
            } finally { h.close() }
        }
    }
}
