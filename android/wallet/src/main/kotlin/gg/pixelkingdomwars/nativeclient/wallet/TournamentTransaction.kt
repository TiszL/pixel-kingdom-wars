package gg.pixelkingdomwars.nativeclient.wallet

import com.solana.publickey.ProgramDerivedAddress
import com.solana.publickey.SolanaPublicKey
import gg.pixelkingdomwars.nativeclient.tournament.TournamentProtocol
import java.math.BigInteger
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import kotlinx.serialization.json.*
import org.bouncycastle.math.ec.rfc8032.Ed25519

/** Independent kind-6 reconstruction using installed trust and admitted catalogue policy.
 * Historical verification is allowed after completion or expiry. It never authorizes a
 * wallet prompt, delivery, finality or release; fresh eligibility belongs to the caller. */
object TournamentTransaction {
    suspend fun prepare(operation: JsonObject, trust: CharterSigningTrust, actor: String,
        policy: CharterCryptoPolicy): PreparedCharter {
        val v = TournamentProtocol.operation(operation); policy.validate()
        val attempt = v.tObj("attempt"); val quote = attempt.tObj("quote")
        val input = quote.tObj("packetInput"); val observation = quote.tObj("observation")
        val pins = trust.toJson(); val lock = v.tObj("original").tObj("operation")
        require(pins.tObj("deployment") == observation.tObj("source").tObj("programs"))
        require(pins.tText("policySigner") == input.tText("policySigner"))
        require(pins.tNumber("royaltyBps") == policy.royaltyBps.toLong())
        require(pins.tText("treasury") == v.tObj("operationTerms").tObj("domain").tText("treasury"))
        require(pins.getValue("lookupTables").jsonArray.any { it == input["expectedLookupTable"] })
        require(actor == lock.tText("leader") && Ed25519.validatePublicKeyFull(cKey(actor), 0))
        val bytes = canonical(v, policy)
        val packet = v.tObj("preparation").tObj("packet")
        val candidate = cHex(input.tText("candidateHex"), 161, 161)
        val prepared = PreparedCharter(actor, "tournament", attempt.tText("id"), packet.tText("messageSha256"),
            cReadLe(candidate.copyOfRange(121,129)).longValueExactCompat(),
            cAmount(observation.tText("unixTimestamp"),63).longValueExactCompat(), listOf(actor), bytes)
        val retained = v["signed"] as? JsonObject ?: return prepared
        checkWire(prepared, retained)
        return prepared.withRetainedTransaction(cHex(retained.tText("signedTransactionHex"), 66, 1232))
    }

    suspend fun verifyWire(operation: JsonObject, trust: CharterSigningTrust, wire: JsonObject,
        policy: CharterCryptoPolicy): JsonObject {
        val leader = operation.tObj("original").tObj("operation").tText("leader")
        return checkWire(prepare(operation, trust, leader, policy), wire)
    }

    fun toWire(prepared: PreparedCharter, signed: SignedCharter): JsonObject {
        require(prepared.kind == "tournament")
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
        val v = TournamentProtocol.wire(wire)
        val bytes = cHex(v.tText("signedTransactionHex"), 66, 1232)
        val checked = prepared.verifySigned(bytes)
        require(checked.transactionSignature != null && checked.transactionSignature == v.tText("signature"))
        require(cHash(bytes) == v.tText("wireSha256") && prepared.messageSha256 == v.tText("messageSha256"))
        return v
    }

