package gg.pixelkingdomwars.nativeclient.renderer

import org.junit.Test
import kotlin.test.*

class BattlePlacementDispatchTest {
    private val admission = Any()
    private val vex = BattleDeploymentMode("vex-selection", 260, 120, 12f, false, admission,
        BattleDeploymentTarget("raid", "hero", "vex"))
    private val theodor = vex.copy(identity = "theodor-selection", target = vex.target!!.copy(unit = "theodor"))

    @Test fun `completed Vex tap survives later Theodor selection and dispatches its original target once`() {
        val gesture = BattleDeploymentGesture()
        gesture.down(10f, 10f, 0, vex)
        assertTrue(gesture.up(10f, 10f))
        var current = vex
        val main = mutableListOf<() -> Unit>()
        val delivered = mutableListOf<CompletedBattlePlacement>()
        dispatchBattlePlacement(CompletedBattlePlacement(vex, 3.5f, 4.5f, true), main::add,
            { current.admission }, { true }, delivered::add)
        current = theodor
        main.single()(); main.single()()
        assertEquals(listOf(vex.target), delivered.map { it.mode.target })
        assertEquals(3.5f, delivered.single().x)
    }

    @Test fun `closed admission scene account raid and lifecycle changes discard completed callbacks`() {
        for (replacement in listOf(null, vex.copy(admission = Any()),
            vex.copy(admission = Any(), target = vex.target!!.copy(raidId = "other-raid")))) {
            var current: BattleDeploymentMode? = vex
            var pending: (() -> Unit)? = null
            val received = mutableListOf<CompletedBattlePlacement>()
            dispatchBattlePlacement(CompletedBattlePlacement(vex, 0f, 0f, true), { pending = it },
                { current?.admission }, { true }, received::add)
            current = replacement; pending!!()
            assertTrue(received.isEmpty())
        }
        for (transition in listOf("renderer", "scene", "account", "lifecycle")) {
            var current = true
            var pending: (() -> Unit)? = null
            val received = mutableListOf<CompletedBattlePlacement>()
            dispatchBattlePlacement(CompletedBattlePlacement(vex, 0f, 0f, true), { pending = it },
                { vex.admission }, { current }, received::add)
            current = false; pending!!()
            assertTrue(received.isEmpty(), transition)
        }
    }

    @Test fun `another selection becoming unavailable cannot discard an already completed original placement`() {
        var selected: BattleDeploymentMode? = vex
        val main = mutableListOf<() -> Unit>()
        val enqueued = mutableListOf<BattleDeploymentTarget?>()
        dispatchBattlePlacement(CompletedBattlePlacement(selected!!, 0f, 0f, true), main::add,
            { admission }, { true }) { enqueued.add(it.mode.target) }
        selected = theodor
        assertEquals("theodor", selected.target?.unit)
        selected = null // The selected hero was reserved by an earlier command.
        main.single()()
        assertNull(selected)
        assertEquals(listOf(vex.target), enqueued)
    }

    @Test fun `pan second finger cancellation and mid-gesture selection never produce completed placements`() {
        val g = BattleDeploymentGesture()
        for (cancel in listOf<() -> Unit>({ g.move(30f, 30f) }, { g.pan() }, { g.cancel() }, { g.sync(theodor) })) {
            g.down(0f, 0f, 0, vex); cancel()
            assertFalse(g.up(0f, 0f))
        }
        g.down(0f, 0f, 0, vex)
        assertFalse(g.frame(1000, vex), "An interrupted frame cannot invent a completed hold")
        g.cancel(); assertFalse(g.up(0f, 0f))
    }
}
