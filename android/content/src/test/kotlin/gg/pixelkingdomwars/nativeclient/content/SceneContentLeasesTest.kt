package gg.pixelkingdomwars.nativeclient.content

import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import kotlin.test.*
import org.junit.After
import org.junit.Test

class SceneContentLeasesTest {
    private val root = Files.createTempDirectory("pkw-scene-content-test").toFile()
    @After fun clean() { root.deleteRecursively() }

    private fun install(store: ContentStore, bytes: String): File {
        val hash = MessageDigest.getInstance("SHA-256").digest(bytes.toByteArray()).joinToString("") { "%02x".format(it) }
        return store.install(ContentManifest(1,"675fdf78",hash,
            listOf(ContentFile("atlas/tile.png",hash,bytes.toByteArray().size.toLong())))) { bytes.byteInputStream() }
    }

    @Test fun `old GL generations survive three activations and pruning until every scene disposes`() {
        val store = ContentStore(root)
        val original = install(store,"original")
        store.activate(original.name)
        val first = SceneContentLeases.acquire(root,original)
        val second = SceneContentLeases.acquire(root,original)
        try {
            // A replacement updater has no instance-local lease for the old GL surface.
            val updater = ContentStore(root)
            for (version in listOf("second","third","fourth")) updater.activate(install(updater,version).name)
            val active = requireNotNull(updater.activeRoot())
            val fallback = File(root,File(root,"previous").readText())
            install(updater,"next-download")
            assertEquals("original",File(original,"atlas/tile.png").readText())
            first.close(); first.close()
            install(updater,"another-download")
            assertTrue(original.isDirectory,"A second GL scene still owns this generation")
            second.close()
            install(updater,"after-disposal")
            assertFalse(original.exists(),"Disposed scenes must not leak old generations indefinitely")
            assertEquals(active,updater.activeRoot())
            assertTrue(fallback.isDirectory,"The last-known-good generation remains available")
            assertFailsWith<IllegalStateException> { SceneContentLeases.acquire(root,original) }
        } finally { first.close(); second.close() }
    }

    @Test fun `scene leases reject foreign roots symlinks and unverified directories`() {
        val installed = install(ContentStore(root),"owned")
        val otherRoot = File(root,"other").apply { mkdir() }
        assertFailsWith<IllegalArgumentException> { SceneContentLeases.acquire(otherRoot,installed) }
        val unverified = File(root,"a".repeat(64)).apply { mkdir() }
        assertFailsWith<IllegalStateException> { SceneContentLeases.acquire(root,unverified) }
        val link = File(root,"b".repeat(64))
        Files.createSymbolicLink(link.toPath(),installed.toPath())
        try { assertFailsWith<IllegalArgumentException> { SceneContentLeases.acquire(root,link) } }
        finally { link.delete() }
    }
}
