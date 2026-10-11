package gg.pixelkingdomwars.nativeclient.network

import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class QuestClaimsTest {
    private val id="00000000-0000-4000-8000-000000000001"
    private fun board(completed: Boolean=true, claimed: Boolean=false) = buildJsonObject {
        put("quests",buildJsonArray { add(buildJsonObject { put("id",id); put("completed",completed); put("claimed",claimed) }) })
    }
    @Test fun `lost accepted reply reads persisted claim without sending twice`() = runBlocking {
        var accepted=false; var posts=0
        val result=claimQuestReward(id,{board(claimed=accepted)},{posts++; accepted=true; throw IOException("reply lost")})
        assertTrue(result.objects("quests").single().flag("claimed")); assertEquals(1,posts)
    }
    @Test fun `already claimed quest never posts or fabricates a new reward`() = runBlocking {
        var posts=0
        claimQuestReward(id,{board(claimed=true)},{posts++})
        assertEquals(0,posts)
    }
    @Test fun `incomplete or absent quests cannot submit a claim`() {
        var posts=0
        assertThrows(IllegalStateException::class.java) { runBlocking { claimQuestReward(id,{board(completed=false)},{posts++}) } }
        assertThrows(IllegalStateException::class.java) { runBlocking { claimQuestReward(id,{buildJsonObject {}},{posts++}) } }
        assertEquals(0,posts)
    }
    @Test fun `unconfirmed network failure stays unresolved and does not retry`() {
        var posts=0
        assertThrows(IOException::class.java) { runBlocking { claimQuestReward(id,{board()},{posts++; throw IOException("offline")}) } }
        assertEquals(1,posts)
    }
    @Test fun `revoked session propagates without another account read`() {
        var reads=0
        assertThrows(ApiException::class.java) { runBlocking { claimQuestReward(id,{reads++;board()},{throw ApiException(401,"SESSION_REVOKED","Revoked")}) } }
        assertEquals(1,reads)
    }
}
