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

test('deletion retries use exponential backoff and terminal failures stop retrying',async()=>{
  let call;
  const pool={query:async(sql,args)=>{call={sql,args};return {rowCount:1};}};
  assert.equal(await failScheduledDeletion(pool,5,'worker-b','timeout'),true);
  assert.match(call.sql,/retry_after\\s*=\\s*CASE WHEN attempt_count >= 5 THEN NULL ELSE NOW\\(\\) \\+ make_interval/);
  assert.match(call.sql,/LEAST\(3600/);
  assert.deepEqual(call.args,[5,'worker-b','timeout']);
});

test('failed deletion inspection query is bounded and returns only terminal failures',async()=>{
  let call;
  const pool={query:async(sql,args)=>{call={sql,args};return {rows:[{id:1,status:'failed'}]};}};
  const rows=await (await import('../src/delivery/auto-delete-repository.js')).listFailedScheduledDeletions(pool,999);
  assert.equal(rows.length,1);
  assert.match(call.sql,/WHERE status = 'failed'/);
  assert.match(call.sql,/LIMIT \$1/);
  assert.deepEqual(call.args,[25]);
});
