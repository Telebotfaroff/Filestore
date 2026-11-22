import { subscribeDeliveryWorkerWake } from '../delivery/wake.js';
import { claimCreatorBroadcast, claimBroadcastRecipients, markBroadcastRecipient, getBroadcastState, finalizeCreatorBroadcast } from './repository.js';

export function createCreatorBroadcastWorker(telegram,pool,logger,deliveryBotId,sourceTelegram=null) {
 const botId=Number(deliveryBotId);let stopped=true,busy=false,pending=false,timer,unsubscribe;
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const retryAfter=e=>Number(e?.response?.parameters?.retry_after??e?.response?.retry_after??0);
 const errorCode=e=>Number(e?.response?.error_code??e?.code??0);
 const isTransient=e=>errorCode(e)===429||errorCode(e)>=500||!errorCode(e);
 const sanitizeError=msg=>String(msg??'send_failed').replace(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g,'[REDACTED_TOKEN]').slice(0,400);
 const resolveSourceTelegram=()=>typeof sourceTelegram==='function'?sourceTelegram():sourceTelegram;
 const MEDIA_EXT={photo:'jpg',video:'mp4',document:'bin',animation:'mp4'};
 async function resolveCampaignMedia(job){
  if(!job.media_file_id)return null;
  const src=resolveSourceTelegram();
  if(!src)throw new Error('Media source bot is unavailable.');
  const fileUrl=String(await src.getFileLink(job.media_file_id));
  const resp=await fetch(fileUrl);
  if(!resp.ok)throw new Error(`Media download failed (HTTP ${resp.status}).`);
  const arrBuf=await resp.arrayBuffer();
  if(arrBuf.byteLength>50*1024*1024)throw new Error('Broadcast media exceeds 50 MB Telegram upload limit.');
  const ext=MEDIA_EXT[job.media_type]||'bin';
  return {source:Buffer.from(arrBuf),filename:`broadcast-${job.id}.${ext}`};
 }
 async function sendPayload(uid,job,mediaInput=null){
  const replyMarkup=Array.isArray(job.buttons)&&job.buttons.length?{reply_markup:{inline_keyboard:job.buttons}}:{};
  if(!job.media_file_id){await telegram.sendMessage(uid,job.message_text,{disable_web_page_preview:true,...replyMarkup});return;}
  if(!mediaInput)throw new Error('Media source payload is unavailable.');
  const caption=String(job.caption||job.message_text||'').slice(0,1024)||undefined;
  const opts={...(caption?{caption}:{}),...replyMarkup};
  const payload={source:mediaInput.source,filename:mediaInput.filename};
  if(job.media_type==='photo')return telegram.sendPhoto(uid,payload,opts);
  if(job.media_type==='video')return telegram.sendVideo(uid,payload,opts);
  if(job.media_type==='document')return telegram.sendDocument(uid,payload,opts);
  if(job.media_type==='animation')return telegram.sendAnimation(uid,payload,opts);
  throw new Error('Unsupported broadcast media type.');
 }
 async function sendWithRetry(uid,job,mediaInput=null){
  for(let attempt=0;attempt<4;attempt++){
   try{await sendPayload(uid,job,mediaInput);return {ok:true};}
   catch(e){
    const wait=retryAfter(e);
    if(attempt<3&&isTransient(e)){
     const delay=wait>0?wait*1000:Math.min(8000,500*Math.pow(2,attempt));
     logger.warn({botId,userId:uid,attempt:attempt+1,delay,error:sanitizeError(e?.message)},'Broadcast send transient failure; retrying');
     await sleep(delay);if(stopped)return {stopped:true};continue;
    }
    return {ok:false,error:sanitizeError(e?.response?.error_code??e?.code??e?.message??'send_failed').slice(0,120)};
   }
  }
  return {ok:false,error:'retry_exhausted'};
 }
 async function processOne(){
  const job=await claimCreatorBroadcast(pool,botId);if(!job)return false;
  try{
   const mediaInput=await resolveCampaignMedia(job);
   while(!stopped){
    if(await getBroadcastState(pool,job.id)!=='processing')break;
    const users=await claimBroadcastRecipients(pool,job.id,25);if(!users.length)break;
    for(const u of users){
     if(stopped||await getBroadcastState(pool,job.id)!=='processing')break;
     const result=await sendWithRetry(u.telegram_user_id,job,mediaInput);
     if(result.stopped)break;
     await markBroadcastRecipient(pool,job.id,u.telegram_user_id,result.ok?'sent':'failed',result.error??null);
     await sleep(100);
    }
   }
   await finalizeCreatorBroadcast(pool,job.id);
  }catch(e){
   const safeErr=sanitizeError(e?.message);
   logger.error({broadcastId:job.id,error:safeErr},'Creator broadcast worker failed');
   await pool.query("UPDATE creator_broadcasts SET status='pending',last_error=$2 WHERE id=$1 AND status='processing'",[job.id,safeErr]).catch(()=>{});
  }
  return true;
 }
 async function run(){if(stopped)return;if(busy){pending=true;return;}busy=true;pending=false;try{while(!stopped){const had=await processOne();if(!had)break;}}catch(e){logger.error({botId,error:sanitizeError(e?.message)},'Broadcast worker loop error');}finally{busy=false;if(!stopped&&pending)void run();}}
 function wake(){if(stopped)return;pending=true;if(!busy)void run();}
 return {start(){if(!stopped)return;stopped=false;unsubscribe=subscribeDeliveryWorkerWake(wake);timer=setInterval(wake,60000);timer.unref?.();void (async()=>{await pool.query("UPDATE creator_broadcasts SET status='pending' WHERE delivery_bot_id=$1 AND status='processing'",[botId]);await pool.query("UPDATE creator_broadcast_recipients SET status='pending' WHERE broadcast_id IN (SELECT id FROM creator_broadcasts WHERE delivery_bot_id=$1) AND status='sending'",[botId]);await run();})().catch(e=>logger.warn({botId,error:sanitizeError(e?.message)},'Broadcast recovery failed'));logger.info({botId},'Creator broadcast worker started');},stop(){stopped=true;if(timer)clearInterval(timer);timer=undefined;unsubscribe?.();unsubscribe=undefined;}};
}
