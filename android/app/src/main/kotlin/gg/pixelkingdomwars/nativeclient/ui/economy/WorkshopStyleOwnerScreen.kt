package gg.pixelkingdomwars.nativeclient.ui.economy

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticAppearance
import gg.pixelkingdomwars.nativeclient.data.BoundCosmeticArtAdmission
import gg.pixelkingdomwars.nativeclient.data.BoundCosmeticWakeSourcePreview
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.workshopStyleOwnerUi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

private data class StylePixels(val appearance: BoundCosmeticAppearance, val tier: Int, val image: ImageBitmap)

/** Presentation over the existing two session owners. Their commands, consent, journals and account guards remain unchanged. */
@Composable internal fun WorkshopStyleOwnerScreen(
    awnings: BoundCosmeticWorkshopViewModel?, wake: BoundCosmeticWakeWorkshopViewModel?, wallet: String,
    selectedBase: String?, generation: Long, actionsAllowed: Boolean, art: BoundCosmeticArtAdmission,
    artGeneration: Long, previewGuard: () -> Unit, wakeSourcePreview: BoundCosmeticWakeSourcePreview?, host: WorkshopOwnerHost,
) {
    val a = awnings?.state?.collectAsState()?.value
    val w = wake?.state?.collectAsState()?.value
    val awningNotice = awnings?.notice?.collectAsState()?.value
    val wakeNotice = wake?.notice?.collectAsState()?.value
    val awningRunning = awnings?.busy?.collectAsState()?.value == true
    val wakeRunning = wake?.busy?.collectAsState()?.value == true
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val lifecycleState by lifecycle.currentStateFlow.collectAsState()
    val ownerActive = lifecycleState.isAtLeast(Lifecycle.State.STARTED)
    val current by rememberUpdatedState { ownerActive && host.current() && runCatching { previewGuard() }.isSuccess }
    val nativeReady = current() && runCatching { art.applicationReady() }.getOrDefault(false)
    val openingAwning = remember(awnings, wallet, selectedBase, generation, artGeneration, ownerActive) { a?.view }
    val openingWake = remember(wake, wallet, selectedBase, generation, artGeneration, ownerActive) { w?.view }
    val awningCurrent = current() && a != null && a.journal.identity.wallet == wallet && a.advertised &&
        a.view != null && a.view !== openingAwning && !a.busy && !awningRunning && awningNotice?.error != true
    val wakeCurrent = current() && w != null && w.journal.identity.wallet == wallet && w.advertised &&
        w.view != null && w.view !== openingWake && !w.busy && !wakeRunning && wakeNotice?.error != true
    val busy = awningRunning || wakeRunning || a?.busy == true || w?.busy == true

    // One lifecycle driver per existing owner. The recovery dialogs below do not start additional drivers.
    DisposableEffect(awnings, wake, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) { awnings?.dismiss(); wake?.dismiss() } }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); awnings?.dismiss(); wake?.dismiss() }
    }
    LaunchedEffect(awnings, lifecycle, wallet, selectedBase, generation, nativeReady, artGeneration) {
        awnings?.let { model ->
            model.dismiss()
            lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model.foreground(); awaitCancellation() }
        }
    }
    LaunchedEffect(wake, lifecycle, wallet, selectedBase, generation, artGeneration) {
        wake?.let { model ->
            // Retire craft consent without invalidating an account-level Off in flight.
            model.invalidateAdmission()
            lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model.foreground(); awaitCancellation() }
        }
    }
    LaunchedEffect(actionsAllowed) {
        if (!actionsAllowed) { awnings?.dismiss(); awnings?.foreground(); wake?.dismiss(); wake?.foreground() }
    }

    val appearances = a?.view?.recipes?.map { it.appearance }.orEmpty().takeIf { awningCurrent }.orEmpty()
    val pixels by produceState<Map<String, StylePixels>>(emptyMap(), appearances, art, artGeneration, selectedBase, generation, ownerActive) {
        value = emptyMap()
        val context = currentCoroutineContext()
        val guard = { context.ensureActive(); check(current()); previewGuard(); check(art.applicationReady()) }
        val loaded = mutableMapOf<String, StylePixels>()
        for (appearance in appearances) {
            try {
                guard()
                val admitted = art.preview(appearance, guard)
                val bitmap = withContext(Dispatchers.IO) {
                    guard()
                    val bytes = admitted.pngBytes
                    val decoded = requireNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size))
                    require(decoded.width == admitted.cellW && decoded.height == admitted.cellH)
                    decoded.asImageBitmap()
                }
                guard(); loaded[appearance.outputId] = StylePixels(appearance, admitted.tier, bitmap)
                value = loaded.toMap()
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { context.ensureActive() }
        }
    }
    val admittedPixels = pixels.filterValues { picture -> current() && appearances.any { it == picture.appearance } }
    var selectedTier by rememberSaveable(wallet, selectedBase) { mutableStateOf<Int?>(null) }
    var wakeSelected by rememberSaveable(wallet, selectedBase) { mutableStateOf(false) }
    var history by rememberSaveable(wallet) { mutableStateOf<String?>(null) }
    val ui = workshopStyleOwnerUi(a, w, wallet, selectedBase, awningCurrent, wakeCurrent, current(), busy,
        actionsAllowed, nativeReady, admittedPixels.mapValues { it.value.tier }, art::completedMarketOutput,
        selectedTier, wakeSelected, (if (wakeSelected) wakeNotice else awningNotice)?.message)
    val preview: @Composable (String, Modifier) -> Unit = { output, modifier ->
        if (output == "aurora_wake") {
            val appearance = w?.view?.recipe?.appearance ?: w?.original?.receipt?.appearance
                ?: w?.journal?.operation?.command?.appearance ?: w?.journal?.archives?.firstOrNull()?.command?.appearance
            if (appearance != null) AdmittedWakeSourcePreview(appearance, wakeSourcePreview, artGeneration,
                selectedBase, generation, previewGuard, modifier)
            else PkwText("Source preview unavailable", PkwTokens.Type.small, modifier, textAlign = androidx.compose.ui.text.style.TextAlign.Center, maxLines = 3)
        } else {
            val picture = admittedPixels[output]
            if (picture != null) Image(picture.image, awningLabel(output), modifier,
                contentScale = ContentScale.Fit, filterQuality = FilterQuality.None)
            else PkwText("Verified preview unavailable", PkwTokens.Type.small, modifier, textAlign = androidx.compose.ui.text.style.TextAlign.Center, maxLines = 3)
        }
    }
    // A door never does nothing: a stale sheet says why instead of swallowing the tap.
    fun read(action: () -> Unit) { if (current()) action() else Toasts.post("Return to the current Workshop before continuing.") }
    val refresh = { read { if (!busy) { awnings?.refresh(); wake?.refresh() } }; Unit }
    fun openOriginals() { if (current()) history = if (wakeSelected) "wake" else "awning" }
    // c-gap-craft: the craft review is the designed half sheet (SPEC §2.1 "The consent checkbox in today's code becomes
    // this explicit second tap"), in the owners' own consent sentences; it replaces the "APPEARANCE REVIEWS & RECEIPTS"
    // chrome dialog. Only the review the owner holds for this kingdom and generation is drawn (the old screens' filter).
    val awningReview = a?.review?.takeIf { it.command.request.baseId == selectedBase && it.generation == generation }
    val wakeReview = w?.review?.takeIf { it.command.request.baseId == selectedBase && it.generation == generation }
    val reviewUi = when {
        awningReview != null -> {
            val resend = a?.journal?.operation?.attempted == true
            CraftReviewUi(awningLabel(awningReview.command.recipe.outputId).uppercase(java.util.Locale.US), listOfNotNull(
                "The listed materials are consumed immediately. This craft cannot be cancelled or refunded. This appearance can be crafted once for this account.",
                "No SOL, KEEP, Gems or SHARDS payment. Completion is automatic and remains with the original account after a kingdom transfer.",
                "This sends the exact saved request again only after checking its original outcome.".takeIf { resend }).joinToString(" "),
                confirmLabel = if (resend) "SEND SAME REQUEST" else "CRAFT AWNING", sending = busy)
        }
        wakeReview != null -> {
            val resend = w?.journal?.operation?.attempted == true
            CraftReviewUi("AURORA WAKE", listOfNotNull(
                "These materials are consumed when crafting starts. This cannot be cancelled or refunded. The appearance remains with your account after a kingdom transfer.",
                "No SOL, KEEP, SHARDS or Gems payment. No fleet or reward advantage.",
                "This explicitly sends the same saved request again.".takeIf { resend }).joinToString(" "),
                confirmLabel = if (resend) "SEND SAME REQUEST" else "CRAFT AURORA", sending = busy)
        }
        else -> null
    }
    // The half sheet's rows are the selected look's: a review opened from a saved request selects its own tier first.
    LaunchedEffect(awningReview?.command?.key, wakeReview?.command?.key) {
        awningReview?.let { r -> ui.awning.tiers.firstOrNull { it.recipeId == r.command.recipe.recipeId }?.let { selectedTier = it.tier; wakeSelected = false } }
        if (wakeReview != null) wakeSelected = true
    }
    val closeReview: () -> Unit = { if (a?.review != null) awnings?.dismiss(); if (w?.review != null) wake?.invalidateAdmission() }
    BackHandlerAt(BackPriority.CONFIRM, reviewUi != null) { closeReview() }
    // The explicit START on the half sheet is the material consent the old checkbox collected; the owner's own guards
    // (current kingdom, orders allowed, verified art) still decide, exactly as the old CRAFT AWNING button's enabled rule.
    val confirmReview: () -> Unit = { read {
        val r = a?.review
        when {
            busy -> Unit
            r != null && awningReview != null -> when {
                !actionsAllowed -> Toasts.post("Game orders are paused. Checking originals and completion history remains available.")
                !nativeReady -> Toasts.post("Verified preview is unavailable. Crafting is held.")
                else -> awnings?.confirm(r, true)
            }
            wakeReview != null -> Toasts.post("New Aurora crafts and switching on are held. Your account setting and original receipts remain available.")
            else -> Unit
        }
    } }
    // The sheet draws the host's admitted Workshop art tier and "LV n" (workshop-style.png header); a host without them
    // keeps the honest grass-only header.
    CompositionLocalProvider(LocalWorkshopOwnerHost provides host) {
      Box(Modifier.fillMaxSize()) {
        WorkshopSheet(WorkshopSheetUi(
            CraftFrameUi("WORKSHOP", null, CraftLiveUi("ui:workshop-menu", "Style & appearance"), current(),
                workshopTabs(), WorkshopTab.COSMETICS), CraftHeaderUi(null), style = ui, review = reviewUi, destinationsAvailable = false),
            WorkshopSheetActions(onClose = host.onClose, onTab = host.onTab, onHistory = ::openOriginals, onRetry = refresh,
                onReviewBack = { closeReview() }, onReviewConfirm = { confirmReview() },
                onCheckSaved = { key -> read {
                    if (!busy && key == a?.journal?.operation?.command?.key) awnings?.check()
                    else if (!busy && key == w?.journal?.operation?.command?.key) wake?.check()
                } },
                style = WorkshopStyleActions(
                    onSelectTier = { tier -> read { if (ui.awning.tiers.any { it.tier == tier }) { selectedTier = tier; wakeSelected = false } } },
                    onSelectWake = { read { wakeSelected = true } },
                    onCraft = { recipe -> read {
                        val primary = ui.ownerControls?.primary
                        if (!busy && !wakeSelected && primary?.state == CommandState.ENABLED &&
                            primary.action == PrimaryAction.START &&
                            ui.awning.tiers.any { it.recipeId == recipe && it.tier == ui.selectedTier }) awnings?.review(recipe)
                    } },
                    onSetAwningPreference = { enabled -> read {
                        val primary = ui.ownerControls?.awningPreference
                        if (!busy && primary?.state == CommandState.ENABLED) {
                            if (!enabled && primary.action == PrimaryAction.HIDE) awnings?.setPreference(false)
                            else if (enabled && primary.action == PrimaryAction.SHOW) awnings?.setPreference(true)
                        }
                    } },
                    onRefreshWakePreference = { read { if (!busy) wake?.refreshPreference() } },
                    onToggleWake = { show -> read {
                        // No C5 capability is registered. Preserve the independent account Off action only.
                        if (!show && ui.ownerControls?.canToggleWake == true && w?.preference?.enabled == true) wake?.setPreference(false)
                    } }, preview = preview)), Modifier.fillMaxSize())
        // The originals page (header History / ORIGINAL REQUESTS) in the sheet's own bounds; never while a review is open.
        CraftRecordsOverlay(if (reviewUi == null && history != null) styleRecords(history == "wake", a, w, awnings, wake, wallet,
            selectedBase, actionsAllowed, nativeReady, busy, onSwitch = { history = it }) else null,
            onClose = { history = null }, modifier = Modifier.fillMaxSize())
      }
    }
}

