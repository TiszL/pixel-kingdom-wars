package gg.pixelkingdomwars.nativeclient.wallet

import com.solana.publickey.ProgramDerivedAddress
import com.solana.publickey.SolanaPublicKey
import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.security.MessageDigest
import java.util.Base64
import kotlinx.serialization.json.*
import org.bouncycastle.crypto.digests.KeccakDigest
import org.bouncycastle.math.ec.rfc8032.Ed25519

/** Values arrive from the admitted canonical constants catalogue, never a quote. */
data class CharterCryptoPolicy(val computeUnitLimit: Int, val maxPolicyPermitTtlSec: Long,
    val issuedPermitTtlSec: Long, val coreCreateFeeLamports: String, val royaltyBps: Int, val basisPoints: Int) {
    internal fun validate() {
        require(computeUnitLimit > 0 && maxPolicyPermitTtlSec > 0 && issuedPermitTtlSec in 1..maxPolicyPermitTtlSec)
        require(basisPoints in 1..65535 && royaltyBps in 0..basisPoints); cAmount(coreCreateFeeLamports)
    }
}
/** Operator-owned immutable configuration; no response can configure this object. */
class CharterSigningTrust private constructor(private val raw: JsonObject) {
    fun toJson(): JsonObject = cOwn(raw)
    override fun equals(other: Any?) = other is CharterSigningTrust && raw == other.raw
    override fun hashCode() = raw.hashCode()
    companion object {
        fun from(raw: JsonObject): CharterSigningTrust {
            val v = cOwn(raw); v.shape("version revision deployment policySigner treasury royaltyBps lookupTables")
            require(v.number("version") == 1L && v.string("revision").matches(Regex("[A-Za-z0-9_.:-]{1,128}")))
            cDeployment(v.obj("deployment")); cKey(v.string("policySigner")); cKey(v.string("treasury"))
            require(v.number("royaltyBps") <= 65535)
            val tables = v.array("lookupTables", 4); require(tables.isNotEmpty())
            tables.forEach { cLookupPin(it.jsonObject) }
            require(tables.map { it.jsonObject.string("address") }.distinct().size == tables.size)
            return CharterSigningTrust(v)
        }
    }
}
data class SignedCharter(val wire: String, val signature: String, val transactionSignature: String?)

/** Opaque exact v0 message, including any separately retained counterparty signature.
 * A partial result is evidence only; transactionSignature exists only when all slots verify. */
class PreparedCharter internal constructor(val wallet: String, val kind: String, val attemptId: String,
    val messageSha256: String, val expiryUnixTimestamp: Long, val observedUnixTimestamp: Long, private val wallets: List<String>, message: ByteArray, retained: ByteArray? = null) {
    private val message = message.copyOf()
    private val original = retained?.copyOf() ?: (byteArrayOf(wallets.size.toByte()) + ByteArray(64 * wallets.size) + message)
    fun unsignedTransaction(): ByteArray = original.copyOf()
    private fun signatures(bytes: ByteArray): List<ByteArray> {
        val prefix = 1 + 64 * wallets.size
        require(bytes.size in (prefix + 1)..1232 && bytes.size == prefix + message.size && bytes[0].toInt() == wallets.size)
        require(bytes.copyOfRange(prefix, bytes.size).contentEquals(message)) { "Wallet changed the Charter message" }
        return wallets.indices.map { index ->
            bytes.copyOfRange(1 + 64 * index, 65 + 64 * index).also { sig ->
                if (sig.any { it != 0.toByte() }) cVerify(wallets[index], message, sig)
            }
        }
    }
    fun verifySigned(bytes: ByteArray): SignedCharter {
        val owned = bytes.copyOf(); val sigs = signatures(owned)
        val actorIndex = wallets.indexOf(wallet); require(actorIndex >= 0 && sigs[actorIndex].any { it != 0.toByte() })
        for (i in wallets.indices) {
            val old = original.copyOfRange(1 + i * 64, 65 + i * 64)
            require(old.all { it == 0.toByte() } || old.contentEquals(sigs[i])) { "Wallet discarded retained Charter evidence" }
        }
        return SignedCharter(cBase64(owned), cBase64(sigs[actorIndex]),
            if (sigs.all { s -> s.any { it != 0.toByte() } }) base58(sigs.first()) else null)
    }
    fun verifySignedBase64(wire: String): SignedCharter = verifySigned(cDecode64(wire, 1232))
    fun withRetainedTransaction(bytes: ByteArray): PreparedCharter {
        val owned = bytes.copyOf(); val sigs = signatures(owned)
        require(sigs.any { s -> s.any { it != 0.toByte() } })
        for (i in wallets.indices) {
            val old = original.copyOfRange(1 + i * 64, 65 + i * 64)
            require(old.all { it == 0.toByte() } || old.contentEquals(sigs[i]))
        }
        return PreparedCharter(wallet, kind, attemptId, messageSha256, expiryUnixTimestamp, observedUnixTimestamp, wallets, message, owned)
    }
}

