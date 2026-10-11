package gg.pixelkingdomwars.nativeclient.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontSynthesis
import androidx.compose.ui.text.TextStyle
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.sp
import gg.pixelkingdomwars.nativeclient.R
import androidx.compose.ui.Alignment
import gg.pixelkingdomwars.nativeclient.ui.chrome.Card
import gg.pixelkingdomwars.nativeclient.ui.chrome.CloseButton
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.ops.InterruptedIntent
import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.ops.Receipt
import gg.pixelkingdomwars.nativeclient.wallet.SocialProvider
import kotlinx.coroutines.delay
import androidx.compose.foundation.clickable
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.kit.HeraldPlate
import gg.pixelkingdomwars.nativeclient.ui.kit.IconSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.VeilChip
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/** Exact production web primitives.tsx/styles.css palette. UI dimensions are presentation, not game rules. */
object Palette {
    val backdrop = Color(0xFF100E14)
    val surface = Color(0xFF1A171E)
    val card = Color(0xFF14121A)
    val panel = Color(0xFF3D3833)
    val border = Color(0xFF3D3833)
    val borderLt = Color(0xFF6B6354)
    val ink = Color(0xFF1A171E)
    val text = Color(0xFFEFE8D6)
    val muted = Color(0xFFC4BBA4)
    val textFaint = Color(0xFF9C937F)
    val gold = Color(0xFFE3AE3C)
    val goldHi = Color(0xFFF4D77B)
    val goldDp = Color(0xFF9C6F1E)
    val onGold = ink
    val danger = Color(0xFFC75A2E)
    val blood = Color(0xFF8F2C2C)
    val success = Color(0xFF8CB36E)
    val notice = Color(0xFF263524)
    val hudField = Color(0xFF2F2C34)
    /** Web `.btn.sec` stone plate and its #756b59 rule. */
    val stone = Color(0xFF29262E)
    val stoneBorder = Color(0xFF756B59)
}

private val WebFont = FontFamily(Font(R.font.pkw_vt323, FontWeight.Normal))
private fun pixelType(size:Int, line:Int=size+4, spacing:Int=0) = TextStyle(
    fontFamily=WebFont,fontWeight=FontWeight.Normal,fontSynthesis=FontSynthesis.None,
    fontSize=size.sp,lineHeight=line.sp,letterSpacing=spacing.sp)
/** Web html/body: every run of text is the pixel font (styles.css `font-family: 'VT323', monospace`).
 * Owner 2026-09-17 ("font still not loaded"): the sans fallback is gone; paragraphs are VT323 at a larger
 * size with a looser line, so long copy stays legible without a second font. */
object PkwType {
    val readable: TextStyle = pixelType(17, 22)
    /** Global chat log. Owner 2026-09-18 ("player messages are too big"): a chat log is read line after line, so
     * a message — and the name above it, never larger than what it said — is a step under `bodySmall` on a tight
     * line; the time, the mention flag and the log's hint are the app's smallest caption. sp: follows the system
     * font scale. */
    val chatLine: TextStyle = pixelType(15, 17)
    val chatMeta: TextStyle = pixelType(12, 14)
}

@Composable fun PkwTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme=darkColorScheme(primary=Palette.gold,onPrimary=Palette.ink,
            secondary=Palette.muted,onSecondary=Palette.ink,background=Palette.backdrop,
            surface=Palette.surface,onSurface=Palette.text,onBackground=Palette.text,
            surfaceVariant=Palette.card,onSurfaceVariant=Palette.muted,outline=Palette.borderLt,
            error=Palette.danger,onError=Palette.text),
        typography=Typography(displayLarge=pixelType(48,52),displayMedium=pixelType(40,44),displaySmall=pixelType(32,36),
            headlineLarge=pixelType(32,36,2),headlineMedium=pixelType(28,32,2),headlineSmall=pixelType(26,30,2),
            titleLarge=pixelType(24,28,2),titleMedium=pixelType(22,26,1),titleSmall=pixelType(20,24,1),
            bodyLarge=pixelType(20,24),bodyMedium=pixelType(18,22),bodySmall=pixelType(16,19),
            labelLarge=pixelType(22,26,1),labelMedium=pixelType(18,22,1),labelSmall=pixelType(14,18,1)),
        shapes=Shapes(extraSmall=RoundedCornerShape(0.dp),small=RoundedCornerShape(0.dp),medium=RoundedCornerShape(0.dp),large=RoundedCornerShape(0.dp),extraLarge=RoundedCornerShape(0.dp)),
        content=content)
}

