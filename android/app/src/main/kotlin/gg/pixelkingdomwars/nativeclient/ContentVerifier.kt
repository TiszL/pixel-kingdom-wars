package gg.pixelkingdomwars.nativeclient

import android.content.Context

/** Verification stamps belong to one installed build. Any APK update or reinstall changes this
 * fingerprint, so the first launch afterwards re-hashes every generation once. */
internal fun contentVerifierFingerprint(context: Context): String {
    val installed = runCatching { context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime }.getOrDefault(0L)
    return "${BuildConfig.APPLICATION_ID}/${BuildConfig.VERSION_CODE}/${BuildConfig.VERSION_NAME}/${BuildConfig.BUILD_TYPE}/$installed"
}