/** D170/D175 exact ABI reconstruction. No RPC, clock, wallet prompt or relay here.
 * Historical verification uses independently saved pins and the original observed clock;
 * callers must separately check fresh network, height, expiry and lifecycle before approval. */
object CharterTransaction {
    suspend fun prepare(signing: JsonObject, trust: CharterSigningTrust, actor: String, policy: CharterCryptoPolicy): PreparedCharter {
        val v = cOwn(signing); policy.validate(); validateSigning(v, policy)
        val pins = trust.toJson()
        require(pins.obj("deployment") == v.obj("deployment") && pins.string("policySigner") == v.obj("policy").string("signer"))
        require(pins.number("royaltyBps") == policy.royaltyBps.toLong())
        require(pins.array("lookupTables", 4).any { it == v.obj("lookupPin") })
        val tableBytes = cHex(v.obj("lookupTable").string("dataHex"), 440, 440)
        require(base58(tableBytes.copyOfRange(408, 440)) == pins.string("treasury"))
        val kind = v.string("kind"); val original = v.obj("original")
        val wallets = if (kind == "creation") listOf(original.string("payer")) else {
            val terms = original.obj("terms"); require(terms.obj("domain").string("treasury") == pins.string("treasury"))
            listOf(terms.string("buyer"), terms.string("seller"))
        }
        require(actor in wallets); wallets.forEach { require(Ed25519.validatePublicKeyFull(cKey(it), 0)) }
        val message = canonical(v, policy)
        return PreparedCharter(actor, kind, v.string("attemptId"), v.obj("packet").string("messageSha256"),
            cReadLe(cHex(v.obj("policy").string("candidateHex"),161,161).copyOfRange(121,129)).longValueExactCompat(),
            cAmount(v.string("observedUnixTimestamp"),63).longValueExactCompat(), wallets, message)
    }
    suspend fun verifyWire(signing: JsonObject, trust: CharterSigningTrust, wire: JsonObject, policy: CharterCryptoPolicy): JsonObject {
        val owned = cOwn(wire); owned.shape("signedTransaction signature wireSha256 messageSha256")
        val actor = if (signing.string("kind") == "creation") signing.obj("original").string("payer") else signing.obj("original").obj("terms").string("buyer")
        val prepared = prepare(signing, trust, actor, policy)
        val bytes = cDecode64(owned.string("signedTransaction"), 1232); val checked = prepared.verifySigned(bytes)
        require(checked.transactionSignature != null && checked.transactionSignature == owned.string("signature"))
        require(cHash(bytes) == owned.string("wireSha256") && prepared.messageSha256 == owned.string("messageSha256"))
        return owned
    }
    suspend fun verifyContribution(signing: JsonObject, trust: CharterSigningTrust, contribution: JsonObject, policy: CharterCryptoPolicy): JsonObject {
        val owned = cOwn(contribution); owned.shape("wallet attemptId messageSha256 signature")
        require(signing.string("kind") == "sale")
        val p = prepare(signing, trust, owned.string("wallet"), policy)
        require(owned.string("attemptId") == p.attemptId && owned.string("messageSha256") == p.messageSha256)
        val signature = cDecode64(owned.string("signature"), 64).also { require(it.size == 64) }
        val wire = p.unsignedTransaction(); val index = if (owned.string("wallet") == signing.obj("original").obj("terms").string("buyer")) 0 else 1
        signature.copyInto(wire, 1 + 64 * index); p.verifySigned(wire)
        return owned
    }
    /** PostgreSQL jsonb key ordering is UTF8 byte length, then bytes. Closed terms use ASCII keys. */
    fun termsText(terms: JsonObject): String {
        fun encode(v: JsonElement): String = when (v) {
            is JsonObject -> v.keys.sortedWith(compareBy<String> { it.length }.thenBy { it })
                .joinToString(", ", "{", "}") { JsonPrimitive(it).toString() + ": " + encode(v.getValue(it)) }
            is JsonPrimitive -> v.toString()
            else -> throw IllegalArgumentException("Terms arrays are not allowed")
        }
        return encode(terms)
    }

