package gg.pixelkingdomwars.nativeclient.ui.world

import gg.pixelkingdomwars.nativeclient.model.FantasyMarker
import gg.pixelkingdomwars.nativeclient.model.FantasyOwnedTile
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases.BaseHandOver
import org.junit.Assert.*
import org.junit.Test

/**
 * D-NEXT, the owner on the Seeker (2026-09-26, code 31, Sunscar): "keep is displayed very ugly on current screen, zoomed
 * in base is much better ... current keep display is extra not needed, on this range only player profile picture and
 * name should be visible, in efficient way". At map zoom the BASES lane now draws no castle. From `uiDots` until the
 * lane draws a kingdom's real base, its name tag is all the player sees of it. So that tag is the compact one: the
 * avatar and the NAME, with no keep level, and a long name is cut so the tag stays small. Once the base draws (per
 * kingdom, [BaseHandOver.drawsBase]) the tag is the web's again, level included. The owner's code-31 tag showed only the
 * avatar and "20" because the feed's name was empty. A blank name now reads "Keeper", like the cards, and "Your kingdom"
 * on your own deeds, so a compact tag never loses its only text and your kingdom never reads as a stranger's. Each tag
 * carries its player's picture path, and a tap on a tag selects its kingdom (REFIX review of 82c91fc).
 */
class KingdomTagTest {
    private val cols = 178; private val rowsN = 120; private val x0 = 300; private val y0 = 100 // a Crownlands-sized realm
    private val cx = x0 + cols / 2; private val cy = y0 + rowsN / 2
    private val long = "Averyveryverylongkingdomname"

    private fun portrait(): Triple<Float, Float, RealmHudPlan> {
        val (w, h) = SeekerRows.portrait(3f)
        return Triple(w, h, RealmHudPlan.plan(RealmHudPlan.Input(w, h, SeekerRows.PORTRAIT_INSETS, HudType.of(3f, false, h), realmCols = cols, realmRows = rowsN,
            title = "Sunscar", subtitle = "13,925 deeds · 2 kingdoms")))
    }
    /** A 5×5 block of neighbouring kingdoms around the camera, yours in the middle, one with a very long name. */
    private val bases = (0 until 25).map { i ->
        val x = cx - 2 + i % 5; val y = cy - 2 + i / 5
        RealmHudBase(y * 720 + x, x, y, if (i == 3) long else "Keep$i", 1 + i % 20, mine = i == 12)
    }
    /** The tags at camera (s dp per deed, d device px per deed) on the Seeker portrait, nothing selected. */
    private fun tags(s: Double, d: Double, list: List<RealmHudBase> = bases): List<WorldLabels.TagLabel> {
        val (w, h, plan) = portrait()
        val res = WorldLabels.realm(list, null, false, WorldLabels.RealmView(cx + 0.5, cy + 0.5, s, d, w.toDouble(), h.toDouble()), 720,
            plan.chrome(), plan.safeBox.ltrb(), HudType.of(3f, false, h))
        return res.labels.map { it as WorldLabels.TagLabel }
    }

    /**
     * SHARDKEEP D-191: a kingdom the active filter drops has no name tag, in the map range where the tag and the dot are all
     * a kingdom shows (the BASES lane hides its dot too), unless it is the selected kingdom, whose card is up on it. The
     * screen hands the labels only the filtered list; this pins that the placement never names a base outside it on
     * its own and always names the selection.
     */
    @Test fun `a filtered-out kingdom has no tag unless it is selected`() {
        val (w, h, plan) = portrait(); val t = HudType.of(3f, false, h)
        val filter = RealmFilter(lo = 7, hi = 20)
        val kept = bases.filter { filter.passes(it, null) }
        assertTrue("kingdoms on both sides of the range (not a vacuous pass)", kept.size in 1 until bases.size)
        val view = WorldLabels.RealmView(cx + 0.5, cy + 0.5, 60.0, 120.0, w.toDouble(), h.toDouble())
        val shown = WorldLabels.realm(kept, null, false, view, 720, plan.chrome(), plan.safeBox.ltrb(), t).labels.map { (it as WorldLabels.TagLabel).base }
        assertTrue("tags were placed", shown.isNotEmpty())
        assertTrue("no tag names a kingdom below level 7", shown.all { it.level >= 7 })
        val dropped = bases.first { !filter.passes(it, null) }
        val withSel = WorldLabels.realm(kept, dropped, false, view, 720, plan.chrome(), plan.safeBox.ltrb(), t).labels.map { it as WorldLabels.TagLabel }
        val sel = withSel.single { it.base == dropped }
        assertTrue("the selected kingdom is named, big, although the filter drops it", sel.big)
        assertTrue("and it is the only one outside the range", withSel.filter { it.base != dropped }.all { it.base.level >= 7 })
    }

