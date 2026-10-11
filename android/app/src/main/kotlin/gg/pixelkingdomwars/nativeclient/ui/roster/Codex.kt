package gg.pixelkingdomwars.nativeclient.ui.roster

import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.network.string
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** One Codex entry (web screens/codex.tsx `CodexEntry`): authored prose with a tag line whose every number
 * is read from the constants catalogue at render time, so a retune never leaves the Codex describing a rule
 * the game no longer applies. Entries whose tag needs a missing constant are omitted rather than invented. */
data class CodexEntry(val key: String, val name: String, val tag: String, val who: String, val strat: String? = null, val troop: String? = null)
enum class CodexTab { TROOPS, DEFENSE, BUILDINGS, ITEMS }

/** The production Codex, read-only. The prose is production copy (apps/web/src/ui/screens/codex.tsx); the
 * numbers come from the pack. */
object CodexData {
    private fun constants(catalogue: JsonObject?, key: String): JsonObject? = (catalogue?.get("constants") as? JsonObject)?.get(key) as? JsonObject
    private fun JsonObject.obj(key: String) = this[key] as? JsonObject
    private fun JsonObject.num(key: String): String? = (this[key] as? JsonPrimitive)?.content
    private fun JsonObject.int(key: String): Int? = num(key)?.toDoubleOrNull()?.toInt()
    private fun JsonObject.array(key: String): List<String>? = (this[key] as? JsonArray)?.map { (it as? JsonPrimitive)?.content ?: return null }
    private fun footprint(structure: JsonObject?): String? = structure?.array("footprint")?.joinToString("×")

    private fun trainingTag(catalogue: JsonObject?, troop: String, suffix: String? = null): String? {
        val stats = constants(catalogue, "TROOPS")?.obj(troop) ?: return null
        val pts = stats.int("pts") ?: return null
        val cost = stats.num("costKeep") ?: return null
        val trainSec = stats.num("trainSec")?.toDoubleOrNull() ?: return null
        val points = "$pts ${if (pts == 1) "PT" else "PTS"}"
        // Training is always minutes-or-less; spell the unit out rather than "2M", which reads as a quantity.
        val time = if (trainSec % 60.0 == 0.0) "${(trainSec / 60).toInt()} MIN" else "${plain(trainSec)} SEC"
        return "$points · $cost SHARDS · $time${suffix?.let { " · $it" } ?: ""}"
    }
    private fun plain(value: Double): String = if (value == Math.floor(value)) value.toInt().toString() else value.toString()