/** All player-facing copy (English only; no i18n layer yet). */
object Copy {
    const val APP_NAME = "PIXEL KINGDOM WARS"
    const val NETWORK = "SOLANA MOBILE · DEVNET"
    const val LOCAL_SERVER = "TEST KINGDOM"
    const val PREPARING = "Preparing your kingdom"
    const val PREPARING_DETAIL = "Please wait while your kingdom loads."
    const val TITLE_HEADLINE = "Your kingdom.\nIn your hands."
    const val TITLE_DETAIL = "Connect the same wallet you use on the web to restore your account, bases and progression."
    const val CONNECT_WALLET = "Connect wallet"
    const val USE_ANOTHER_WALLET = "Use another wallet"
    /** One line under the reset: any MWA wallet works; the reset only makes Android ask which one again. */
    // Honest by construction: the wallet library opens a plain `solana-wallet:` link and cannot target an app, so
    // Android alone decides whether a chooser appears (two or more wallets installed, none set as the default).
    const val USE_ANOTHER_WALLET_NOTE = "Any Mobile Wallet Adapter wallet works — Seed Vault, Phantom, Solflare, Backpack. This forgets the saved wallet connection. Android asks which wallet to open only when several are installed and none is the default; otherwise clear the current wallet's \"Open by default\" in Android settings first."
    const val WALLET_FORGOTTEN = "WALLET CONNECTION FORGOTTEN — CONNECT WALLET STARTS A NEW ONE. ANDROID ASKS WHICH WALLET ONLY WHEN SEVERAL ARE INSTALLED AND NONE IS THE DEFAULT."
    const val RESTORE_SESSION = "Restore existing session"
    const val PLAY_WEB = "Play the current web game"
    const val TOTP_TITLE = "Protect your kingdom"
    const val TOTP_DETAIL = "Enter your authenticator code to finish signing in to your existing account."
    const val TOTP_FIELD = "6-digit authenticator code"
    const val TOTP_VERIFY = "Verify sign-in"
    const val TOTP_CANCEL = "Cancel sign-in"
    const val LAND_TITLE = "CLAIM YOUR LAND"
    const val LAND_ANOTHER_KEEP = "FOUND ANOTHER KEEP"
    /** The price is never stated before the server freezes it with the reservation (no game number lives here). */
    const val LAND_PRICE_NOTE = "One on-chain SOL payment deeds this parcel to you. The exact price is frozen when your tile is reserved."
    const val LAND_KEEP_BUILDING = "KEEP BUILDING FOR NOW"
    const val NO_LAND_PROMPT = "NO LAND YET — GOLD FORGE, MARKET & RAIDS LOCKED"
    const val SCOUT = "SCOUT STRONGHOLD"
    const val INTERRUPTED_TITLE = "Interrupted request"
    const val CHECK_STATUS = "Retry check"
    const val CLOSE_REQUEST = "Close"
    const val RETRY_SAME = "Try again"
    const val BACK_AGAIN = "Back again to exit"
    /** The loaded pack lacks `MOBILE_BACK.exitConfirmMs`: no exit window is invented, so Back cannot exit. */
    const val BACK_EXIT_UNAVAILABLE = "Back-to-exit needs a game content update — use the Home gesture to leave"
    const val UPDATE_REQUIRED = "Update required"
    const val MAINTENANCE = "Raising the drawbridge"
    const val ALPHA_GATED = "Playtest access needed"
    const val FUNDS_TITLE = "Not enough funds"
    const val CONTENT_APPLY = "Apply game content update"
    const val SIGN_OUT = "Sign out"
    // Tutorial controls on the profile ACCOUNT tab (web menu.tsx replayTutorial/toggleGuidance toasts). The web lands on the
    // base after a replay; native stays on the hub, so the restart toast says where the welcome card is waiting.
    const val TUTORIAL_RESTARTED = "TUTORIAL RESTARTED — RETURN TO YOUR BASE"
    const val GUIDANCE_ON = "GUIDANCE ON"
    const val GUIDANCE_OFF = "GUIDANCE OFF"
    // PvP raid flow (web RaidChooser.tsx, RaidEntryCost.tsx, raidNoTargets.tsx, RaidUI.tsx, results.tsx), verbatim.
    const val RAID = "RAID"
    const val FREE_ENERGY = "FREE ENERGY"
    const val EACH_PVP_TARGET = "EACH PVP TARGET"
    const val ENTRY_COST_NOTE = "Charged when a target is found. Retreat keeps these spent."
    const val BUY_LAND_TO_RAID = "BUY LAND TO RAID LANDOWNERS"
    const val FINDING_TARGET = "FINDING A TARGET…"
    const val PREPARING_CAMPAIGN = "PREPARING THE CAMPAIGN…"
    const val BACK_TO_BASE = "BACK TO BASE"
    const val TRY_AGAIN = "TRY AGAIN"
    const val WORLD_MAP = "WORLD MAP"
    const val CAMPAIGN = "CAMPAIGN"
    const val NO_SETTLERS_TITLE = "NO OTHER SETTLERS YET"
    const val NO_SETTLERS_WHY = "Landless keeps are only matched against each other, and right now there is no other landless keep free to fight. Nothing is wrong with your keep — the pool is empty."
    const val PLAY_CAMPAIGN = "PLAY CAMPAIGN"
    fun buyYourLand(entryFeeSol: String) = "BUY YOUR LAND · $entryFeeSol SOL"
    const val NEXT_TARGET = "NEXT TARGET"
    const val RETRY_NEXT_TARGET = "RETRY NEXT TARGET"
    const val CONFIRMING = "CONFIRMING…"
    const val CONFIRMING_RETREAT = "CONFIRMING RETREAT…"
    const val RETREAT_UNCONFIRMED = "RETREAT UNCONFIRMED · RETRY NEXT TARGET"
    const val NEXT_TARGET_TITLE = "FIND ANOTHER TARGET?"
    fun nextTargetBody(cost: String) = "Next target: $cost. Your current entry is not refunded. No extra charge if no other target is available."
    const val RETREAT_TITLE = "RETREAT · END THE BATTLE?"
    /** Owner 2026-09-17: say exactly what a retreat does (server liveRaids.ts: an explicit terminal finish scored on destruction so far). */
    const val RETREAT_BODY = "END THE BATTLE NOW. WHAT YOU HAVE DESTROYED SO FAR IS SCORED; UNUSED TROOPS RETURN HOME."
    const val RETREAT = "RETREAT"
    const val RAID_OFFLINE = "RAID OFFLINE · RECONNECTING"
    const val CHOOSE_BUFFS_FIRST = "CHOOSE BUFFS BEFORE DEPLOYING YOUR FIRST UNIT"
    const val VICTORY = "VICTORY"
    const val DEFEAT = "DEFEAT"
    const val HOME = "HOME"
    const val NEXT_RAID = "NEXT RAID"
    const val NEXT_STAGE = "NEXT STAGE"
    const val CAMPAIGN_MAP = "CAMPAIGN MAP"
    const val TRAIN_ARMY = "TRAIN ARMY"
    const val RAID_LOG = "RAID LOG"
    const val REPLAY_SAVED = "REPLAY SAVED"
    const val SHARDS_LOOTED = "SHARDS LOOTED"
    const val TROPHIES = "TROPHIES"
    const val REDACTED = "REDACTED"
    const val WALLS_HELD = "THE WALLS HELD"
    const val KEEP_FELL = "KEEP FELL"
    // Battle history (web raidlog.tsx), verbatim.
    const val BATTLE_HISTORY = "BATTLE HISTORY"
    const val UNFINISHED_MARCH = "UNFINISHED MARCH"
    const val UNFINISHED_MARCH_SUB = "SERVER-SAVED · READY TO CONTINUE"
    const val CONTINUE = "CONTINUE"
    const val SELECTED_DEED_HISTORY = "SELECTED DEED HISTORY"
    const val WALLET_RAID_HISTORY = "WALLET RAID HISTORY"
    const val NO_DEED_SELECTED = "NO ACTIVE DEED SELECTED · YOUR PRIOR PARTICIPATION REMAINS BELOW"
    const val NO_DEED_BATTLES = "NO BATTLES RECORDED FOR THIS DEED."
    const val LOAD_OLDER_DEED = "LOAD OLDER DEED BATTLES"
    const val PRIOR_PARTICIPATION = "OTHER / PRIOR DEED PARTICIPATION"
    const val PRIOR_PARTICIPATION_SUB = "YOUR EXACT PRIVATE RECORD SURVIVES A DEED SALE"
    const val NO_PARTICIPATED = "NO OTHER PARTICIPATED BATTLES."
    const val LOAD_OLDER_PARTICIPATED = "LOAD OLDER PARTICIPATED BATTLES"
    const val LOADING = "LOADING…"
    const val LOADING_HISTORY = "LOADING BATTLE HISTORY…"
    const val HISTORY_FOOTER = "DEED RECORDS TRANSFER · PARTICIPANT REPLAYS REMAIN PRIVATE"
    const val REPLAY = "REPLAY"
    // Defender interlock (web BaseRaidInterlock.tsx), verbatim.
    const val BASE_UNDER_RAID = "BASE UNDER RAID"
    const val ACTIVE_RAID_MESSAGE = "You are being raided, please wait to continue playing or watch it live"
    const val WATCH_LIVE = "WATCH LIVE"
    const val SWITCH_DEED = "SWITCH DEED"
    fun raidLockState(state: String) = when (state) { "reserved" -> "ATTACKER IS PREPARING"; "live" -> "BATTLE IN PROGRESS"; else -> "SETTLING BATTLE" }
    // Bases (web bases.tsx) and authority recovery (web state/baseAuthorityRecovery.ts), verbatim.
    const val BASES_KICKER = "LAND DEED COMMAND"
    const val BASES_TITLE = "YOUR BASES"
    const val BASES_VERIFYING = "Loading your bases…"
    const val BASES_UNAVAILABLE = "MULTI-BASE IS NOT ACTIVE ON THIS SERVER."
    const val ACTIVE_DEEDS = "ACTIVE DEEDS"
    const val INACTIVE_DEEDS = "INACTIVE DEEDS"
    const val BASES_READONLY = "BASE-SCOPED READS ARE LIVE. BUILDING, RAIDING, ACTIVATION AND REPLACEMENT STAY LOCKED UNTIL SERVER MUTATIONS ARE BASE-SCOPED."
    const val CURRENT_BASE = "CURRENT BASE"
    const val OPEN_BASE = "OPEN BASE"
    const val SLOT_EMPTY = "EMPTY"
    const val NO_EXTRA_DEEDS = "NO EXTRA DEEDS DETECTED"
    const val REPLACE_ACTIVE_SLOT = "REPLACE ACTIVE SLOT"
    const val CHOOSE = "CHOOSE…"
    const val ACTIVATE_DEED = "ACTIVATE DEED"
    const val ACTIVATION_LOCKED = "ACTIVATION LOCKED"
    const val NEXT_LAND_TILE = "YOUR NEXT LAND TILE"
    const val NEXT_EARTH_CELL = "YOUR NEXT EARTH CELL"
    const val NEXT_TILE_FANTASY = "CHOOSE AN AVAILABLE TILE IN AN ORDINARY REALM. THE SERVER RESERVES YOUR LAND BEFORE SIGNING. GENESIS AND SEEKER ALLOCATIONS REMAIN RESERVED."
    const val NEXT_CELL_EARTH = "CHOOSE A CLAIMABLE EARTH CELL BEFORE SIGNING, OR LEAVE IT OPEN FOR THE SERVER TO SECURELY CHOOSE AN AVAILABLE CELL."
    const val SLOTS_FULL = "ALL ACTIVE SLOTS ARE OCCUPIED. AN ADDITIONAL DEED STAYS INACTIVE UNTIL YOU REPLACE AN ACTIVE SLOT."
    const val BUY_ANOTHER_DEED = "BUY ANOTHER LAND DEED"
    const val LAND_RESERVATION_UNAVAILABLE = "LAND RESERVATION IS NOT AVAILABLE ON THIS SERVER."
    const val CELL_RESERVATION_UNAVAILABLE = "CELL RESERVATION IS NOT LIVE YET. A FUTURE PURCHASE WILL FREEZE YOUR CHOSEN CELL BEFORE SIGNING; IF OMITTED, THE SERVER CHOOSES AN AVAILABLE EARTH CELL SECURELY."
    const val DEED_LOCATION_PENDING = "DEED LOCATION PENDING"
    const val NO_DEEDED_LAND = "NO DEEDED LAND"
    const val EARTH_CELL_PENDING = "EARTH CELL PENDING"
    const val LAND_PAID_DEED_PENDING = "LAND PAID · DEED PENDING"
    const val FREE_BASE_NO_DEED = "FREE BASE · NO DEED"
    const val DEED_STALE = "The selected deed is no longer active or owned by this wallet."
    const val DEED_CHANGED = "DEED OWNERSHIP CHANGED — SELECT AN ACTIVE BASE"
    const val EXPLICIT_SELECTION = "THIS ACCOUNT REQUIRES AN EXPLICIT BASE SELECTION"
    const val LAND_VERIFICATION_UNAVAILABLE = "LAND VERIFICATION IS TEMPORARILY UNAVAILABLE — RETRY YOUR ACTION"
    const val CHOOSE_ACTIVE_BASE = "CHOOSE AN ACTIVE BASE ON THIS DEVICE"
    const val RETURNED_TO_RAID = "RETURNED TO YOUR UNFINISHED RAID"
    const val SCOUT_CLOSE = "CLOSE"
    const val SCOUT_PREFIX = "SCOUT"
    // Social sign-in, placed as the web does (connectOptions.ts: social entry after the wallet options); the
    // three-button split and its Google → X → email order are native choices.
    const val SOCIAL_GOOGLE = "Continue with Google"
    const val SOCIAL_X = "Continue with X"
    const val SOCIAL_EMAIL = "Continue with email"
    const val SOCIAL_SUB = "No seed phrase. Signs in with the game wallet of your existing web account."
    const val SOCIAL_EMAIL_FIELD = "Email address"
    const val SOCIAL_SEND_CODE = "Send code"
    const val SOCIAL_CODE_FIELD = "6-digit code from your email"
    const val SOCIAL_VERIFY_CODE = "Verify code"
    const val SOCIAL_CHANGE_EMAIL = "Use a different email"
    const val SOCIAL_CANCEL = "Cancel"
    const val SOCIAL_BROWSER_WAIT = "Finish signing in with your browser, then return here. Closing the browser cancels the sign-in."
    fun socialCodeSent(email: String) = "Enter the code sent to $email."
    fun socialInterrupted(provider: SocialProvider) = "Your ${provider.label} sign-in was interrupted before it finished. Choose it again to continue."
    const val PRIVY_MFA_TITLE = "Verify your game wallet"
    const val PRIVY_MFA_DETAIL = "This wallet is protected by an authenticator. Enter its 6-digit code to approve the sign-in signature. This is separate from the game's own login code."
    const val PRIVY_MFA_UNSUPPORTED = "This wallet's verification method is not supported in the app yet. Verify in the web game instead."
    const val PRIVY_MFA_FIELD = "Wallet authenticator code"
    const val PRIVY_MFA_SUBMIT = "Approve"
    const val PRIVY_MFA_CANCEL = "Cancel"
    const val PRIVY_MFA_CANCELLED = "Wallet verification cancelled. Choose a sign-in option when you are ready."
    fun interrupted(kind: String) = when (kind) {
        IntentKind.TRAINING_BATCH -> "A training response was interrupted. Check its status before starting another batch."
        IntentKind.TRAINING_CANCEL -> "A training cancellation is unconfirmed. Check the saved cancellation before another order."
        IntentKind.TRAINING_FINISH -> "A finish-all response was interrupted. Check its status before finishing again."
        IntentKind.CONSTRUCTION -> "An earlier construction response was interrupted. Recover it before submitting another order."
        IntentKind.RESEARCH -> "A research response is unresolved. Check server status; no order will be resent automatically."
        IntentKind.LAND_RESERVATION -> "A land reservation reply was lost. Try the same request again; the server replays your one pending reservation."
        IntentKind.WALL_ROW -> "A wall row purchase reply was lost. Retry the same upgrade; the server replays a committed key without charging twice."
        IntentKind.LAYOUT_UNLOCK -> "A layout slot unlock reply was lost. Retry it; an unlocked slot answers with no charge."
        IntentKind.HERO_UPGRADE -> "A hero upgrade reply was lost. Its payment is unverified. Check status before another purchase."
        IntentKind.HERO_RECOVERY -> "A hero recovery reply was lost. Its payment is unverified. Check status before another purchase."
        IntentKind.ITEM_BUY -> "A purchase reply was lost. Try the same request again; the server replays it without charging twice."
        IntentKind.ITEM_USE -> "The game server response was interrupted. The item-use outcome is uncertain: check it before using another item."
        else -> "An earlier request was interrupted. Check its status before continuing."
    }
    /** Troop display names (web ui/copy.ts TROOP_NAMES); an unknown key reads as its upper-cased root. */
    private val TROOP_NAMES = mapOf("highlander" to "HIGHLANDER", "bowman" to "BOWMAN", "kegrunner" to "KEG RUNNER", "tunneler" to "TUNNELER", "turrider" to "TUR RIDER",
        "plunderer" to "PLUNDERER", "giant" to "GIANT", "troll" to "TROLL", "dragon" to "DRAGON", "mage" to "MAGE", "bilgewraith" to "BILGEWRAITH", "gloamfang" to "GLOAMFANG",
        "direwyvern" to "DIREWYVERN", "hexbarrow" to "HEXBARROW", "barrowling" to "BARROWLING", "wyrmling" to "WYRMLING")
    fun troopName(troop: String): String = TROOP_NAMES[troop] ?: troop.uppercase()
    /** Owner field result 2026-10-06: every answer fits a two-line toast and the herald without an ellipsis. */
    fun observation(receipt: Receipt<*>?) = when (receipt) {
        // Owner review 2026-10-06 (M1): `unknown` is "no matching evidence", not "no record"; only `absent` says that.
        Receipt.Unknown -> "The server has not confirmed this request."
        Receipt.Absent -> "The server has no record of this request."
        Receipt.Unsupported -> "The server cannot verify this request yet. Nothing was resent."
        is Receipt.Closed -> "The interrupted request is closed."
        is Receipt.Accepted -> "The server confirmed the original request."
        null -> null
    }
}