    @Test fun `in the map range every tag is the avatar and the name without a level`() {
        // s 30 … 99.5 at dpr 2 (d 60 … 199): the owner's code-31 screen was s ≈ 60, one deed on the scale bar
        for (s in doubleArrayOf(HudBands.UI_DOTS_S, 30.0, 60.0, 99.5)) {
            val t = tags(s, s * 2)
            assertTrue("s=$s: tags were placed (not a vacuous pass)", t.size >= 4)
            for (tag in t) {
                assertNull("s=$s: ${tag.base.name} shows no level at map zoom", tag.level)
                assertEquals("s=$s: the name is the kingdom's", RealmHudModel.mapTagName(tag.base.name), tag.name)
            }
            assertTrue("s=$s: your kingdom is named", t.any { it.base.mine && it.name == "Keep12" })
        }
    }

    @Test fun `up close the tag is the web's again, level and full name, as today`() {
        for (s in doubleArrayOf(140.0, 200.0, 350.0)) {
            val t = tags(s, s * 2) // d ≥ 280: every kingdom's real base draws
            assertTrue("s=$s: tags were placed", t.isNotEmpty())
            for (tag in t) {
                assertEquals("s=$s: ${tag.base.name} shows its keep level again", tag.base.level, tag.level)
                assertEquals("s=$s: and its whole name", tag.base.name, tag.name)
            }
        }
    }

    @Test fun `through the hand-over each tag gains its level exactly when its kingdom's base draws`() {
        var compact = 0; var full = 0
        for (d in doubleArrayOf(200.0, 215.0, 230.0, 245.0, 260.0, 279.0)) {
            val s = d / 2
            for (tag in tags(s, d)) {
                val base = BaseHandOver.drawsBase(tag.base.tileId, s, d)
                assertEquals("d=$d ${tag.base.name}: level iff its base draws", if (base) tag.base.level else null, tag.level)
                if (base) full++ else compact++
            }
        }
        assertTrue("both tags occur in the band (not a vacuous pass): $compact compact, $full full", compact > 0 && full > 0)
    }

    @Test fun `a long name is cut in the compact tag only, and the placement measures what is drawn`() {
        val lone = listOf(RealmHudBase(cy * 720 + cx, cx, cy, long, 20, mine = true))
        val far = tags(60.0, 120.0, lone).single(); val near = tags(200.0, 400.0, lone).single()
        assertEquals("Averyveryve…", far.name)
        assertEquals(RealmHudModel.MAP_TAG_NAME, far.name.codePointCount(0, far.name.length))
        assertNull(far.level)
        assertEquals(long, near.name); assertEquals(20, near.level)
        // the compact tag is narrower by the cut characters and by the level's gap and digits
        val (_, h, _) = portrait(); val t = HudType.of(3f, false, h)
        val wFar = RealmHudModel.tagW(far.name, far.level, false, t.cap.toDouble(), t.body.toDouble())
        val wNear = RealmHudModel.tagW(near.name, near.level, false, t.cap.toDouble(), t.body.toDouble())
        assertEquals(wNear - (long.length - far.name.length) * 0.4 * t.cap - (5 + 2 * 0.4 * t.body), wFar, 1e-9)
    }

    @Test fun `the compact name counts characters, never splitting an emoji, and keeps a short name whole`() {
        assertEquals("Keeper", RealmHudModel.mapTagName("Keeper"))
        assertEquals("Twelve chars", RealmHudModel.mapTagName("Twelve chars"))
        val crowns = "👑".repeat(20)
        val cut = RealmHudModel.mapTagName(crowns)
        assertEquals("👑".repeat(RealmHudModel.MAP_TAG_NAME - 1) + "…", cut)
    }

