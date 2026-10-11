package gg.pixelkingdomwars.nativeclient.renderer

import org.junit.Test
import kotlin.test.*

class ScenePreparationNoticeTest {
    private class Host {
        var generation = 1L
        var disposed = false
        var rendererOwner = Any()
        var lease = Any()
        val main = ArrayDeque<() -> Unit>()
        val received = mutableListOf<ScenePreparationNotice>()
        fun callback(): (ScenePreparationNotice) -> Unit {
            val owner = rendererOwner
            val reporter = lease
            return { notice -> dispatchSceneCallback(notice, main::addLast,
                { rendererOwner === owner && lease === reporter && it.isCurrent(generation, disposed) }, received::add) }
        }
        fun drain() { while (main.isNotEmpty()) main.removeFirst().invoke() }
    }

    @Test fun `GL failure queued before Main admits another revision cannot restore its retry notice`() {
        val host = Host()
        val callback = host.callback()
        callback(ScenePreparationNotice(1, "failed A"))
        host.generation = 2
        // updateBattle clears B synchronously when called on Main, ahead of the queued A callback.
        val clear = ScenePreparationNotice(2, null)
        dispatchSceneCallback(clear, { it() }, { it.isCurrent(host.generation, false) }, host.received::add)
        host.drain()
        assertEquals(listOf(clear), host.received)
    }

    @Test fun `late success from an old commit cannot hide the current preparation failure`() {
        val host = Host()
        val callback = host.callback()
        callback(ScenePreparationNotice(1, null))
        host.generation = 2
        val failure = ScenePreparationNotice(2, "failed B")
        // Force GL and Main ordering opposite to commit order.
        callback(failure)
        host.main.removeLast().invoke()
        host.drain()
        assertEquals(listOf(failure), host.received)
    }

    @Test fun `same first-scene failure in a newer generation remains deliverable`() {
        val host = Host()
        val callback = host.callback()
        callback(ScenePreparationNotice(1, "missing page", fatal = true))
        host.generation = 2
        val current = ScenePreparationNotice(2, "missing page", fatal = true)
        callback(current)
        host.drain()
        assertEquals(listOf(current), host.received, "A rejected old fatal must not consume the current fatal")
    }

    @Test fun `disposal replacement and a changed report lease invalidate already posted callbacks`() {
        for (invalidate in listOf<(Host) -> Unit>({ it.disposed = true }, { it.rendererOwner = Any() }, { it.lease = Any() })) {
            val host = Host()
            val old = host.callback()
            old(ScenePreparationNotice(1, "old renderer"))
            invalidate(host)
            host.drain()
            assertTrue(host.received.isEmpty())
            // Replacement renderers may reuse the same number; host ownership, not a number alone, protects them.
            host.disposed = false
            host.rendererOwner = Any()
            old(ScenePreparationNotice(1, null))
            val current = ScenePreparationNotice(1, "new renderer")
            host.callback()(current)
            host.drain()
            assertEquals(listOf(current), host.received)
        }
    }

    @Test fun `catalogue fatal from a replaced renderer cannot blank its successor`() {
        val main = ArrayDeque<() -> Unit>()
        val failures = mutableListOf<String>()
        var owner: Any? = Any()
        var lease = Any()
        val originalOwner = owner
        val originalLease = lease
        fun report(message: String) = dispatchSceneCallback(message, main::addLast,
            { owner === originalOwner && lease === originalLease }, failures::add)
        report("catalogue unavailable")
        owner = Any()
        main.removeFirst().invoke()
        assertTrue(failures.isEmpty())
        // An unchanged renderer may continue after a different-generation scene; catalogue failures
        // concern that instance, so only lifecycle and lease ownership applies to this legacy path.
        owner = originalOwner
        report("current catalogue unavailable")
        main.removeFirst().invoke()
        assertEquals(listOf("current catalogue unavailable"), failures)
        report("old lease")
        lease = Any()
        main.removeFirst().invoke()
        assertEquals(1, failures.size)
        report("destroyed view")
        lease = originalLease
        owner = null
        main.removeFirst().invoke()
        assertEquals(1, failures.size)
    }
}
