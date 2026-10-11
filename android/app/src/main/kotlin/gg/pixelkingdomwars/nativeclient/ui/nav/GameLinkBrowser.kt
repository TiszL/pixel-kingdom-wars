package gg.pixelkingdomwars.nativeclient.ui.nav

import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.net.toUri
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString

/** A resolved VIEW activity in an app that Android also resolves as an APP_BROWSER. */
internal data class GameBrowserActivity(val packageName: String, val activityName: String, val enabled: Boolean, val exported: Boolean)
internal fun externalGameBrowsers(browserPackages: Set<String>, handlers: List<GameBrowserActivity>, ownPackage: String): List<GameBrowserActivity> =
    handlers.filter { it.packageName in browserPackages && it.packageName != ownPackage && it.enabled && it.exported }
        .distinctBy { it.packageName to it.activityName }

/** Never send an implicit VIEW for the associated host: it could resolve straight back to this activity. */
@Suppress("DEPRECATION") // The int PackageManager overload remains supported on the API28 minimum.
internal fun openWebGameLink(context: Context, url: String): Boolean = runCatching {
    require(GameLinkContract.browserUrl(Intent.ACTION_VIEW, url) == url)
    val pm = context.packageManager
    val browserPackages = pm.queryIntentActivities(Intent.makeMainSelectorActivity(Intent.ACTION_MAIN, Intent.CATEGORY_APP_BROWSER), 0)
        .mapNotNull { it.activityInfo?.takeIf { activity -> activity.enabled && activity.exported && activity.applicationInfo.enabled }?.packageName }.toSet()
    val view = Intent(Intent.ACTION_VIEW, url.toUri()).addCategory(Intent.CATEGORY_BROWSABLE)
    val activities = browserPackages.flatMap { browser ->
        pm.queryIntentActivities(Intent(view).setPackage(browser), PackageManager.MATCH_DEFAULT_ONLY).mapNotNull { result -> result.activityInfo?.let {
            GameBrowserActivity(it.packageName, it.name, it.enabled && it.applicationInfo.enabled, it.exported)
        } }
    }
    val targets = externalGameBrowsers(browserPackages, activities, context.packageName).map {
        Intent(view).setComponent(ComponentName(it.packageName, it.activityName))
    }
    if (targets.isEmpty()) return false
    val launch = if (targets.size == 1) targets.single() else Intent.createChooser(targets.first(), "Open web game")
        .putExtra(Intent.EXTRA_INITIAL_INTENTS, targets.drop(1).toTypedArray())
    context.startActivity(launch)
    true
}.getOrDefault(false)

/** An explicit browser handoff preserves the original public URL and the browser's own authentication. */
@Composable internal fun BrowserGameLinkPrompt(links: PendingGameLinks, request: BrowserGameLink) {
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    // AlertDialog owns Android Back. It performs no game action and never alters other confirmations.
    AlertDialog(onDismissRequest = { links.closeBrowser(request) }, title = { Text("Open web game") },
        text = { Text(if (request.unavailable) "No browser could open this link. You can retry or copy the original link into a browser."
            else "This link uses the web game. Open it in your browser to keep its referral or other link details. Your browser may be signed in to a different account.") },
        confirmButton = { TextButton(onClick = {
            if (openWebGameLink(context, request.url)) links.closeBrowser(request) else links.browserFailed(request)
        }) { Text(if (request.unavailable) "Retry browser" else "Open browser") } },
        dismissButton = { Row {
            TextButton(onClick = { clipboard.setText(AnnotatedString(request.url)) }) { Text("Copy link") }
            TextButton(onClick = { links.closeBrowser(request) }) { Text("Cancel") }
        } })
}
