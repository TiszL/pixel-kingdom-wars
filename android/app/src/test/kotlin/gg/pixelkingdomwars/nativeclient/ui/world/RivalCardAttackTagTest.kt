package gg.pixelkingdomwars.nativeclient.ui.world

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Owner 2026-09-26, on the Seeker: a rival kingdom's card said "In range", which made no sense, because "you can attack
 * anyone despite their location if not shielded ... or change of wording 'you can attack'". The server agrees: raid
 * permission is base exists, not shielded, no warzone suppression, same land tier, and the D-099 Keep asymmetry
 * (`keep_too_far_below`). There is no distance or location rule anywhere. So the tag stays, painted from the same
 * `actions.attack.allowed`, but it says "You can attack"; no world, realm or globe copy may suggest that where a kingdom
 * sits decides whether you can raid it; and a refused rival keeps the server's reason in words instead of a tag.
 *
 * `ParcelCardBody` is a Composable and this module has no JVM Compose runner, so the tag's decision is the pure
 * [rivalAttackTag], and the card's wiring is read at source level like [WorldLegacyGlobeTest], comments stripped first
 * so a note explaining the rule can neither satisfy nor break it.
 */
class RivalCardAttackTagTest {
    private fun strip(src: String) = src.replace(Regex("""/\*[\s\S]*?\*/"""), "").replace(Regex("""(?m)(^|\s)//.*$"""), "$1")
    private fun literals(code: String) = Regex("\"(?:[^\"\\\\\\n]|\\\\.)*\"").findAll(code).map { it.value }.toList()
    private val worldDir = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/world")
    private val card = strip(File(worldDir, "ParcelCard.kt").readText())

    private fun attack(allowed: Boolean, blockedBy: String? = null) = buildJsonObject {
        put("allowed", allowed); if (blockedBy != null) put("blockedBy", blockedBy)
    }

    @Test fun `a rival the server lets you raid is tagged You can attack`() {
        assertEquals("You can attack", rivalAttackTag(own = false, attack = attack(true)))
    }

    @Test fun `the card draws that tag, in the red attack tone, from the server's attack permission`() {
        assertTrue("the rival card still renders the attack tag (removing it hides that a kingdom can be raided)",
            "rivalAttackTag(own != null, attack)?.let { HudTag(it, HudTagTone.RED) }" in card)
        assertTrue("and the tag's input is the server's actions.attack",
            "val scout = actions?.get(\"scout\") as? JsonObject; val attack = actions?.get(\"attack\") as? JsonObject" in card)
    }

    /**
     * The owner asked for the "change of wording 'you can attack'", and the tag matters most in a warzone: it switches an
     * ordinary shield off, so the server sends `shield.suppressedByWarzone` AND `attack.allowed`, and the card shows
     * "Shield suppressed" beside "You can attack". Each tag is one line that ends in an ellipsis (HudText maxLines 1),
     * so in a plain Row the second one read "YOU CA…" on the owner's Seeker in landscape. The row must wrap.
     */
    @Test fun `in a warzone the attack tag wraps whole beside Shield suppressed instead of being cut`() {
        val cap = HudType.of(density = 2.625f, landscape = true, heightDp = 411f).cap // the Seeker in landscape: a short one
        fun tag(text: String) = HudType.textWidth(text.length, cap, letterSpacing = 1f) + 6 + 6 // HudTag: 1 dp spacing, 6 dp sides
        // the tag column in the short landscape card: CARD_W, less the close gutter (40), the body padding (16 + 16),
        // the 40 dp avatar and the 12 dp between them
        val column = RealmHudPlan.CARD_W - 40 - 32 - 40 - 12
        val both = tag("Shield suppressed") + 4 + tag("You can attack")
        assertTrue("both tags ($both dp) do not fit one line of $column dp: a Row cuts the attack tag", both > column)
        assertTrue("each fits a line of its own, so wrapping shows it whole", tag("Shield suppressed") <= column && tag("You can attack") <= column)
        // a 360 dp portrait phone: the full-width card, a 56 dp avatar
        val portrait = 360f - 40 - 32 - 56 - 12
        assertTrue("a narrow portrait phone cuts it too ($both > $portrait)", both > portrait)

        val row = "FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {"
        val start = card.indexOf(row)
        assertTrue("the card's tag row wraps (a FlowRow)", start >= 0)
        val tags = card.substring(start, card.indexOf("rivalAttackTag(own != null, attack)?.let { HudTag(it, HudTagTone.RED) }", start))
        assertTrue("the shield tags and the attack tag are in that one wrapping row",
            "HudTag(\"Shield suppressed\", HudTagTone.RED)" in tags && "Row(" !in tags.removePrefix("FlowRow("))
    }

    @Test fun `a blocked rival, your own base and a missing permission show no attack tag`() {
        assertNull("a refused raid is not advertised", rivalAttackTag(own = false, attack = attack(false, "keep_too_far_below")))
        assertNull("a shielded rival is not advertised", rivalAttackTag(own = false, attack = attack(false, "shielded")))
        assertNull("your own base is never a target", rivalAttackTag(own = true, attack = attack(true)))
        assertNull("no permission read means no claim", rivalAttackTag(own = false, attack = null))
        assertNull("an allowed flag the server did not send is not a yes", rivalAttackTag(own = false, attack = JsonObject(emptyMap())))
    }

    @Test fun `a blocked rival keeps the server's reason in words, the D-099 Keep gap included`() {
        assertTrue("the refusal line is still drawn from the server's blockedBy",
            "attack?.string(\"blockedBy\")?.let { HudText(worldBlockReason(it, attack[\"keepReach\"] as? JsonObject)" in card)
        val keep = buildJsonObject { put("defenderKeep", 3); put("attackerKeep", 12) }
        assertEquals("Their Keep is too far below yours (L3 vs your L12)", worldBlockReason("keep_too_far_below", keep))
        assertEquals("Shield active", worldBlockReason("shielded"))
    }

    @Test fun `no copy on the rival card implies distance, reach or a range`() {
        val copy = literals(card)
        assertTrue("the card's copy was found (${copy.size} literals)", copy.size > 20)
        val proximity = Regex("""\b(in range|out of range|range|reach|reachable|nearby|near|distance|within|close by|far away)\b""",
            RegexOption.IGNORE_CASE)
        assertEquals("every rival can be raided wherever it sits", emptyList<String>(), copy.filter { proximity.containsMatchIn(it) })
    }

    @Test fun `no world, realm or globe copy makes raiding depend on where a kingdom sits`() {
        val sources = worldDir.listFiles { f -> f.name.endsWith(".kt") }!!.sortedBy { it.name }
        assertTrue("the world package was found (${sources.size} files)", sources.size > 10 && sources.any { it.name == "WorldHudScreen.kt" })
        // "nearby kingdoms/keeps" (what the map currently draws) and the D-099 "too far below yours" (Keep levels) stay.
        val location = Regex("""\b(in|out of|within|beyond|outside) (attack |raid |your )?(range|reach)\b|\bin reach\b|\bnear(by)? you\b|\bfar away\b|\bdistance\b|\bclose enough\b""",
            RegexOption.IGNORE_CASE)
        val offenders = sources.flatMap { f -> literals(strip(f.readText())).filter { location.containsMatchIn(it) }.map { "${f.name}: $it" } }
        assertEquals(emptyList<String>(), offenders)
    }
}
