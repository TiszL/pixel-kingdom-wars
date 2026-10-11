package gg.pixelkingdomwars.nativeclient.renderer.gl3

/**
 * Minimal LRU (core.js `lru`): [put] past [capacity] evicts the least recently used entry and tells [onEvict] (a lane
 * frees the entry's texture there). [get] refreshes recency without allocating, so a resident page touched every frame
 * costs nothing on the GL thread.
 */
class Gl3Lru<K : Any, V : Any>(val capacity: Int, private val onEvict: (K, V) -> Unit) {
    private val map = LinkedHashMap<K, V>(16, 0.75f, true)

    init { require(capacity > 0) { "LRU capacity must be positive" } }

    val size: Int get() = map.size
    operator fun get(key: K): V? = map[key]
    fun has(key: K): Boolean = map.containsKey(key)

    fun put(key: K, value: V): V {
        val old = map.put(key, value)
        if (old != null && old !== value) onEvict(key, old)
        while (map.size > capacity) {
            val eldest = map.entries.iterator().next()
            map.remove(eldest.key)
            onEvict(eldest.key, eldest.value)
        }
        return value
    }

    fun delete(key: K): Boolean {
        val old = map.remove(key) ?: return false
        onEvict(key, old)
        return true
    }

    /** Least recently used first. Allocates (diagnostics only). */
    fun keys(): List<K> = map.keys.toList()

    fun clear() {
        val entries = map.entries.toList()
        map.clear()
        for ((k, v) in entries) onEvict(k, v)
    }
}
