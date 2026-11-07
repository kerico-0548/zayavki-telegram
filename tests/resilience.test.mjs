import test from "node:test";
import assert from "node:assert/strict";
import {readFile,readdir} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";

test("Очень быстрый ответ повторяется после сохранения привязки подсказки",async()=>{
 const db=new PGlite();
 try{
  await db.exec("create role anon;create role authenticated;create role service_role;");
  for(const f of (await readdir("supabase/migrations")).sort())await db.exec(await readFile("supabase/migrations/"+f,"utf8"));
  const query=async(e)=>db.query("select public.nr_handle_update($1::jsonb,9001)",[JSON.stringify(e)]);
  await db.exec("insert into requests_app.tickets(request_key,name,subject,body,token_hash,ip_hash,status,client_chat_id) values(gen_random_uuid(),'Клиент','Вопрос','Описание вопроса','hash','ip','new',1001)");
  const {id}=(await db.query("select id from requests_app.tickets")).rows[0];
  await query({updateId:1,actor:9001,chat:9001,action:"prompt",ticket:id});
  const jobs=(await db.query("select public.nr_claim_outbox(8) as jobs")).rows[0].jobs;
  const reply={updateId:2,actor:9001,chat:9001,action:"reply",replyTo:777,body:"Очень быстрый ответ"};
  await assert.rejects(()=>query(reply),/prompt_mapping_pending/);
  assert.equal((await db.query("select count(*) as n from requests_app.updates where update_id=2")).rows[0].n,0);
  await db.query("select public.nr_delivered($1,$2,777)",[jobs[0].id,jobs[0].lease_token]);
  await query(reply);
  assert.equal((await db.query("select body from requests_app.messages")).rows[0].body,"Очень быстрый ответ");
 }finally{await db.close();}
});
test("Очередь не выдаёт одно сообщение двум обработчикам и восстанавливает просроченную аренду",async()=>{
 const db=new PGlite();
 try{
  await db.exec("create role anon;create role authenticated;create role service_role;");
  for(const f of (await readdir("supabase/migrations")).sort())await db.exec(await readFile("supabase/migrations/"+f,"utf8"));
  await db.exec("insert into requests_app.outbox(effect_key,chat_id,kind,data) values('test',1001,'text','{\"text\":\"Тест\"}')");
  const first=(await db.query("select public.nr_claim_outbox(8) as jobs")).rows[0].jobs;
  const second=(await db.query("select public.nr_claim_outbox(8) as jobs")).rows[0].jobs;
  assert.equal(first.length,1);assert.equal(second.length,0);
  await db.exec("update requests_app.outbox set leased_until=now()-interval '1 second'");
  const recovered=(await db.query("select public.nr_claim_outbox(8) as jobs")).rows[0].jobs;
  assert.equal(recovered.length,1);assert.notEqual(first[0].lease_token,recovered[0].lease_token);
  await db.query("select public.nr_delivered($1,$2,11)",[first[0].id,first[0].lease_token]);
  assert.equal((await db.query("select state from requests_app.outbox")).rows[0].state,"processing");
 }finally{await db.close();}
});

