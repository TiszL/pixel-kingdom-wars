package gg.pixelkingdomwars.nativeclient.ui.profile

import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.ui.Alignment
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.AccountCard
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.NoteLine
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubArt
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteCardPage
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteConfirmDialog
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteConfirmUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteNoticeRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteTextInput
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SectionHeader
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SkeletonRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.StoneBusyButton
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.Well
import android.content.ContentResolver
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.ui.*
import gg.pixelkingdomwars.nativeclient.ui.nav.*
import kotlinx.coroutines.*

class ProfileViewModel(graph: AppGraph, session: SessionGraph) : ScreenViewModel() {
    private val current = { graph.holder.requireCurrent(session.session) }
    private val repository = LiveProfileRepository(session.api, session.session.wallet, current, graph.account::refreshIdentity)
    val state = repository.state
    val bounds = runCatching { ProfileBounds.from(graph.content.state.value.catalogue) }.getOrNull()
    val avatarImages = ProfileAvatarImage()
    init { refresh() }
    fun refresh() = run { repository.refresh() }
    fun checkName(name: String) = run { repository.checkName(name) }
    fun rename(name: String) = run { repository.rename(name); toast("NAME UPDATED") }
    fun clearAvatar() = run { repository.clearAvatar(); toast("PROFILE IMAGE REMOVED") }
    fun upload(resolver: ContentResolver, uri: Uri) = run {
        val limits = requireNotNull(bounds) { "Profile rules are not loaded" }
        val type = resolver.getType(uri)
        require(type in setOf("image/png", "image/jpeg", "image/webp")) { "Choose a PNG, JPEG or WebP image" }
        current()
        val bytes = withContext(Dispatchers.IO) {
            val context = currentCoroutineContext()
            requireNotNull(resolver.openInputStream(uri)) { "Selected image is unavailable" }.use { input ->
                val cancellation = Job(context[Job])
                cancellation.invokeOnCompletion { runCatching { input.close() } }
                try { readProfileImage(input, limits.maxUploadBytes) { context.ensureActive() } }
                finally { cancellation.cancel() }
            }
        }
        current()
        repository.upload(bytes, requireNotNull(type), limits)
        toast("PROFILE IMAGE UPDATED")
    }
}

/**
 * EDIT PROFILE (Profile > ACCOUNT > PROFILE IMAGE). Owner 2026-10-06 ("UI unfinished"): the old dark page is the designed
 * card now ([RouteCardPage]): the name field and its check, the image well, CHOOSE / REMOVE, the two confirms as the hub
 * ConfirmDialog. [ProfileViewModel] (validation, the upload, the rename) and every sentence are unchanged.
 */
