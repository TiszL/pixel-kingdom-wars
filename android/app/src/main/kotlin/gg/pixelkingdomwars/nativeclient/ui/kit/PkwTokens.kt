package gg.pixelkingdomwars.nativeclient.ui.kit

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontSynthesis
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import gg.pixelkingdomwars.nativeclient.R
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/**
 * The design tokens of "Bright Command, forged" (`design/final/TOKENS.json`, DESIGN-SYSTEM §4) as Kotlin.
 *
 * Where a token equals an existing [Palette] colour it is that colour, not a second literal. Sizes are dp, type is sp,
 * durations are ms. Radii are always 0: corners are stepped pixel shapes ([PixelShapes]).
 */
object PkwTokens {

    /** One verb colour: the face, its 3 dp highlight band, the face below 55 % ([mid]) and the 5-6 dp lip ([lo]). */
    data class Ramp(val face: Color, val hi: Color, val lo: Color, val mid: Color)

    /** TOKENS.json `color`. */
    object Colors {
        /** Every outline (2-3 dp), text stroke, badge rim, plate shell. Not [Palette.ink] (#1A171E): the design's ink is darker. */
        val ink = Color(0xFF140F17)
        val bg = Palette.backdrop
        val surface = Palette.surface
        val card = Palette.card
        val charcoal = Palette.stone
        /** HUD chip fill over the world (flat, opaque). */
        val veil = Color(0xFF221D27)
        /** Colour pass 2026-10-02: lifted from #3A3340 so the band reads on the dark realms. */
        val veilHi = Color(0xFF4A4152)
        val border = Palette.border
        val borderLt = Palette.borderLt
        val text = Palette.text
        val muted = Palette.muted
        val faint = Palette.textFaint
        /** Outlined labels on chunky faces (`.ol` in the mockups). */
        val label = Color(0xFFFFFFFF)

        /** Colour pass 2026-10-02 (DESIGN-SYSTEM "Colour pass"): the face is the owner's gold ([Palette.gold]); the
         *  highlight is brighter and the lip deeper than [Palette.goldHi] / [Palette.goldDp], so those are literals now. */
        val gold = Ramp(Palette.gold, Color(0xFFFFE38A), Color(0xFF8F5A12), Color(0xFFD3962A))
        /** Brighter, further from grass and from the Gems teal. */
        val green = Ramp(Color(0xFF45B23E), Color(0xFFA6EA7E), Color(0xFF22701E), Color(0xFF3A9E35))
        /** Royal, not teal: parts from every realm sea. */
        val blue = Ramp(Color(0xFF3A74DA), Color(0xFF95C3FF), Color(0xFF1A3F8A), Color(0xFF2E62C4))
        /** Crimson, not orange: parts from Cinderfall lava. Never text on light (use [shortText]). */
        val red = Ramp(Color(0xFFD23A3A), Color(0xFFFF8C7A), Color(0xFF771821), Color(0xFFBA2E32))
        /** Warm fieldstone (rhymes with the five-tier walls). Unoutlined sentences on it are pure white (4.7:1). */
        val stone = Ramp(Color(0xFF7E7266), Color(0xFFB3A797), Color(0xFF463D34), Color(0xFF716659))
        /** Disabled face and icon only, never text. TOKENS has no mid for off: the face continues (`.btn.off`). */
        val off = Ramp(Color(0xFFA3A09A), Color(0xFFC6C3BC), Color(0xFF6E6B66), Color(0xFFA3A09A))
        /** Mid from common.css `.btn.moss`. */
        val moss = Ramp(Color(0xFF5D8A3C), Color(0xFF9CC47A), Color(0xFF34501F), Color(0xFF52793A))
        /** `.btn.char` in common.css (TOKENS lists the face only). */
        val charcoalRamp = Ramp(Palette.stone, Color(0xFF4A4552), Color(0xFF151218), Color(0xFF232028))

