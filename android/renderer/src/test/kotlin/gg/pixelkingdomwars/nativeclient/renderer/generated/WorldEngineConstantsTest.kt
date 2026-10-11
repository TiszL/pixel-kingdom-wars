package gg.pixelkingdomwars.nativeclient.renderer.generated

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import java.lang.reflect.Modifier
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.fail
import org.junit.Test

/**
 * GLOBE-NATIVE-PLAN §4.3/§7: the realm engine's presentation constants (bands, idle policy, GPU safety, texture units,
 * plot hashing, cost budgets) must be the pinned web values, never a hand copy that drifts. The generated Kotlin table
 * and the golden `contracts.json` come from the same pinned modules; this test reads both and checks them both ways:
 * every web value has a Kotlin constant with the same value, and every Kotlin constant is a web value.
 */
class WorldEngineConstantsTest {
    private val golden = JsonReader().parse(checkNotNull(javaClass.getResourceAsStream("/world/golden/contracts.json")).use { String(it.readBytes()) })
    private val c = golden.get("constants")
    private val g = golden.get("groundcost")

    /** The generator's key rule: camelCase → UPPER_SNAKE, nested keys joined with '_'. */
    private fun snake(k: String) = k.replace(Regex("([a-z0-9])([A-Z])"), "$1_$2").uppercase().replace(Regex("[^A-Z0-9_]"), "_")
    private fun leaves(v: JsonValue, prefix: String = "", out: MutableMap<String, JsonValue> = linkedMapOf()): Map<String, JsonValue> {
        if (v.isObject) { var ch = v.child; while (ch != null) { leaves(ch, if (prefix.isEmpty()) snake(ch.name) else "${prefix}_${snake(ch.name)}", out); ch = ch.next } }
        else out[prefix] = v
        return out
    }
    private fun group(vararg parts: Pair<String, JsonValue>): Map<String, JsonValue> = linkedMapOf<String, JsonValue>().also { m ->
        for ((prefix, v) in parts) m.putAll(if (v.isObject) leaves(v, prefix) else mapOf(prefix to v))
    }
    private fun fieldsOf(obj: Class<*>): Map<String, Any?> = obj.declaredFields
        .filter { Modifier.isStatic(it.modifiers) && it.name != "INSTANCE" }
        .associate { f -> f.isAccessible = true; f.name to f.get(null) }

    private fun same(path: String, want: JsonValue, got: Any?) {
        fun num(v: JsonValue) = if (v.isString) v.asString().toDouble() else v.asDouble()
        when (got) {
            is Int, is Double -> assertEquals(num(want), (got as Number).toDouble(), path)
            is Boolean -> assertEquals(want.asBoolean(), got, path)
            is String -> assertEquals(want.asString(), got, path)
            is IntArray -> assertEquals(want.map { it.asInt() }, got.toList(), path)
            is DoubleArray -> assertEquals(want.map { num(it) }, got.toList(), path)
            is BooleanArray -> assertEquals(want.map { it.asBoolean() }, got.toList(), path)
            is List<*> -> assertEquals(want.map { it.asString() }, got, path)
            is Array<*> -> { assertEquals(want.size, got.size, path); got.forEachIndexed { i, x -> same("$path[$i]", want.get(i), x) } }
            else -> fail("$path: unexpected ${got?.javaClass}")
        }
    }

    @Test fun `every generated constant is the pinned web value and every web value is generated`() {
        val groups = mapOf(
            WorldEngineConstants.Bands::class.java to group("" to c.get("BANDS")),
            WorldEngineConstants.Idle::class.java to group("" to c.get("IDLE")),
            WorldEngineConstants.GpuSafe::class.java to group("" to c.get("GPU_SAFE")),
            WorldEngineConstants.Units::class.java to group("" to c.get("UNITS")),
            WorldEngineConstants.PlotOffset::class.java to group("" to c.get("PLOT_OFFSET"), "CENTRE" to c.get("PLOT_CENTRE")),
            WorldEngineConstants.DeedPx::class.java to group("" to c.get("DEED_PX")),
            WorldEngineConstants.Kind::class.java to group("" to c.get("KIND")),
            WorldEngineConstants.Flag::class.java to group("" to c.get("FLAG")),
            WorldEngineConstants.Classes::class.java to group("" to c.get("CLASS")),
            WorldEngineConstants.GroundCost::class.java to group("" to g),
            WorldEngineConstants.View::class.java to group("UBO_BINDING" to c.get("UBO_VIEW")),
        )
        for ((obj, want) in groups) {
            val got = fieldsOf(obj)
            assertEquals(want.keys.sorted(), got.keys.sorted(), "${obj.simpleName}: the same constants on both sides")
            for ((k, v) in want) same("${obj.simpleName}.$k", v, got[k])
        }
        assertEquals(golden.getString("pin"), WorldEngineConstants.PIN, "one pin for the goldens and the constants")
    }

    @Test fun `the values the N2 engine leans on are where the port expects them`() {
        // a renamed or regrouped key would compile nowhere else until the engine noticed: pin the few it reads first
        assertEquals(24, WorldEngineConstants.Bands.FAR_END)
        assertEquals(48, WorldEngineConstants.Bands.MAP_START)
        assertEquals(3, WorldEngineConstants.Bands.REST.size)
        assertEquals(2, WorldEngineConstants.GpuSafe.SEVERE_NEED)
        assertEquals(255, WorldEngineConstants.DeedPx.THIS_REALM)
        assertTrue(WorldEngineConstants.GroundCost.PASS_CHART <= WorldEngineConstants.GroundCost.DISPLAY_BUDGET)
    }
}
