package gg.pixelkingdomwars.nativeclient.wallet

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.vehicle.VehiclePolicy
import gg.pixelkingdomwars.nativeclient.vehicle.VehicleProtocol
import java.security.MessageDigest
import java.util.Base64
import kotlinx.serialization.json.*
import org.bouncycastle.math.ec.rfc8032.Ed25519

/** Installed independently of any API record; copied so callers cannot replace pins
 * during an approval. Historic verification deliberately does not require these pins. */
class VehicleSigningTrust private constructor(private val owned: JsonObject) {
    fun toJson(): JsonObject = VehicleProtocol.copy(owned).jsonObject
    internal val core get() = owned.charterObject("core")
    companion object {
        fun from(raw: JsonObject): VehicleSigningTrust {
            val v = VehicleProtocol.copy(raw).jsonObject
            require(v.keys == setOf("version","revision","core","operationalPolicyVersion"))
            require(vehicleNumber(v,"version") == 1L && vehicleNumber(v,"operationalPolicyVersion") == 1L)
            require(v.charterText("revision").length in 1..128)
            val c = v.charterObject("core")
            require(c.keys == setOf("expectedGenesisHash","reviewedDeploymentSlot","reviewedProgramDataSha256","upgradeAuthority"))
            vehicleKey(c.charterText("expectedGenesisHash")); vehicleNumber(c,"reviewedDeploymentSlot")
            vehicleHex(c.charterText("reviewedProgramDataSha256"),32,32)
            if (c["upgradeAuthority"] != JsonNull) vehicleKey(c.charterText("upgradeAuthority"))
            return VehicleSigningTrust(v)
        }
    }
}

/** Only wallet-module reconstruction can create this capability; all buffers are owned.
 * It verifies consent bytes, never current ownership, network finality or game effects. */
class PreparedVehicle internal constructor(val wallet: String, message: ByteArray) {
    private val message = message.copyOf()
    val messageSha256: String = vehicleHash(this.message)
    fun unsignedTransaction(): ByteArray = byteArrayOf(1) + ByteArray(64) + message
    fun verifySigned(bytes: ByteArray): JsonObject {
        require(bytes.size in 66..1232 && bytes.size == 65 + message.size && bytes[0] == 1.toByte()) { "Invalid vehicle wire" }
        val wire = bytes.copyOf()
        require(wire.copyOfRange(65,wire.size).contentEquals(message)) { "Wallet changed the original vehicle burn" }
        val signature = wire.copyOfRange(1,65)
        require(Ed25519.verify(signature,0,vehicleKey(wallet),0,message,0,message.size)) { "Invalid original-wallet vehicle signature" }
        return buildJsonObject {
            put("signedTransactionHex",vehicleHex(wire)); put("signature",base58(signature))
            put("wireSha256",vehicleHash(wire)); put("messageSha256",messageSha256)
        }
    }
    fun verifySignedBase64(value: String): JsonObject = verifySigned(vehicleBase64(value,1232))
    fun verifyWire(raw: JsonObject): JsonObject {
        val v = VehicleProtocol.copy(raw).jsonObject
        require(v.keys == setOf("signedTransactionHex","signature","wireSha256","messageSha256"))
        val checked = verifySigned(vehicleHex(v.charterText("signedTransactionHex"),66,1232))
        require(v == checked) { "Vehicle wire metadata differs from signed bytes" }
        return checked
    }
}

/** Independent legacy compiler: exactly Core BurnV1(0c00), then a single-wallet
 * Memo. No v0, lookup tables, compute budget, replacement hash or policy signer. */
object VehicleTransaction {
    fun prepare(client: JsonObject, trust: VehicleSigningTrust, policy: VehiclePolicy): PreparedVehicle {
        val v = VehicleProtocol.client(client)
        val p = canonical(v,policy)
        val source = v.charterObject("consentSource"); val pins = trust.core
        require(source["genesisHash"] == pins["expectedGenesisHash"] &&
            source["reviewedDeploymentSlot"] == pins["reviewedDeploymentSlot"] &&
            source["reviewedProgramDataSha256"] == pins["reviewedProgramDataSha256"]) { "Vehicle deployment differs from installed pins" }
        verifyMetadata(v,p)
        return p
    }

    fun verifyWire(client: JsonObject, wire: JsonObject, policy: VehiclePolicy): JsonObject {
        val v = VehicleProtocol.client(client); val p = canonical(v,policy)
        verifyMetadata(v,p)
        val checked = p.verifyWire(wire)
        val saved = v.charterObject("record").charterOptional("signed") ?: v.charterOptional("burnReceipt")
        if (saved != null) for (k in listOf("signature","wireSha256","messageSha256")) require(checked[k] == saved[k])
        return checked
    }