    private suspend fun canonical(v: JsonObject, rules: CharterCryptoPolicy): ByteArray {
        val creation = v.string("kind") == "creation"; val original = v.obj("original")
        val o = if (creation) original else original.obj("creation"); val chain = o.obj("chain")
        val economy = cKey(chain.string("economyProgram")); val craft = cKey(chain.string("craftProgram"))
        suspend fun pda(program: ByteArray, seed: String, vararg tails: ByteArray): ByteArray =
            ProgramDerivedAddress.find(listOf(seed.toByteArray(Charsets.UTF_8), *tails), SolanaPublicKey(program)).getOrThrow().bytes
        val clan = cId(o.string("clanId")); val asset = pda(craft, "charter_mint", clan)
        val a = linkedMapOf(
            "authority" to pda(economy, "seeker_authority"), "config" to pda(economy, "charter_config"),
            "transferConfig" to pda(economy, "charter_transfer_config"), "craftProgram" to craft,
            "craftControl" to pda(craft, "charter_control"), "collection" to pda(craft, "charter_collection"),
            "collectionAuthority" to pda(craft, "charter_collection_authority"), "charter" to pda(economy, "charter", clan),
            "asset" to asset, "assetBinding" to pda(economy, "charter_asset", asset), "freezeAuthority" to pda(craft, "charter_freeze", clan),
            "executor" to pda(economy, "charter_executor", clan), "creationReceipt" to pda(economy, "charter_creation", cId(o.string("creationIntentId"))))
        for (field in listOf("config", "craftControl", "collection", "collectionAuthority", "charter", "asset", "assetBinding", "freezeAuthority", "executor", "creationReceipt"))
            require(base58(a.getValue(field)) == chain.string(field)) { "Charter PDA differs" }
        fun at(vararg names: String) = names.map { a.getValue(it) }
        val core = cKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d")
        require(base58(core) == v.obj("deployment").obj("core").string("programId"))
        require(listOf(base58(core),base58(economy),base58(craft)).distinct().size == 3)
        val metadata = o.obj("metadata"); val name = metadata.string("name"); val uri = metadata.string("uri")
        require(cKeccak("SKCHMET1".toByteArray() + cStr(name) + cStr(uri)).contentEquals(cHex(metadata.string("hash"),32,32)))
        val policy = v.obj("policy"); val candidate = cHex(policy.string("candidateHex"),161,161)
        val permit = candidate.copyOfRange(73,89); require(permit.any { it != 0.toByte() })
        val expiry = cReadLe(candidate.copyOfRange(121,129)); val clock = cAmount(v.string("observedUnixTimestamp"),63)
        require(expiry.bitLength() <= 63 && expiry > clock && expiry - clock <= BigInteger.valueOf(rules.maxPolicyPermitTtlSec))
        val receipt = pda(economy,"permit",permit); val args = permit + cLe(expiry) + cLe(BigInteger.ONE,2)
        val payer: ByteArray; val payload: ByteArray; val instruction: Instruction; val rents: List<Triple<String,ByteArray,Int>>
        val sysvar = cKey("Sysvar1nstructions1111111111111111111111111"); val system = ByteArray(32)
        if (creation) {
            payer = cKey(o.string("payer"))
            payload = "SKCHREG1".toByteArray() + byteArrayOf(1,0) + cConcat(at("config","craftProgram","craftControl","collection","collectionAuthority","charter","asset","assetBinding","freezeAuthority","executor","creationReceipt")) +
                clan + payer + cId(o.string("creationIntentId")) + cHex(metadata.string("hash"),32,32) + cHex(o.string("admissionCommitment"),32,32)
            val keys = listOf(payer) + at("authority","config","charter","assetBinding","creationReceipt") + listOf(receipt) + at("executor","craftProgram","craftControl","asset","collection","collectionAuthority","freezeAuthority") + listOf(core,sysvar,system,economy)
            instruction = Instruction(economy, keys.mapIndexed { i,k -> AccountMeta(k,i==0,i in listOf(0,3,4,5,6,10,11)) },
                cDiscriminator("register_charter") + clan + cId(o.string("creationIntentId")) + cHex(o.string("admissionCommitment"),32,32) + cStr(name) + cStr(uri) + args)
            // D170 reviewed account layouts; sizes are ABI, not economy constants.
            rents = listOf(Triple("charter",a.getValue("charter"),280),Triple("assetBinding",a.getValue("assetBinding"),90),
                Triple("creationReceipt",a.getValue("creationReceipt"),154),Triple("permitReceipt",receipt,107),Triple("asset",asset,137+name.toByteArray().size+uri.toByteArray().size))
        } else {
            val t = original.obj("terms"); val seller = cKey(t.string("seller")); payer = cKey(t.string("buyer"))
            val treasury = cKey(t.obj("domain").string("treasury"))
            require(expiry - clock == BigInteger.valueOf(rules.issuedPermitTtlSec) && t.number("expectedRevision") < 0xffffffffL)
            require(cHash(("SHARDKEEP_CHARTER_SALE_TERMS_V1" + termsText(t)).toByteArray()) == original.string("termsHash"))
            val transfer = pda(economy,"charter_transfer",cId(t.string("id")))
            payload = "SKCHXFR1".toByteArray() + byteArrayOf(1,0) + cConcat(at("config","transferConfig","craftProgram","craftControl","collection","collectionAuthority","charter","asset","assetBinding","freezeAuthority","executor") + listOf(transfer,seller,payer,treasury)) +
                clan + cId(t.string("id")) + cId(t.string("fenceId")) + cLe(BigInteger.valueOf(t.number("expectedRevision")),4) + cLe(cAmount(t.string("priceLamports"))) + cLe(BigInteger.valueOf(rules.royaltyBps.toLong()),2) + cHex(original.string("termsHash"),32,32)
            val keys = listOf(payer,seller) + at("authority","config","transferConfig") + listOf(treasury) + at("charter","assetBinding") + listOf(transfer,receipt) + at("executor","craftProgram","craftControl","asset","collection","collectionAuthority","freezeAuthority") + listOf(core,sysvar,system,economy)
            instruction = Instruction(economy, keys.mapIndexed { i,k -> AccountMeta(k,i<2,i in listOf(0,1,5,6,8,9,13,14)) },
                cDiscriminator("settle_charter_transfer") + clan + cId(t.string("id")) + cId(t.string("fenceId")) + cLe(BigInteger.valueOf(t.number("expectedRevision")),4) + cLe(cAmount(t.string("priceLamports"))) + cHex(original.string("termsHash"),32,32) + args)
            rents = listOf(Triple("transfer-receipt",transfer,338),Triple("permit-receipt",receipt,107))
        }
        val allocations = v.obj("costs").array("allocations",5)
        require(allocations.size == rents.size && allocations.mapIndexed { i,e -> val r=e.jsonObject; val expected=rents[i]
            r.string("kind")==expected.first && r.string("address")==base58(expected.second) && r.number("bytes")==expected.third.toLong() }.all { it })
        val expected = "SKPERMT2".toByteArray() + cKey(chain.string("genesisHash")) + economy + byteArrayOf(if(creation) 5 else 1) + permit + payer + cLe(expiry) + cKeccak(payload)
        require(candidate.contentEquals(expected)); val signature = cHex(policy.string("signatureHex"),64,64)
        cVerify(policy.string("signer"),candidate,signature)
        val table = v.obj("lookupTable"); val raw = cHex(table.string("dataHex"),440,440)
        require(table.string("owner") == "AddressLookupTab1e1111111111111111111111111" && cHash(raw) == v.obj("lookupPin").string("dataSha256"))
        require(cReadLe(raw.copyOfRange(0,4))==BigInteger.ONE && raw.copyOfRange(4,12).all{it==(-1).toByte()} && raw[21]==0.toByte())
        require(cReadLe(raw.copyOfRange(12,20)) < BigInteger.valueOf(table.number("slot")) && (raw[20].toInt() and 255)<=12)
        val addresses=(0 until 12).map{raw.copyOfRange(56+32*it,88+32*it)}
        val static = at("authority","config","transferConfig","craftProgram","craftControl","collection","collectionAuthority") + listOf(core,sysvar,system,economy,addresses[11])
        require(addresses.map(::base58).distinct().size == 12 && addresses.indices.all{addresses[it].contentEquals(static[it])})
        if(!creation) require(base58(addresses[11]) == original.obj("terms").obj("domain").string("treasury"))
        val compute = Instruction(cKey("ComputeBudget111111111111111111111111111111"),emptyList(),byteArrayOf(2)+cLe(BigInteger.valueOf(rules.computeUnitLimit.toLong()),4))
        // Native Ed25519 instruction: one self-contained signature; all three source indices are u16::MAX.
        val edData=byteArrayOf(1,0)+cLe(BigInteger.valueOf(48),2)+byteArrayOf(-1,-1)+cLe(BigInteger.valueOf(16),2)+byteArrayOf(-1,-1)+cLe(BigInteger.valueOf(112),2)+cLe(BigInteger.valueOf(161),2)+byteArrayOf(-1,-1)+cKey(policy.string("signer"))+signature+candidate
        val ed=Instruction(cKey("Ed25519SigVerify111111111111111111111111111"),emptyList(),edData)
        val bytes=compileV0(payer,cKey(v.string("blockhash")),listOf(compute,ed,instruction),cKey(table.string("address")),addresses)
        val packet=v.obj("packet");val actual=cHex(packet.string("messageHex"),1,if(creation)1167 else 1103)
        boundedV0(actual,if(creation)1 else 2)
        require(bytes.contentEquals(actual) && cHash(bytes)==packet.string("messageSha256"))
        val unsigned=byteArrayOf(if(creation)1 else 2)+ByteArray(if(creation)64 else 128)+bytes
        require(unsigned.size<=1232 && unsigned.size.toLong()==packet.number("packetBytes") && unsigned.contentEquals(cHex(packet.string("unsignedTransactionHex"),1,1232)))
        return bytes
    }

