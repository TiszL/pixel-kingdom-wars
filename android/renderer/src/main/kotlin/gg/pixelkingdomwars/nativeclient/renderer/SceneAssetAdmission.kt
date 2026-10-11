package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.assets.AssetManager

/** May run again after a canceled asynchronous task leaves the loader. Resident assets keep one owner. */
internal fun <T> queueMissingSceneAssets(manager: AssetManager, paths: Collection<String>, type: Class<T>) {
    paths.forEach { if (!manager.contains(it)) manager.load(it,type) }
}
