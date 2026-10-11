package gg.pixelkingdomwars.nativeclient.ui.sheets.map.live

import gg.pixelkingdomwars.nativeclient.data.WorldParcelFailure
import gg.pixelkingdomwars.nativeclient.data.WorldParcelFailureKind
import gg.pixelkingdomwars.nativeclient.json
import gg.pixelkingdomwars.nativeclient.model.FantasyGlobe
import gg.pixelkingdomwars.nativeclient.model.FantasyGlobeMe
import gg.pixelkingdomwars.nativeclient.model.FantasyOwnedTile
import gg.pixelkingdomwars.nativeclient.model.FantasyParcel
import gg.pixelkingdomwars.nativeclient.model.FantasyTile
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.KingdomPanelUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.KingdomSheetKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.MapTagUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.kingdomCommandTap
import gg.pixelkingdomwars.nativeclient.ui.world.RealmHudBase
import gg.pixelkingdomwars.nativeclient.ui.world.WorldUiState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * map-base (SPEC §2.3): the designed kingdom sheet replaces the old dark base card over the SAME parcel read. This sheet
 * is where a player decides to raid someone, so every command and tag must be the server's word: ATTACK and SCOUT exactly
 * as `actions.*.allowed` say, a refusal in the server's words, "NO SHIELD" only when the read says the shield is off, no
 * energy price the read never sent, and no raid ever offered on your own deed. Each case would fail if that rule moved.
 */
class KingdomPanelMapperTest {
    private val tile = 1450 // catalog column 10, row 2 on the 720 x 360 grid
    private val cols = 720
    private val rows = 360
    private val shielded = """{"active":true,"suppressedByWarzone":false,"expiresAt":"2026-10-05T15:00:00.000Z","remainingMs":10800000}"""

    private fun detail(attack: String = """{"allowed":true}""", scout: String = """{"allowed":true}""",
        shield: String? = """{"active":false,"suppressedByWarzone":false}""",
        player: String = """{"wallet":"W1","name":"Kaly","keepLevel":8,"trophies":1412,"clanTag":"EMB"}"""): String =
        "{\"player\":$player," + (shield?.let { "\"shield\":$it," } ?: "") + "\"actions\":{\"scout\":$scout,\"attack\":$attack}}"

    private fun parcel(availability: String, detail: String? = null, allocation: String? = null) =
        FantasyParcel("fantasy-v1", FantasyTile(tileId = tile, realmId = "frostveil", allocation = allocation), availability, detail?.let(::json))

    private fun state(selected: FantasyParcel? = null, failure: WorldParcelFailure? = null, owned: FantasyOwnedTile? = null) = WorldUiState(
        globe = owned?.let { FantasyGlobe("fantasy-v1", me = FantasyGlobeMe(ownedTiles = listOf(it))) },
        selected = selected, selectedTileId = tile, parcelFailure = failure)

    private fun map(state: WorldUiState, busy: Boolean = false, now: Long = 0L, choose: Boolean = false, silhouette: RealmHudBase? = null): KingdomPanelUi =
        requireNotNull(kingdomPanelUi(state, cols, rows, "Frostveil", silhouette, busy, { "portrait-$it" }, { 3 }, now, choose))

    private fun mine(active: Boolean) = FantasyOwnedTile(baseId = "my-base", tileId = tile, realmId = "frostveil", name = "Home", keepLevel = 5, active = active)

    private fun texts(ui: KingdomPanelUi) = ui.tags.map(MapTagUi::text)

    /** The frame's whole point: the server says this kingdom may be raided, so SCOUT (blue, navigation) and the red ATTACK
     *  primary both work, and the ATTACK door is the existing raid entry. */
    @Test fun `a rival the server lets you raid gets a blue SCOUT and the red ATTACK primary, both enabled`() {
        val ui = map(state(parcel("occupied", detail())))
        assertEquals(KingdomSheetKind.RIVAL, ui.kind)
        val attack = requireNotNull(ui.attack); val scout = requireNotNull(ui.scout)
        assertEquals("ATTACK", attack.caption); assertEquals(CommandState.ENABLED, attack.state)
        assertEquals(Verb.RED, attack.verb); assertTrue("ATTACK is the sheet's one primary", attack.primary)
        assertEquals("raid this kingdom", attack.sub)
        assertEquals("SCOUT", scout.caption); assertEquals(CommandState.ENABLED, scout.state)
        assertEquals(Verb.BLUE, scout.verb); assertFalse(scout.primary)
        assertEquals(KingdomDoor.ATTACK, KingdomDoor.of(attack)); assertEquals(KingdomDoor.SCOUT, KingdomDoor.of(scout))
        assertEquals("Kaly", ui.title); assertEquals("LV 8", ui.level); assertEquals("portrait-8", ui.portrait)
        assertNull("a rival has no land or home primary", ui.primary)
        assertTrue("the owner-approved attack tag still shows when the server allows the raid", "YOU CAN ATTACK" in texts(ui))
    }

