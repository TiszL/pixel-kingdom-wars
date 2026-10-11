package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.mining.*
import kotlinx.serialization.json.*

/** Owner failure assertions over public cryptographically signed packets, not a chain-finality fixture. */
internal fun taxFailureFixture(recovery: MiningTaxClaimsRecoveryEnvelope, ordinals: List<Int> = listOf(0),
    setup: MiningTaxClaimsRecoveryEnvelope? = null): JsonObject {
    val p = requireNotNull(recovery.preparation); val s = p.source
    val slot = maxOf(s.snapshotSlot, s.blockhashSlot) + 1
    val r = setup?.copy(wires = recovery.wires) ?: recovery.copy(status = "signed", settlement = null)
    val failures = ordinals.map { ordinal ->
        val w = recovery.wires.single { it.ordinal == ordinal.toLong() }
        MiningTaxClaimsFailure(p.wallet, p.idempotencyKey, p.claimId, w.ordinal,
            MiningTaxClaimsFailureReceipt(1, p.wallet, p.idempotencyKey, p.claimId, p.round, p.spot, w.ordinal, w.kind,
                w.signature, w.messageSha256, w.wireSha256, slot, p.snapshot.unixTimestamp.toLong(), "18446744073709551615", "0", "0",
                MiningTaxClaimsFailureSource("trusted-finalized-rpc-reviewed-program", p.identity.genesisHash, p.identity.programId,
                    p.identity.configAddress, s.reviewedDeploymentSlot, s.reviewedProgramDataSha256, s.snapshotSha256, s.snapshotSlot, s.blockhashSlot, slot + 1),
                "failed", true, false, false, false, false), "2020-01-01T00:00:00.000000Z", true, false)
    }
    return Json.encodeToJsonElement(MiningTaxClaimsFailureEnvelope.serializer(), MiningTaxClaimsFailureEnvelope(r, failures)).jsonObject
}

/** A corrupt signature packet with a recomputed wire digest; later siblings stay independently recoverable. */
internal fun corruptTaxFailureWire(raw: JsonObject): JsonObject {
    val r = raw.getValue("recovery").jsonObject; val wires = r.getValue("wires").jsonArray.toMutableList(); val w = wires[0].jsonObject
    val bytes = w.getValue("signedTransactionHex").jsonPrimitive.content.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    bytes[1] = (bytes[1].toInt() xor 1).toByte()
    val hash = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
    wires[0] = JsonObject(w + mapOf("signedTransactionHex" to JsonPrimitive(bytes.joinToString("") { "%02x".format(it.toInt() and 255) }), "wireSha256" to JsonPrimitive(hash)))
    return JsonObject(raw + ("recovery" to JsonObject(r + ("wires" to JsonArray(wires)))))
}