/** A gate ("needs land", "not built yet", "values may be stale") is not a failure: it is WARN, gold on ink
 * with an action beside it, never the blood banner the owner reads as "a strange red response". ERROR stays
 * reserved for a real failure (a rejected payment, a server error). INFO is the quiet green confirmation. */
enum class NoticeKind { INFO, WARN, ERROR }

/** Notice plate colours per kind (web `.notice` / `.warn` / `.err` rules): INFO is a quiet stone plate, WARN a gold-
 * ruled ink plate, ERROR a blood-ruled stone plate. Never a bare black box (owner 2026-09-17). */
data class NoticeStyle(val fill: Color, val rule: Color, val text: Color)
fun noticeStyle(kind: NoticeKind): NoticeStyle = when (kind) {
    NoticeKind.INFO -> NoticeStyle(Palette.stone, Palette.borderLt, Palette.text)
    NoticeKind.WARN -> NoticeStyle(Palette.ink, Palette.gold, Palette.gold)
    NoticeKind.ERROR -> NoticeStyle(Palette.stone, Palette.blood, Palette.text)
}

/** A framed message plate. Pass [onDismiss] whenever the message is persistent state the player may want gone:
 * it draws the X (semantics "Dismiss") that clears it. No X means the caller's own action row retires it. */
