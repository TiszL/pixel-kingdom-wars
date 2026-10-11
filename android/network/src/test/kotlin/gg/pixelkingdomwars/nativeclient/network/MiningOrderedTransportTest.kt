package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.mining.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

class MiningOrderedTransportTest {
    private val raw=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/mining-ordered-journal.json")).readText()).jsonObject
    private val policy=MiningClaimsProtocolPolicy(9,1,120,200000)
    private val p=MiningClaimPreparationView.from(raw.getValue("preparation").jsonObject,policy)
    private val proof=MiningClaimContinuation.from(raw.getValue("continuation").jsonObject,policy)
    private val envelope=MiningClaimContinuationEnvelope(1,p.wallet,p.claimId,"continued",proof,proof.createdAt)
    private val json=Json{encodeDefaults=true}
    private class Memory:SecretStore {var value:String?=null;override fun read()=value;override fun write(value:String){this.value=value};override fun clear(){value=null}}
    private fun tls(after:()->Unit={},block:(MockWebServer,GameApi,SessionCookieJar,SessionToken,Memory)->Unit){
        val cert=HeldCertificate.Builder().addSubjectAlternativeName("localhost").build();val identity=HandshakeCertificates.Builder().heldCertificate(cert).build();val trust=HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val client=OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(),trust.trustManager).eventListener(object:EventListener(){override fun responseBodyStart(call:Call){after()}}).build()
        try{MockWebServer().use{s->s.useHttps(identity.sslSocketFactory(),false);s.start();val memory=Memory();val jar=SessionCookieJar(s.url("/"),memory);val token=jar.sessionToken();jar.acceptResponse(token,s.url("/"),listOf(Cookie.parse(s.url("/"),"session=fixture; Path=/; Secure; HttpOnly")!!));block(s,GameApi.withTransport(s.url("/").toString(),jar,"test",client),jar,token,memory)}}finally{client.connectionPool.evictAll();client.dispatcher.executorService.shutdown()}
    }
    @Test fun `ordinal review uses exactly one canonical query while extra or missing query cannot enqueue`() {tls{server,api,_,token,_->
        for(path in listOf("/claims/mining/${p.claimId}/review","/claims/mining/${p.claimId}/review?ordinal=2","/claims/mining/${p.claimId}/review?ordinal=00","/claims/mining/${p.claimId}/review?ordinal=0&ordinal=1","/claims/mining/${p.claimId}/continuation?ordinal=0"))assertThrows(IllegalArgumentException::class.java){runBlocking{api.getMiningClaim(path,token,{},{})}}
        assertEquals(0,server.requestCount)
        for(i in 0..1){val expected=MiningClaimOrdinalReview.from(raw.getValue("reviews").jsonArray[i].jsonObject);server.enqueue(MockResponse().setBody(json.encodeToString(MiningClaimOrdinalReview.serializer(),expected)));var retained=0
            runBlocking{api.getMiningClaim("/claims/mining/${p.claimId}/review?ordinal=$i",token,{}){MiningClaimOrdinalReview.from(it).also{v->v.bind(p,i)};retained++}}
            assertEquals(1,retained);val request=server.takeRequest();assertEquals("GET",request.method);assertEquals("/api/claims/mining/${p.claimId}/review?ordinal=$i",request.path)
        }
    }}
    @Test fun `continuation exact POST retains owned child before stale session without cookies or replay`() {
        lateinit var sessionJar:SessionCookieJar;tls(after={sessionJar.beginAuthentication()}){server,api,jar,token,memory->sessionJar=jar;val cookies=memory.value;server.enqueue(MockResponse().setBody(json.encodeToString(MiningClaimContinuationEnvelope.serializer(),envelope)).addHeader("Set-Cookie","session=obsolete; Path=/; Secure; HttpOnly"));var accepted:MiningClaimContinuationEnvelope?=null
            val body=buildJsonObject{put("idempotencyKey",proof.childPreparation.idempotencyKey)}
            assertThrows(SessionSupersededException::class.java){runBlocking{api.postMiningClaim("/claims/mining/${p.claimId}/continue",body,token,{},{value->accepted=MiningClaimContinuationEnvelope.from(value,policy).also{require(it.wallet==p.wallet&&it.parentClaimId==p.claimId)}})}}
            assertEquals(envelope,accepted);assertEquals(cookies,memory.value);assertEquals(1,server.requestCount);val request=server.takeRequest();assertEquals("POST",request.method);assertEquals(body.toString(),request.body.readUtf8())
        }
    }
    @Test fun `only definitive continuation refusal codes retain no-child evidence before stale guard`() {
        val known=listOf(409 to "MINING_CLAIM_NOT_EXPIRED",409 to "MINING_CLAIM_SETUP_REQUIRED",409 to "MINING_CLAIM_PARENT_SIGNED",409 to "MINING_CLAIM_DISABLED",400 to "MINING_CLAIM_INVALID_INPUT",400 to "MINING_CLAIM_NOT_PREPARED")
        for((status,code) in known+listOf(503 to "MINING_CLAIM_STORAGE",409 to "MINING_CLAIM_BUSY",409 to "MINING_CLAIM_SOURCE_CONFLICT",409 to "MINING_CLAIM_INVALID_INPUT")){var current=true;tls(after={current=false}){server,api,_,token,_->server.enqueue(MockResponse().setResponseCode(status).setBody("""{"error":{"code":"$code","message":"Refused"}}"""));var refusal:ApiException?=null
            assertThrows(Exception::class.java){runBlocking{api.postMiningClaim("/claims/mining/${p.claimId}/continue",buildJsonObject{put("idempotencyKey",proof.childPreparation.idempotencyKey)},token,{check(current)},{},{refusal=it})}}
            assertEquals(if((status to code) in known)code else null,refusal?.code);assertEquals(1,server.requestCount)
        }}
    }
    @Test fun `continuation rejects unrelated bodies and historical lookup is GET only`() {tls{server,api,_,token,_->
        for(body in listOf(buildJsonObject{},buildJsonObject{put("idempotencyKey",proof.childPreparation.idempotencyKey);put("profile","ordered-v0")}))assertThrows(IllegalArgumentException::class.java){runBlocking{api.postMiningClaim("/claims/mining/${p.claimId}/continue",body,token,{},{})}}
        assertEquals(0,server.requestCount);server.enqueue(MockResponse().setBody(json.encodeToString(MiningClaimContinuationEnvelope.serializer(),envelope)));var received:MiningClaimContinuationEnvelope?=null
        runBlocking{api.getMiningClaim("/claims/mining/${p.claimId}/continuation",token,{}){received=MiningClaimContinuationEnvelope.from(it,policy)}};assertEquals(envelope,received);assertEquals("GET",server.takeRequest().method);assertEquals(1,server.requestCount)
    }}
}
