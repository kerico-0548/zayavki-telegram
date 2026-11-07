import test from "node:test";
import assert from "node:assert/strict";
import {readFile,readdir} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";
import {makeHandlers,normalize,sha256,tokenFor,render} from "../supabase/functions/_shared/core.js";

const admin=9001,alice=1001,bob=1002;
let seq=1;
const env={BOT_TOKEN:"test-token",BOT_USERNAME:"nobel_test_bot",ADMIN_CHAT_ID:String(admin),
 SITE_URL:"https://example.github.io/requests/",SUPABASE_URL:"https://example.supabase.co",
 FORM_SECRET:"f".repeat(48),TG_WEBHOOK_SECRET:"t".repeat(48),SETUP_SECRET:"s".repeat(48)};
async function database(){
 const db=new PGlite();
 await db.exec("create role anon; create role authenticated; create role service_role;");
 for(const f of (await readdir("supabase/migrations")).sort())await db.exec(await readFile("supabase/migrations/"+f,"utf8"));
 const rpc=async(name,args={})=>{
   const keys=Object.keys(args);
   const sql="select public."+name+"("+keys.map((k,i)=>k+" => $"+(i+1)).join(",")+") as result";
   const values=keys.map(k=>typeof args[k]==="object"&&args[k]!==null?JSON.stringify(args[k]):args[k]);
   return (await db.query(sql,values)).rows[0].result;
 };
 return {db,rpc};
}
const payload=()=>({name:"Аня",subject:"Вопрос об уроке",body:"Хочу узнать расписание",requestKey:crypto.randomUUID()});
async function draft(rpc,data=payload(),ip="ip"){
 const token=await tokenFor(data.requestKey,env.FORM_SECRET);
 const result=await rpc("nr_create_draft",{p_key:data.requestKey,p_name:data.name,p_subject:data.subject,p_body:data.body,p_hash:await sha256(token),p_ip_hash:ip});
 return {data,token,result};
}
const event=(action,actor,extra={})=>({updateId:seq++,actor,chat:actor,action,...extra});
async function deliverAll(rpc,startId=100){
 const jobs=await rpc("nr_claim_outbox",{p_limit:12});
 for(const [i,j]of jobs.entries())await rpc("nr_delivered",{p_id:j.id,p_lease:j.lease_token,p_message:startId+i});
 return jobs;
}
test("Полный путь: форма, подтверждение, два клиента, ответы и статусы",async()=>{
 const {db,rpc}=await database();
 try{
  const d=await draft(rpc);
  await rpc("nr_handle_update",{p_event:event("start",alice,{tokenHash:await sha256(d.token)}),p_admin:admin});
  const tickets=(await db.query("select * from requests_app.tickets")).rows;
  assert.equal(tickets.length,1);assert.equal(tickets[0].status,"new");assert.equal(Number(tickets[0].client_chat_id),alice);
  const id=tickets[0].id;
  let jobs=await deliverAll(rpc);assert.equal(jobs.length,2);assert.ok(jobs.some(j=>Number(j.chat_id)===admin));
  await rpc("nr_handle_update",{p_event:event("view",bob,{ticket:id}),p_admin:admin});
  jobs=await deliverAll(rpc);assert.equal(jobs[0].kind,"help");assert.ok(!JSON.stringify(jobs[0].data).includes("Аня"));
  await rpc("nr_handle_update",{p_event:event("status",bob,{ticket:id,status:"done"}),p_admin:admin});
  await deliverAll(rpc);assert.equal((await db.query("select status from requests_app.tickets")).rows[0].status,"new");
  await rpc("nr_handle_update",{p_event:event("prompt",admin,{ticket:id}),p_admin:admin});
  jobs=await deliverAll(rpc,700);assert.equal(jobs[0].kind,"prompt");
  const reply=event("reply",admin,{replyTo:700,body:"Здравствуйте! Занятие в субботу"});
  await rpc("nr_handle_update",{p_event:reply,p_admin:admin});
  await rpc("nr_handle_update",{p_event:reply,p_admin:admin});
  jobs=await deliverAll(rpc);
  assert.equal(jobs.filter(j=>j.kind==="forward").length,1);
  assert.equal(Number(jobs.find(j=>j.kind==="forward").chat_id),alice);
  assert.equal((await db.query("select count(*) as n from requests_app.messages")).rows[0].n,1);
  await rpc("nr_handle_update",{p_event:event("prompt",alice,{ticket:id}),p_admin:admin});
  await deliverAll(rpc,800);
  await rpc("nr_handle_update",{p_event:event("reply",alice,{replyTo:800,body:"Спасибо, буду!"}),p_admin:admin});
  jobs=await deliverAll(rpc);assert.equal(Number(jobs.find(j=>j.kind==="forward").chat_id),admin);
  await rpc("nr_handle_update",{p_event:event("status",admin,{ticket:id,status:"done"}),p_admin:admin});
  jobs=await deliverAll(rpc);assert.equal(jobs.find(j=>j.kind==="status").data.ticket.status,"done");
 }finally{await db.close();}
});
test("Повтор формы и Start: без дубля, просроченная ссылка не привязывается",async()=>{
 const {db,rpc}=await database();
 try{
  const data=payload(),a=await draft(rpc,data),b=await draft(rpc,data);assert.equal(a.token,b.token);
  assert.equal((await db.query("select count(*) as n from requests_app.tickets")).rows[0].n,1);
  await rpc("nr_handle_update",{p_event:event("start",alice,{tokenHash:await sha256(a.token)}),p_admin:admin});
  await rpc("nr_handle_update",{p_event:event("start",bob,{tokenHash:await sha256(a.token)}),p_admin:admin});
  assert.equal(Number((await db.query("select client_chat_id from requests_app.tickets")).rows[0].client_chat_id),alice);
  const c=await draft(rpc);await db.query("update requests_app.tickets set expires_at=now()-interval '1 minute' where request_key=$1",[c.data.requestKey]);
  await rpc("nr_handle_update",{p_event:event("start",bob,{tokenHash:await sha256(c.token)}),p_admin:admin});
  assert.equal((await db.query("select status from requests_app.tickets where request_key=$1",[c.data.requestKey])).rows[0].status,"draft");
 }finally{await db.close();}
});
test("Ответы по двум заявкам одного клиента не перемешиваются",async()=>{
 const {db,rpc}=await database();
 try{
  const first=await draft(rpc),second=await draft(rpc,{...payload(),subject:"Другой вопрос"});
  for(const d of [first,second])await rpc("nr_handle_update",{p_event:event("start",alice,{tokenHash:await sha256(d.token)}),p_admin:admin});
  await deliverAll(rpc);
  const ts=(await db.query("select id,subject from requests_app.tickets order by number")).rows;
  await rpc("nr_handle_update",{p_event:event("prompt",admin,{ticket:ts[0].id}),p_admin:admin});await deliverAll(rpc,1000);
  await rpc("nr_handle_update",{p_event:event("prompt",admin,{ticket:ts[1].id}),p_admin:admin});await deliverAll(rpc,2000);
  await rpc("nr_handle_update",{p_event:event("reply",admin,{replyTo:1000,body:"Ответ на первый"}),p_admin:admin});
  await rpc("nr_handle_update",{p_event:event("reply",admin,{replyTo:2000,body:"Ответ на второй"}),p_admin:admin});
  const ms=(await db.query("select ticket_id,body from requests_app.messages order by id")).rows;
  assert.equal(ms[0].ticket_id,ts[0].id);assert.equal(ms[1].ticket_id,ts[1].id);
  await rpc("nr_handle_update",{p_event:event("reply",bob,{replyTo:1000,body:"Чужой ответ"}),p_admin:admin});
  assert.equal((await db.query("select count(*) as n from requests_app.messages")).rows[0].n,2);
 }finally{await db.close();}
});
test("Прямой доступ к таблицам и RPC закрыт для посетителя",async()=>{
 const {db}=await database();
 try{
  await db.exec("set role anon");
  await assert.rejects(()=>db.query("select * from requests_app.tickets"),/permission denied/);
  await assert.rejects(()=>db.query("select public.nr_claim_outbox(8)"),/permission denied/);
  await db.exec("reset role");
 }finally{await db.close();}
});
test("Сбой Telegram сохраняется; только владелец может повторить",async()=>{
 const {db,rpc}=await database();
 try{
  const d=await draft(rpc);await rpc("nr_handle_update",{p_event:event("start",alice,{tokenHash:await sha256(d.token)}),p_admin:admin});
  const jobs=await rpc("nr_claim_outbox",{p_limit:8}),job=jobs.find(j=>Number(j.chat_id)===alice);
  await rpc("nr_failed",{p_id:job.id,p_lease:job.lease_token,p_code:"telegram_403",p_admin:admin});
  assert.equal((await db.query("select state from requests_app.outbox where id=$1",[job.id])).rows[0].state,"failed");
  await rpc("nr_handle_update",{p_event:event("retry",bob,{job:String(job.id)}),p_admin:admin});
  assert.equal((await db.query("select state from requests_app.outbox where id=$1",[job.id])).rows[0].state,"failed");
  await rpc("nr_handle_update",{p_event:event("retry",admin,{job:String(job.id)}),p_admin:admin});
  assert.equal((await db.query("select state from requests_app.outbox where id=$1",[job.id])).rows[0].state,"pending");
 }finally{await db.close();}
});
test("HTTP: секреты webhook и настройки, валидация, CORS и настоящая форма",async()=>{
 const {db,rpc}=await database();const sent=[];
 const tg=async(method,args)=>{sent.push({method,args});return {message_id:sent.length,username:env.BOT_USERNAME};};
 const h=makeHandlers(env,{rpc,tg});
 const req=(url,body,headers={})=>new Request(url,{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)});
 try{
  const data=payload();
  let r=await h.create(req("https://fn",data,{origin:"https://example.github.io"}));assert.equal(r.status,200);
  const result=await r.json();assert.equal(new URL(result.telegramUrl).hostname,"t.me");
  const token=new URL(result.telegramUrl).searchParams.get("start");
  assert.ok(token.length<=64);
  r=await h.create(req("https://fn",payload(),{origin:"https://evil.example"}));assert.equal(r.status,403);
  r=await h.create(req("https://fn",{...payload(),body:"x"}));assert.equal(r.status,400);
  r=await h.webhook(req("https://fn",{update_id:1}));assert.equal(r.status,401);
  r=await h.setup(req("https://fn",{action:"register"}));assert.equal(r.status,401);
  const update={update_id:seq++,message:{message_id:10,chat:{id:alice,type:"private"},from:{id:alice,is_bot:false},text:"/start "+token}};
  r=await h.webhook(req("https://fn",update,{"X-Telegram-Bot-Api-Secret-Token":env.TG_WEBHOOK_SECRET}));assert.equal(r.status,200);
  assert.equal(sent.filter(x=>x.method==="sendMessage").length,2);
  r=await h.webhook(req("https://fn",update,{"X-Telegram-Bot-Api-Secret-Token":env.TG_WEBHOOK_SECRET}));assert.equal(r.status,200);
  assert.equal(sent.filter(x=>x.method==="sendMessage").length,2);
 }finally{await db.close();}
});
test("Нормализация игнорирует группы и подменённый chat_id; кнопки не принимают произвольные данные",()=>{
 assert.equal(normalize({update_id:1,message:{chat:{id:-5,type:"group"},from:{id:alice},text:"/requests"}}),null);
 assert.equal(normalize({update_id:1,message:{chat:{id:bob,type:"private"},from:{id:alice},text:"/requests"}}),null);
 const e=normalize({update_id:1,callback_query:{data:"p:not-a-uuid",from:{id:alice},message:{chat:{id:alice,type:"private"}}}});
 assert.equal(e.action,"help");
});
test("Переполнение формы ограничено сервером, частота запросов ограничена базой",async()=>{
 const {db,rpc}=await database();
 try{
  const h=makeHandlers(env,{rpc,tg:async()=>({message_id:1})});
  const r=await h.create(new Request("https://fn",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...payload(),body:"a".repeat(2001)})}));
  assert.equal(r.status,400);
  for(let i=0;i<10;i++)assert.ok((await draft(rpc,payload(),"same-ip")).result.ok);
  assert.equal((await draft(rpc,payload(),"same-ip")).result.error,"rate_limit");
 }finally{await db.close();}
});


test("Новый формат серверных ключей Supabase используется без подстановки в Bearer JWT",async()=>{
 const previous=globalThis.fetch;let headers;
 globalThis.fetch=async(url,options)=>{headers=options.headers;assert.ok(url.endsWith("/rest/v1/rpc/nr_create_draft"));return Response.json({ok:true,expires_at:"2026-11-07T12:00:00Z"});};
 try{
  const h=makeHandlers({...env,SUPABASE_SECRET_KEYS:JSON.stringify({default:"sb_secret_testonly"}),SUPABASE_SERVICE_ROLE_KEY:"legacy-should-not-be-used"});
  const r=await h.create(new Request("https://fn",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload())}));
  assert.equal(r.status,200);assert.equal(headers.apikey,"sb_secret_testonly");assert.equal(headers.Authorization,undefined);
 }finally{globalThis.fetch=previous;}
});