    /** A shielded kingdom cannot be raided, and the player must be told why; looking at it is still allowed. */
    @Test fun `a shielded rival has ATTACK off with Shield active while SCOUT stays enabled`() {
        val ui = map(state(parcel("occupied", detail(attack = """{"allowed":false,"blockedBy":"shielded"}""", shield = shielded))))
        val attack = requireNotNull(ui.attack)
        assertEquals(CommandState.DISABLED, attack.state)
        assertEquals("Shield active", attack.reason)
        assertEquals(CommandState.ENABLED, requireNotNull(ui.scout).state)
        assertFalse("a refused raid is not advertised", "YOU CAN ATTACK" in texts(ui))
        assertFalse("NO SHIELD" in texts(ui))
    }

    /** The shield time is the read's own remainingMs, counted down on the host's clock, never a device-calendar guess. */
    @Test fun `the shield tag counts down from the read's remainingMs on the host clock`() {
        val at = state(parcel("occupied", detail(attack = """{"allowed":false,"blockedBy":"shielded"}""", shield = shielded)))
        assertTrue(MapTagUi("SHIELD 3H 0M", Verb.STONE) in map(at, now = 0L).tags)
        val hourLater = 3_600L * 1_000_000_000L
        assertTrue(MapTagUi("SHIELD 2H 0M", Verb.STONE) in map(at, now = hourLater).tags)
    }

    /** A player must never be offered a raid on themself: their own deed is GO HOME only, even when a read carries actions. */
    @Test fun `your own deed shows only GO HOME, never SCOUT or ATTACK`() {
        val ui = map(state(parcel("occupied", detail()), owned = mine(active = true)))
        assertEquals(KingdomSheetKind.OWN, ui.kind)
        assertNull(ui.scout); assertNull(ui.attack)
        val home = requireNotNull(ui.primary)
        assertEquals("GO HOME", home.caption); assertEquals(Verb.BLUE, home.verb)
        assertEquals(KingdomDoor.GO_HOME, KingdomDoor.of(home))
        assertNull("the own sheet is header + GO HOME only", ui.secondary)
        assertTrue(ui.tags.isEmpty() && ui.facts.isEmpty() && !ui.info)
    }

    /** An inactive deed has no base to open, so the door goes to Your Bases; and the own sheet needs no parcel read. */
    @Test fun `an inactive own deed offers MANAGE DEED, and your deed is yours before its read lands`() {
        val inactive = map(state(parcel("occupied", detail()), owned = mine(active = false)))
        assertEquals("MANAGE DEED", inactive.primary?.caption)
        assertEquals(KingdomDoor.MANAGE_DEED, KingdomDoor.of(inactive.primary))
        val early = map(state(owned = mine(active = true)))
        assertEquals(KingdomSheetKind.OWN, early.kind); assertEquals("Home", early.title); assertEquals("LV 5", early.level)
        assertNull(early.attack)
    }

    /** Open land is bought through the existing land gate draft, not raided. */
    @Test fun `an open parcel offers CHOOSE THIS LAND through the existing draft`() {
        val ui = map(state(parcel("available")))
        assertEquals(KingdomSheetKind.OPEN_LAND, ui.kind)
        assertEquals("CHOOSE THIS LAND", ui.primary?.caption)
        assertEquals(KingdomDoor.CHOOSE_THIS_LAND, KingdomDoor.of(ui.primary))
        assertNull(ui.scout); assertNull(ui.attack)
        assertEquals(listOf("Realm", "Parcel", "Location"), ui.facts.map { it.first })
        assertEquals("10, 2", ui.facts.first { it.first == "Parcel" }.second)
    }

    /** Held or reserved land has no purchase door; a deed whose re-read failed offers RETRY so the player is never stuck. */
    @Test fun `held and reserved land explain themselves, and a failed re-read there offers RETRY`() {
        val held = map(state(parcel("held")))
        assertEquals(KingdomSheetKind.CLOSED_LAND, held.kind); assertNull(held.primary)
        assertEquals("Another checkout currently holds this parcel.", held.note)
        val reserved = map(state(parcel("reserved", allocation = "seeker")))
        assertTrue(requireNotNull(reserved.note).startsWith("SEEKER reserve"))
        val failed = map(state(parcel("held"), WorldParcelFailure(tile, WorldParcelFailureKind.OTHER, "Server said no", "500")))
        assertEquals(KingdomDoor.RETRY, KingdomDoor.of(failed.primary)); assertEquals("Server said no", failed.note)
    }