    /**
     * Rewritten from "a missing or blank feed name reads Keeper, and your own uncarried deed reads My base". The owner's
     * code-31 kingdom (blank name, level 20) came through the feed and so read "Keeper", a stranger's name, on its map
     * tag. Your own deeds now read "Your kingdom", what the app calls a nameless player's kingdom
     * everywhere else (`Identity.displayName`, the home bar), whether or not the feed carried them; the tag's
     * "My base" fallback is gone, so one rule names your kingdom. Rivals without a name still read "Keeper", like the cards.
     */
    @Test fun `a missing or blank name reads Keeper on a rival and Your kingdom on your own deeds`() {
        val columns = 720; val realm = "sunscar"
        val markers = listOf(FantasyMarker(1000, null, 20), FantasyMarker(1001, "", 20), FantasyMarker(1002, "   ", 5), FantasyMarker(1003, "Ann", 3))
        val owned = listOf(FantasyOwnedTile("base-a", 1001, realm, "", 20, active = true, selected = true),
            FantasyOwnedTile("base-b", 2000, realm, " ", 4, active = true), FantasyOwnedTile("base-c", 2001, realm, "Bo", 4))
        val bases = realmHudBases(realm, markers, owned, { realm }, columns, null, 0L)
        assertEquals(listOf("Keeper", "Your kingdom", "Keeper", "Ann", "Your kingdom", "Bo"), bases.map { it.name })
        val mine = bases.first { it.tileId == 1001 }
        assertTrue(mine.mine)
        assertEquals("the owner's code-31 tag names his kingdom", "Your kingdom", RealmHudModel.mapTagName(mine.name))
    }

    /**
     * Integration review of 560fe54: the tag and the loading card said "Your kingdom" for the owner's nameless kingdom,
     * then the loaded card's title went BLANK (`?: "Keeper"` never tests an empty name). One rule now names a kingdom on
     * the tag, the loading card and the loaded card, so the title the owner tapped is the title the card keeps.
     */
    @Test fun `the tag, the loading card and the loaded card name a kingdom the same way`() {
        val columns = 720; val realm = "sunscar"
        val owned = listOf(FantasyOwnedTile("base-a", 1001, realm, "", 20, active = true, selected = true))
        val markers = listOf(FantasyMarker(1001, "", 20), FantasyMarker(1002, "  ", 5), FantasyMarker(1003, null, 3), FantasyMarker(1004, "Ann", 3))
        val bases = realmHudBases(realm, markers, owned, { realm }, columns, null, 0L)
        val reads = mapOf(1001 to "\"\"", 1002 to "\"  \"", 1003 to "null", 1004 to "\"Ann\"")
        for (b in bases) {
            val own = owned.firstOrNull { it.tileId == b.tileId }
            val loading = pendingCardTitle(b, own, b.x, b.y)
            val player = kotlinx.serialization.json.Json.parseToJsonElement("{\"name\":${reads.getValue(b.tileId)}}") as kotlinx.serialization.json.JsonObject
            assertEquals("${b.tileId}: the loading card keeps the tag's name", b.name, loading)
            assertEquals("${b.tileId}: the loaded card keeps it too, never blank", b.name, loadedCardTitle(player, own != null))
        }
        assertEquals(listOf("Your kingdom", "Keeper", "Keeper", "Ann"), bases.map { it.name })
        assertEquals("a read without a name at all", "Keeper", loadedCardTitle(kotlinx.serialization.json.JsonObject(emptyMap()), false))
        assertEquals("your own deed without a silhouette yet", "Your kingdom", pendingCardTitle(null, owned.single(), 1, 1))
        assertEquals("open land is its place", "Deed 3, 4", pendingCardTitle(null, null, 3, 4))
    }

    @Test fun `realm search finds players by the names they chose, never by the stand-in names`() {
        // review of 560fe54 (low): "kee" filled the 8 rows with nameless kingdoms, crowding out real players named Keeper…
        val columns = 720; val realm = "sunscar"
        val markers = listOf(FantasyMarker(1000, null, 20), FantasyMarker(1001, "", 20), FantasyMarker(1002, " ", 5),
            FantasyMarker(1003, "Keeperton", 3), FantasyMarker(1004, "Young Ann", 3))
        val owned = listOf(FantasyOwnedTile("base-a", 1001, realm, "", 20, active = true), FantasyOwnedTile("base-b", 2000, realm, null, 4))
        val bases = realmHudBases(realm, markers, owned, { realm }, columns, null, 0L)
        assertEquals("the stand-ins are still shown", listOf("Keeper", "Your kingdom", "Keeper", "Keeperton", "Young Ann", "Your kingdom"), bases.map { it.name })
        assertEquals(listOf("Keeperton"), RealmHudModel.search(bases, "kee").map { it.name })
        assertEquals(listOf("Young Ann"), RealmHudModel.search(bases, "you").map { it.name })
        assertEquals(listOf("Young Ann"), RealmHudModel.search(bases, "ann").map { it.name })
    }