    fun troops(catalogue: JsonObject?): List<CodexEntry> {
        fun entry(troop: String, name: String, who: String, strat: String, suffix: String? = null) = trainingTag(catalogue, troop, suffix)?.let { CodexEntry(troop, name, it, who, strat, troop) }
        val direwyvernPts = constants(catalogue, "TROOPS")?.obj("direwyvern")?.int("pts")
        val brood = constants(catalogue, "TROOP_ABILITIES")?.obj("hexbarrow")?.obj("brood")
        return listOfNotNull(
            entry("highlander", "HIGHLANDER", "A mountain soldier in a sheepskin cloak. Brave, simple, always first through the gate.",
                "Your front line. He walks to the nearest building and soaks arrow fire while weaker troops work behind him. Cannons kill him fast — send the Tur Rider at those first."),
            entry("bowman", "BOWMAN", "A quiet hunter in a pine-green hood. Never gets close if he can help it.",
                "Shoots from 3.5 tiles — just past a Cannon. Fragile: one Mortar shell erases a whole cluster. Spread him out, and kill Mortars before massing."),
            entry("kegrunner", "KEG RUNNER", "A tiny sprinter hugging a powder keg bigger than he is. The fuse is lit the moment he drops. He is not afraid — he simply does not think that far ahead.",
                "He runs to the exact wall that opens your army’s shortest path and blows it. One keg kills a t1 or t2 wall; t3 takes two kegs, or one plus a Powder Charge. The blast is cross-shaped. Archer Towers and Spike Traps shred him — deploy in pairs so the second finishes the job.", "THE WALL BREAKER"),
            entry("tunneler", "TUNNELER", "A mole of a man — dusty coat, sky-pale goggles, claws on his boots. Walls offend him personally.",
                "Goes UNDER, not through. He dives at the wall and travels as an untargetable dirt mound, popping up inside — 1 second vulnerable as he emerges. He never damages walls. Spike Traps trigger on his mound: the mole-catcher."),
            entry("turrider", "TUR RIDER", "A lancer on a huge white mountain tur. The horns arrive before the rider does.",
                "Your tank. He beelines to Cannons and Mortars and soaks their fire so everything else stays alive. Cannons hurt him most; Mortar splash barely matters on one big target."),
            entry("plunderer", "PLUNDERER", "A wiry shadow in a blood-red mask with an empty sack and one gold-lit eye. He is only here for the money.",
                "Runs straight at Vaults and Mines and hits them for DOUBLE damage. Dies to anything that looks at him. Send him through the breach after the guns are busy — pure loot runs."),
            entry("gloamfang", "GLOAMFANG", "An elite ground hunter that prioritizes defending troops before turning on the base.",
                "Howl strengthens nearby attackers, then leap and lunge close distance quickly. Its large camp footprint rewards deploying it where the buff can reach a real push.", "FORGE WRIT"),
            direwyvernPts?.let { entry("direwyvern", "DIREWYVERN", "A flying siege beast far stronger than a Dragon. It occupies $it camp points—as much as several Dragons.",
                "Its firestorm leaves damaging ground behind and maul punishes clustered targets. It flies over walls, but its enormous camp footprint makes every loss matter.", "FORGE WRIT") },
            entry("hexbarrow", "HEXBARROW", "A slow mobile siege engine that fires hexshots and carries a brood of temporary Barrowlings.",
                "It prefers buildings and deals amplified structure damage, but still breaks a blocking wall when no preferred target is reachable. Protect it long enough to disgorge its full brood.", "FORGE WRIT"),
            brood?.let { b -> b.int("lifespanSec")?.let { life -> b.int("variants")?.let { variants ->
                CodexEntry("barrowling", "BARROWLING", "SPAWN ONLY · $life SEC LIFESPAN · $variants VARIANTS",
                    "A short-lived Hexbarrow spawn. It cannot be trained, researched, stored in camp, or deployed directly.",
                    "Barrowlings are replayed from the Hexbarrow’s server-authored spawn events. They pressure defenses briefly, then expire on the authoritative battle timeline.", "barrowling") } } },
        )
    }
    fun troop(catalogue: JsonObject?, troop: String): CodexEntry? = troops(catalogue).firstOrNull { it.troop == troop }

