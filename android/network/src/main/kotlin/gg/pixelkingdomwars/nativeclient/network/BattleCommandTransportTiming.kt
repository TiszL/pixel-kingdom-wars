package gg.pixelkingdomwars.nativeclient.network

import okhttp3.*
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy

/** A request-local anonymous callback. URLs, headers, bodies, connection details and identifiers
 * never reach it. Ordinary calls retain the caller's exact listener with no wrapper allocation. */
internal fun commandTimingListener(delegate: EventListener.Factory) = EventListener.Factory { call ->
    val original = delegate.create(call)
    val timing = call.request().tag(BattleCommandTransportTiming::class.java)
    if (timing == null) original else CommandEvents(original, timing)
}

/** Forward every OkHttp 4.12 event: supplied transports may depend on unmeasured lifecycle hooks.
 * Only the optional observer is failure-isolated; the original listener's semantics are unchanged. */
private class CommandEvents(private val original: EventListener, private val timing: BattleCommandTransportTiming) : EventListener() {
    override fun requestHeadersEnd(call: Call, request: Request) {
        timing.observe(BattleCommandStage.REQUEST_HEADERS_SENT)
        original.requestHeadersEnd(call, request)
    }
    override fun requestBodyEnd(call: Call, byteCount: Long) {
        timing.observe(BattleCommandStage.REQUEST_BODY_SENT)
        original.requestBodyEnd(call, byteCount)
    }
    override fun responseHeadersEnd(call: Call, response: Response) {
        timing.observe(BattleCommandStage.RESPONSE_HEADERS_RECEIVED)
        original.responseHeadersEnd(call, response)
    }
    override fun callStart(call: Call) = original.callStart(call)
    override fun proxySelectStart(call: Call, url: HttpUrl) = original.proxySelectStart(call, url)
    override fun proxySelectEnd(call: Call, url: HttpUrl, proxies: List<Proxy>) = original.proxySelectEnd(call, url, proxies)
    override fun dnsStart(call: Call, domainName: String) = original.dnsStart(call, domainName)
    override fun dnsEnd(call: Call, domainName: String, inetAddressList: List<InetAddress>) = original.dnsEnd(call, domainName, inetAddressList)
    override fun connectStart(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy) = original.connectStart(call, inetSocketAddress, proxy)
    override fun secureConnectStart(call: Call) = original.secureConnectStart(call)
    override fun secureConnectEnd(call: Call, handshake: Handshake?) = original.secureConnectEnd(call, handshake)
    override fun connectEnd(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy, protocol: Protocol?) = original.connectEnd(call, inetSocketAddress, proxy, protocol)
    override fun connectFailed(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy, protocol: Protocol?, ioe: IOException) = original.connectFailed(call, inetSocketAddress, proxy, protocol, ioe)
    override fun connectionAcquired(call: Call, connection: Connection) = original.connectionAcquired(call, connection)
    override fun connectionReleased(call: Call, connection: Connection) = original.connectionReleased(call, connection)
    override fun requestHeadersStart(call: Call) = original.requestHeadersStart(call)
    override fun requestBodyStart(call: Call) = original.requestBodyStart(call)
    override fun requestFailed(call: Call, ioe: IOException) = original.requestFailed(call, ioe)
    override fun responseHeadersStart(call: Call) = original.responseHeadersStart(call)
    override fun responseBodyStart(call: Call) = original.responseBodyStart(call)
    override fun responseBodyEnd(call: Call, byteCount: Long) = original.responseBodyEnd(call, byteCount)
    override fun responseFailed(call: Call, ioe: IOException) = original.responseFailed(call, ioe)
    override fun callEnd(call: Call) = original.callEnd(call)
    override fun callFailed(call: Call, ioe: IOException) = original.callFailed(call, ioe)
    override fun canceled(call: Call) = original.canceled(call)
    override fun satisfactionFailure(call: Call, response: Response) = original.satisfactionFailure(call, response)
    override fun cacheHit(call: Call, response: Response) = original.cacheHit(call, response)
    override fun cacheMiss(call: Call) = original.cacheMiss(call)
    override fun cacheConditionalHit(call: Call, cachedResponse: Response) = original.cacheConditionalHit(call, cachedResponse)
}
