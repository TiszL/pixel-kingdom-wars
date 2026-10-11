package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.boundcosmetics.*
import gg.pixelkingdomwars.nativeclient.network.GameApi
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.network.SessionCookieJar
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.*
import okhttp3.Cookie
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** Unmodified actual private-loopback Workshop view bytes through production HTTPS/session/repository.
 * The by-key reply is its unchanged nested original object reserialized, not separately captured HTTP.
 * JVM AES-GCM is a storage fixture; AndroidKeyStore, production login and native art are not certified. */
class BoundCosmeticWorkshopHttpPairTest {
    @get:Rule val folder = TemporaryFolder()
    private class AesFile(private val file: File, private val key: SecretKey) : SecretStore {
        override fun read(): String? {
            if (!file.exists()) return null
            val bytes = file.readBytes()
            return Cipher.getInstance("AES/GCM/NoPadding").run {
                init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
                doFinal(bytes.copyOfRange(12, bytes.size)).toString(Charsets.UTF_8)
            }
        }
        override fun write(value: String) {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key) }
            val temp = File(file.parentFile, "${file.name}.tmp")
            temp.outputStream().use { it.write(cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))); it.flush(); it.fd.sync() }
            Files.move(temp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        }
        override fun clear() = error("Original evidence is never cleared by this pair")
    }
    private fun tls(block: suspend (MockWebServer, OkHttpClient) -> Unit) {
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val identity = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        val trust = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
        val client = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).build()
        try { MockWebServer().use { server ->
            server.useHttps(identity.sslSocketFactory(), false); server.start()
            runBlocking { withTimeout(20_000) { block(server, client) } }
        } } finally { client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
    }
    private fun respond(server: MockWebServer, body: String) {
        server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setHeader("Cache-Control", "private, no-store").setBody(body))
    }
    private fun request(server: MockWebServer, path: String) {
        val request = requireNotNull(server.takeRequest(5, TimeUnit.SECONDS))
        assertEquals("GET", request.method); assertEquals(path, request.path)
        assertEquals("session=cosmetic-pair", request.getHeader("Cookie"))
        assertEquals("android-native", request.getHeader("X-PKW-Client")); assertEquals(0L, request.bodySize)
        assertNull(request.getHeader("x-pkw-currency")); assertNull(request.getHeader("x-pkw-expected-currency"))
    }
    @Test fun `actual completed Workshop view survives full HTTPS stack and encrypted original reopen`() = tls { server, client ->
        val bytes = requireNotNull(javaClass.getResourceAsStream("/boundcosmetics/final-actual-http.json")).use { it.readBytes() }
        assertEquals("0bda5050d8770431a43156070ba10b7ebe947f82d8a21750c9ee2d2090e9d645",
            MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) })
        val body = bytes.toString(Charsets.UTF_8); val raw = Json.parseToJsonElement(body).jsonObject
        val originalRaw = raw.getValue("originals").jsonArray.single().jsonObject
        val original = BoundCosmeticProof.from(originalRaw); val receipt = requireNotNull(original.receipt)
        val command = BoundCosmeticCommand(receipt.request, receipt.recipe, receipt.appearance)
        val base = raw.getValue("selectedBase").jsonObject; val baseId = base.getValue("baseId").jsonPrimitive.content
        val market = base.getValue("markets").jsonArray.single().jsonObject
        val level = market.getValue("level").jsonPrimitive.long
        // One captured facility only: this is not a Kotlin copy of the game's tier table.
        require(level == receipt.recipe.requiredFacility.level)
        val rules = BoundCosmeticWorkshopRules(maxConcurrentPerBase = 1) { observed ->
            require(observed == level); receipt.recipe.outputId
        } // Empty captured queue: the positive fixture limit is not production policy admission.
        assertTrue(base.getValue("queue").jsonArray.isEmpty())
        val jar = SessionCookieJar(server.url("/"), MemoryStore())
        jar.saveFromResponse(server.url("/"), listOf(requireNotNull(Cookie.parse(server.url("/"), "session=cosmetic-pair; Path=/; Secure; HttpOnly"))))
        val game = GameApi.withTransport(server.url("/").toString(), jar, "cosmetic-pair", client)
        val session = AccountSession(original.wallet, server.url("/").toString(), jar.sessionToken())
        val holder = AccountSessionHolder(dispatcher = Dispatchers.Unconfined).also { it.replace(session) }
        val api = SessionApiClient(game, session.token, ApiRouting())
        val identity = BoundCosmeticIdentity(session.origin.trimEnd('/'), "devnet", session.wallet)
        val file = File(folder.root, "original.enc"); val secretKey = KeyGenerator.getInstance("AES").generateKey()
        val store = BoundCosmeticStore(AesFile(file, secretKey), identity)
        fun repository(saved: BoundCosmeticStore) = BoundCosmeticWorkshopRepository(session, holder, api, saved, rules,
            { baseId }, { 0L }, { null }, {}, { error("Read-only pair must not hydrate gameplay") },
            { false }, { false }, { _, _ -> error("Read-only pair must not admit native art") })
        val repo = repository(store)
        respond(server, body); repo.refresh()
        val view = requireNotNull(repo.state.value.view); val selected = view.selectedBase as BoundCosmeticSelectedBase.Available
        assertTrue(repo.state.value.advertised); assertEquals(original.wallet, view.wallet)
        assertEquals(raw.getValue("serverNow").jsonPrimitive.content, view.serverNow)
        assertEquals(original, view.originals.single()); assertNotNull(view.originals.single().completion)
        assertEquals(receipt.blueprint, view.blueprint.proof)
        assertEquals(base.getValue("craftingStock").jsonArray.associate { row -> row.jsonObject.let {
            it.getValue("itemId").jsonPrimitive.content to (it.getValue("available").jsonPrimitive.content to it.getValue("pendingOutput").jsonPrimitive.content)
        } }, selected.craftingStock.associate { it.itemId to (it.available to it.pendingOutput) })
        assertEquals(base.getValue("preference").jsonObject.getValue("enabled").jsonPrimitive.boolean, selected.preference.enabled)
        assertEquals(base.getValue("preference").jsonObject.getValue("revision").jsonPrimitive.content, selected.preference.revision)
        assertEquals(BoundCosmeticBaseRead.from(base.getValue("visual").jsonObject), selected.visual)
        assertNull(repo.state.value.journal.operation)
        request(server, "/api/bound-cosmetics?baseId=$baseId")

        // Seed the exact captured command as uncertain, then reopen the encrypted journal.
        store.attempt(store.begin(store.read(), command)); assertNull(store.read().operation!!.proof)
        assertFalse(file.readBytes().toString(Charsets.UTF_8).contains(command.key))
        val reopenedStore = BoundCosmeticStore(AesFile(file, secretKey), identity); val reopened = repository(reopenedStore)
        assertEquals(command, reopened.state.value.journal.operation!!.command)
        respond(server, body)
        respond(server, originalRaw.toString()) // Same object, reserialized; not a second HTTP capture.
        reopened.refresh()
        request(server, "/api/bound-cosmetics?baseId=$baseId"); request(server, "/api${command.receiptPath}")
        val retained = BoundCosmeticStore(AesFile(file, secretKey), identity).read().operation!!
        assertEquals(command, retained.command); assertTrue(retained.attempted); assertEquals(original, retained.proof)
        assertEquals(original, reopened.state.value.journal.operation!!.proof)
        assertEquals(3, server.requestCount); assertFalse(reopened.state.value.busy); assertNull(reopened.state.value.review)
    }
}