    fun defense(catalogue: JsonObject?): List<CodexEntry> {
        val defenses = constants(catalogue, "DEFENSES"); val costs = constants(catalogue, "BUILD_COSTS"); val repair = constants(catalogue, "TRAP_REPAIR")
        val tiers = constants(catalogue, "ART_V2")?.int("tiers")
        fun tierRange(list: List<String>?): String? = tiers?.let { t -> list?.takeIf { it.size >= t }?.let { "${it[0]}–${it[t - 1]}" } }
        fun trap(key: String, name: String, use: String, who: String, strat: (String) -> String, keep: Boolean): CodexEntry? {
            val cost = costs?.obj(key)?.num("costShards") ?: return null
            val burst = tierRange(defenses?.obj(key)?.array(if (key == "pitfall") "stunTicksByTier" else "burstDamageByTier")) ?: return null
            val tag = if (keep) "$cost SHARDS · ONE USE · $use · KEEP L${costs.obj(key)?.int("requiresKeepLevel") ?: return null}"
                else "$cost SHARDS · ONE USE · REPAIR ${tierRange(repair?.obj(key)?.array("costShardsByTier")) ?: return null} SHARDS"
            return CodexEntry(key, name, tag, who, strat(burst))
        }
        return listOfNotNull(
            defenses?.obj("cannon")?.let { c -> c.num("rangeTiles")?.let { r -> c.num("fireIntervalSec")?.let { f -> CodexEntry("cannon", "CANNON", "RANGE $r · 1 SHOT / $f SEC",
                "A squat stone bastion with a pivot gun. Slow, heavy, patient.",
                "Single target, big hits. Shreds Tur Riders and Highlanders; struggles against fast swarms. Place it behind walls — the range ring you see is exactly what the game uses.") } } },
            defenses?.obj("archertower")?.let { a -> a.num("rangeTiles")?.let { r -> a.num("fireIntervalSec")?.toDoubleOrNull()?.let { f -> CodexEntry("archertower", "ARCHER TOWER", "RANGE $r · ${Math.round(1 / f)} SHOTS / SEC",
                "A slim watchtower with a hooded bowman on top who never sleeps.",
                "Fast, light, hits many. Your answer to Keg Runners, emerging Tunnelers and Plunderer swarms. Pair it with a Cannon covering the same lane.") } } },
            CodexEntry("mortar", "MORTAR", "RANGE 2–7 · SPLASH · KEEP L3+", "A wide stone pit that lobs shells in a high arc. You hear it before you see it.",
                "Deletes clusters of Bowmen and Plunderers at long range — but it CANNOT hit anything closer than 2 tiles. Guard its dead zone or fast troops will hug it to death."),
            defenses?.obj("airdefence")?.let { a -> footprint(a)?.let { fp -> a.num("rangeTiles")?.let { r -> costs?.obj("airdefence")?.int("requiresKeepLevel")?.let { k ->
                CodexEntry("airdefence", "AIR DEFENCE", "$fp · RANGE $r · AIR ONLY · KEEP L$k", "A dedicated harpoon battery that tracks the sky and ignores every ground target.",
                    "Its long reach punishes Dragons and Direwyverns, but ground armies can walk underneath untouched. Overlap its coverage with ground defenses instead of treating it as a general tower.") } } } },
            trap("spiketrap", "SPIKE TRAP", "", "A patch of grass with a secret. Attackers see nothing at all.",
                { "$it damage to the first ground unit that steps on it. It is then spent and inert until repaired. Seed likely ground lanes rather than feeding it a cheap scout." }, keep = false),
            trap("powdermine", "POWDER MINE", "GROUND SPLASH", "A buried powder charge designed to punish a packed ground push.",
                { "Deals $it damage in a tiered blast radius. It cannot hit flying units and remains spent until repaired." }, keep = true),
            trap("pitfall", "PITFALL", "GROUND STUN", "A concealed collapse that hurts one ground attacker and stops its advance.",
                { "Its stun scales from ${it.replace("–", " to ")} simulation ticks. Place it inside overlapping tower fire so the bounded pause matters." }, keep = true),
            trap("airmine", "AIR MINE", "FLYING SPLASH", "A drifting anti-air charge that ignores the ground and bursts among flyers.",
                { "Deals $it damage to clustered flying attackers. Ground troops never trigger it." }, keep = true),
            constants(catalogue, "WALL_ART")?.int("tiers")?.let { art -> constants(catalogue, "STRUCTURES")?.obj("wall")?.int("maxTier")?.let { levels ->
                CodexEntry("wall", "WALLS", "$art ART TIERS · $levels LEVELS", "Old Svan stone. It has outlived every army that touched it — until the kegs came.",
                    "Walls slow and steer attackers. There are two answers to a wall — break it (Keg Runner) or go under it (Tunneler) — so build compartments, not one big box. Every extra wall buys your guns seconds.") } },
        )
    }

