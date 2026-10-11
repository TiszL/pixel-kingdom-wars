package gg.pixelkingdomwars.nativeclient.wallet

import com.solana.publickey.ProgramDerivedAddress
import com.solana.publickey.SolanaPublicKey
import gg.pixelkingdomwars.nativeclient.retirement.RetirementProtocol
import java.math.BigInteger
import kotlinx.serialization.json.*
import org.bouncycastle.math.ec.rfc8032.Ed25519

/** Independent kind-9 reconstruction using installed trust and admitted catalogue policy.
 * Historical verification is allowed after completion or expiry. It never authorizes a
 * wallet prompt, delivery, finality or release; fresh eligibility belongs to the caller. */
object RetirementTransaction {
    suspend fun prepare(operation: JsonObject, trust: CharterSigningTrust, actor: String,
        policy: CharterCryptoPolicy): PreparedCharter {
        val v = RetirementProtocol.operation(operation); policy.validate()
        val attempt = v.tObj("attempt"); val quote = attempt.tObj("quote")
        val input = quote.tObj("packetInput"); val observation = quote.tObj("observation")
        val pins = trust.toJson(); val lock = v.tObj("original").tObj("retirement")
        require(pins.tObj("deployment") == observation.tObj("source").tObj("programs"))
        require(pins.tText("policySigner") == input.tText("policySigner"))
        require(pins.tNumber("royaltyBps") == policy.royaltyBps.toLong())
        require(pins.getValue("lookupTables").jsonArray.any { it == input["expectedLookupTable"] })
        require(actor == lock.tText("leader") && Ed25519.validatePublicKeyFull(cKey(actor), 0))
        val bytes = canonical(v, policy)
        val packet = v.tObj("preparation").tObj("packet")
        val candidate = cHex(input.tText("candidateHex"), 161, 161)
        val prepared = PreparedCharter(actor, "retirement", attempt.tText("id"), packet.tText("messageSha256"),
            cReadLe(candidate.copyOfRange(121,129)).longValueExactCompat(),
            cAmount(observation.tText("unixTimestamp"),63).longValueExactCompat(), listOf(actor), bytes)
        val retained = v["signed"] as? JsonObject ?: return prepared
        checkWire(prepared, retained)
        return prepared.withRetainedTransaction(cHex(retained.tText("signedTransactionHex"), 66, 1232))
    }

    suspend fun verifyWire(operation: JsonObject, trust: CharterSigningTrust, wire: JsonObject,
        policy: CharterCryptoPolicy): JsonObject {
        val leader = operation.tObj("original").tObj("retirement").tText("leader")
        return checkWire(prepare(operation, trust, leader, policy), wire)
    }

    fun toWire(prepared: PreparedCharter, signed: SignedCharter): JsonObject {
        require(prepared.kind == "retirement")
        val bytes = cDecode64(signed.wire, 1232)
        val checked = prepared.verifySigned(bytes)
        require(checked == signed && checked.transactionSignature != null)
        return buildJsonObject {
            put("signedTransactionHex", bytes.tHex())
            put("signature", requireNotNull(checked.transactionSignature))
            put("wireSha256", cHash(bytes)); put("messageSha256", prepared.messageSha256)
        }
    }

    private fun checkWire(prepared: PreparedCharter, wire: JsonObject): JsonObject {
        val v = RetirementProtocol.wire(wire)
        val bytes = cHex(v.tText("signedTransactionHex"), 66, 1232)
        val checked = prepared.verifySigned(bytes)
        require(checked.transactionSignature != null && checked.transactionSignature == v.tText("signature"))
        require(cHash(bytes) == v.tText("wireSha256") && prepared.messageSha256 == v.tText("messageSha256"))
        return v
    }