@Composable fun Notice(message: String, kind: NoticeKind, onDismiss: (() -> Unit)? = null) {
    // Second old-screen sweep (owner 2026-10-06): on the designed parchment a notice is a cream row with its state rule
    // (gold lip for a gate, crimson for a failure) and brown / refusal ink; dark surfaces keep [noticeStyle].
    val style = if (gg.pixelkingdomwars.nativeclient.ui.chrome.onParchment()) parchmentNoticeStyle(kind) else noticeStyle(kind)
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).background(style.fill).border(2.dp, style.rule), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.width(4.dp).fillMaxHeight().background(style.rule))
        Text(message, Modifier.weight(1f).padding(horizontal = 12.dp, vertical = 10.dp), color = style.text, style = MaterialTheme.typography.bodySmall)
        onDismiss?.let { CloseButton(it, Modifier.padding(end = 2.dp), contentDescription = "Dismiss") }
    }
}
/** [noticeStyle] on the designed parchment (cream face, kit ink): INFO a parchment-lip rule, WARN the gold lip, ERROR crimson. */
fun parchmentNoticeStyle(kind: NoticeKind): NoticeStyle {
    val k = gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens.Colors
    return when (kind) {
        NoticeKind.INFO -> NoticeStyle(k.cream, k.parchmentLo, k.textOnParch)
        NoticeKind.WARN -> NoticeStyle(k.cream, k.gold.lo, k.textOnParch)
        NoticeKind.ERROR -> NoticeStyle(k.cream, k.red.face, k.shortText)
    }
}
/** Existing call sites: `error` is a real failure; anything else is the quiet confirmation. */
@Composable fun Notice(message: String, error: Boolean = false, onDismiss: (() -> Unit)? = null) = Notice(message, if (error) NoticeKind.ERROR else NoticeKind.INFO, onDismiss)

