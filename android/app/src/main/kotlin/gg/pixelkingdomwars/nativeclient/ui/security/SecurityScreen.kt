package gg.pixelkingdomwars.nativeclient.ui.security

import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.ui.text.style.TextAlign
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.QuietButton
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.AccountCard
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.NoteLine
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteCardPage
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteFieldLabel
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteNoticeRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteTextInput
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SectionHeader
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SkeletonRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.StatusTag
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.StoneBusyButton
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.Alignment

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.view.WindowManager
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import gg.pixelkingdomwars.nativeclient.data.SecurityRepository
import gg.pixelkingdomwars.nativeclient.model.AccountSecurityStatus
import gg.pixelkingdomwars.nativeclient.model.RecoveryPhase
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Same destination serves signed-in account settings and the restricted login-recovery cookie.
 * Inputs use remember (never rememberSaveable); background/disposal erases them and the setup seed. */
@Composable fun SecurityScreen(repository: SecurityRepository, loginRecovery: Boolean = false, onBack: () -> Unit, walletAuthenticator: @Composable () -> Unit = {}) {
    val state by repository.state.collectAsState()
    val scope = rememberCoroutineScope()
    val owner = LocalLifecycleOwner.current
    val context = LocalContext.current
    val uri = LocalUriHandler.current
    var resumed by remember { mutableStateOf(owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    val leave = { repository.clearSensitive(); onBack() }
    BackHandlerAt(BackPriority.SCREEN) { leave() }
    DisposableEffect(repository, owner, context) {
        val window = context.activity()?.window
        val wasSecure = window != null && window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0
        window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        repository.setForeground(resumed)
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> { resumed = true; repository.setForeground(true); scope.launch { repository.refresh() } }
                Lifecycle.Event.ON_STOP -> { resumed = false; repository.setForeground(false) }
                else -> Unit
            }
        }
        owner.lifecycle.addObserver(observer)
        onDispose {
            owner.lifecycle.removeObserver(observer); repository.setForeground(false)
            if (!wasSecure) window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
    }
    LaunchedEffect(repository) { repository.refresh() }
    // Re-read at authoritative maturity/recovery boundaries, only while the screen is active.
    val status = state.status
    LaunchedEffect(repository, resumed, status) {
        if (!resumed || status == null) return@LaunchedEffect
        val now = Instant.now()
        val boundaries = listOf(status.totpReadyAt, status.recovery.readyAt, status.recovery.expiresAt)
            .mapNotNull { it?.let(Instant::parse) }.filter { it.isAfter(now) }.distinct().sorted()
        for (next in boundaries) {
            delay(java.time.Duration.between(Instant.now(), next).toMillis().coerceAtLeast(1))
            repository.refresh()
        }
    }
    // Owner 2026-10-06 ("UI unfinished"): the old dark ACCOUNT SECURITY page is the designed card ([RouteCardPage]); every
    // owner call, guard, masked field and sentence below is the previous page's own. A disabled door says why when tapped.
    val hold = when {
        state.busy -> "A security request is finishing. Please wait."
        !state.fresh -> "This status may be out of date. Refresh before making changes."
        else -> "Enter a valid code above first."
    }
    RouteCardPage("ACCOUNT SECURITY", "shield", leave, footer = {
        StoneBusyButton("REFRESH STATUS", state.busy, { if (!state.needsSignIn) scope.launch { repository.refresh() } else Toasts.post("Sign in again to continue.") },
            Modifier.weight(1f))
    }) {
        NoteLine("Your contact email and authenticator protect this account. Security changes also require wallet confirmation.", maxLines = 4)
        state.notice?.let { RouteNoticeRow(it) }; state.error?.let { RouteNoticeRow(it, error = true) }
        walletAuthenticator()
        when {
            state.needsSignIn -> RouteNoticeRow("Sign in again to continue.")
            status == null -> if (state.busy) SkeletonRow(height = 72.dp)
                else RouteNoticeRow("Security status is unavailable. Refresh to safely continue.", onRetry = { scope.launch { repository.refresh() } })
            else -> {
                if (!state.fresh) RouteNoticeRow("This status may be out of date. Refresh before making changes.", error = true)
                if (status.replacementRequired) RouteNoticeRow("REPLACEMENT AUTHENTICATOR REQUIRED · Key export and new withdrawals stay locked until verification.", error = true)
                Readiness(status)
                val enabled = state.fresh && !state.busy
                // Recreate only the nonpersistent input fields after a background/exit/verification clear.
                key(state.sensitiveRevision) {
                    var stepCode by remember { mutableStateOf("") }
                    var authenticatorCode by remember { mutableStateOf("") }
                    var email by remember { mutableStateOf("") }
                    var emailCode by remember { mutableStateOf("") }
                    var loginCode by remember { mutableStateOf("") }
                    var recoveryCode by remember { mutableStateOf("") }
                    var cancelCode by remember { mutableStateOf("") }
                    var completionCode by remember { mutableStateOf("") }
                    val recovery = status.recovery
                    recovery.receipt?.let { receipt ->
                        SecurityCard("RECOVERY REFUND RECEIPT") {
                            SecurityLine("${receipt.cancelledWithdrawals} pending withdrawals cancelled")
                            SecurityLine("${receipt.refundedKeep} KEEP refunded")
                            SecurityLine("${receipt.inFlightWithdrawals} processing withdrawals left untouched")
                        }
                    }
                    if (recovery.phase == RecoveryPhase.EMAIL_PENDING || recovery.phase == RecoveryPhase.HOLDING) {
                        SecurityCard(if (recovery.phase == RecoveryPhase.EMAIL_PENDING) "CONFIRM AUTHENTICATOR RECOVERY" else "RECOVERY HOLD ACTIVE") {
                            SecurityLine("Security factors and new withdrawals stay locked during recovery. Cancelling later does not restore refunded withdrawals.")
                            recovery.readyAt?.let { SecurityLine("Ready to complete: ${date(it)}") }
                            recovery.expiresAt?.let { SecurityLine("Expires: ${date(it)}") }
                            if (recovery.phase == RecoveryPhase.EMAIL_PENDING) {
                                SecurityLine("Enter the recovery email code. Confirmation starts the security hold and cancels/refunds pending withdrawals.")
                                CodeField("Recovery email code", recoveryCode, { recoveryCode = it }, enabled)
                                SecurityButton("Confirm recovery & start hold", enabled && validCode(recoveryCode), hold, Verb.GREEN) { val code = recoveryCode; recoveryCode = ""; scope.launch { repository.confirmRecovery(code) } }
                                SecurityButton("Resend recovery email", enabled, hold) { scope.launch { repository.startRecovery() } }
                            } else {
                                val ready = recovery.readyAt?.let { !Instant.parse(it).isAfter(Instant.now()) } == true
                                val notReady = if (!ready) "Recovery can be completed when the server permits it." else hold
                                SecurityLine("When the server permits completion, confirm your wallet and the email code to remove the old authenticator. All sessions will end.")
                                SecurityButton("Send completion email", enabled && ready, notReady) { scope.launch { repository.sendRecoveryCompletionEmail() } }
                                CodeField("Completion email code", completionCode, { completionCode = it }, enabled && ready)
                                SecurityButton("Remove old authenticator & sign out", enabled && ready && validCode(completionCode), notReady, Verb.RED) { val code = completionCode; completionCode = ""; scope.launch { repository.completeRecovery(code) } }
                            }
                            CodeField("Current authenticator code to cancel", cancelCode, { cancelCode = it }, enabled)
                            SecurityButton("Cancel recovery", enabled && validCode(cancelCode), hold) { val code = cancelCode; cancelCode = ""; scope.launch { repository.cancelRecovery(code) } }
                        }
                    }
                    if (!status.factorsLocked) {
                        if (status.emailVerified && (!status.totpEnabled || !loginRecovery)) {
                            SecurityCard("VERIFY AN EXISTING FACTOR") {
                                SecurityLine(if (status.totpEnabled) "For email changes, enter a code from your current PKW authenticator." else "Request a code at your current verified email before adding an authenticator or changing email.")
                                if (!status.totpEnabled) SecurityButton("Send current-email verification code", enabled, hold) { scope.launch { repository.sendFactorEmail() } }
                                CodeField(if (status.totpEnabled) "Current authenticator code" else "Current-email verification code", stepCode, { stepCode = it }, enabled)
                            }
                        } else if (status.totpEnabled && !loginRecovery) {
                            CodeField("Current authenticator code for email changes", stepCode, { stepCode = it }, enabled)
                        }
                        SecurityCard("AUTHENTICATOR APP") {
                            if (status.totpEnabled) {
                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    StatusTag("ON", Verb.GREEN); SecurityLine("Authenticator enabled")
                                }
                                if (!loginRecovery) {
                                    if (status.loginTotpRequired) SecurityLine("Turn off login protection before removing its authenticator.")
                                    CodeField("Authenticator code to disable", authenticatorCode, { authenticatorCode = it }, enabled)
                                    SecurityButton("Disable authenticator", enabled && !status.loginTotpRequired && validCode(authenticatorCode),
                                        if (status.loginTotpRequired) "Turn off login protection before removing its authenticator." else hold, Verb.RED) {
                                        val code = authenticatorCode; authenticatorCode = ""; scope.launch { repository.disableAuthenticator(code) } }
                                }
                                SecurityButton("Lost authenticator? Start recovery", enabled && status.emailVerified && status.recoveryEnabled && !status.replacementRequired,
                                    if (!status.emailVerified || !status.recoveryEnabled) "Automated recovery is unavailable for this account." else hold) { scope.launch { repository.startRecovery() } }
                                if (!status.emailVerified) SecurityLine("Automated recovery requires a verified contact email. Contact game support if your authenticator is lost.")
                                if (!status.recoveryEnabled) SecurityLine("Automated recovery is unavailable on this server.")
                                if (!status.emailVerified || !status.recoveryEnabled) QuietButton("support@pixelkingdomwars.com", {
                                    runCatching { uri.openUri("mailto:support@pixelkingdomwars.com?subject=Lost%20Pixel%20Kingdom%20Wars%20authenticator") }
                                }, onParchment = true)
                            } else {
                                state.enrollment?.let { setup ->
                                    val bitmap = remember(setup) { setup.qrPng?.let { png -> runCatching {
                                        android.graphics.BitmapFactory.decodeByteArray(png, 0, png.size, android.graphics.BitmapFactory.Options().apply { inMutable = true })
                                    }.getOrNull() } }
                                    DisposableEffect(bitmap) { onDispose { bitmap?.takeUnless { it.isRecycled }?.eraseColor(android.graphics.Color.TRANSPARENT) } }
                                    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                        bitmap?.let { Image(it.asImageBitmap(), "Scan in your authenticator app", Modifier.size(200.dp).background(androidx.compose.ui.graphics.Color.White)) }
                                        SecurityLine(if (bitmap == null) "Add this setup key manually in your authenticator." else "Or enter this key manually:")
                                        SelectionContainer { PkwText(setup.secret, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch, maxLines = 3) }
                                        SecurityLine("Hidden when this screen leaves the foreground.")
                                    }
                                }
                                if (state.enrollmentStarted) {
                                    if (state.enrollment == null) SecurityLine("Your setup key was hidden. If it is already added, verify its code. Otherwise explicitly create a replacement setup key below.")
                                    CodeField("New authenticator code", authenticatorCode, { authenticatorCode = it }, enabled)
                                    SecurityButton("Verify authenticator", enabled && validCode(authenticatorCode), hold, Verb.GREEN) { val code = authenticatorCode; authenticatorCode = ""; scope.launch { repository.verifyAuthenticator(code) } }
                                }
                                SecurityButton(if (state.enrollmentStarted) "Create a replacement setup key" else "Set up authenticator", enabled && (!status.emailVerified || validCode(stepCode)), hold) {
                                    val code = stepCode; stepCode = ""; scope.launch { repository.enrollAuthenticator(code) } }
                            }
                        }
                        if (!loginRecovery && !status.replacementRequired) {
                            SecurityCard("CONTACT EMAIL") {
                                SecurityLine(if (status.emailVerified) "Verified: ${status.email ?: "Contact email"}" else "No verified contact email")
                                RouteFieldLabel("NEW CONTACT EMAIL")
                                RouteTextInput(email, { email = it }, "New contact email", enabled = enabled, keyboardType = KeyboardType.Email)
                                SecurityButton("Send verification email", enabled && email.isNotBlank() && (!(status.totpEnabled || status.emailVerified) || validCode(stepCode)),
                                    if (email.isBlank()) "Enter the new contact email first." else hold) {
                                    val address = email; val code = stepCode; email = ""; stepCode = ""; scope.launch { repository.startEmail(address, code) } }
                                status.pendingEmail?.let { pending ->
                                    SecurityLine("Pending verification: $pending")
                                    CodeField("New email verification code", emailCode, { emailCode = it }, enabled)
                                    SecurityButton("Verify contact email", enabled && validCode(emailCode), hold, Verb.GREEN) { val code = emailCode; emailCode = ""; scope.launch { repository.verifyEmail(code) } }
                                }
                            }
                            SecurityCard("LOGIN PROTECTION") {
                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    StatusTag(if (status.loginTotpRequired) "ON" else "OFF", if (status.loginTotpRequired) Verb.GREEN else Verb.STONE)
                                    SecurityLine("Require PKW authenticator on login: ${if (status.loginTotpRequired) "ON" else "OFF"}")
                                }
                                SecurityLine("Changes sign out other sessions. Enabling requires a verified authenticator, contact email and available recovery.")
                                CodeField("Authenticator code for login protection", loginCode, { loginCode = it }, enabled)
                                SecurityButton(if (status.loginTotpRequired) "Disable login protection" else "Require authenticator on login",
                                    enabled && status.totpEnabled && loginCode.matches(Regex("[0-9]{6}")) && (status.loginTotpRequired || (status.emailVerified && status.recoveryEnabled)),
                                    if (!status.totpEnabled) "Set up the authenticator app first." else hold) {
                                    val code = loginCode; loginCode = ""; scope.launch { repository.setLoginProtection(!status.loginTotpRequired, code) } }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** A titled section: the PS header on the parchment, then a cream card holding its lines, fields and doors. */
@Composable private fun SecurityCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    SectionHeader(title)
    AccountCard(Modifier.fillMaxWidth(), contentPadding = 10.dp) { Column(verticalArrangement = Arrangement.spacedBy(8.dp), content = content) }
}
/** A VT sentence on the cream card. */
@Composable internal fun SecurityLine(text: String) {
    PkwText(text, PkwTokens.Type.small, Modifier.fillMaxWidth(), color = PkwTokens.Colors.textOnParch, maxLines = 6)
}
/** A masked one-time code field (number keyboard, dots) under its caption. */
@Composable private fun CodeField(label: String, value: String, onChange: (String) -> Unit, enabled: Boolean) {
    RouteFieldLabel(label.uppercase())
    RouteTextInput(value, onChange, label, enabled = enabled, secret = true)
}
/**
 * A full-width kit button whose label may wrap to two lines (the security verbs are long). [enabled] false draws the
 * off face; a tap then posts [hold], so the door says why instead of doing nothing.
 */
@Composable internal fun SecurityButton(label: String, enabled: Boolean, hold: String, verb: Verb = Verb.STONE, onClick: () -> Unit) {
    ChunkyBox(PkwTokens.ramp(if (enabled) verb else Verb.OFF), { if (enabled) onClick() else Toasts.post(hold) }, label,
        Modifier.fillMaxWidth().heightIn(min = PkwTokens.Dims.secondaryH)) {
        PkwText(label.uppercase(), PkwTokens.Type.label, Modifier.padding(horizontal = 8.dp), color = PkwTokens.Colors.label, outline = 1.dp,
            textAlign = TextAlign.Center, maxLines = 2)
    }
}
@Composable private fun Readiness(status: AccountSecurityStatus) {
    when {
        status.instantEligible && status.instantWithdrawalsEnabled -> RouteNoticeRow("Instant withdrawals available")
        status.totpEnabled && !status.totpReady -> RouteNoticeRow("Authenticator maturing${status.totpReadyAt?.let { ": ${date(it)}" } ?: ""}")
        status.totpEnabled -> RouteNoticeRow("Authenticator enabled. Instant withdrawals are currently unavailable.")
    }
}
private fun validCode(value: String) = value.trim().matches(Regex("[0-9]{6,8}"))
private fun date(value: String) = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm z").withZone(ZoneId.systemDefault()).format(Instant.parse(value))
private tailrec fun Context.activity(): Activity? = when (this) { is Activity -> this; is ContextWrapper -> baseContext.activity(); else -> null }
