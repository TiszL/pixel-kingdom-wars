package gg.pixelkingdomwars.nativeclient.wallet

import com.solana.publickey.ProgramDerivedAddress
import com.solana.publickey.SolanaPublicKey
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.vehicle.VehiclePolicy
import gg.pixelkingdomwars.nativeclient.vehicle.VehicleProtocol
import java.math.BigInteger
import java.util.Base64
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

/** Installed application RPC only. A record/review can never provide this capability
 * or its URL. Replies are complete JSON-RPC envelopes, with base64 raw account data. */
fun interface VehicleRpcReads {
    suspend fun request(method: String, params: JsonArray): JsonObject
}

/** Fresh, independently pinned eligibility over the SAME legacy message. No send,
 * retry, replacement blockhash, game-effect or finality authority is exposed. */
object VehicleCurrent {
    private val lock = Any()
    private var pending = 0
    private val workers = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    suspend fun verify(client: JsonObject, pins: VehicleSigningTrust, policy: VehiclePolicy, networkFeeLamports: String,
        rpc: VehicleRpcReads, guard: () -> Unit,
        monotonicMs: () -> Long = { System.nanoTime()/1_000_000 }): () -> Unit {
        guard()
        val v = VehicleProtocol.client(client); val rules = VehiclePolicy.from(policy.raw)
        val trust = VehicleSigningTrust.from(pins.toJson()); val prepared = VehicleTransaction.prepare(v,trust,rules)
        require(VehicleProtocol.terminal(v) == null) { "Vehicle burn is already terminal" }
        val started = monotonicMs()
        val ageLimit = rules.bound("reviewMaxAgeMs"); val timeout = rules.bound("rpcTimeoutMs")
        require(ageLimit > 0 && timeout > 0 && rules.bound("maxPendingRpc") in 1..512)
        fun fresh() {
            guard()
            val now = monotonicMs()
            require(now >= started && now-started <= ageLimit) { "Vehicle review expired; recheck the same original" }
        }
        synchronized(lock) {
            require(pending < rules.bound("maxPendingRpc")) { "Vehicle RPC is busy" }
            pending++
        }
        val abandoned = AtomicBoolean(false)
        // The task owns its occupancy. A timeout/cancellation can return to the UI,
        // but ignored-cancellation RPC work keeps the slot until its actual drain.
        val task = workers.async(start = CoroutineStart.LAZY) {
                suspend fun call(method: String, params: JsonArray): JsonElement {
                    currentCoroutineContext().ensureActive(); require(!abandoned.get()); fresh()
                    val reply = rpc.request(method,params)
                    currentCoroutineContext().ensureActive(); require(!abandoned.get()); fresh()
                    return result(reply)
                }
                inspect(v,trust,rules,prepared,networkFeeLamports,::call)
                fresh()
        }
        // Completion also handles cancellation before the lazy body ever starts;
        // it cannot release occupancy while an ignored-cancellation call still drains.
        task.invokeOnCompletion { synchronized(lock) { pending-- } }
        task.start()
        try {
            withTimeout(timeout) { task.await() }
            fresh()
        } finally {
            abandoned.set(true)
            if (!task.isCompleted) task.cancel()
        }
        return ::fresh
    }