        val parchment = Color(0xFFF4E3BC)
        val parchmentHi = Color(0xFFFFF8E6)
        val parchmentLo = Color(0xFFC9A86A)
        val cream = Color(0xFFFCF3DC)
        val creamLo = Color(0xFFE8D3A0)
        val wood = Color(0xFF7A4526)
        val woodHi = Color(0xFFA5663A)
        val woodLo = Color(0xFF431F0E)
        val woodSeam = Color(0xFF6A3B1F)
        val textOnParch = Color(0xFF3B2614)
        /** Secondary text on parchment / cream, and the locked / disabled REASON line on light (5.8:1). */
        val textOnParch2 = Color(0xFF6E5034)
        /** Reason lines and short text on DARK plates only (6.4:1 on surface). Colour pass: was [Palette.danger]
         *  (#C75A2E, 4.2:1). On parchment use [textOnParch2] for a reason and [shortText] for a refusal. */
        val danger = Color(0xFFEE7A50)
        val blood = Palette.blood
        val shortPill = Color(0xFFFFD9CC)
        val shortText = Color(0xFFA3261A)
        val selectedTint = Color(0xFFFFF3C8)
        /** Charcoal plate recipe (DESIGN-SYSTEM §5). */
        val plateBand = Color(0xFF2C2832)
        val plateLip = Color(0xFF0F0D12)
        /** Meter track (DESIGN-SYSTEM §6 ProgressBar). */
        val track = Color(0xFF3A2F28)

        val shards = Color(0xFFE8A530)
        val gems = Color(0xFF2FB879)
        val keep = Palette.gold
        val skr = Color(0xFFC9F29A)
        val divine = Color(0xFFECE1F6)

        /** Every scrim is this ink at a token alpha ([Scrim]). */
        val scrim = Color(0xFF0E0914)
    }

    /** The ramp of a [Verb]. */
    fun ramp(verb: Verb): Ramp = when (verb) {
        Verb.GOLD -> Colors.gold
        Verb.GREEN -> Colors.green
        Verb.BLUE -> Colors.blue
        Verb.RED -> Colors.red
        Verb.STONE -> Colors.stone
        Verb.CHARCOAL -> Colors.charcoalRamp
        Verb.OFF -> Colors.off
        Verb.MOSS -> Colors.moss
    }

    /** TOKENS.json `color.scrim` alphas. */
    object Scrim {
        const val SHEET_HALF = 0f
        const val SHEET_TALL = 0.40f
        const val FULL_CARD = 0.60f
        const val COMMAND_SHELF = 0.36f
        const val SEAL = 0.55f
    }

    /**
     * TOKENS.json `type`. The design's display face is Press Start 2P; it is not in the APK yet (DESIGN-SYSTEM §11 risk 2:
     * it needs a docs/DECISIONS.md entry, and only a WOFF2 copy carries its licence on this Mac, which Android cannot load).
     * Until then [DISPLAY_FACE_BUNDLED] is false and the display tokens use VT323 at the larger fallback sizes the design
     * names ("VT323 at 22 sp for numerals"), all above the 18 sp VT323 floor. Bundling the face is this one switch plus
     * [displayFamily].
     */
    object Type {
        const val DISPLAY_FACE_BUNDLED = false
        val bodyFamily: FontFamily = FontFamily(Font(R.font.pkw_vt323, FontWeight.Normal))
        val displayFamily: FontFamily = bodyFamily

        /** Press Start 2P sizes (sp) from TOKENS.json, kept for the swap. */
        const val PS_NUMERAL_L = 16
        const val PS_PRIMARY = 14
        const val PS_TITLE = 13
        const val PS_LABEL = 12
        const val PS_CAPTION = 11
        /** The VT323 floor (sp). Nothing in the kit draws text below it. */
        const val VT_FLOOR = 18

        private fun style(family: FontFamily, size: Int) = TextStyle(fontFamily = family, fontWeight = FontWeight.Normal,
            fontSynthesis = FontSynthesis.None, fontSize = size.sp, lineHeight = (size + 2).sp, letterSpacing = 0.sp)
        private fun display(ps: Int, fallback: Int) = style(displayFamily, if (DISPLAY_FACE_BUNDLED) ps else fallback)