    private fun validateSigning(v: JsonObject, rules: CharterCryptoPolicy) {
        val creation=v.string("kind")=="creation";require(creation || v.string("kind")=="sale")
        v.shape("version attemptId deployment policy lookupTable lookupPin blockhash blockhashSlot lastValidBlockHeight observedSlot observedUnixTimestamp context signingAuthorized relayAuthorized kind original packet costs costLimits" + if(creation)" coreCostProfile" else "")
        require(v.number("version")==1L);cId(v.string("attemptId"));v.no("signingAuthorized");v.no("relayAuthorized")
        cDeployment(v.obj("deployment"));cKey(v.string("blockhash"));v.number("lastValidBlockHeight");cAmount(v.string("observedUnixTimestamp"),63)
        val p=v.obj("policy");p.shape("signer candidateHex signatureHex");cKey(p.string("signer"));cHex(p.string("candidateHex"),161,161);cHex(p.string("signatureHex"),64,64)
        val table=v.obj("lookupTable");table.shape("address owner executable dataHex slot");cKey(table.string("address"));cKey(table.string("owner"));table.no("executable");cHex(table.string("dataHex"),440,440)
        cLookupPin(v.obj("lookupPin"));require(table.string("address")==v.obj("lookupPin").string("address"))
        val context=v.obj("context");context.shape("feeSlot closingSlot closingGenesisHash");cKey(context.string("closingGenesisHash"))
        val slots=listOf(v.number("observedSlot"),table.number("slot"),v.number("blockhashSlot"),context.number("feeSlot"),context.number("closingSlot"))
        require(slots.zipWithNext().all{it.first<=it.second})
        val deployment=v.obj("deployment");for(k in listOf("economy","craft","core"))require(deployment.obj(k).number("reviewedDeploymentSlot")<=slots.first())
        val original=v.obj("original");if(!creation)original.shape("creation terms termsHash")
        val o=if(creation)original else original.obj("creation")
        o.shape("creationIntentId clanId payer metadata chain admissionCommitment");cId(o.string("creationIntentId"));cId(o.string("clanId"));cKey(o.string("payer"));cHex(o.string("admissionCommitment"),32,32)
        val m=o.obj("metadata");m.shape("name uri hash");cHex(m.string("hash"),32,32)
        // The network protocol enforces catalogue name bounds; this layer bounds instruction bytes.
        val name=m.string("name");require(name.length in 1..512 && name.trim()==name && name.matches(Regex("[A-Za-z0-9 ._-]+")))
        val uri=m.string("uri");require(uri.toByteArray(Charsets.UTF_8).size in 1..292 && uri.startsWith("https://"))
        val parsed=java.net.URI(uri);require(parsed.scheme=="https" && !parsed.host.isNullOrBlank() && parsed.rawUserInfo==null)
        val chain=o.obj("chain");chain.shape("genesisHash economyProgram craftProgram config craftControl collection collectionAuthority charter asset assetBinding freezeAuthority executor creationReceipt")
        chain.values.forEach{require(it is JsonPrimitive && it.isString);cKey(it.content)}
        require(chain.string("genesisHash")==deployment.string("expectedGenesisHash") && chain.string("genesisHash")==context.string("closingGenesisHash"))
        require(chain.string("economyProgram")==deployment.obj("economy").string("programId") && chain.string("craftProgram")==deployment.obj("craft").string("programId"))
        val packet=v.obj("packet");packet.shape("version messageHex unsignedTransactionHex messageSha256 packetBytes nativeInstructionIndex signingAuthorized relayAuthorized"+if(creation)" mintAuthorized" else "")
        require(packet.number("version")==1L && packet.number("nativeInstructionIndex")==1L && packet.number("packetBytes") in 66..1232)
        packet.no("signingAuthorized");packet.no("relayAuthorized");if(creation)packet.no("mintAuthorized")
        cHex(packet.string("messageSha256"),32,32);cHex(packet.string("messageHex"),1,if(creation)1167 else 1103);cHex(packet.string("unsignedTransactionHex"),1,1232)
        val costs=v.obj("costs");costs.shape(if(creation)"allocations networkFeeLamports rentLamports coreCreateFeeLamports totalLamports" else "allocations priceLamports sellerLamports royaltyLamports networkFeeLamports rentLamports totalLamports")
        val allocations=costs.array("allocations",if(creation)5 else 2);require(allocations.size==if(creation)5 else 2)
        var rent=BigInteger.ZERO
        for(e in allocations){val r=e.jsonObject;r.shape("kind address bytes minimumBalanceLamports");require(r.string("kind").length in 1..20);cKey(r.string("address"));require(r.number("bytes") in 1..1232);rent+=cAmount(r.string("minimumBalanceLamports"))}
        require(allocations.map{it.jsonObject.string("address")}.distinct().size==allocations.size)
        require(rent==cAmount(costs.string("rentLamports")))
        val fee=cAmount(costs.string("networkFeeLamports"));val total=cAmount(costs.string("totalLamports"));val limits=v.obj("costLimits")
        limits.shape("maxNetworkFeeLamports maxRentLamports "+if(creation)"maxTotalLamports" else "maxAdditionalLamports")
        limits.values.forEach{require(it is JsonPrimitive && it.isString);require(cAmount(it.content)>BigInteger.ZERO)}
        require(fee<=cAmount(limits.string("maxNetworkFeeLamports")) && rent<=cAmount(limits.string("maxRentLamports")))
        if(creation){
            val core=cAmount(costs.string("coreCreateFeeLamports"));require(core==cAmount(rules.coreCreateFeeLamports))
            require(total==rent+fee+core && total<=cAmount(limits.string("maxTotalLamports")))
            val profile=v.obj("coreCostProfile");profile.shape("version profile reviewedProgramDataSha256")
            require(profile.number("version")==1L && profile.string("profile")=="mpl-core-0.15.2-charter-pfd-seq-none" && profile.string("reviewedProgramDataSha256")==deployment.obj("core").string("reviewedProgramDataSha256"))
        }else{
            cHex(original.string("termsHash"),32,32);val t=original.obj("terms")
            t.shape("version id clanId seller buyer priceLamports sellerLeaves domain expectedRevision epochId fenceId royaltyBps")
            require(t.number("version")==1L);for(k in listOf("id","clanId","epochId","fenceId"))cId(t.string(k))
            cKey(t.string("seller"));cKey(t.string("buyer"));t.boolean("sellerLeaves")
            require(t.number("expectedRevision")<=0xffffffffL && t.number("royaltyBps")==rules.royaltyBps.toLong())
            val d=t.obj("domain");d.shape("genesisHash economyProgram craftProgram treasury");d.values.forEach{require(it is JsonPrimitive && it.isString);cKey(it.content)}
            for(k in listOf("genesisHash","economyProgram","craftProgram"))require(d.string(k)==chain.string(k))
            require(t.string("clanId")==o.string("clanId") && listOf(t.string("seller"),t.string("buyer"),d.string("treasury")).distinct().size==3)
            val price=cAmount(t.string("priceLamports"));require(price>BigInteger.ZERO && price==cAmount(costs.string("priceLamports")))
            val royalty=price*BigInteger.valueOf(rules.royaltyBps.toLong())/BigInteger.valueOf(rules.basisPoints.toLong())
            require(cAmount(costs.string("royaltyLamports"))==royalty && cAmount(costs.string("sellerLamports"))==price-royalty)
            require(total==price+fee+rent && fee+rent<=cAmount(limits.string("maxAdditionalLamports")))
        }
    }
}