    /** jsonb orders object keys by UTF8 byte length, then unsigned bytes; arrays retain order. */
    fun termsText(terms: JsonObject): String {
        fun utf8(s: String): ByteArray {
            val encoded = Charsets.UTF_8.newEncoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).encode(CharBuffer.wrap(s))
            return ByteArray(encoded.remaining()).also { encoded.get(it) }
        }
        val order = Comparator<String> { left, right ->
            val a = utf8(left); val b = utf8(right)
            if (a.size != b.size) a.size.compareTo(b.size) else {
                var result = 0
                for (i in a.indices) { result = (a[i].toInt() and 255).compareTo(b[i].toInt() and 255); if (result != 0) break }
                result
            }
        }
        fun encode(value: JsonElement): String = when (value) {
            is JsonObject -> value.keys.sortedWith(order).joinToString(", ", "{", "}") {
                utf8(it); JsonPrimitive(it).toString() + ": " + encode(value.getValue(it))
            }
            is JsonArray -> value.joinToString(", ", "[", "]") { encode(it) }
            is JsonPrimitive -> {
                if (value.isString) utf8(value.content)
                else require(value == JsonNull || value.content in listOf("true", "false") ||
                    value.content.matches(Regex("-?(0|[1-9][0-9]*)")))
                value.toString()
            }
        }
        return encode(TournamentProtocol.copy(terms))
    }

    fun termsHash(terms: JsonObject): String = cHash(
        ("SHARDKEEP_CHARTER_TOURNAMENT_LOCK_TERMS_V1" + termsText(terms)).toByteArray(Charsets.UTF_8))

    private suspend fun canonical(v: JsonObject, rules: CharterCryptoPolicy): ByteArray {
        val original = v.tObj("original"); val creation = original.tObj("creation")
        val lock = original.tObj("operation"); val chain = creation.tObj("chain")
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
            require(base58(a.getValue(field)) == chain.tText(field)) { "Tournament Charter PDA differs" }
        require(termsHash(v.tObj("operationTerms")) == lock.tText("termsHash"))
        val metadata = creation.tObj("metadata")
        require(cKeccak("SKCHMET1".toByteArray() + cStr(metadata.tText("name")) + cStr(metadata.tText("uri")))
            .contentEquals(cHex(metadata.tText("hash"),32,32)))
        val core = cKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d")
        require(deployment.tText("expectedGenesisHash") == chain.tText("genesisHash"))
        require(deployment.tObj("economy").tText("programId") == base58(economy) && deployment.tObj("craft").tText("programId") == base58(craft))
        require(deployment.tObj("core").tText("programId") == base58(core))
        require(listOf(base58(economy),base58(craft),base58(core)).distinct().size == 3)
        for (program in listOf("economy","craft","core")) require(deployment.tObj(program).tNumber("reviewedDeploymentSlot") <= observation.tNumber("slot"))
        val payload = "SKCHLCK1".toByteArray() + byteArrayOf(1,0) + cConcat(listOf(a.getValue("config"),a.getValue("charter"),asset,leader)) +
            clan + cId(lock.tText("lockId")) + cLe(BigInteger.valueOf(lock.tNumber("expectedRevision")),4) +
            byteArrayOf(if (lock.tText("action") == "set") 1 else 2) + cHex(lock.tText("termsHash"),32,32)
        val expected = "SKPERMT2".toByteArray() + cKey(chain.tText("genesisHash")) + economy + byteArrayOf(6) + permit + leader + cLe(expiry) + cKeccak(payload)
        require(candidate.contentEquals(expected))
        val policySignature = cHex(v.tObj("preparation").tText("policySignatureHex"),64,64)
        cVerify(input.tText("policySigner"),candidate,policySignature)
        val allocation = quote.tObj("costs").getValue("allocations").jsonArray.single().jsonObject
        require(allocation.tText("address") == base58(a.getValue("receipt")))
        val table = input.tObj("lookupTable"); val raw = cHex(table.tText("dataHex"),440,440)
        require(table.tText("owner") == "AddressLookupTab1e1111111111111111111111111" && cHash(raw) == input.tObj("expectedLookupTable").tText("dataSha256"))
        require(cReadLe(raw.copyOfRange(0,4)) == BigInteger.ONE && raw.copyOfRange(4,12).all { it == (-1).toByte() } && raw[21] == 0.toByte())
        require(cReadLe(raw.copyOfRange(12,20)) < BigInteger.valueOf(table.tNumber("slot")) && (raw[20].toInt() and 255) <= 12)
        val addresses = (0 until 12).map { raw.copyOfRange(56+32*it,88+32*it) }
        val sysvar = cKey("Sysvar1nstructions1111111111111111111111111"); val system = ByteArray(32)
        val expectedLookup = listOf(a.getValue("authority"),a.getValue("config"),a.getValue("transferConfig"),craft,a.getValue("craftControl"),
            a.getValue("collection"),a.getValue("collectionAuthority"),core,sysvar,system,economy,cKey(v.tObj("operationTerms").tObj("domain").tText("treasury")))
        require(expectedLookup.map(::base58).distinct().size == 12 && addresses.indices.all { addresses[it].contentEquals(expectedLookup[it]) })
        val keys = listOf(leader,a.getValue("authority"),a.getValue("config"),a.getValue("charter"),a.getValue("craftControl"),a.getValue("receipt"),sysvar,system)
        val instruction = Instruction(economy, keys.mapIndexed { i,key -> AccountMeta(key,i==0,i in listOf(0,3,5)) },
            cDiscriminator(lock.tText("action") + "_charter_lock") + clan + cId(lock.tText("lockId")) + cLe(BigInteger.valueOf(lock.tNumber("expectedRevision")),4) +
                cHex(lock.tText("termsHash"),32,32) + permit + cLe(expiry) + cLe(BigInteger.ONE,2))
        val compute = Instruction(cKey("ComputeBudget111111111111111111111111111111"), emptyList(), byteArrayOf(2) + cLe(BigInteger.valueOf(rules.computeUnitLimit.toLong()),4))
        fun build(signature: ByteArray): ByteArray {
            val ed = Instruction(cKey("Ed25519SigVerify111111111111111111111111111"),emptyList(),
                byteArrayOf(1,0) + cLe(BigInteger.valueOf(48),2) + byteArrayOf(-1,-1) + cLe(BigInteger.valueOf(16),2) + byteArrayOf(-1,-1) +
                    cLe(BigInteger.valueOf(112),2) + cLe(BigInteger.valueOf(161),2) + byteArrayOf(-1,-1) + cKey(input.tText("policySigner")) + signature + candidate)
            return compileV0(leader,cKey(input.tText("blockhash")),listOf(compute,ed,instruction),cKey(table.tText("address")),addresses)
        }
        fun checkPacket(packet: JsonObject, bytes: ByteArray) {
            val actual = cHex(packet.tText("messageHex"),1,1167); boundedV0(actual,1)
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
