package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.Gdx
import com.badlogic.gdx.Input
import com.badlogic.gdx.assets.AssetManager
import com.badlogic.gdx.assets.loaders.FileHandleResolver
import com.badlogic.gdx.files.FileHandle
import java.lang.reflect.Proxy
import org.junit.Test
import kotlin.test.*

/** Real renderer sampling path without GL. The device harness separately checks a nonempty inventory. */
class LocalTextureInventoryTest {
    private class Inventory : AssetManager(FileHandleResolver(::FileHandle),false) {
        var scans = 0
        override fun getAssetNames(): com.badlogic.gdx.utils.Array<String> { scans++; return super.getAssetNames() }
    }
    @Test fun `local report inventory refreshes without enabling any performance sampler and caches unchanged residency`() {
        val oldInput = Gdx.input
        Gdx.input = Proxy.newProxyInstance(Input::class.java.classLoader,arrayOf(Input::class.java)) { _,_,_ -> null } as Input
        val inventory = Inventory()
        val renderer = NativeGameRenderer(FileHandle("unused-local-inventory"),{})
        fun field(name: String) = renderer.javaClass.getDeclaredField(name).apply { isAccessible = true }
        try {
            field("assets").set(renderer,inventory)
            // Loaded pages were released: local diagnostics must not retain the preceding estimate.
            field("textureCount").setInt(renderer,3); field("textureRgbaMiB").setDouble(renderer,64.0)
            val sample = renderer.javaClass.getDeclaredMethod("samplePerformance",String::class.java,Int::class.javaPrimitiveType).apply { isAccessible = true }
            sample.invoke(renderer,"base",0)
            assertEquals(0.0,field("textureRgbaMiB").getDouble(renderer))
            assertEquals(1,inventory.scans)
            repeat(20) { sample.invoke(renderer,"base",0) }
            assertEquals(1,inventory.scans,"Unchanged frames must not rescan the texture inventory")
            assertNull(field("performance").get(renderer)); assertNull(field("diagnosticSample").get(renderer)); assertNull(field("diagnosticSummary").get(renderer))
        } finally { renderer.dispose(); Gdx.input = oldInput }
    }
}