/** web3 MessageV0 compilation: first occurrence, privilege union, invoked keys remain static. */
internal fun compileV0(payer: ByteArray, blockhash: ByteArray, instructions: List<Instruction>, table: ByteArray, addresses: List<ByteArray>): ByteArray {
    data class Meta(val key: ByteArray, val signer: Boolean, val writable: Boolean, val invoked: Boolean)
    val all=linkedMapOf<String,Meta>()
    fun add(key:ByteArray,signer:Boolean=false,writable:Boolean=false,invoked:Boolean=false){
        val address=base58(key);val old=all[address]
        all[address]=Meta(key,signer||old?.signer==true,writable||old?.writable==true,invoked||old?.invoked==true)
    }
    add(payer,true,true)
    for(ix in instructions){add(ix.programId,invoked=true);ix.keys.forEach{add(it.key,it.signer,it.writable)}}
    val tableKeys=addresses.map(::base58)
    val writable=all.values.filter{!it.signer && !it.invoked && it.writable && base58(it.key) in tableKeys}
    val readonly=all.values.filter{!it.signer && !it.invoked && !it.writable && base58(it.key) in tableKeys}
    val loaded=(writable+readonly).map{base58(it.key)}.toSet()
    val static=all.values.filter{base58(it.key) !in loaded}.sortedWith(compareByDescending<Meta>{it.signer}.thenByDescending{it.writable})
    val ordered=static+writable+readonly;require(static.size<=32 && ordered.size<=256 && loaded.isNotEmpty())
    val indices=ordered.mapIndexed{i,m->base58(m.key) to i}.toMap()
    return ByteArrayOutputStream().apply{
        write(0x80);write(static.count{it.signer});write(static.count{it.signer&&!it.writable});write(static.count{!it.signer&&!it.writable})
        write(compactU16(static.size));static.forEach{write(it.key)};write(blockhash);write(compactU16(instructions.size))
        for(ix in instructions){write(indices.getValue(base58(ix.programId)));write(compactU16(ix.keys.size));ix.keys.forEach{write(indices.getValue(base58(it.key)))};write(compactU16(ix.data.size));write(ix.data)}
        write(1);write(table);write(compactU16(writable.size));writable.forEach{write(tableKeys.indexOf(base58(it.key)))}
        write(compactU16(readonly.size));readonly.forEach{write(tableKeys.indexOf(base58(it.key)))}
    }.toByteArray()
}

