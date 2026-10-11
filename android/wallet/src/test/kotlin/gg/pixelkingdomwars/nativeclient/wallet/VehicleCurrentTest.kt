package gg.pixelkingdomwars.nativeclient.wallet

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.vehicle.VehiclePolicy
import java.util.Base64
import java.util.Collections
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class VehicleCurrentTest {
    private val vectors = vehicleFixture("/vehicle-client-vectors.json")
    private val row = vectors.getValue("vectors").jsonArray.first().jsonObject
    private val raw = vehicleFixture("/vehicle-client-current.json")
    private val policy = VehiclePolicy.from(vectors.charterObject("constants"))
    private val pinsJson = vehicleChange(row.charterObject("trust"),"core",raw.charterObject("trust"))
    private val pins = VehicleSigningTrust.from(pinsJson)
    private val client = row.charterObject("client").let { v ->
        vehicleChange(vehicleChange(v,"consentSource",buildJsonObject {
            put("genesisHash",raw.charterObject("trust").getValue("expectedGenesisHash")); put("anchorSlot",60)
            put("reviewedDeploymentSlot",raw.charterObject("trust").getValue("reviewedDeploymentSlot"))
            put("reviewedProgramDataSha256",raw.charterObject("trust").getValue("reviewedProgramDataSha256"))
        }),"record.preparation.blockhashContextSlot",JsonPrimitive(60))
    }
    private val wallet = client.charterObject("record").charterText("wallet")
    private val identity = client.charterObject("record").charterObject("reservation").charterObject("identity")
    private val prep = client.charterObject("record").charterObject("preparation")
    private fun signed(): JsonObject {
        val signed = JsonObject(row.charterObject("wire").filterKeys { it != "signedTransactionHex" } + ("acceptedAt" to JsonPrimitive("2035-01-01T00:00:00.000002Z")))
        return vehicleChange(vehicleChange(client,"record.signed",signed),"record.status",JsonPrimitive("signed"))
    }
    private fun rawAccount(data: String, owner: String, executable: Boolean = false) = buildJsonObject {
        put("owner",owner); put("executable",executable); put("lamports",1); put("rentEpoch",0)
        put("data",JsonArray(listOf(JsonPrimitive(Base64.getEncoder().encodeToString(vehicleHex(data,1,8*1024*1024))),JsonPrimitive("base64"))))
    }
    private fun accounts(variant: String): JsonArray {
        val v = raw.getValue("variants").jsonArray.map { it.jsonObject }.single { it.charterText("name") == variant }
        // Public raw Core fixture structure is retained; original addresses are
        // rebound to the independent signed-vector actor/collection for live reads.
        fun bytes(name: String): String = v.charterText(name)
            .replace(vehicleHex(vehicleKey(raw.charterText("wallet"))),vehicleHex(vehicleKey(wallet)))
            .replace(vehicleHex(vehicleKey(raw.charterObject("identity").charterText("collection"))),vehicleHex(vehicleKey(identity.charterText("collection"))))
        return JsonArray(listOf(rawAccount(raw.charterObject("core").charterText("programHex"),VEHICLE_LOADER,true),
            rawAccount(raw.charterObject("core").charterText("programDataHex"),VEHICLE_LOADER),
            if(v["assetDataHex"]==JsonNull) JsonNull else rawAccount(bytes("assetDataHex"),VEHICLE_CORE),
            rawAccount(bytes("collectionDataHex"),VEHICLE_CORE)))
    }
    private inner class Rpc(val variant: String = "plain",val change: (String,JsonElement)->JsonElement = {_,v->v}): VehicleRpcReads {
        var slot = 70L
        val calls = Collections.synchronizedList(mutableListOf<String>())
        val parameters = Collections.synchronizedList(mutableListOf<Pair<String,JsonArray>>())
        override suspend fun request(method: String, params: JsonArray): JsonObject {
            calls.add(method); parameters.add(method to params)
            fun context(value: JsonElement) = buildJsonObject { put("context",buildJsonObject { put("slot",++slot) }); put("value",value) }
            val result = when(method) {
                "getGenesisHash" -> pinsJson.charterObject("core").getValue("expectedGenesisHash")
                "getSlot" -> JsonPrimitive(++slot)
                "getMultipleAccounts" -> context(accounts(variant))
                "getFeeForMessage" -> context(JsonPrimitive(5000))
                "getBalance" -> context(JsonPrimitive(5000))
                "isBlockhashValid" -> context(JsonPrimitive(true))
                "getBlockHeight" -> prep.getValue("lastValidBlockHeight")
                "getSignatureStatuses" -> context(JsonArray(listOf(JsonNull)))
                else -> error("No sign or send is allowed: $method")
            }
            return buildJsonObject { put("jsonrpc","2.0"); put("id",1); put("result",change(method,result)) }
        }
    }
    private suspend fun reject(client: JsonObject = this.client,pins: VehicleSigningTrust = this.pins,rpc: VehicleRpcReads) {
        assertNotNull("Current contradictions cannot prompt or broadcast",runCatching { VehicleCurrent.verify(client,pins,policy,"5000",rpc,{}) }.exceptionOrNull())
    }
    @Test fun `live approval checks exact legacy fee current SOL and original hash in monotone finalized banks`() = runBlocking {
        val rpc = Rpc(); val fresh = VehicleCurrent.verify(client,pins,policy,"5000",rpc,{})
        fresh()
        assertEquals(listOf("getGenesisHash","getSlot","getMultipleAccounts","getFeeForMessage","getBalance","isBlockhashValid","getBlockHeight","getGenesisHash","getSlot","getMultipleAccounts"),rpc.calls)
        val fee = rpc.parameters.single { it.first == "getFeeForMessage" }.second
        assertEquals(Base64.getEncoder().encodeToString(vehicleHex(prep.charterText("messageHex"),1,1167)),fee.first().jsonPrimitive.content)
        assertEquals(prep.getValue("blockhash"),rpc.parameters.single { it.first=="isBlockhashValid" }.second[0])
        for((method,params) in rpc.parameters.filter { it.first in listOf("getSlot","getMultipleAccounts","getFeeForMessage","getBalance","isBlockhashValid","getBlockHeight") }) {
            val options = params.last().jsonObject; assertEquals(JsonPrimitive("finalized"),options["commitment"])
            if(method in listOf("getMultipleAccounts","getBalance","isBlockhashValid","getBlockHeight"))assertTrue(options.containsKey("minContextSlot"))
        }
    }
    @Test fun `processed signature status context ahead of finalized bank does not invent a finalized floor`() = runBlocking {
        val rpc=Rpc(change={method,value->when {
            method=="getSignatureStatuses"->vehicleChange(value.jsonObject,"context.slot",JsonPrimitive(132))
            method=="getSlot"->JsonPrimitive(100)
            value is JsonObject&&value["context"]!=null->vehicleChange(value,"context.slot",JsonPrimitive(100))
            else->value
        }})
        VehicleCurrent.verify(signed(),pins,policy,"5000",rpc,{})()
        assertEquals(2,rpc.calls.count{it=="getMultipleAccounts"})
    }
    @Test fun `independent actual network fee must equal the exact displayed review amount`() = runBlocking {
        assertTrue(runCatching{VehicleCurrent.verify(client,pins,policy,"4999",Rpc(),{})}.isFailure)
        assertTrue(runCatching{VehicleCurrent.verify(client,pins,policy,"05000",Rpc(),{})}.isFailure)
        VehicleCurrent.verify(client,pins,policy,"5000",Rpc(),{})()
    }
    @Test fun `network and finalized context changes hold`() = runBlocking {
        reject(rpc=Rpc(change={m,v->if(m=="getGenesisHash")JsonPrimitive(wallet) else v}))
        for(method in listOf("getSlot","getMultipleAccounts","getFeeForMessage","getBalance","isBlockhashValid")) {
            reject(rpc=Rpc(change={m,v->if(m!=method)v else if(m=="getSlot")JsonPrimitive(0) else vehicleChange(v.jsonObject,"context.slot",JsonPrimitive(0))}))
        }
    }
    @Test fun `full program deployment hash and explicit upgrade authority are independently checked`() = runBlocking {
        reject(pins=VehicleSigningTrust.from(vehicleChange(pinsJson,"core.upgradeAuthority",JsonPrimitive(wallet))),rpc=Rpc())
        for(index in listOf(0,1)) {
            reject(rpc=Rpc(change={m,v->if(m!="getMultipleAccounts")v else {
                val a=v.jsonObject.getValue("value").jsonArray.toMutableList()
                a[index]=vehicleChange(a[index].jsonObject,"data",JsonArray(listOf(JsonPrimitive(Base64.getEncoder().encodeToString(ByteArray(if(index==0)36 else 50))),JsonPrimitive("base64"))))
                vehicleChange(v.jsonObject,"value",JsonArray(a))
            }}))
        }
    }
    @Test fun `current raw owner inherited freeze delegate and malformed plugin states hold`() = runBlocking {
        for(variant in listOf("absent-asset","other-owner","inherited-permanent-freeze","asset-transfer-delegate-none","unknown-registry-plugin","trailing-data"))reject(rpc=Rpc(variant))
    }
    @Test fun `second bank catches ownership lost while quoting fee`() = runBlocking {
        var banks=0
        reject(rpc=Rpc(change={m,v->if(m!="getMultipleAccounts"||++banks==1)v else vehicleChange(v.jsonObject,"value",accounts("other-owner"))}))
        assertEquals(2,banks)
    }
    @Test fun `original hash validity AND last valid height are both required`() = runBlocking {
        reject(rpc=Rpc(change={m,v->if(m=="isBlockhashValid")vehicleChange(v.jsonObject,"value",JsonPrimitive(false)) else v}))
        reject(rpc=Rpc(change={m,v->if(m=="getBlockHeight")JsonPrimitive(prep.getValue("lastValidBlockHeight").jsonPrimitive.long+1) else v}))
    }
    @Test fun `fee quote must be known bounded and covered before any refund`() = runBlocking {
        for(fee in listOf<JsonElement>(JsonNull,JsonPrimitive(policy.bound("maxNetworkFeeLamports")+1),JsonPrimitive("5000")))
            reject(rpc=Rpc(change={m,v->if(m=="getFeeForMessage")vehicleChange(v.jsonObject,"value",fee) else v}))
        reject(rpc=Rpc(change={m,v->if(m=="getBalance")vehicleChange(v.jsonObject,"value",JsonPrimitive(4999)) else v}))
    }
    @Test fun `retained original signature is checked through full history and any observation holds`() = runBlocking {
        val rpc=Rpc(); VehicleCurrent.verify(signed(),pins,policy,"5000",rpc,{})()
        assertEquals(row.charterObject("wire").getValue("signature"),rpc.parameters.single { it.first=="getSignatureStatuses" }.second[0].jsonArray.single())
        reject(client=signed(),rpc=Rpc(change={m,v->if(m=="getSignatureStatuses")vehicleChange(v.jsonObject,"value",JsonArray(listOf(buildJsonObject {put("err",JsonNull)}))) else v}))
    }
    @Test fun `RPC errors unknown encoding and missing authority accounts fail closed`() = runBlocking {
        reject(rpc=VehicleRpcReads {_,_->buildJsonObject {put("jsonrpc","2.0");put("id",1);put("error",buildJsonObject {put("code",-1)})}})
        reject(rpc=Rpc(change={m,v->if(m!="getMultipleAccounts")v else {
            val rows=v.jsonObject.getValue("value").jsonArray.toMutableList(); rows[2]=vehicleChange(rows[2].jsonObject,"data",JsonArray(listOf(JsonPrimitive(""),JsonPrimitive("jsonParsed"))))
            vehicleChange(v.jsonObject,"value",JsonArray(rows))
        }}))
    }
    @Test fun `returned guard cannot become fresh again through replayed server timestamps`() = runBlocking {
        var now=100L; var live=true
        val fresh=VehicleCurrent.verify(client,pins,policy,"5000",Rpc(),{check(live)},{now})
        now+=policy.bound("reviewMaxAgeMs")+1
        assertTrue(runCatching { fresh() }.isFailure)
        now=100;live=false
        assertTrue(runCatching { fresh() }.isFailure)
    }
    @Test fun `session change during read drains only that call and starts no later RPC`() = runBlocking {
        var active=true;var calls=0
        val delegated=Rpc()
        val provider=VehicleRpcReads {method,params->
            calls++
            delegated.request(method,params).also {active=false}
        }
        assertTrue(runCatching {VehicleCurrent.verify(client,pins,policy,"5000",provider,{check(active)})}.isFailure)
        assertEquals(1,calls)
        val rpc=Rpc(); val held=runCatching { VehicleCurrent.verify(client,pins,policy,"5000",rpc,{check(active)}) }
        assertTrue(held.isFailure);assertTrue(rpc.calls.isEmpty())
    }
    @Test fun `timed out ignored cancellation retains actual occupancy until provider drains`() = runBlocking {
        val small = VehiclePolicy.from(vehicleChange(vehicleChange(policy.raw,"client.rpcTimeoutMs",JsonPrimitive(40)),"client.maxPendingRpc",JsonPrimitive(2)))
        val entered=Channel<Unit>(2);val release=CompletableDeferred<Unit>();val calls=Collections.synchronizedList(mutableListOf<String>())
        val stuck=VehicleRpcReads {method,_->
            calls.add(method)
            withContext(NonCancellable) {entered.send(Unit);release.await()}
            buildJsonObject {put("jsonrpc","2.0");put("id",1);put("result",pinsJson.charterObject("core").getValue("expectedGenesisHash"))}
        }
        val jobs=List(2) {async {runCatching {VehicleCurrent.verify(client,pins,small,"5000",stuck,{})}}}
        withTimeout(2000) {repeat(2){entered.receive()}}
        jobs.forEach {assertTrue(it.await().isFailure)}
        val busy=runCatching {VehicleCurrent.verify(client,pins,small,"5000",Rpc(),{})}.exceptionOrNull()
        assertTrue(busy?.message.orEmpty().contains("busy"));assertEquals(2,calls.size)
        release.complete(Unit)
        // Completion is asynchronous; bounded test-only waiting observes drain,
        // never retries a production mutation or a provider call from the worker.
        withTimeout(2000) {
            while(true) {
                val result=runCatching {VehicleCurrent.verify(client,pins,policy,"5000",Rpc(),{})}
                if(result.isSuccess)break
                delay(5)
            }
        }
        assertEquals(listOf("getGenesisHash","getGenesisHash"),calls)
    }
}