    /** A terminal can be recovered without a locally retained wire. Reconstruct the
     * exact original packet from its public signature before allowing archival. This
     * binds consent/effect; the authenticated source reader still owns finality. */
    fun verifyHistory(client: JsonObject, policy: VehiclePolicy) {
        val v = VehicleProtocol.client(client); policy.verifyClient(v)
        if (v.charterObject("record").charterOptional("preparation") == null) return
        verifyMetadata(v,canonical(v,policy))
    }

    private fun verifyMetadata(client: JsonObject, prepared: PreparedVehicle) {
        val r = client.charterObject("record")
        for (metadata in listOfNotNull(r.charterOptional("signed"),client.charterOptional("burnReceipt"))) {
            val signatureText = metadata.charterText("signature")
            require(signatureText.length in 64..88)
            val signature = base58Decode(signatureText)
            require(signature.size == 64 && base58(signature) == signatureText)
            val bytes = prepared.unsignedTransaction().also { signature.copyInto(it,1) }
            val checked = prepared.verifySigned(bytes)
            for (k in listOf("signature","messageSha256","wireSha256")) require(metadata[k] == checked[k])
        }
    }

    private fun canonical(client: JsonObject, policy: VehiclePolicy): PreparedVehicle {
        policy.verifyClient(client)
        val r = client.charterObject("record"); val p = r.charterObject("preparation")
        val original = VehicleProtocol.original(client); val identity = original.charterObject("identity")
        val wallet = vehicleKey(VehicleProtocol.actor(client)); val asset = vehicleKey(identity.charterText("assetId"))
        val collection = vehicleKey(identity.charterText("collection")); val core = vehicleKey(VEHICLE_CORE)
        val memo = vehicleKey(VEHICLE_MEMO); val system = ByteArray(32)
        require(Ed25519.validatePublicKeyFull(wallet,0)) { "Vehicle payer must be the original Ed25519 wallet" }
        require(listOf(wallet,asset,collection,core,memo,system).map(::base58).distinct().size == 6) { "Vehicle roles overlap" }
        val id = VehicleProtocol.reference(client).charterText("id")
        val memoText = if (client.charterText("kind") == "installation") {
            "shardkeep:vehicle-install:v1:$id:${identity.charterText("family")}:${vehicleNumber(identity,"tier") }"
        } else {
            // Compact JSON, fixed field order, string counters. This is NOT JSONB.
            val effect = policy.serviceEffect(original.charterObject("state"))
            val order = listOf("version","operation","installationId","baseId","berthId","revision","family","tier",
                "completedTotal","allowanceStart","tierAfter","revisionAfter","allowanceStartAfter","remainingUses")
            require(effect.keys == order.toSet())
            val text = JsonObject(order.associateWith { effect.getValue(it) }).toString()
            val serviceHash = vehicleHash(text.toByteArray(Charsets.UTF_8))
            require(serviceHash == p.charterText("serviceSha256")) { "Vehicle service effect changed" }
            "shardkeep:vehicle-service:v1:$id:$serviceHash"
        }
        val burn = Instruction(core,listOf(AccountMeta(asset,false,true),AccountMeta(collection,false,true),
            AccountMeta(wallet,true,true),AccountMeta(wallet,true,false),AccountMeta(system,false,false),AccountMeta(core,false,false)),byteArrayOf(12,0))
        val note = Instruction(memo,listOf(AccountMeta(wallet,true,false)),memoText.toByteArray(Charsets.UTF_8))
        val expected = compileMiningMessage(wallet,vehicleKey(p.charterText("blockhash")),listOf(burn,note))
        require(expected.contentEquals(vehicleHex(p.charterText("messageHex"),1,1167)) && vehicleHash(expected) == p.charterText("messageSha256")) {
            "Vehicle instructions do not match the original consent"
        }
        return PreparedVehicle(base58(wallet),expected)
    }
}

internal const val VEHICLE_CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
internal const val VEHICLE_MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
internal const val VEHICLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111"
internal fun vehicleKey(value: String): ByteArray {
    require(value.length in 32..44)
    return publicKeyBytes(value).also { require(base58(it) == value && it.any { b -> b != 0.toByte() }) }
}
internal fun vehicleNumber(v: JsonObject, name: String): Long = CharterGrammar.number(v.getValue(name))
internal fun vehicleHex(value: String, min: Int, max: Int): ByteArray {
    require(value.length in min*2..max*2 && value.length%2 == 0 && value.matches(Regex("[0-9a-f]+")))
    return ByteArray(value.length/2) { value.substring(it*2,it*2+2).toInt(16).toByte() }
}
internal fun vehicleHex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
internal fun vehicleHash(bytes: ByteArray): String = vehicleHex(MessageDigest.getInstance("SHA-256").digest(bytes))
internal fun vehicleBase64(value: String, max: Int): ByteArray {
    require(value.length in 4..((max+2)/3*4) && value.length%4 == 0)
    return Base64.getDecoder().decode(value).also { require(it.size<=max && Base64.getEncoder().encodeToString(it)==value) }
}