    /** A deedless player is refused occupied bases (402/403): the sheet must send them to the land gate, not leave a dead end. */
    @Test fun `a land-gate refusal offers CHOOSE LAND, and choose mode offers the next open deed instead`() {
        val gate = WorldParcelFailure(tile, WorldParcelFailureKind.LAND_GATE, WorldParcelFailure.LAND_GATE_TEXT, "402")
        val ui = map(state(failure = gate))
        assertEquals(KingdomSheetKind.FAILED, ui.kind)
        assertEquals("CHOOSE LAND", ui.primary?.caption); assertEquals(KingdomDoor.CHOOSE_LAND, KingdomDoor.of(ui.primary))
        assertEquals(WorldParcelFailure.LAND_GATE_TEXT, ui.note)
        val choosing = map(state(failure = gate), choose = true)
        assertNull("the chooser is already in the land flow", choosing.primary)
        assertEquals(KingdomDoor.NEXT_OPEN_DEED, KingdomDoor.of(choosing.secondary))
    }

    /** Any other refusal (429 budget, server error) can be retried; the sheet says the server's words. */
    @Test fun `any other refusal offers RETRY with the server's words`() {
        for (kind in listOf(WorldParcelFailureKind.BUSY, WorldParcelFailureKind.OTHER)) {
            val ui = map(state(failure = WorldParcelFailure(tile, kind, "Details are busy", "429")))
            assertEquals(KingdomSheetKind.FAILED, ui.kind)
            assertEquals("RETRY", ui.primary?.caption); assertEquals(KingdomDoor.RETRY, KingdomDoor.of(ui.primary))
            assertEquals("Details are busy", ui.note)
        }
        val elsewhere = map(state(failure = WorldParcelFailure(tile + 1, WorldParcelFailureKind.OTHER, "x", "x")))
        assertEquals("another deed's refusal is not this one's", KingdomSheetKind.LOADING, elsewhere.kind)
    }

    /** "NO SHIELD" invites a raid, so it must never be inferred from a read that did not say the shield is off. */
    @Test fun `no shield object or flag means no NO SHIELD tag, only an explicit false does`() {
        assertFalse(texts(map(state(parcel("occupied", detail(shield = null))))).any { "SHIELD" in it })
        assertFalse("NO SHIELD" in texts(map(state(parcel("occupied", detail(shield = """{"suppressedByWarzone":false}"""))))))
        assertTrue(MapTagUi("NO SHIELD", Verb.RED) in map(state(parcel("occupied", detail()))).tags)
    }

    /** In a warzone the shield is switched off by the war, not absent: the tag says so, never NO SHIELD. */
    @Test fun `a warzone-suppressed shield is tagged SHIELD SUPPRESSED`() {
        val ui = map(state(parcel("occupied", detail(shield = """{"active":false,"suppressedByWarzone":true}"""))))
        assertTrue(MapTagUi("SHIELD SUPPRESSED", Verb.RED) in ui.tags)
        assertFalse("NO SHIELD" in texts(ui))
        assertTrue("FROSTVEIL" in texts(ui))
    }

    /** While an action runs nothing may be sent twice: both commands draw BUSY and a tap on them does nothing. */
    @Test fun `busy draws both commands BUSY and their taps do nothing`() {
        val ui = map(state(parcel("occupied", detail(attack = """{"allowed":false,"blockedBy":"shielded"}"""))), busy = true)
        val scout = requireNotNull(ui.scout); val attack = requireNotNull(ui.attack)
        assertEquals(CommandState.BUSY, scout.state); assertEquals(CommandState.BUSY, attack.state)
        var acted = 0; var explained = 0
        kingdomCommandTap(attack, { acted++ }, { explained++ })
        kingdomCommandTap(scout, { acted++ }, { explained++ })
        assertEquals(0, acted); assertEquals(0, explained)
    }

    /** A door never does nothing: an enabled tap acts, a refused tap says the server's reason (never silent). */
    @Test fun `a refused tap explains its reason and an enabled tap acts`() {
        val ui = map(state(parcel("occupied", detail(attack = """{"allowed":false,"blockedBy":"keep_too_far_below","keepReach":{"defenderKeep":3,"attackerKeep":12}}"""))))
        val attack = requireNotNull(ui.attack)
        assertEquals("Their Keep is too far below yours (L3 vs your L12)", attack.reason)
        var acted = false; var said: String? = null
        kingdomCommandTap(attack, { acted = true }, { said = it })
        assertFalse(acted); assertEquals(attack.reason, said)
        kingdomCommandTap(requireNotNull(ui.scout), { acted = true }, { said = "wrong" })
        assertTrue(acted)
        val unknown = requireNotNull(map(state(parcel("occupied", detail(attack = """{"allowed":false}""")))).attack)
        assertEquals("a refusal without a reason still says something", "Temporarily unavailable", unknown.reason)
    }