@Composable fun InfoCard(title: String, value: String) {
    Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.titleSmall, color = Palette.gold); Text(value, style = MaterialTheme.typography.bodyMedium)
    } }
}

/** The shared "Interrupted request" line every money operation surfaces through. Owner 2026-10-06 (screenshot 1): the old
 * dark bar is gone; each saved request is a designed herald line (kit [gg.pixelkingdomwars.nativeclient.ui.kit.HeraldPlate],
 * hub SPEC §3.1) with its recovery actions over the SAME owner callbacks: RETRY CHECK ([onCheck], GET-only observation),
 * TRY AGAIN ([onRetry], only when the server replays the same key) and CLOSE ([onClose], only when closable). DISMISS only
 * folds the line into one pill: the saved request is untouched and one tap brings its actions back. A new [reveal] value
 * (Home's BUILD refused by this saved request, owner 2026-10-06) unfolds it again so its doors are in view. */
@Composable fun InterruptedBanner(items: List<InterruptedIntent>, busy: Boolean, onCheck: (String) -> Unit, onClose: (String) -> Unit, onRetry: (String) -> Unit,
    reveal: Int = 0) {
    items.forEach { item -> InterruptedHerald(item, busy, onCheck, onClose, onRetry, reveal) }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable private fun InterruptedHerald(item: InterruptedIntent, busy: Boolean, onCheck: (String) -> Unit, onClose: (String) -> Unit, onRetry: (String) -> Unit,
    reveal: Int) {
    var folded by rememberSaveable(item.intent.idempotencyKey) { mutableStateOf(false) }
    LaunchedEffect(reveal) { if (reveal > 0) folded = false }
    val title = "${Copy.INTERRUPTED_TITLE} · ${item.intent.label}"
    val outer = Modifier.padding(horizontal = 8.dp, vertical = 3.dp)
    if (folded) {
        Box(outer.heightIn(min = PkwTokens.Dims.minTap).sceneInputRegion()
            .clickable(onClickLabel = "Show recovery actions", role = Role.Button) { folded = false }, contentAlignment = Alignment.CenterStart) {
            VeilChip(title, icon = "ui:queue-status", contentDescription = "$title. Show its recovery actions")
        }
        return
    }
    // Owner field result 2026-10-06 (build 607a9c37): the CLOSE row WAS drawn but sat below the Home status column's height
    // cap (KingdomScreen `heightIn(max = chromeLimit).verticalScroll`), under two four-line sentences, so nobody could see
    // it. The server's answer now replaces the "interrupted" sentence (one short line, never an ellipsis) and the action rows
    // are scrolled into view whenever CLOSE appears or Home's BUILD reveals this line.
    val actionsLocation = remember { androidx.compose.foundation.relocation.BringIntoViewRequester() }
    LaunchedEffect(item.closable, reveal) { if (item.closable || reveal > 0) actionsLocation.bringIntoView() }
    val answer = Copy.observation(item.lastObservation)
    HeraldPlate(outer.semantics { liveRegion = LiveRegionMode.Polite }) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PkwIcon("ui:queue-status", 30.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                PkwText(title, PkwTokens.Type.body, color = PkwTokens.Colors.gold.hi, maxLines = HERALD_TEXT_MAX_LINES)
                PkwText(when {
                    item.proven -> "The server accepted this request. Refresh to apply it."
                    item.kept -> listOfNotNull(answer, KEPT_REQUEST_LINE).joinToString(" ")
                    answer != null -> answer
                    else -> Copy.interrupted(item.kind)
                }, PkwTokens.Type.small, color = if (answer != null && !item.proven) PkwTokens.Colors.muted else PkwTokens.Colors.text,
                    maxLines = HERALD_TEXT_MAX_LINES)
            }
            IconSquare("shape:close", Verb.STONE, { folded = true }, "Dismiss")
        }
        Column(Modifier.fillMaxWidth().bringIntoViewRequester(actionsLocation), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                SecondaryButton(if (item.proven) "REFRESH" else Copy.CHECK_STATUS.uppercase(), { onCheck(item.kind) }, Modifier.weight(1f),
                    verb = Verb.GOLD, enabled = !busy)
                if (item.retryable) SecondaryButton(Copy.RETRY_SAME.uppercase(), { onRetry(item.kind) }, Modifier.weight(1f), enabled = !busy)
            }
            // CLOSE has its own full-width row (owner 2026-10-06): a construction keeps RETRY CHECK and TRY AGAIN beside it, and
            // three PS captions in one 310 dp row would cut RETRY CHECK.
            if (item.closable) SecondaryButton(Copy.CLOSE_REQUEST.uppercase(), { onClose(item.kind) }, Modifier.fillMaxWidth(), enabled = !busy)
        }
    }
}

/** A request a newer order parked (owner review 2026-10-06, B1): kept, shown, never blocking, RETRY CHECK only. */
internal const val KEPT_REQUEST_LINE = "Kept on this device. It no longer blocks new orders."

/** Herald sentences wrap fully: no player-facing sentence ends in an ellipsis (owner field result 2026-10-06). */
internal const val HERALD_TEXT_MAX_LINES = 8

/** A once-per-second wall clock for timers; presentation only, the server still owns every job. */
@Composable fun displayClock(): Long {
    val owner = LocalLifecycleOwner.current
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(owner) { owner.lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { while (true) { now = System.currentTimeMillis(); delay(1_000) } } }
    return now
}