/** Bounded canonical short-vec decoder rejects malformed inputs before comparison. */
internal fun boundedV0(bytes:ByteArray,signers:Int){
    var offset=0
    fun byte():Int{require(offset<bytes.size);return bytes[offset++].toInt() and 255}
    fun take(n:Int):ByteArray{require(n>=0 && offset+n<=bytes.size);return bytes.copyOfRange(offset,offset+n).also{offset+=n}}
    fun short(max:Int):Int{
        val start=offset;var n=0;var shift=0
        while(true){val b=byte();require(shift<=14 && (shift<14 || b<=3));n=n or ((b and 127) shl shift);if(b and 128==0)break;shift+=7}
        require(n<=max && bytes.copyOfRange(start,offset).contentEquals(compactU16(n)));return n
    }
    require(byte()==128 && byte()==signers && byte()==0);val readOnly=byte();val keys=short(32);require(keys>=signers && readOnly<=keys-signers)
    take(keys*32);take(32);require(short(3)==3)
    val refs=mutableListOf<Int>()
    repeat(3){val program=byte();require(program<keys);repeat(short(32)){refs+=byte()};take(short(512))}
    require(short(1)==1);take(32);val lookup=mutableListOf<Int>()
    repeat(2){repeat(short(12)){lookup+=byte().also{require(it<12)}}}
    require(lookup.isNotEmpty() && lookup.distinct().size==lookup.size && refs.all{it<keys+lookup.size} && offset==bytes.size)
}

