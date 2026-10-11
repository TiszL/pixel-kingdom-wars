package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import kotlinx.coroutines.Job

class CharterViewModel(private val repository:CharterRepository,val wallet:CharterWallet?=null):ScreenViewModel() {
    val state=repository.state
    private var last:Job?=null
    private fun action(block:suspend ()->Unit)=run(block).also{if(it!=null)last=it}
    suspend fun foreground(){last?.join();refresh()?.join()}
    fun refresh()=action{repository.awaitIdle();repository.open()}
    fun nextPage()=action{repository.nextPage()}
    fun select(kind:String,key:String)=action{repository.select(kind,key)}
    fun selectSaved(key:String)=action{repository.selectSaved(key)}
    fun check()=action{repository.checkOriginal()}
    fun closeAbsent()=action{repository.closeAbsent()}
    fun create(baseId:String,name:String,tag:String,mode:String)=action{repository.create(baseId,name,tag,mode)}
    fun sell(clanId:String,buyer:String,price:String,leaves:Boolean)=action{repository.sell(clanId,buyer,price,leaves)}
    fun accept(baseId:String)=action{repository.accept(baseId)}
    fun payMembers()=action{repository.payMembers()}
    fun prepare()=action{repository.prepare()}
    fun recoverPreparation()=action{repository.recoverPreparation()}
    fun recover()=action{repository.recover()}
    fun cancel()=action{repository.cancel()}
    fun refund(baseId:String?)=action{repository.refund(baseId)}
    fun review()=action{repository.review()}
    fun approve()=action{repository.approve()}
    fun publish()=action{repository.publishSignature()}
    fun deliver()=action{repository.deliver()}
    fun dismiss()=repository.dismiss()
}