        /** Celebration numbers, level badge. */
        val numeralL: TextStyle = display(PS_NUMERAL_L, 30)
        /** Primary button label. */
        val primary: TextStyle = display(PS_PRIMARY, 26)
        /** Sheet / plate title. */
        val title: TextStyle = display(PS_TITLE, 24)
        /** Resource values, button labels, tab labels. */
        val label: TextStyle = display(PS_LABEL, 22)
        /** The display floor: deck / command captions, badges, tags, cost pills. */
        val caption: TextStyle = display(PS_CAPTION, 20)
        /** Dialog lead line. */
        val lead: TextStyle = style(bodyFamily, 24)
        /** Status lines, sentences. */
        val body: TextStyle = style(bodyFamily, 20)
        /** The body floor: captions, sub-lines. */
        val small: TextStyle = style(bodyFamily, VT_FLOOR)
    }

    /** TOKENS.json `space`: a 2 dp unit. */
    object Space {
        val s2 = 2.dp; val s4 = 4.dp; val s6 = 6.dp; val s8 = 8.dp; val s12 = 12.dp; val s16 = 16.dp; val s24 = 24.dp; val s32 = 32.dp
        val screenGutter = 8.dp
        val sheetGutter = 8.dp
    }

    /** TOKENS.json `shape` and `size`, in dp. */
    object Dims {
        val minTap = 48.dp
        val outlineChip = 2.dp; val outlineButton = 3.dp; val outlinePlate = 3.dp; val outlineCard = 2.dp
        val lipButton = 6.dp; val lipButtonPressed = 3.dp; val lipPlate = 4.dp; val highlightBand = 3.dp
        /** The face moves down by this much when pressed (lip 6 → 3). */
        val pressTravel = 3.dp

        val levelBadge = 40.dp
        val statusChipW = 238.dp; val statusChipH = 30.dp
        val resourceRowW = 108.dp; val resourceRowH = 26.dp; val resourceGap = 2.dp
        val deckAttackW = 80.dp; val deckAttackH = 72.dp; val deckSmall = 52.dp; val deckBuild = 72.dp; val deckBottomInset = 14.dp
        val edgeButton = 48.dp; val edgeTabW = 44.dp; val edgeTabH = 48.dp
        val contextChipW = 108.dp; val contextChipH = 48.dp
        val command = 68.dp; val commandPrimaryW = 120.dp; val commandPrimaryH = 92.dp
        val costPillH = 26.dp; val costPillIcon = 24.dp
        /** The cost pill's offset above its command (DESIGN-SYSTEM §6 CommandButton). */
        val costPillAbove = 30.dp
        val namePlateH = 58.dp; val namePlateMinW = 160.dp; val namePlateMaxW = 280.dp
        val badgeH = 24.dp; val badgeMinW = 24.dp
        val worldBubble = 48.dp; val timerPlateW = 114.dp; val timerPlateH = 34.dp
        val sheetPrimaryH = 60.dp; val secondaryH = 52.dp; val tabH = 48.dp
        val sheetHeaderH = 136.dp
        /** A tall sheet's top edge on the 412 × 915 phone (DESIGN-SYSTEM §6 Sheet). */
        val tallSheetTop = 104.dp
        /** A FULL sheet's top edge (design ruling 092decf3 item 3; hub/SPEC.md:46). */
        val fullSheetTop = SheetGeometry.FULL_TOP_DP.dp
        /** A FULL sheet's bottom gap above the gesture inset (the host adds the inset itself). */
        val fullSheetBottom = SheetGeometry.FULL_BOTTOM_DP.dp
        /** The Gold Forge hero header (goldforge/SPEC.md); [sheetHeaderH] stays the default living header. */
        val goldForgeHeaderH = 204.dp
        /** The troop card's take-back button "− 1" under a chosen card (TOKENS.json `size.troopCardMinus`, critic §3). */
        val troopCardMinusW = 89.dp; val troopCardMinusH = 48.dp
        val troopCardW = 89.dp; val troopCardH = 128.dp
        val itemTileW = 72.dp; val itemTileH = 80.dp; val drawerTileW = 48.dp; val drawerTileH = 56.dp
        val ingredientRowH = 52.dp
        val toastH = 58.dp; val bannerH = 44.dp
        val timerChipH = 30.dp
        val progressBarH = 12.dp; val progressRing = 48.dp
        val sealBackW = 100.dp
    }

