package gg.pixelkingdomwars.nativeclient.renderer.gl3

/** Open-addressing set of non-zero longs: the (program, state) pairs already drawn. No boxing, so a lookup on the
 *  draw path never allocates; only an insert that grows the table does, and an insert is a first draw (cold anyway). */
internal class LongSet(initialCapacity: Int = 256) {
    private var keys = LongArray(Integer.highestOneBit(maxOf(4, initialCapacity) * 2 - 1))
    var size = 0; private set

    fun contains(key: Long): Boolean {
        require(key != 0L)
        val mask = keys.size - 1
        var i = mix(key) and mask
        while (true) {
            val k = keys[i]
            if (k == 0L) return false
            if (k == key) return true
            i = (i + 1) and mask
        }
    }

    /** True when [key] was not present. */
    fun add(key: Long): Boolean {
        require(key != 0L)
        if ((size + 1) * 2 > keys.size) grow()
        val mask = keys.size - 1
        var i = mix(key) and mask
        while (true) {
            val k = keys[i]
            if (k == 0L) { keys[i] = key; size++; return true }
            if (k == key) return false
            i = (i + 1) and mask
        }
    }

    fun clear() { keys.fill(0L); size = 0 }

    /** The members in table order (coverage reports only: allocates). */
    fun toArray(): LongArray { val out = LongArray(size); var n = 0; for (k in keys) if (k != 0L) out[n++] = k; return out }

    private fun grow() {
        val old = keys
        keys = LongArray(old.size * 2); size = 0
        for (k in old) if (k != 0L) add(k)
    }

    private fun mix(key: Long): Int { val h = key * -0x61c8864680b583ebL; return (h xor (h ushr 32)).toInt() }
}
