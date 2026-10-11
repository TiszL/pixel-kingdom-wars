package gg.pixelkingdomwars.nativeclient.notifications

import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton

import android.Manifest
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.launch

@Composable fun NotificationSettingsCard(controller: NativeNotifications) {
    val state by controller.state.collectAsState()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) scope.launch { controller.enable() }
    }
    LaunchedEffect(controller) { controller.refresh() }
    Column {
        Text("Game notifications", style = MaterialTheme.typography.titleMedium)
        Text("Get raid, completed work, full mine and mail updates for this account. Signing out turns them off on this device.")
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        if (!state.supported) Text("Notifications are not available on this server yet.")
        if (state.optedIn) {
            OutlinedButton(onClick = { scope.launch { controller.disable() } }, enabled = !state.busy) { Text("Turn off notifications") }
        } else Button(onClick = {
            NativeNotificationRuntime.channel(context)
            if (Build.VERSION.SDK_INT >= 33 && !NativeNotificationRuntime.permitted(context)) permission.launch(Manifest.permission.POST_NOTIFICATIONS)
            else scope.launch { controller.enable() }
        }, enabled = state.supported && !state.busy) { Text("Enable notifications") }
        TextButton(onClick = { context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)) }) {
            Text("Android notification settings")
        }
    }
}