    private suspend fun canonical(v: JsonObject, rules: CharterCryptoPolicy): ByteArray {
        val original = v.tObj("original"); val creation = original.tObj("creation")
        val lock = original.tObj("retirement"); val chain = creation.tObj("chain")
        val quote = v.tObj("attempt").tObj("quote"); val input = quote.tObj("packetInput")
        val observation = quote.tObj("observation"); val deployment = observation.tObj("source").tObj("programs")
        val economy = cKey(chain.tText("economyProgram")); val craft = cKey(chain.tText("craftProgram"))
        val leader = cKey(lock.tText("leader")); val clan = cId(creation.tText("clanId"))
        suspend fun pda(program: ByteArray, seed: String, vararg tails: ByteArray): ByteArray =
            ProgramDerivedAddress.find(listOf(seed.toByteArray(Charsets.UTF_8), *tails), SolanaPublicKey(program)).getOrThrow().bytes
        val candidate = cHex(input.tText("candidateHex"),161,161)
        val permit = candidate.copyOfRange(73,89); require(permit.any { it != 0.toByte() })
        val expiry = cReadLe(candidate.copyOfRange(121,129)); val clock = cAmount(observation.tText("unixTimestamp"),63)
        require(expiry.bitLength() <= 63 && expiry > clock && expiry - clock == BigInteger.valueOf(rules.issuedPermitTtlSec))
        val asset = pda(craft,"charter_mint",clan)
        val a = linkedMapOf("authority" to pda(economy,"seeker_authority"), "config" to pda(economy,"charter_config"),
            "transferConfig" to pda(economy,"charter_transfer_config"), "craftControl" to pda(craft,"charter_control"),
            "collection" to pda(craft,"charter_collection"), "collectionAuthority" to pda(craft,"charter_collection_authority"),
            "charter" to pda(economy,"charter",clan), "asset" to asset, "assetBinding" to pda(economy,"charter_asset",asset),
            "freezeAuthority" to pda(craft,"charter_freeze",clan), "executor" to pda(economy,"charter_executor",clan),
            "creationReceipt" to pda(economy,"charter_creation",cId(creation.tText("creationIntentId"))), "receipt" to pda(economy,"permit",permit))
        for (field in listOf("config","craftControl","collection","collectionAuthority","charter","asset","assetBinding","freezeAuthority","executor","creationReceipt"))
            require(base58(a.getValue(field)) == chain.tText(field)) { "Retirement Charter PDA differs" }
        require(cHex(lock.tText("clearanceHash"),32,32).any { it != 0.toByte() })
        val metadata = creation.tObj("metadata")
        require(cKeccak("SKCHMET1".toByteArray() + cStr(metadata.tText("name")) + cStr(metadata.tText("uri")))
            .contentEquals(cHex(metadata.tText("hash"),32,32)))
        val core = cKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d")
        require(deployment.tText("expectedGenesisHash") == chain.tText("genesisHash"))
        require(deployment.tObj("economy").tText("programId") == base58(economy) && deployment.tObj("craft").tText("programId") == base58(craft))
        require(deployment.tObj("core").tText("programId") == base58(core))
        require(listOf(base58(economy),base58(craft),base58(core)).distinct().size == 3)
        for (program in listOf("economy","craft","core")) require(deployment.tObj(program).tNumber("reviewedDeploymentSlot") <= observation.tNumber("slot"))
        val retirement = pda(economy,"charter_retirement",clan)
        val payload = "SKCHRET1".toByteArray() + byteArrayOf(1,0) + cConcat(listOf(a.getValue("config"),craft,a.getValue("craftControl"),a.getValue("collection"),a.getValue("collectionAuthority"),a.getValue("charter"),asset,a.getValue("assetBinding"),a.getValue("freezeAuthority"),retirement,leader)) +
            clan + cId(lock.tText("id")) + cId(lock.tText("fenceId")) + cLe(BigInteger.valueOf(lock.tNumber("expectedRevision")),4) + cHex(lock.tText("clearanceHash"),32,32)
        val expected = "SKPERMT2".toByteArray() + cKey(chain.tText("genesisHash")) + economy + byteArrayOf(9) + permit + leader + cLe(expiry) + cKeccak(payload)
        require(candidate.contentEquals(expected))
        val policySignature = cHex(v.tObj("preparation").tText("policySignatureHex"),64,64)
        cVerify(input.tText("policySigner"),candidate,policySignature)
        val allocations = quote.tObj("costs").getValue("allocations").jsonArray.map { it.jsonObject }
        for ((kind,address,size) in listOf(Triple("permit-receipt",a.getValue("receipt"),107L),Triple("retirement-receipt",retirement,250L))) {
            val allocation=allocations.single { it.tText("kind")==kind }
            require(allocation.tText("address")==base58(address) && allocation.tNumber("bytes")==size)
        }
        val table=input.tObj("lookupTable");val raw=cHex(table.tText("dataHex"),56,8248)
        require((raw.size-56)%32==0 && table.tText("owner")=="AddressLookupTab1e1111111111111111111111111" && cHash(raw)==input.tObj("expectedLookupTable").tText("dataSha256"))
        require(cReadLe(raw.copyOfRange(0,4))==BigInteger.ONE && raw.copyOfRange(4,12).all { it==(-1).toByte() } && raw[21]==0.toByte())
        val count=(raw.size-56)/32;require(count in 1..256 && (raw[20].toInt() and 255)<=count && cReadLe(raw.copyOfRange(12,20))<BigInteger.valueOf(table.tNumber("slot")))
        val addresses=(0 until count).map { raw.copyOfRange(56+32*it,88+32*it) }
        require(addresses.map(::base58).distinct().size==addresses.size)
        val sysvar=cKey("Sysvar1nstructions1111111111111111111111111");val system=ByteArray(32)
        val keys=listOf(leader,a.getValue("authority"),a.getValue("config"),a.getValue("charter"),a.getValue("assetBinding"),retirement,a.getValue("receipt"),craft,a.getValue("craftControl"),asset,a.getValue("collection"),a.getValue("collectionAuthority"),a.getValue("freezeAuthority"),core,sysvar,system)
        require(keys.map(::base58).distinct().size==keys.size)
        val instruction=Instruction(economy,keys.mapIndexed { i,key->AccountMeta(key,i==0,i in listOf(0,3,5,6)) },
            cDiscriminator("retire_charter") + clan + cId(lock.tText("id")) + cId(lock.tText("fenceId")) + cLe(BigInteger.valueOf(lock.tNumber("expectedRevision")),4) + cHex(lock.tText("clearanceHash"),32,32) + permit + cLe(expiry) + cLe(BigInteger.ONE,2))
        val compute = Instruction(cKey("ComputeBudget111111111111111111111111111111"), emptyList(), byteArrayOf(2) + cLe(BigInteger.valueOf(rules.computeUnitLimit.toLong()),4))
        fun build(signature: ByteArray): ByteArray {
            val ed = Instruction(cKey("Ed25519SigVerify111111111111111111111111111"),emptyList(),
                byteArrayOf(1,0) + cLe(BigInteger.valueOf(48),2) + byteArrayOf(-1,-1) + cLe(BigInteger.valueOf(16),2) + byteArrayOf(-1,-1) +
                    cLe(BigInteger.valueOf(112),2) + cLe(BigInteger.valueOf(161),2) + byteArrayOf(-1,-1) + cKey(input.tText("policySigner")) + signature + candidate)
            return compileV0(leader,cKey(input.tText("blockhash")),listOf(compute,ed,instruction),cKey(table.tText("address")),addresses)
        }
        fun checkPacket(packet: JsonObject, bytes: ByteArray) {
            val actual = cHex(packet.tText("messageHex"),1,1167)
            val unsigned = byteArrayOf(1) + ByteArray(64) + bytes
            require(bytes.contentEquals(actual) && cHash(bytes) == packet.tText("messageSha256"))
            require(unsigned.size <= 1232 && unsigned.size.toLong() == packet.tNumber("packetBytes") && unsigned.contentEquals(cHex(packet.tText("unsignedTransactionHex"),66,1232)))
        }
        val message = build(policySignature)
        checkPacket(v.tObj("preparation").tObj("packet"),message)
        checkPacket(quote.tObj("template"),build(ByteArray(64)))
        return message
    }
}

private fun JsonObject.tObj(key: String) = requireNotNull(this[key] as? JsonObject)
private fun JsonObject.tText(key: String) = getValue(key).jsonPrimitive.content
private fun JsonObject.tNumber(key: String) = getValue(key).jsonPrimitive.long
private fun ByteArray.tHex() = joinToString("") { "%02x".format(it.toInt() and 255) }
