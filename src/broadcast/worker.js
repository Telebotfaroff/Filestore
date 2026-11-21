import { subscribeDeliveryWorkerWake } from '../delivery/wake.js';
import { claimCreatorBroadcast, claimBroadcastRecipients, markBroadcastRecipient, getBroadcastState, finalizeCreatorBroadcast } from './repository.js';

export function createCreatorBroadcastWorker(telegram,pool,logger,deliveryBotId,sourceTelegram=null) {
 const botId=Number(deliveryBotId);let stopped=true,busy=false,pending=false,timer,unsubscribe;
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const retryAfter=e=>Number(e?.response?.parameters?.retry_after??e?.response?.retry_after??0);
 const errorCode=e=>Number(e?.response?.error_code??e?.code??0);
 const isTransient=e=>errorCode(e)===429||errorCode(e)>=500||!errorCode(e);
 async function sendPayload(uid,job){
  if(!job.media_file_id){await telegram.sendMessage(uid,job.message_text,{disable_web_page_preview:true,...(Array.isArray(job.buttons)&&job.buttons.length?{reply_markup:{inline_keyboard:job.buttons}}:{})});return;}
  if(!sourceTelegram)throw new Error('Media source bot is unavailable.');
  const fileUrl=await sourceTelegram.getFileLink(job.media_file_id);
  const caption=job.caption||job.message_text||undefined;
  const opts=caption?{caption}:{};if(Array.isArray(job.buttons)&&job.buttons.length)opts.reply_markup={inline_keyboard:job.buttons};
  if(job.media_type==='photo')return telegram.sendPhoto(uid,fileUrl,opts);
  if(job.media_type==='video')return telegram.sendVideo(uid,fileUrl,opts);
  if(job.media_type==='document')return telegram.sendDocument(uid,fileUrl,opts);
  if(job.media_type==='animation')return telegram.sendAnimation(uid,fileUrl,opts);
  throw new Error('Unsupported broadcast media type.');
 }
 async function sendWithRetry(uid,job){
  for(let attempt=0;attempt<4;attempt++){
   try{await sendPayload(uid,job);return {ok:true};}
   catch(e){
    const wait=retryAfter(e);
    if(attempt<3&&isTransient(e)){
     const delay=wait>0?wait*1000:Math.min(8000,500*Math.pow(2,attempt));
     logger.warn({botId,userId:uid,attempt:attempt+1,delay,error:e.message},'Broadcast send transient failure; retrying');
     await sleep(delay);if(stopped)return {stopped:true};continue;
    }
    return {ok:false,error:String(e?.response?.error_code??e?.code??e?.message??'send_failed').slice(0,120)};
   }
  }
  return {ok:false,error:'retry_exhausted'};
 }
 async function processOne(){
  const job=await claimCreatorBroadcast(pool,botId);if(!job)return false;
  try{
   while(!stopped){
    if(await getBroadcastState(pool,job.id)!=='processing')break;
    const users=await claimBroadcastRecipients(pool,job.id,25);if(!users.length)break;
    for(const u of users){
     if(stopped||await getBroadcastState(pool,job.id)!=='processing')break;
     const result=await sendWithRetry(u.telegram_user_id,job);
     if(result.stopped)break;
     await markBroadcastRecipient(pool,job.id,u.telegram_user_id,result.ok?'sent':'failed',result.error??null);
     await sleep(100);
    }
   }
   await finalizeCreatorBroadcast(pool,job.id);
  }catch(e){
   logger.error({broadcastId:job.id,error:e.message},'Creator broadcast worker failed');
   await pool.query("UPDATE creator_broadcasts SET status='pending',last_error=$2 WHERE id=$1 AND status='processing'",[String(e.message).slice(0,400),job.id]).catch(()=>{});
  }
  return true;
 }
 async function run(){if(stopped)return;if(busy){pending=true;return;}busy=true;pending=false;try{while(!stopped){const had=await processOne();if(!had)break;}}catch(e){logger.error({botId,error:e.message},'Broadcast worker loop error');}finally{busy=false;if(!stopped&&pending)void run();}}
 function wake(){if(stopped)return;pending=true;if(!busy)void run();}
 return {start(){if(!stopped)return;stopped=false;unsubscribe=subscribeDeliveryWorkerWake(wake);timer=setInterval(wake,60000);timer.unref?.();void (async()=>{await pool.query("UPDATE creator_broadcasts SET status='pending' WHERE delivery_bot_id=$1 AND status='processing'",[botId]);await pool.query("UPDATE creator_broadcast_recipients SET status='pending' WHERE broadcast_id IN (SELECT id FROM creator_broadcasts WHERE delivery_bot_id=$1) AND status='sending'",[botId]);await run();})().catch(e=>logger.warn({botId,error:e.message},'Broadcast recovery failed'));logger.info({botId},'Creator broadcast worker started');},stop(){stopped=true;if(timer)clearInterval(timer);timer=undefined;unsubscribe?.();unsubscribe=undefined;}};
}