    fun buildings(catalogue: JsonObject?): List<CodexEntry> {
        val structures = constants(catalogue, "STRUCTURES"); val batteries = constants(catalogue, "KEEP_BATTERIES"); val loot = constants(catalogue, "LOOT"); val costs = constants(catalogue, "BUILD_COSTS")
        fun levels(key: String): String? = structures?.obj(key)?.let { s -> footprint(s)?.let { fp -> s.int("maxLevel")?.let { "$fp · L1–L$it" } } }
        val vaultMax = structures?.obj("vault")?.int("maxLevel"); val protectMax = loot?.int("vaultProtectionMaxBps"); val lootable = loot?.int("balanceLootableBps")
        // D-065 numbers (packages/shared/src/raidLoot.ts vaultProtectionBps: linear in level, the constant is the maximum at maxLevel).
        val vault = if (vaultMax != null && protectMax != null && lootable != null && vaultMax > 0) CodexEntry("vault", "VAULT", "1×1 · L1–L20 · THE TARGET",
            "A fat stone drum with a gold-banded door. It looks like money because it is.",
            "Raiders can take up to ${lootable / 100}% of this base's shards. Your best STANDING Vault shields part of that — ${plain(Math.floorDiv(protectMax.toLong(), vaultMax.toLong()) / 100.0)} points at L1, ${protectMax / 100} at L$vaultMax, so a maxed Vault leaves only ${(lootable - protectMax) / 100}% lootable. A Vault that falls in the raid protects nothing: wall it in.") else null
        val camp = structures?.obj("camp")?.let { c -> levels("camp")?.let { l -> c.array("capacityPts")?.let { cap -> c.int("maxLevel")?.let { max -> cap.takeIf { it.size >= max }?.let {
            CodexEntry("camp", "ARMY CAMP", "$l · CAP ${it[0]}–${it[max - 1]} PTS", "Tents, a fire, and restless soldiers sharpening steel. Your army lives here between raids — you can SEE them waiting.",
                "Total army size = combined capacity of your camps. The Barracks trains; the Camp holds. Build more camps (or level them) before training a bigger army — a full camp means a full raid.") } } } } }
        return listOfNotNull(
            levels("keep")?.let { l -> batteries?.int("highRangeUnlockLevel")?.let { high -> batteries.int("lowRangeUnlockLevel")?.let { low ->
                CodexEntry("keep", "KEEP", "$l · THE HEART", "The tallest tower in your land — your home. Everything unlocks through it.",
                    "Gates every other building level. At L$high it awakens a long-range ground battery, then at L$low gains a close-range battery for its dead zone. Neither fires at flying attackers.") } } },
            levels("mine")?.let { CodexEntry("mine", "MINE", "$it · WHERE YOU EARN", "A timber-framed tunnel into the gold seam. The daily claim happens here.",
                "Each level raises your MINING QUOTA — the fixed shards your Mine makes each day, never split with other players. The best long-term investment in the game.") },
            vault,
            levels("barracks")?.let { CodexEntry("barracks", "BARRACKS", it, "A long stone hall that smells of oil and rope. Armies are made here.",
                "Trains troops into the Army Camp; queue size 10/15/20 points by level. Troops are consumed on every raid — treat your army as ammunition, not pets.") },
            levels("forge")?.let { CodexEntry("forge", "ALCHEMY LAB", "$it · TROOP UPGRADES", "A bubbling field laboratory where old recipes turn trained troops into stronger versions of themselves.",
                "Upgrades troop levels. No troop can out-level the Alchemy Lab — raise the building first, then research the troop. Its internal building identity remains forge for saved-base compatibility.") },
            camp,
            levels("clanhall")?.let { l -> costs?.obj("clanhall")?.int("requiresKeepLevel")?.let { k -> CodexEntry("clanhall", "CLAN HALL", "$l · KEEP L$k",
                "A permanent gathering hall for the clan, standing inside the base like every other structure.",
                "It is destructible and counts toward raid destruction. Clan membership remains account-level, so losing the hall in battle never removes anyone from the clan.") } },
            levels("lodge")?.let { CodexEntry("lodge", "EXPLORATION LODGE", it,
                "Plans expeditions and keeps their departure and return records.",
                "Expedition actions are available only when this kingdom enables them.") },
            levels("berth")?.let { CodexEntry("berth", "BERTH", it,
                "A mooring for expedition vessels.",
                "Vessel and journey actions are available only when this kingdom enables them.") },
            levels("harvester")?.let { CodexEntry("harvester", "REALM HARVESTER", it,
                "Gathers the local materials of this kingdom.",
                "The kingdom's realm determines the materials gathered here.") },
            levels("workshop")?.let { CodexEntry("workshop", "WORKSHOP", it,
                "Refines Shards into Forge Ingots for the Gold Forge.",
                "Forge Ingots feed the Gold Forge.") },
        )
    }

