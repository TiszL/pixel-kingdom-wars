package gg.pixelkingdomwars.nativeclient.wallet

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

/** Narrow independent Borsh decoder for the accepted D182 current-owner profile.
 * Unknown extensions hold instead of the SDK convenience decoder's skip behavior.
 * No compressed account, external adapter, gap, duplicate or trailing byte is accepted. */
internal object VehicleCore {
    private val types = setOf(1,2,3,5,7,8)
    private data class Account(val owner: String?, val collection: String?, val plugins: Map<Int,Boolean>)

    fun eligible(asset: ByteArray?, collection: ByteArray, wallet: String, collectionAddress: String): Boolean {
        val inherited = decode(collection,true)
        if (asset == null) return false
        val owned = decode(asset,false)
        val plugins = inherited.plugins + owned.plugins
        return owned.owner == wallet && owned.collection == collectionAddress &&
            plugins[1] != true && plugins[5] != true && 3 !in plugins
    }

    private fun decode(input: ByteArray, collection: Boolean): Account {
        require(input.size in 1..65536) { "Unsupported Core account size" }
        val bytes = input.copyOf(); val r = Cursor(bytes)
        require(r.byte() == if (collection) 5 else 1) { "Unsupported Core account" }
        var owner: String? = null; var collectionKey: String? = null
        if (collection) r.take(32) else {
            owner = base58(r.take(32))
            when (r.byte()) { 0 -> Unit; 1 -> r.take(32); 2 -> collectionKey = base58(r.take(32)); else -> error("Unknown Core update authority") }
        }
        r.string(); r.string()
        if (collection) { r.take(4); r.take(4) } else when (r.byte()) { 0 -> Unit; 1 -> r.take(8); else -> error("Noncanonical Core sequence") }
        if (r.position == bytes.size) return Account(owner,collectionKey,emptyMap())
        require(r.byte() == 3) { "Invalid Core plugin header" }
        val registryAt = r.offset(); val pluginAt = r.position
        require(registryAt in pluginAt until bytes.size)
        r.position = registryAt; require(r.byte() == 4) { "Invalid Core plugin registry" }
        val count = r.u32(); require(count <= types.size) { "Unsupported Core plugin count" }
        val records = List(count.toInt()) {
            val type = r.byte(); require(type in types) { "Unsupported Core plugin" }
            when (r.byte()) { 0,1,2 -> Unit; 3 -> r.take(32); else -> error("Unknown Core plugin authority") }
            type to r.offset()
        }
        require(records.map { it.first }.distinct().size == records.size) { "Duplicate Core plugin" }
        require(r.u32() == 0L && r.position == bytes.size) { "External or trailing Core data" }
        var next = pluginAt; val plugins = mutableMapOf<Int,Boolean>()
        for ((type,offset) in records.sortedBy { it.second }) {
            require(offset == next && offset < registryAt) { "Unexplained Core plugin offset" }
            r.position = offset; require(r.byte() == type) { "Core plugin registry mismatch" }
            plugins[type] = if (type == 1 || type == 5) {
                val frozen = r.byte(); require(frozen in 0..1) { "Noncanonical Core freeze" }; frozen == 1
            } else false
            next = r.position; require(next <= registryAt)
        }
        require(next == registryAt) { "Trailing Core plugin bytes" }
        return Account(owner,collectionKey,plugins)
    }

    private class Cursor(val bytes: ByteArray) {
        var position = 0
        fun take(size: Int): ByteArray {
            require(size >= 0 && size <= bytes.size-position) { "Truncated Core account" }
            return bytes.copyOfRange(position,position+size).also { position += size }
        }
        fun byte(): Int = take(1)[0].toInt() and 255
        fun u32(): Long = take(4).foldIndexed(0L) { i,n,b -> n or ((b.toLong() and 255) shl (8*i)) }
        fun offset(): Int {
            val b = take(8)
            require(b.drop(4).all { it == 0.toByte() })
            val v = b.take(4).foldIndexed(0L) { i,n,x -> n or ((x.toLong() and 255) shl (8*i)) }
            require(v <= bytes.size); return v.toInt()
        }
        fun string() {
            val n = u32(); require(n <= bytes.size-position)
            Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(take(n.toInt())))
        }
    }
}
