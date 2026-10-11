package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.assets.AssetDescriptor
import com.badlogic.gdx.assets.AssetLoaderParameters
import com.badlogic.gdx.assets.AssetManager
import com.badlogic.gdx.assets.loaders.AsynchronousAssetLoader
import com.badlogic.gdx.assets.loaders.FileHandleResolver
import com.badlogic.gdx.files.FileHandle
import com.badlogic.gdx.utils.Disposable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.Test
import kotlin.test.*

/** Actual pinned libGDX loader lifecycle; no GL, textures, network, or Android account is created. */
class SceneAssetAdmissionTest {
    private class Page : Disposable { var disposed = false; override fun dispose() { disposed = true } }
    private class Loader : AsynchronousAssetLoader<Page,AssetLoaderParameters<Page>>(FileHandleResolver(::FileHandle)) {
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val blockNext = AtomicBoolean(false)
        val reject = AtomicBoolean(false)
        override fun getDependencies(name: String, file: FileHandle, parameter: AssetLoaderParameters<Page>?): com.badlogic.gdx.utils.Array<AssetDescriptor<*>>? {
            if (blockNext.getAndSet(false)) {
                started.countDown()
                check(release.await(5,TimeUnit.SECONDS)) { "Test did not release the pending loader" }
            }
            check(!reject.get()) { "Unavailable staged page" }
            return null
        }
        override fun loadAsync(manager: AssetManager, name: String, file: FileHandle, parameter: AssetLoaderParameters<Page>?) {}
        override fun loadSync(manager: AssetManager, name: String, file: FileHandle, parameter: AssetLoaderParameters<Page>?) = Page()
    }
    private fun awaitLoaded(manager: AssetManager, path: String) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (!manager.isLoaded(path) && System.nanoTime() < deadline) { manager.update(); Thread.sleep(1) }
        assertTrue(manager.isLoaded(path),"The current replacement must become resident after cancellation or retry")
    }
    private fun fixture(block: (AssetManager,Loader,Page) -> Unit) {
        val manager = AssetManager(FileHandleResolver(::FileHandle),false)
        val loader = Loader(); manager.setLoader(Page::class.java,loader)
        try {
            queueMissingSceneAssets(manager,listOf("active"),Page::class.java)
            awaitLoaded(manager,"active")
            block(manager,loader,manager.get("active",Page::class.java))
        } finally { loader.release.countDown(); manager.dispose() }
    }

    @Test fun `same page needed by newest revision loads after prior in-flight cancellation without dropping active scene`() = fixture { manager,loader,active ->
        loader.blockNext.set(true)
        queueMissingSceneAssets(manager,listOf("staged"),Page::class.java)
        manager.update()
        assertTrue(loader.started.await(5,TimeUnit.SECONDS))
        manager.unload("staged")
        assertTrue(manager.contains("staged"),"libGDX still exposes a canceled current task until its next update")
        queueMissingSceneAssets(manager,listOf("staged"),Page::class.java)
        manager.update()
        assertFalse(manager.contains("staged"))
        loader.release.countDown()
        // This second admission is the render-loop retry after AssetManager removes cancellation.
        queueMissingSceneAssets(manager,listOf("staged"),Page::class.java)
        awaitLoaded(manager,"staged")
        repeat(3) { queueMissingSceneAssets(manager,listOf("active","staged"),Page::class.java) }
        assertEquals(1,manager.getReferenceCount("active")); assertEquals(1,manager.getReferenceCount("staged"))
        assertSame(active,manager.get("active",Page::class.java)); assertFalse(active.disposed)
        manager.unload("staged")
        assertFalse(manager.isLoaded("staged")); assertTrue(manager.isLoaded("active")); assertFalse(active.disposed)
    }

    @Test fun `failed staged page leaves active resident and an explicit retry can admit it once`() = fixture { manager,loader,active ->
        var failure: String? = null
        manager.setErrorListener { descriptor,_ -> failure = descriptor.fileName }
        loader.reject.set(true)
        queueMissingSceneAssets(manager,listOf("staged"),Page::class.java)
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (failure == null && System.nanoTime() < deadline) { manager.update(); Thread.sleep(1) }
        assertEquals("staged",failure)
        assertFalse(manager.contains("staged")); assertSame(active,manager.get("active",Page::class.java)); assertFalse(active.disposed)
        loader.reject.set(false)
        queueMissingSceneAssets(manager,listOf("staged"),Page::class.java)
        awaitLoaded(manager,"staged")
        assertEquals(1,manager.getReferenceCount("staged")); assertFalse(active.disposed)
    }
}