    /** Production's ITEMS tab is authored copy (the raid buffs, rally, energy, streak and KEEP lines carry their
     * own literal figures in codex.tsx); only the shield line derives from `SHIELD`. */
    fun items(catalogue: JsonObject?): List<CodexEntry> {
        val shield = constants(catalogue, "SHIELD")
        val onLoss = shield?.int("hoursOnLoss"); val extend = shield?.int("extendHours"); val max = shield?.int("maxHours")
        return listOfNotNull(
            CodexEntry("warhorn", "WAR HORN", "40 KEEP · ONE RAID", "+15% troop damage for the whole raid. Blow it when the wall is already down."),
            CodexEntry("swiftboots", "SWIFT BOOTS", "30 KEEP · ONE RAID", "+20% move speed. Loot runs and dead-zone hugging get much easier."),
            CodexEntry("powdercharge", "POWDER CHARGE", "35 KEEP · ONE RAID", "+60% damage against walls. Turns one Keg Runner into a t3-wall one-shot."),
            CodexEntry("rally", "RALLY", "FREE · KEEP L3 · ONCE PER RAID", "A 5-second rage pulse (+25% speed and damage) around a point you pick. The skill is WHEN you pop it."),
            if (onLoss != null && extend != null && max != null) CodexEntry("shield", "SHIELD", "${fmtDur(onLoss * 3_600L).uppercase()} AFTER A LOSS",
                "Nobody can raid you while it holds. Extend +${fmtDur(extend * 3_600L).uppercase()} with SOL (max ${fmtDur(max * 3_600L).uppercase()}). It breaks the moment YOU attack another player.") else null,
            CodexEntry("energy", "RAID ENERGY", "3 FREE PER DAY", "Each PvP raid costs one. Extra raid: 0.1 SOL, max 6 a day. Ruined Keeps never cost energy."),
            CodexEntry("streak", "STREAK", "UP TO ×1.4 MINING BONUS", "Show up every day; the ×1.4 mining bonus kicks in at a 7-day streak. Miss a day and the streak resets — rebuild it."),
            CodexEntry("keep", "KEEP", "PIXEL KINGDOM GOLD", "The kingdom’s currency — everything you mine. Spend it to grow stronger, or withdraw it to your wallet as the KEEP token. That choice IS the game."),
        )
    }

    fun entries(catalogue: JsonObject?, tab: CodexTab): List<CodexEntry> = when (tab) {
        CodexTab.TROOPS -> troops(catalogue); CodexTab.DEFENSE -> defense(catalogue); CodexTab.BUILDINGS -> buildings(catalogue); CodexTab.ITEMS -> items(catalogue)
    }

    /** Troop stat badges (web `StatBadge`): HP/DMG scale by `TROOP_LEVELING.statMultPerLevel^(lv-1)`, rounded;
     * SPD/RNG are unleveled; the level is the player's real `/army` level (default 1). */
    data class TroopStatLine(val level: Int, val hp: Long, val dmg: Long, val speed: String, val range: String, val maxLevel: Int)
    fun troopStats(catalogue: JsonObject?, troop: String, level: Int?): TroopStatLine? {
        val stats = constants(catalogue, "TROOPS")?.obj(troop) ?: return null
        val leveling = constants(catalogue, "TROOP_LEVELING") ?: return null
        val mult = leveling.num("statMultPerLevel")?.toDoubleOrNull() ?: return null
        val max = leveling.int("maxLevel") ?: return null
        val lv = level?.takeIf { it > 0 } ?: 1
        val scale = Math.pow(mult, (lv - 1).toDouble())
        val hp = stats.num("hp")?.toDoubleOrNull() ?: return null; val dps = stats.num("dps")?.toDoubleOrNull() ?: return null
        val range = stats.num("range")?.let { if (it == "melee") "MELEE" else it } ?: return null
        return TroopStatLine(lv, Math.round(hp * scale), Math.round(dps * scale), stats.num("speedTilesPerSec") ?: "—", range, max)
    }

    /** Battle abilities as data only (`HERO_SKILLS[hero]`): the skill name and the level that unlocks it. The
     * battle scene that plays them belongs to the PvP lane. */
    data class HeroSkill(val key: String, val name: String, val unlockLevel: Int?)
    fun heroSkills(catalogue: JsonObject?, hero: String): List<HeroSkill> =
        constants(catalogue, "HERO_SKILLS")?.obj(hero)?.entries?.map { (key, value) ->
            HeroSkill(key, key.replace(Regex("([a-z])([A-Z])"), "$1 $2").uppercase(), (value as? JsonObject)?.int("unlockLevel"))
        }?.sortedBy { it.unlockLevel ?: Int.MAX_VALUE } ?: emptyList()
}