    private suspend fun inspect(v: JsonObject, trust: VehicleSigningTrust, policy: VehiclePolicy,
        prepared: PreparedVehicle, networkFeeLamports: String, call: suspend (String,JsonArray)->JsonElement) {
        val pins = trust.core; val r = v.charterObject("record"); val p = r.charterObject("preparation")
        val identity = VehicleProtocol.original(v).charterObject("identity")
        val codeAddress = base58(ProgramDerivedAddress.find(listOf(vehicleKey(VEHICLE_CORE)),
            SolanaPublicKey(vehicleKey(VEHICLE_LOADER))).getOrThrow().bytes)
        val keys = listOf(VEHICLE_CORE,codeAddress,identity.charterText("assetId"),identity.charterText("collection"))
        val minimum = vehicleNumber(p,"blockhashContextSlot")
        suspend fun bank(minimumSlot: Long): Long {
            require(call("getGenesisHash",JsonArray(emptyList())) == pins["expectedGenesisHash"]) { "Vehicle network differs from installed pins" }
            val opening = number(call("getSlot",params(options())))
            require(opening >= minimumSlot && opening >= vehicleNumber(pins,"reviewedDeploymentSlot")) { "Vehicle finalized slot regressed" }
            val response = call("getMultipleAccounts",params(JsonArray(keys.map(::JsonPrimitive)),options(opening,"base64"))).jsonObject
            val slot = context(response,opening)
            val rows = response.getValue("value").jsonArray
            require(rows.size == keys.size && rows.all { it is JsonObject }) { "Original vehicle/Core account is absent" }
            val program = account(rows[0].jsonObject,VEHICLE_LOADER,true,36)
            val code = account(rows[1].jsonObject,VEHICLE_LOADER,false,8*1024*1024)
            require(program.size == 36 && little(program,0,4) == BigInteger.valueOf(2) &&
                program.copyOfRange(4,36).contentEquals(vehicleKey(codeAddress))) { "Vehicle Core program changed" }
            require(code.size >= 45 && little(code,0,4) == BigInteger.valueOf(3) &&
                little(code,4,8) == vehicleNumber(pins,"reviewedDeploymentSlot").toBigInteger() &&
                vehicleHash(code) == pins.charterText("reviewedProgramDataSha256")) { "Vehicle Core deployment changed" }
            val authority = when (code[12].toInt()) {
                0 -> JsonNull
                1 -> JsonPrimitive(base58(code.copyOfRange(13,45)))
                else -> error("Invalid Core upgrade authority")
            }
            require(authority == pins["upgradeAuthority"]) { "Vehicle Core upgrade authority changed" }
            val asset = account(rows[2].jsonObject,VEHICLE_CORE,false,65536)
            val collection = account(rows[3].jsonObject,VEHICLE_CORE,false,65536)
            require(VehicleCore.eligible(asset,collection,prepared.wallet,identity.charterText("collection"))) { "Original vehicle is not an eligible wallet holding" }
            return slot
        }
        var slot = bank(minimum)
        val message = prepared.unsignedTransaction().let { it.copyOfRange(65,it.size) }
        val fee = call("getFeeForMessage",params(JsonPrimitive(Base64.getEncoder().encodeToString(message)),options())).jsonObject
        slot = context(fee,slot); val feeLamports = number(fee.getValue("value"))
        require(networkFeeLamports == feeLamports.toString()) { "Vehicle fee changed; review the original again" }
        require(feeLamports <= policy.bound("maxNetworkFeeLamports")) { "Vehicle fee exceeds installed operational cap" }
        val balance = call("getBalance",params(JsonPrimitive(prepared.wallet),options(slot))).jsonObject
        slot = context(balance,slot); val payer = number(balance.getValue("value"))
        require(payer >= feeLamports) { "Wallet needs the actual network fee before burn; refunds are not spendable yet" }
        val valid = call("isBlockhashValid",params(p.getValue("blockhash"),options(slot))).jsonObject
        slot = context(valid,slot)
        require(CharterGrammar.bool(valid.getValue("value"))) { "Original vehicle blockhash expired or unresolved" }
        val height = number(call("getBlockHeight",params(options(slot))))
        require(height <= vehicleNumber(p,"lastValidBlockHeight")) { "Original vehicle blockheight expired or unresolved" }
        r.charterOptional("signed")?.let { signed ->
            val statuses = call("getSignatureStatuses",params(JsonArray(listOf(signed.getValue("signature"))),
                buildJsonObject { put("searchTransactionHistory",true) })).jsonObject
            // Signature status context can be processed, ahead of the finalized bank.
            context(statuses,slot)
            require(statuses.getValue("value").jsonArray == JsonArray(listOf(JsonNull))) { "Original vehicle signature is already observed; recover it" }
        }
        bank(slot)
    }

    private fun params(vararg values: JsonElement) = JsonArray(values.toList())
    private fun options(slot: Long? = null, encoding: String? = null) = buildJsonObject {
        put("commitment","finalized"); slot?.let { put("minContextSlot",it) }; encoding?.let { put("encoding",it) }
    }
    private fun number(v: JsonElement) = CharterGrammar.number(v)
    private fun context(v: JsonObject, minimum: Long): Long {
        require(v.keys == setOf("context","value"))
        val context = v.charterObject("context")
        require(context.keys.all { it in setOf("slot","apiVersion") })
        return vehicleNumber(context,"slot").also { require(it >= minimum) { "Vehicle RPC context regressed" } }
    }
    private fun account(v: JsonObject, owner: String, executable: Boolean, max: Int): ByteArray {
        require(v.keys.containsAll(setOf("owner","executable","data")) &&
            v.keys.all { it in setOf("owner","executable","data","lamports","rentEpoch","space") })
        require(v.charterText("owner") == owner && CharterGrammar.bool(v.getValue("executable")) == executable)
        val data = v.getValue("data").jsonArray
        require(data.size == 2 && CharterGrammar.text(data[1]) == "base64")
        return vehicleBase64(CharterGrammar.text(data[0]),max).also { bytes ->
            require(bytes.isNotEmpty()); v["space"]?.let { require(number(it) == bytes.size.toLong()) }
        }
    }
    private fun little(bytes: ByteArray, offset: Int, length: Int) = BigInteger(1,bytes.copyOfRange(offset,offset+length).reversedArray())

    private fun result(input: JsonObject): JsonElement {
        // Separate from the small history copier: full pinned ProgramData is bounded
        // at 8 MiB, and the complete raw RPC document at 16 MiB before base64 decoding.
        var chars = 0L; var nodes = 0
        fun copy(v: JsonElement, depth: Int): JsonElement {
            require(++nodes <= 2048 && depth <= 16)
            return when(v) {
                is JsonObject -> { require(v.size <= 32); JsonObject(v.mapValues { (k,x) -> chars += k.length; require(chars <= 16*1024*1024); copy(x,depth+1) }) }
                is JsonArray -> { require(v.size <= 32); JsonArray(v.map { copy(it,depth+1) }) }
                is JsonPrimitive -> { chars += v.content.length; require(chars <= 16*1024*1024); v }
            }
        }
        val v = copy(input,0).jsonObject
        require(v.keys.containsAll(setOf("jsonrpc","id","result")) && v.keys.all { it in setOf("jsonrpc","id","result","error") })
        require(v["jsonrpc"] == JsonPrimitive("2.0") && (v["error"] == null || v["error"] == JsonNull)) { "Vehicle RPC unavailable" }
        return v.getValue("result")
    }
}
