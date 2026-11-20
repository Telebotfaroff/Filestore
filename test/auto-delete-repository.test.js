import test from 'node:test';
import assert from 'node:assert/strict';
import { claimDueDeletion, finishScheduledDeletion, failScheduledDeletion } from '../src/delivery/auto-delete-repository.js';

test('deletion claim records a unique lease owner and returns it', async () => {
  const calls=[];
  const pool={query:async(sql,args)=>{calls.push({sql,args});return {rows:[{id:9,chat_id:123,message_id:456}]};}};
  const claim=await claimDueDeletion(pool,'@delivery','worker-a');
  assert.deepEqual(claim,{id:9,chatId:123,messageId:456,leaseOwner:'worker-a'});
  assert.match(calls[0].sql,/locked_by = \$2/);
  assert.deepEqual(calls[0].args,['@delivery','worker-a']);
});

test('deletion completion only succeeds for the current unexpired lease', async()=>{
  let call;
  const pool={query:async(sql,args)=>{call={sql,args};return {rowCount:1};}};
  assert.equal(await finishScheduledDeletion(pool,9,'worker-a'),true);
  assert.match(call.sql,/status = 'processing' AND locked_by = \$2 AND locked_until > NOW\(\)/);
  assert.deepEqual(call.args,[9,'worker-a']);
});

test('stale deletion completion is reported as lost lease', async()=>{
  const pool={query:async()=>({rowCount:0})};
  assert.equal(await finishScheduledDeletion(pool,9,'old-worker'),false);
});

test('deletion failure writes are lease-guarded and bounded', async()=>{
  let call;
  const pool={query:async(sql,args)=>{call={sql,args};return {rowCount:1};}};
  assert.equal(await failScheduledDeletion(pool,9,'worker-a','network error'),true);
  assert.match(call.sql,/locked_by = \$2 AND locked_until > NOW\(\)/);
  assert.match(call.sql,/attempt_count >= 5/);
  assert.deepEqual(call.args,[9,'worker-a','network error']);
});

test('stale deletion failure cannot overwrite newer claim',async()=>{
  const pool={query:async()=>({rowCount:0})};
  assert.equal(await failScheduledDeletion(pool,9,'old-worker','late error'),false);
});