    /** The home HUD budget (TOKENS.json `budget`). */
    object Budget {
        const val HOME_PERMANENT_HUD_MAX_PCT = 12f
        const val MAX_WORLD_MARKERS = 3
        const val MAX_EDGE_BUTTONS = 2
        const val MAX_RESOURCE_ROWS = 4
        const val MAX_TOASTS = 3
        const val MAX_COMMANDS = 5
        /** Design correction 7 / design ruling 5ed31eb8: the PORTRAIT bar holds at most four commands (INFO, up to two
         *  secondaries, the primary); a fifth action lives inside the INFO sheet. [MAX_COMMANDS] stays for landscape. */
        const val MAX_COMMANDS_PORTRAIT = 4
    }

    /**
     * Z-order of the layers over the base scene (UX-ARCHITECTURE §7.4 mount order), for `Modifier.zIndex` inside one
     * parent. The scene itself is a lower sibling of the navigation host and is not in this list.
     */
    object Z {
        const val WORLD_MARKERS = 1f
        const val HUD = 2f
        const val COMMAND_BAR = 3f
        const val SHEET = 4f
        const val DRAWER = 5f
        const val HERALD = 6f
        const val TOAST = 7f
        const val SEAL = 8f
        /** The resource stack when the host lifts it above the sheet and Seal scrims (design ruling 092decf3 item 4):
         *  readable over consent, never tappable while a Seal shows (`ResourceStack(enabled = false)`). */
        const val RESOURCE_STACK = 8.5f
        const val CELEBRATION = 9f
    }

    /** TOKENS.json `motion`: durations in ms and the four easings. */
    object Motion {
        val Out: Easing = CubicBezierEasing(0.2f, 0f, 0f, 1f)
        val In: Easing = CubicBezierEasing(0.4f, 0f, 1f, 1f)
        val Pop: Easing = CubicBezierEasing(0.34f, 1.56f, 0.64f, 1f)
        val Linear: Easing = LinearEasing

        const val PRESS = 60
        const val RELEASE = 90
        const val SELECT = 140
        const val PLATE_IN = 160
        const val COMMAND_STAGGER = 30
        const val DECK_SWAP = 160
        const val SHEET_IN = 220
        const val SHEET_OUT = 160
        /** Half sheet (DESIGN-SYSTEM §7; not in TOKENS.json). */
        const val HALF_SHEET_IN = 180
        const val HALF_SHEET_OUT = 140
        const val DRAWER_IN = 200
        const val DRAWER_OUT = 140
        const val DRAWER_ROW_STAGGER = 20
        const val TAB_SWITCH = 120
        const val BADGE_POP = 180
        const val BADGE_OUT = 120
        const val TOAST_IN = 160
        const val TOAST_OUT = 160
        const val TOAST_HOLD = 4000
        const val BANNER_HOLD = 4000
        const val SEAL_IN = 160
        const val SEAL_OUT = 120
        const val SEAL_ARM = 450
        const val TAP_THROUGH_LOCK = 300
        const val COUNT_UP = 600
        const val COIN_FLY = 450
        const val GAIN_RISE = 450
        const val CELEBRATE = 900
        const val RIBBON_DROP = 160
        const val PAINT_TILE = 60
        const val SNAP_HINT = 120
        const val INVALID_SHAKE = 160
        const val EDITOR_ENTER = 220
        const val ISLAND_ZOOM = 280
        const val READY_BOUNCE_LOOP = 900
        const val READY_BOUNCE_PAUSE = 2000
        /** Reduced motion: every change cross-fades in this, no loops, no fly-ins. */
        const val REDUCED_CROSSFADE = 120
        /** Celebration rays turn this many degrees per second. */
        const val RAYS_DEG_PER_S = 8f
        /** How far a gain delta rises (dp). */
        const val GAIN_RISE_DP = 12f
        /** How far a toast or banner slides in (dp). */
        const val TOAST_SLIDE_DP = 12f
    }
}