private fun cOwn(value:JsonObject):JsonObject{val text=value.toString();require(text.length<=65536);return Json.parseToJsonElement(text).jsonObject}
private fun JsonObject.shape(fields:String){require(keys==fields.split(' ').filter{it.isNotEmpty()}.toSet()){ "Unknown or missing Charter field" }}
private fun JsonObject.obj(k:String)=requireNotNull(this[k] as? JsonObject)
private fun JsonObject.array(k:String,max:Int)=requireNotNull(this[k] as? JsonArray).also{require(it.size<=max)}
private fun JsonObject.string(k:String):String{val p=requireNotNull(this[k] as? JsonPrimitive);require(p.isString);return p.content}
private fun JsonObject.number(k:String):Long{val p=requireNotNull(this[k] as? JsonPrimitive);require(!p.isString && p.content.matches(Regex("0|[1-9][0-9]*")));return requireNotNull(p.longOrNull).also{require(it in 0..9007199254740991L)}}
private fun JsonObject.boolean(k:String):Boolean{val p=requireNotNull(this[k] as? JsonPrimitive);require(!p.isString);return requireNotNull(p.booleanOrNull)}
private fun JsonObject.no(k:String){require(!boolean(k))}
private fun cDeployment(v:JsonObject){
    v.shape("expectedGenesisHash economy craft core stateProvenance");cKey(v.string("expectedGenesisHash"));require(v.string("stateProvenance")=="fresh-reviewed-deployment")
    for(k in listOf("economy","craft","core")){val p=v.obj(k);p.shape("programId reviewedDeploymentSlot reviewedProgramDataSha256 upgradeAuthority");cKey(p.string("programId"));p.number("reviewedDeploymentSlot");cHex(p.string("reviewedProgramDataSha256"),32,32);if(p["upgradeAuthority"]!=JsonNull)cKey(p.string("upgradeAuthority"))}
}
private fun cLookupPin(v:JsonObject){v.shape("address dataSha256");cKey(v.string("address"));cHex(v.string("dataSha256"),32,32)}
internal fun cKey(value:String):ByteArray{require(value.length in 32..44);return publicKeyBytes(value).also{require(base58(it)==value && it.any{b->b!=0.toByte()})}}
internal fun cId(value:String):ByteArray{require(value.matches(Regex("[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")));return cHex(value.replace("-",""),16,16)}
internal fun cHex(value:String,min:Int,max:Int):ByteArray{require(value.length in min*2..max*2 && value.matches(Regex("(?:[0-9a-f]{2})+")));return ByteArray(value.length/2){value.substring(it*2,it*2+2).toInt(16).toByte()}}
internal fun cAmount(value:String,bits:Int=64):BigInteger{require(value.length in 1..20 && value.matches(Regex("0|[1-9][0-9]*")));return BigInteger(value).also{require(it.bitLength()<=bits)}}
internal fun cLe(n:BigInteger,size:Int=8):ByteArray{require(n.signum()>=0 && n.bitLength()<=8*size);return ByteArray(size){n.shiftRight(8*it).toByte()}}
internal fun cReadLe(bytes:ByteArray)=BigInteger(1,bytes.reversedArray())
internal fun cStr(value:String):ByteArray{val bytes=value.toByteArray(Charsets.UTF_8);return cLe(BigInteger.valueOf(bytes.size.toLong()),4)+bytes}
internal fun cConcat(values:List<ByteArray>):ByteArray=ByteArrayOutputStream().apply{values.forEach{write(it)}}.toByteArray()
internal fun cHash(bytes:ByteArray)=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it.toInt() and 255)}
internal fun cDiscriminator(name:String)=MessageDigest.getInstance("SHA-256").digest(("global:"+name).toByteArray()).copyOfRange(0,8)
internal fun cKeccak(bytes:ByteArray):ByteArray=ByteArray(32).also{out->KeccakDigest(256).apply{update(bytes,0,bytes.size);doFinal(out,0)}}
internal fun cVerify(wallet:String,message:ByteArray,signature:ByteArray){val key=cKey(wallet);require(signature.size==64 && Ed25519.validatePublicKeyFull(key,0) && Ed25519.verify(signature,0,key,0,message,0,message.size)){"Invalid Charter signature"}}
internal fun cBase64(bytes:ByteArray)=Base64.getEncoder().encodeToString(bytes)
internal fun cDecode64(text:String,max:Int):ByteArray{require(text.length in 4..((max+2)/3)*4 && text.length%4==0 && text.matches(Regex("(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?")));return Base64.getDecoder().decode(text).also{require(it.size<=max && cBase64(it)==text)}}