@Composable fun ProfileScreen(model: ProfileViewModel, onBack: () -> Unit) {
    val state by model.state.collectAsState(); val busy by model.busy.collectAsState(); val notice by model.notice.collectAsState()
    val profile = state.profile; val bounds = model.bounds
    var name by remember(profile?.name) { mutableStateOf(profile?.name.orEmpty()) }
    var rename by remember { mutableStateOf(false) }; var remove by remember { mutableStateOf(false) }
    val resolver = LocalContext.current.contentResolver
    // A pending system picker is not restored as upload consent after process death or sign-in
    // change. Only the exact screen model that opened it may consume its result.
    var pickerOwner by remember { mutableStateOf<ProfileViewModel?>(null) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        val owner = pickerOwner; pickerOwner = null
        if (owner === model) uri?.let { model.upload(resolver, it) }
    }
    BackHandlerAt(BackPriority.CONFIRM, rename || remove) { rename = false; remove = false }
    BackHandlerAt(BackPriority.SCREEN, !rename && !remove) { onBack() }
    val enabled = profile != null && !busy && !state.needsRefresh && bounds != null
    val checked = state.availability?.takeIf { it.input == name }
    val canSave = enabled && checked?.available == true && profile?.cooldownDays == 0
    Box(Modifier.fillMaxSize()) {
        RouteCardPage("EDIT PROFILE", "army", onBack, footer = {
            StoneBusyButton("RELOAD", busy, { model.refresh() }, Modifier.width(120.dp))
            PrimaryButton("SAVE NAME", { if (canSave) rename = true }, Modifier.weight(1f), verb = Verb.GREEN,
                state = when { busy -> CommandState.BUSY; canSave -> CommandState.ENABLED; else -> CommandState.DISABLED },
                reason = when {
                    busy || profile == null || canSave -> null
                    state.needsRefresh -> "Reload your profile first."
                    (profile?.cooldownDays ?: 0) > 0 -> "You can rename in ${profile?.cooldownDays} days."
                    bounds == null -> "Profile rules are not loaded"
                    else -> "Check availability first."
                }, reasonOnDark = true)
        }) {
            notice?.let { RouteNoticeRow(it.message, error = it.error, onDismiss = model::dismissNotice) }
            if (state.needsRefresh) RouteNoticeRow("A profile change may have reached the server. Reload your current profile before changing it again.",
                error = true, retrying = busy, onRetry = { model.refresh() })
            if (profile != null) {
                SectionHeader("PLAYER NAME")
                SelectionContainer { NoteLine(profile.wallet, maxLines = 2) }
                RouteTextInput(name, { name = it }, "Name", enabled = enabled && profile.cooldownDays == 0)
                if (profile.cooldownDays > 0) NoteLine("You can rename in ${profile.cooldownDays} days.")
                bounds?.let { NoteLine("Renaming starts a ${it.renameCooldownDays}-day cooldown.") }
                SecondaryButton("CHECK AVAILABILITY", { model.checkName(name) }, Modifier.fillMaxWidth(), verb = Verb.BLUE,
                    enabled = enabled && name.isNotBlank() && profile.cooldownDays == 0)
                checked?.let { PkwText(if (it.available) "${it.normalized} is available. Availability can change before saving." else when (it.reason) {
                    "taken" -> "That name is taken."; "reserved" -> "That name is reserved."; "charset" -> "Use letters, numbers, underscores or hyphens."; else -> "Choose a name within the game's name limits."
                }, PkwTokens.Type.body, Modifier.fillMaxWidth(), color = if (it.available) PkwTokens.Colors.textOnParch else PkwTokens.Colors.shortText, maxLines = 3) }
                SectionHeader("PROFILE IMAGE")
                AccountCard(Modifier.fillMaxWidth()) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Well(null, size = 100.dp) {
                            if (profile.avatarUrl != null && bounds != null) ProfileAvatar(profile, bounds, model.avatarImages, Modifier.size(96.dp))
                            else HubArt("army", 64.dp)
                        }
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            if (profile.avatarUrl == null) PkwText("No custom profile image", PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch, maxLines = 2)
                            NoteLine("Choose a PNG, JPEG or WebP. The server crops it to a square and removes image metadata.", maxLines = 4)
                            bounds?.let { NoteLine("Maximum upload: ${it.maxUploadBytes / (1024 * 1024)} MiB") }
                        }
                    }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SecondaryButton("CHOOSE IMAGE", { pickerOwner = model; picker.launch("image/*") }, Modifier.weight(1f), verb = Verb.BLUE,
                        enabled = enabled, contentDescription = "Choose profile image")
                    SecondaryButton("REMOVE", { remove = true }, Modifier.weight(1f), verb = Verb.RED,
                        enabled = enabled && profile.avatarUrl != null, contentDescription = "Remove profile image")
                }
            } else if (busy || notice == null) SkeletonRow(height = 72.dp)
        }
        RouteConfirmDialog(when {
            rename -> RouteConfirmUi("CHANGE PLAYER NAME?",
                listOf("Use ${state.availability?.normalized.orEmpty()}? Another rename will be available after ${bounds?.renameCooldownDays} days."),
                "CONFIRM NAME", Verb.GREEN, "CANCEL")
            remove -> RouteConfirmUi("REMOVE PROFILE IMAGE?", listOf("Your profile will use the default image."), "REMOVE", Verb.RED, "CANCEL")
            else -> null
        }, onConfirm = {
            if (rename) { rename = false; model.rename(name) }
            else if (remove) { remove = false; model.clearAvatar() }
        }, onBack = { rename = false; remove = false }, modifier = Modifier.fillMaxSize())
    }
}

@Composable internal fun ProfileAvatar(profile: PlayerProfile, bounds: ProfileBounds, loader: ProfileAvatarImage, modifier: Modifier = Modifier.size(96.dp), fallback: Boolean = false) {
    var bitmap by remember(profile.avatarUrl) { mutableStateOf<ImageBitmap?>(null) }
    var error by remember(profile.avatarUrl) { mutableStateOf(false) }
    LaunchedEffect(profile.avatarUrl) {
        try {
            val bytes = loader.load(requireNotNull(profile.avatarUrl), profile.wallet, bounds.maxImageBytes)
            bitmap = withContext(Dispatchers.IO) {
                val dimensions = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, dimensions)
                require(dimensions.outWidth in 1..bounds.imageSize && dimensions.outHeight in 1..bounds.imageSize)
                requireNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size)).asImageBitmap()
            }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { error = true }
    }
    bitmap?.let { Image(it, "Current profile image", modifier) }
        ?: if (fallback) gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt("army", modifier)
        else PkwText(if (error) "Profile image is temporarily unavailable." else "Loading profile image…", PkwTokens.Type.small, modifier,
            color = PkwTokens.Colors.text, textAlign = androidx.compose.ui.text.style.TextAlign.Center, maxLines = 4)
}