    /** The read carries no energy field, so the sheet must not invent the mock's "1 of 3" cost. */
    @Test fun `ATTACK and SCOUT carry no price`() {
        val ui = map(state(parcel("occupied", detail())))
        assertNull(requireNotNull(ui.attack).price); assertNull(requireNotNull(ui.scout).price)
    }

    /** Trophies, clan and the Claim fact come from the read and the catalogue; a read without them shows none. */
    @Test fun `facts behind INFO come only from the read and the catalogue`() {
        val full = map(state(parcel("occupied", detail())))
        assertTrue(full.info)
        assertEquals(listOf("Trophies", "Clan", "Claim", "Location"), full.facts.map { it.first })
        assertEquals("1,412", full.facts.first { it.first == "Trophies" }.second)
        val bare = map(state(parcel("occupied", detail(player = """{"wallet":"W1","name":"Kaly","keepLevel":8}"""))))
        assertEquals("no league, trophies or clan is faked", listOf("Claim", "Location"), bare.facts.map { it.first })
    }

    /** Raids are instant (owner rule): no sheet copy may say a raid travels, marches or arrives. */
    @Test fun `no sheet copy implies travel, marching or arrival`() {
        val gate = WorldParcelFailure(tile, WorldParcelFailureKind.LAND_GATE, WorldParcelFailure.LAND_GATE_TEXT, "402")
        val sheets = listOf(map(state(parcel("occupied", detail()))), map(state(parcel("occupied", detail(shield = shielded)))),
            map(state(parcel("occupied", detail())), choose = true), map(state(parcel("available"))), map(state(parcel("held"))),
            map(state(parcel("reserved", allocation = "seeker"))), map(state(failure = gate)), map(state()),
            map(state(owned = mine(active = true))), map(state(owned = mine(active = false))))
        val copy = sheets.flatMap { ui ->
            listOfNotNull(ui.title, ui.note) + texts(ui) + listOfNotNull(ui.scout, ui.attack, ui.primary, ui.secondary)
                .flatMap { listOfNotNull(it.caption, it.sub, it.reason) }
        } + lookCloserCommand(true).caption + lookCloserCommand(false).caption
        val travel = Regex("""\b(travel\w*|march\w*|arriv\w*|en route|on the way|minutes? away|\d+\s*m away)\b""", RegexOption.IGNORE_CASE)
        assertTrue("copy was collected (${copy.size} strings)", copy.size > 20)
        assertEquals(emptyList<String>(), copy.filter { travel.containsMatchIn(it) })
    }

    /** While the read runs the map's own silhouette names the kingdom; nothing can be raided before the server answers. */
    @Test fun `a loading read shows the silhouette name and level with no commands`() {
        val ui = map(state(), silhouette = RealmHudBase(tile, 10, 2, "Kaly", 8, mine = false))
        assertEquals(KingdomSheetKind.LOADING, ui.kind)
        assertEquals("Kaly", ui.title); assertEquals("LV 8", ui.level); assertEquals("portrait-8", ui.portrait)
        assertNull(ui.scout); assertNull(ui.attack); assertNull(ui.primary)
        assertNull("nothing selected draws nothing", kingdomPanelUi(WorldUiState(), cols, rows, null, null, false, { "p" }, { null }, 0L, false))
    }

    /** A routine re-read must not blank the kingdom the player was reading: it stays, its commands BUSY until the read lands. */
    @Test fun `a re-read of the same deed keeps the shown kingdom with its commands BUSY`() {
        val shown = map(state(parcel("occupied", detail())))
        val reading = map(state())
        val kept = keptKingdomPanel(reading, shown)
        assertEquals(KingdomSheetKind.RIVAL, kept.kind); assertEquals("Kaly", kept.title); assertEquals(shown.tags, kept.tags)
        assertEquals(CommandState.BUSY, kept.attack?.state); assertEquals(CommandState.BUSY, kept.scout?.state)
        assertEquals("another deed never borrows this one", reading, keptKingdomPanel(reading, shown.copy(tileId = tile + 1)))
        val refused = map(state(failure = WorldParcelFailure(tile, WorldParcelFailureKind.OTHER, "No", "No")))
        assertEquals("a refusal is real news and shows", refused, keptKingdomPanel(refused, shown))
        assertEquals(reading, keptKingdomPanel(reading, map(state(parcel("held")))))
        assertEquals("nothing shown before, nothing kept", reading, keptKingdomPanel(reading, null))
    }
}
