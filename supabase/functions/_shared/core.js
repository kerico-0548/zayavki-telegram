const STATUS = { new: "Новая", in_progress: "В работе", done: "Завершена" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export async function sha256(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map(x => x.toString(16).padStart(2,"0")).join("");
}
export async function tokenFor(key, secret) {
  const k = await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC",k,new TextEncoder().encode(key)));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+","-").replaceAll("/","_").replaceAll("=","");
}
export async function equalSecret(a,b) {
  if (!a || !b || a.length>512 || b.length>512) return false;
  const x=await sha256(a),y=await sha256(b); let diff=0;
  for(let i=0;i<x.length;i++) diff|=x.charCodeAt(i)^y.charCodeAt(i);
  return diff===0;
}
export function normalize(update) {
  if (!Number.isSafeInteger(update?.update_id)) return null;
  const cb=update.callback_query, message=cb?.message || update.message;
  const from=cb?.from || message?.from;
  if (!message || message.chat?.type!=="private" || !Number.isSafeInteger(from?.id)
    || from.is_bot || message.chat.id!==from.id) return null;
  const event={updateId:update.update_id,actor:from.id,chat:message.chat.id,action:"help"};
  if (cb) {
    const [cmd,id,arg]=String(cb.data||"").split(":");
    if ((cmd==="l" || cmd==="m") && ["all","new","in_progress","done"].includes(id) && /^\d{1,4}$/.test(arg||"")) {
      return {...event,action:cmd==="l"?"list":"mine",filter:id,page:Number(arg)};
    }
    if (cmd==="r" && /^\d{1,16}$/.test(id||"")) return {...event,action:"retry",job:id};
    if (!UUID.test(id||"")) return event;
    if(cmd==="v") return {...event,action:"view",ticket:id};
    if(cmd==="p") return {...event,action:"prompt",ticket:id};
    if(cmd==="h" && /^\d{1,4}$/.test(arg||"")) return {...event,action:"history",ticket:id,page:Number(arg)};
    if(cmd==="s" && ["new","in_progress","done"].includes(arg)) return {...event,action:"status",ticket:id,status:arg};
    return event;
  }
  const text=String(message.text||"").trim();
  const [command,arg]=text.split(/\s+/,2);
  const cmd=command?.split("@")[0];
  if(cmd==="/id") return {...event,action:"id"};
  if(cmd==="/requests") return {...event,action:"list",filter:"all",page:0};
  if(cmd==="/my") return {...event,action:"mine",filter:"all",page:0};
  if(cmd==="/retry") return {...event,action:"retry",...(/^\d{1,16}$/.test(arg||"")?{job:arg}:{})};
  if(cmd==="/start" && /^[A-Za-z0-9_-]{43}$/.test(arg||"")) return {...event,action:"start",token:arg};
  if(message.reply_to_message?.message_id) return {...event,action:"reply",replyTo:message.reply_to_message.message_id,body:text};
  return event;
}
const button=(text,data)=>({text,callback_data:data});
const inline=rows=>({inline_keyboard:rows});
function cardButtons(t,role) {
  const rows=[[button(role==="admin"?"Ответить":"Написать уточнение","p:"+t.id),button("История","h:"+t.id+":0")]];
  if(role==="admin") rows.push([button("В работу","s:"+t.id+":in_progress"),button("Завершить","s:"+t.id+":done")]);
  rows.push([button("К списку",(role==="admin"?"l":"m")+":all:0")]);
  return inline(rows);
}
export function render(job) {
  const d=job.data,t=d.ticket;
  const result={chat_id:job.chat_id};
  switch(job.kind) {
    case "text": return {...result,text:d.text};
    case "help": return {...result,text:"Выберите обращение: /my"+(d.role==="admin"?"\nВсе заявки: /requests\nОшибки доставки: /retry":"")+"\nДля ответа откройте заявку и нажмите кнопку. Новое обращение можно оставить на сайте."};
    case "card": return {...result,text:d.heading+" №"+t.number+"\n"+STATUS[t.status]+"\n\n"+t.name+"\n"+t.subject+"\n\n"+t.body,reply_markup:cardButtons(t,d.role)};
    case "prompt": return {...result,text:"Ответ по заявке №"+t.number+"\n«"+t.subject+"»\n\nНапишите сообщение ответом на эту подсказку (до 2000 символов).",reply_markup:{force_reply:true,selective:true,input_field_placeholder:"Текст ответа"}};
    case "forward": return {...result,text:(d.author==="admin"?"Ответ владельца":"Уточнение клиента")+" · №"+t.number+"\n"+t.subject+"\n\n"+d.body,reply_markup:inline([[button(d.author==="admin"?"Написать уточнение":"Ответить","p:"+t.id),button("Обращение","v:"+t.id)]])};
    case "status": return {...result,text:"Заявка №"+t.number+"\nНовый статус: "+STATUS[t.status],reply_markup:inline([[button("Открыть","v:"+t.id)]])};
    case "history": return {...result,text:"История · №"+d.number+"\n"+(d.author==="admin"?"Владелец":"Клиент")+"\n"+new Date(d.date).toLocaleString("ru-RU",{timeZone:"Europe/Moscow"})+"\n\n"+d.body};
    case "historynav": {
      const rows=[],nav=[];
      if(d.page>0)nav.push(button("← Ранее","h:"+t.id+":"+(d.page-1)));
      if(d.more)nav.push(button("Далее →","h:"+t.id+":"+(d.page+1)));
      if(nav.length)rows.push(nav);
      rows.push([button("К обращению","v:"+t.id)]);
      return {...result,text:"История заявки №"+t.number+" · страница "+(d.page+1),reply_markup:inline(rows)};
    }
    case "list": {
      const list=d.tickets.slice(0,8),rows=list.map(x=>[button("№"+x.number+" · "+x.subject.slice(0,35)+" · "+STATUS[x.status],"v:"+x.id)]);
      const prefix=d.role==="admin"?"l":"m",nav=[];
      if(d.page>0)nav.push(button("← Назад",prefix+":"+d.filter+":"+(d.page-1)));
      if(d.tickets.length>8)nav.push(button("Далее →",prefix+":"+d.filter+":"+(d.page+1)));
      if(nav.length)rows.push(nav);
      if(d.role==="admin")rows.push([button("Новые","l:new:0"),button("В работе","l:in_progress:0"),button("Все","l:all:0")]);
      return {...result,text:(d.role==="admin"?"Заявки владельца":"Ваши заявки")+"\n"+(list.length?"Выберите обращение · страница "+(d.page+1):"В этом списке пока нет заявок."),reply_markup:inline(rows)};
    }
    case "retrylist": return {...result,text:d.jobs.length?"Сообщения с ошибкой доставки. Нажмите для повтора.":"Ошибок доставки нет.",reply_markup:inline(d.jobs.map(x=>[button("Повторить №"+x.id+" · "+x.error_code,"r:"+x.id)]))};
    default: throw new Error("unknown_outbox_kind");
  }
}
export function makeRpc(url,key,fetcher=fetch) {
  return async(name,args={})=>{
    const response=await fetcher(url.replace(/\/$/,"")+"/rest/v1/rpc/"+name,{method:"POST",headers:{
      apikey:key,...(key.startsWith("eyJ")?{Authorization:"Bearer "+key}:{}),"Content-Type":"application/json"
    },body:JSON.stringify(args),signal:AbortSignal.timeout(12000)});
    if(!response.ok) throw new Error("database_"+response.status);
    const text=await response.text(); return text?JSON.parse(text):null;
  };
}
export function telegram(token,fetcher=fetch) {
  return async(method,payload)=>{
    try {
      const response=await fetcher("https://api.telegram.org/bot"+token+"/"+method,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),signal:AbortSignal.timeout(12000)});
      const data=await response.json();
      if(!response.ok || !data.ok) throw new Error("telegram_"+(data.error_code||response.status));
      return data.result;
    } catch(error) { throw new Error(/^telegram_\d+$/.test(error.message)?error.message:"telegram_network"); }
  };
}
const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...headers}});
async function readJson(request) {
  if(!request.headers.get("content-type")?.includes("application/json")) throw new Error("bad_json");
  if(Number(request.headers.get("content-length"))>16000) throw new Error("bad_json");
  const text=await request.text(); if(text.length>16000) throw new Error("bad_json");
  return JSON.parse(text);
}
export async function drain(rpc,tg,admin) {
  for(let batch=0;batch<3;batch++) {
    const jobs=await rpc("nr_claim_outbox",{p_limit:8});
    if(!jobs?.length)break;
    await Promise.all(jobs.map(async job=>{
      try {
        const sent=await tg("sendMessage",render(job));
        await rpc("nr_delivered",{p_id:job.id,p_lease:job.lease_token,p_message:sent.message_id});
      } catch(error) {
        // Never store URLs, tokens, user text or arbitrary transport exceptions.
        const code=/^telegram_\d+$/.test(error.message)?error.message:"delivery_error";
        await rpc("nr_failed",{p_id:job.id,p_lease:job.lease_token,p_code:code,p_admin:admin});
      }
    }));
    if(jobs.length<8) {
      // Failures may have queued a notification; check once more.
      if(jobs.every(x=>x.kind==="text"))break;
    }
  }
  return (await rpc("nr_pending_count"))===0;
}
export function makeHandlers(env,{rpc, tg}={}) {
  const get=name=>env[name]||"";
  const db=rpc || makeRpc(get("SUPABASE_URL"),get("SERVER_DB_KEY")||get("SUPABASE_SERVICE_ROLE_KEY"));
  const bot=tg || telegram(get("BOT_TOKEN"));
  const admin=/^[1-9]\d{0,15}$/.test(get("ADMIN_CHAT_ID"))?Number(get("ADMIN_CHAT_ID")):null;
  let allowedOrigin="";try{allowedOrigin=new URL(get("SITE_URL")).origin;}catch{}
  const cors=origin=>({"Access-Control-Allow-Origin":origin,"Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type",Vary:"Origin"});
  return {
    async create(request) {
      const origin=request.headers.get("origin")||"";
      if(origin && origin!==allowedOrigin)return json({error:"Этот адрес сайта не подключён."},403);
      const headers=origin?cors(origin):{};
      if(request.method==="OPTIONS")return new Response(null,{status:204,headers});
      if(request.method!=="POST")return json({error:"Метод не поддерживается."},405,headers);
      if(!admin || !get("BOT_USERNAME") || get("FORM_SECRET").length<32)return json({error:"Приём обращений пока не подключён."},503,headers);
      try {
        const data=await readJson(request);
        if(data.website)return json({error:"Не удалось отправить форму."},400,headers);
        const {name,subject,body,requestKey}=data;
        if(typeof name!=="string"||!name.trim()||name.trim().length>80||typeof subject!=="string"||!subject.trim()||subject.trim().length>120||typeof body!=="string"||body.trim().length<5||body.trim().length>2000||!UUID.test(requestKey||""))return json({error:"Проверьте имя, тему и описание."},400,headers);
        const token=await tokenFor(requestKey,get("FORM_SECRET"));
        const ip=request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()||"unknown";
        const result=await db("nr_create_draft",{p_key:requestKey,p_name:name.trim(),p_subject:subject.trim(),p_body:body.trim(),p_hash:await sha256(token),p_ip_hash:await tokenFor("ip:"+ip,get("FORM_SECRET"))});
        if(result.error) {
          const errors={rate_limit:[429,"Слишком много обращений. Попробуйте позже."],expired:[410,"Ссылка устарела. Нажмите отправку ещё раз."],confirmed:[409,"Обращение уже подтверждено. Откройте /my в боте."],conflict:[409,"Данные формы изменились. Обновите страницу и попробуйте ещё раз."]};
          const [status,message]=errors[result.error]||[500,"Не удалось сохранить обращение."];
          return json({error:message},status,headers);
        }
        return json({telegramUrl:"https://t.me/"+get("BOT_USERNAME")+"?start="+token,expiresAt:result.expires_at},200,headers);
      } catch(error) {
        return json({error:error.message==="bad_json"||error instanceof SyntaxError?"Не удалось прочитать форму.":"Сервис временно недоступен. Ваше обращение пока не подтверждено."},error.message==="bad_json"||error instanceof SyntaxError?400:503,headers);
      }
    },
    async webhook(request) {
      if(request.method!=="POST")return json({error:"method"},405);
      if(!await equalSecret(request.headers.get("X-Telegram-Bot-Api-Secret-Token"),get("TG_WEBHOOK_SECRET")))return json({error:"unauthorized"},401);
      try {
        const update=await readJson(request);
        const event=normalize(update);
        if(event) {
          if(event.token) {event.tokenHash=await sha256(event.token);delete event.token;}
          if(update.callback_query?.id)await bot("answerCallbackQuery",{callback_query_id:update.callback_query.id}).catch(()=>{});
          await db("nr_handle_update",{p_event:event,p_admin:admin});
          const done=await drain(db,bot,admin);
          return json({ok:done},done?200:503);
        }
        return json({ok:true});
      } catch {return json({error:"retry"},503);}
    },
    async setup(request) {
      if(request.method!=="POST")return json({error:"method"},405);
      if(!await equalSecret(request.headers.get("X-Setup-Secret"),get("SETUP_SECRET")))return json({error:"unauthorized"},401);
      try {
        const {action}=await readJson(request);
        if(action==="register") {
          if(get("TG_WEBHOOK_SECRET").length<32)return json({error:"webhook_secret_missing"},400);
          await bot("setWebhook",{url:get("SUPABASE_URL").replace(/\/$/,"")+"/functions/v1/telegram-hook",secret_token:get("TG_WEBHOOK_SECRET"),allowed_updates:["message","callback_query"],max_connections:5});
          return json({ok:true});
        }
        if(action==="status") {
          const info=await bot("getWebhookInfo",{}),me=await bot("getMe",{});
          return json({ok:true,username:me.username,url:info.url,pendingUpdates:info.pending_update_count,lastErrorDate:info.last_error_date||null,hasLastError:Boolean(info.last_error_message)});
        }
        if(action==="test") {
          if(!admin)return json({error:"admin_missing"},400);
          await bot("sendMessage",{chat_id:admin,text:"NOBEL: подключение работает. Список заявок: /requests"});
          return json({ok:true});
        }
        return json({error:"unknown_action"},400);
      } catch {return json({error:"setup_failed_check_secrets"},502);}
    }
  };
}