    @Test fun `each kingdom carries its player's picture for its tag, from the feed or your own deed`() {
        // owner code 31: "only player profile picture and name". 82c91fc dropped the feed's avatarUrl, so every tag drew
        // the same castle art; the picture must reach the tag, and a kingdom without one carries none (default portrait).
        val columns = 720; val realm = "sunscar"
        val a = "/api/avatars/3f2b6c1e-9d7a-4c55-8a10-5b7e2f4c9a01.webp"; val b = "/api/avatars/3f2b6c1e-9d7a-4c55-8a10-5b7e2f4c9a02.webp"
        val markers = listOf(FantasyMarker(1000, "Ann", 3, avatarUrl = a), FantasyMarker(1001, "Cy", 5))
        val owned = listOf(FantasyOwnedTile("base-b", 2000, realm, "Me", 4, avatarUrl = b))
        val bases = realmHudBases(realm, markers, owned, { realm }, columns, null, 0L)
        assertEquals(listOf(a, null, b), bases.map { it.avatarUrl })
    }

    @Test fun `a tap on a kingdom's tag selects that kingdom, not the deed under the finger`() {
        // REFIX review, finding 3: the map's tap selected the deed under the finger. At map zoom the tag stands above its
        // kingdom, mostly over the deed to the north, so tapping the name opened the northern neighbour's card. The tag
        // is the kingdom's largest mark there, so it must answer the tap.
        val lone = RealmHudBase(cy * 720 + cx, cx, cy, "Ann", 7, mine = false)
        val (w, h, plan) = portrait(); val t = HudType.of(3f, false, h)
        for (s in doubleArrayOf(30.0, 60.0)) {
            val view = WorldLabels.RealmView(cx + 0.5, cy + 0.5, s, s * 2, w.toDouble(), h.toDouble())
            val res = WorldLabels.realm(listOf(lone), null, false, view, 720, plan.chrome(), plan.safeBox.ltrb(), t)
            val tag = res.labels.single() as WorldLabels.TagLabel
            // a point on the tag's name (upper half), and the catalog deed row under that point on this camera
            val tx = res.xs[0] + res.ws[0] / 2.0; val ty = res.ys[0] + res.hs[0] / 4.0
            val deedRow = Math.floor(view.camY + (ty - h / 2.0) / s).toInt()
            assertEquals("s=$s: that point lies over the deed to the north", cy - 1, deedRow)
            assertEquals("s=$s: a tap there selects the tag's kingdom", lone, res.tagAt(tx, ty))
            assertSame(tag.base, res.tagAt(res.xs[0] + 1.0, res.ys[0] + 1.0))
            assertNull("s=$s: a tap beside the tag is the map's", res.tagAt(res.xs[0] - 2.0, ty))
            assertNull("s=$s: nor below it, on the kingdom's own deed (the deed tap picks it there)", res.tagAt(tx, res.ys[0] + res.hs[0] + 2.0))
        }
        // what the map's tap (onRealmTap) asks before the deed under the finger: the last tags placed, in view px
        val density = 3f; val s = 30.0
        val res = WorldLabels.realm(listOf(lone), null, false, WorldLabels.RealmView(cx + 0.5, cy + 0.5, s, s * 2, w.toDouble(), h.toDouble()), 720,
            plan.chrome(), plan.safeBox.ltrb(), t)
        val px = ((res.xs[0] + res.ws[0] / 2.0) * density).toFloat(); val py = ((res.ys[0] + res.hs[0] / 4.0) * density).toFloat()
        try {
            RealmLabelsState.set(res.counters, density, s * 2, 720, res)
            assertEquals("the tap on the tag selects its kingdom's card", RealmCard(lone.tileId, lone.x, lone.y), RealmLabelsState.tagCard(px, py))
            assertNull("a tap off the tag falls through to the deed", RealmLabelsState.tagCard(px, py + (res.hs[0] * density)))
            RealmLabelsState.clear()
            assertNull("a closed map keeps no tags to hit", RealmLabelsState.tagCard(px, py))
        } finally { RealmLabelsState.clear() }
        // below uiDots the labels are counters, which answer through hitCluster, never as a tag
        val far = WorldLabels.realm(listOf(lone), null, false, WorldLabels.RealmView(cx + 0.5, cy + 0.5, 12.0, 24.0, w.toDouble(), h.toDouble()),
            720, plan.chrome(), plan.safeBox.ltrb(), t)
        assertNull(far.tagAt(far.xs[0] + 1.0, far.ys[0] + 1.0))
    }
}