/** The designed originals page for the STYLE owners (c-gap-craft: replaces the "APPEARANCE REVIEWS & RECEIPTS" chrome
 *  dialog and the old awning / Aurora screens inside it). Same sentences, buttons, enabled rules and owner verbs. */
private fun styleRecords(showWake: Boolean, a: gg.pixelkingdomwars.nativeclient.data.BoundCosmeticWorkshopState?,
    w: gg.pixelkingdomwars.nativeclient.data.BoundCosmeticWakeWorkshopState?, awnings: BoundCosmeticWorkshopViewModel?,
    wake: BoundCosmeticWakeWorkshopViewModel?, wallet: String, selectedBase: String?, actionsAllowed: Boolean, nativeReady: Boolean,
    busy: Boolean, onSwitch: (String) -> Unit): CraftRecordsUi {
    val switches = listOf(
        CraftRecordAction("AWNINGS", true, { onSwitch("awning") }, if (showWake) gg.pixelkingdomwars.nativeclient.ui.model.Verb.STONE else gg.pixelkingdomwars.nativeclient.ui.model.Verb.BLUE),
        CraftRecordAction("AURORA", true, { onSwitch("wake") }, if (showWake) gg.pixelkingdomwars.nativeclient.ui.model.Verb.BLUE else gg.pixelkingdomwars.nativeclient.ui.model.Verb.STONE))
    fun details(op: gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticOperation) = listOfNotNull(CraftRecordDetail("Producing kingdom", op.command.request.baseId),
        CraftRecordDetail("Original request", op.command.key), op.proof?.receipt?.let { CraftRecordDetail("Started (UTC)", it.startedAt) },
        op.proof?.receipt?.let { CraftRecordDetail("Ready (UTC)", it.readyAt) },
        op.proof?.completion?.let { CraftRecordDetail("Completed (UTC)", it.completedAt) })
    if (showWake) {
        if (wake == null || w == null || w.journal.identity.wallet != wallet) return CraftRecordsUi("APPEARANCE RECORDS",
            notes = listOf("Aurora original storage is unavailable. Keep this app's data."), switches = switches)
        val saved = w.journal.operation?.let { op ->
            CraftRecordUi("Saved Aurora · ${awningRequestStatus(op)}", icon = "craft:item_aurora_wake", lines = listOf(when {
                op.proof?.completion != null -> "Your account owns this appearance."
                op.proof != null -> "Your original craft is accepted. Refresh to observe automatic completion."
                op.attempted -> "The craft may already have started. Check its original receipt before explicitly resending."
                else -> "Your exact recipe and original kingdom are saved. Nothing is consumed until you confirm."
            }), details = listOf(CraftRecordDetail("Original request", op.command.key), CraftRecordDetail("Producing kingdom", op.command.request.baseId)),
                actions = listOfNotNull(CraftRecordAction("CHECK ORIGINAL RECEIPT", !busy, { wake.check() }),
                    // This mount never admits a new Aurora craft (no native application capability), as before.
                    if (op.proof == null) CraftRecordAction("REVIEW SAME REQUEST", false, { wake.reviewSaved() }) else null,
                    // Owner rule 2026-10-06: an unknown sent request closes only after archive's fresh check answers "unknown".
                    CraftRecordAction(if (op.proof != null) "SAVE TO HISTORY" else if (op.attempted) "CHECK & CLOSE IF NOT FOUND" else "ARCHIVE UNSENT DRAFT",
                        !busy, { wake.archive() })), attention = true)
        }
        val proofs = wakeHistory(w).map { proof ->
            CraftRecordUi("Aurora Wake", if (proof.completion != null) "OWNED" else "CRAFTING",
                paymentRecordVerb(if (proof.completion != null) gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentTone.DONE
                    else gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentTone.OPEN), "craft:item_aurora_wake",
                listOf(if (proof.completion != null) "Completed · stays with your account" else "Accepted · refresh to check completion"),
                listOfNotNull(CraftRecordDetail("Original request", proof.idempotencyKey),
                    proof.receipt?.let { CraftRecordDetail("Producing kingdom", it.request.baseId) },
                    proof.completion?.let { CraftRecordDetail("Completed (UTC)", it.completedAt) }),
                listOfNotNull(if (w.journal.archives.any { it.command.key == proof.idempotencyKey })
                    CraftRecordAction("CHECK ORIGINAL RECEIPT", !busy, { wake.checkArchived(proof.idempotencyKey) }) else null))
        }
        return CraftRecordsUi("APPEARANCE RECORDS", "A permanent fleet appearance for your account. Each expedition keeps the choice saved when it departed.",
            listOf(CraftRecordSection("SAVED REQUEST", records = listOfNotNull(saved)), CraftRecordSection("AURORA WAKE", records = proofs)),
            notes = listOf("New Aurora crafts and switching on are held. Your account setting and original receipts remain available."),
            footer = CraftRecordAction("REFRESH WORKSHOP & RECEIPTS", !busy, { wake.refresh() }), switches = switches, busy = busy)
    }
    if (awnings == null || a == null || a.journal.identity.wallet != wallet) return CraftRecordsUi("APPEARANCE RECORDS",
        notes = listOf("Awning original storage is unavailable. Keep this app's data."), switches = switches)
    val view = a.view?.takeIf { it.wallet == wallet && it.selectedBase?.baseId == selectedBase }
    val saved = a.journal.operation?.let { op ->
        CraftRecordUi("Saved request · ${awningRequestStatus(op)}", icon = "craft:item_awning", lines = listOf(awningLabel(op.command.recipe.outputId), when {
            op.proof?.completion != null -> "Crafting completed for this account. Return to STYLE to change its appearance."
            op.proof != null -> "The start was accepted. Completion is automatic; a timer alone is not a delivery receipt."
            op.attempted -> "The request may have been accepted. Check its original receipt before deciding whether to resend."
            else -> "This draft is saved. Closing this page does not spend materials or erase it."
        }), details = details(op), actions = listOfNotNull(CraftRecordAction("CHECK ORIGINAL RECEIPT", !busy, { awnings.check() }),
            if (op.proof == null) CraftRecordAction(if (op.attempted) "REVIEW SAME REQUEST" else "REVIEW SAVED DRAFT",
                !busy && actionsAllowed && nativeReady && op.command.request.baseId == selectedBase, { awnings.reviewSaved() }) else null,
            // Owner rule 2026-10-06: an unknown sent request closes only after archive's fresh check answers "unknown".
            CraftRecordAction(if (op.proof != null) "MOVE TO HISTORY" else if (op.attempted) "CHECK & CLOSE IF NOT FOUND" else "ARCHIVE UNUSED DRAFT",
                !busy, { awnings.archive() })), attention = true)
    }
    val owned = view?.originals?.filter { it.completion != null && it.receipt?.appearance?.outputId?.startsWith("artisan_market_awning_t") == true }
        .orEmpty().mapNotNull { proof -> val receipt = proof.receipt ?: return@mapNotNull null
            CraftRecordUi(awningLabel(receipt.recipe.outputId), "OWNED", gg.pixelkingdomwars.nativeclient.ui.model.Verb.GREEN, "craft:item_awning",
                listOf("Owned by this account · one craft"), listOfNotNull(proof.completion?.let { CraftRecordDetail("Completed (UTC)", it.completedAt) }))
        }
    val archives = a.journal.archives.asReversed().map { op ->
        CraftRecordUi(awningLabel(op.command.recipe.outputId), awningRequestStatus(op), paymentRecordVerb(if (op.proof?.completion != null)
            gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentTone.DONE else gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentTone.OPEN), "craft:item_awning",
            listOf(op.command.recipe.inputs.joinToString(" + ") { "${gg.pixelkingdomwars.nativeclient.network.fmtN(it.quantity)} ${
                it.itemId.split('_').joinToString(" ") { part -> part.replaceFirstChar(Char::uppercaseChar) }}" },
                if (op.proof?.completion != null) "The server observed completion. Current kingdom stock is separate from this original receipt."
                else if (op.proof != null) "Start accepted. Check its original for automatic completion."
                else if (op.closedUnknown) "Closed after the server had no record of it. Checking this original never sends it."
                else "Unused archived draft. Checking this original never sends it."),
            details(op), listOf(CraftRecordAction("CHECK ORIGINAL RECEIPT", !busy, { awnings.checkArchived(op.command.key) })))
    }
    return CraftRecordsUi("APPEARANCE RECORDS", "Craft a permanent account appearance, then choose whether to show it in this kingdom. Awnings do not change gameplay stats.",
        listOf(CraftRecordSection("SAVED REQUEST", records = listOfNotNull(saved)),
            CraftRecordSection("OWNED", records = owned, empty = if (view == null) "Refresh to load account appearances. Saved receipts remain in History."
                else "Completed appearances will appear here. No appearance has been reported as completed for this account."),
            CraftRecordSection("ARCHIVE", records = archives,
                empty = "Archived drafts and accepted originals appear here. They remain available after a kingdom transfer.")),
        footer = CraftRecordAction("REFRESH APPEARANCES & RECEIPTS", !busy, { awnings.refresh() }), switches = switches, busy = busy)
}
