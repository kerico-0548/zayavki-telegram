import {readFile,writeFile} from "node:fs/promises";
import {randomBytes,timingSafeEqual} from "node:crypto";
const file=".local/secrets.env",claimFile=".local/owner-claim.json";
const text=await readFile(file,"utf8");
const env=Object.fromEntries(text.replace(/^\uFEFF/,"").split(/\r?\n/).filter(x=>x && !x.startsWith("#") && x.includes("=")).map(x=>{const i=x.indexOf("=");return [x.slice(0,i),x.slice(i+1).trim()];}));
if(!env.BOT_TOKEN||!env.BOT_USERNAME)throw new Error("Заполните BOT_TOKEN и BOT_USERNAME в .local/secrets.env");
async function api(method){
 try{
  const r=await fetch("https://api.telegram.org/bot"+env.BOT_TOKEN+"/"+method,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}",signal:AbortSignal.timeout(15000)});
  const d=await r.json();if(!d.ok)throw new Error();
  return d.result;
 }catch{throw new Error("Telegram API недоступен или токен не подходит. Значения не выводятся.");}
}
if((await api("getWebhookInfo")).url)throw new Error("Webhook уже подключён. Используйте команду /id в боте и настройте ADMIN_CHAT_ID через Supabase.");
if(process.argv[2]==="check"){
 const claim=JSON.parse(await readFile(claimFile,"utf8"));
 if(claim.used && env.ADMIN_CHAT_ID){console.log(JSON.stringify({ownerVerified:true,alreadySaved:true}));process.exit(0);}
 if(Date.now()-claim.created>10*60*1000)throw new Error("Одноразовая ссылка устарела. Создайте новую.");
 const updates=await api("getUpdates");
 const candidates=updates.flatMap(u=>{
  const m=u.message;if(!m||m.chat?.type!=="private"||m.from?.id!==m.chat.id||m.from.is_bot||m.date*1000<claim.created-3000)return [];
  const x=Buffer.from(m.text||""),y=Buffer.from("/start "+claim.code);
  return x.length===y.length&&timingSafeEqual(x,y)?[String(m.from.id)]:[];
 });
 const ids=[...new Set(candidates)];
 if(ids.length!==1){console.log(JSON.stringify({ownerVerified:false,matchingStarts:ids.length}));process.exit(0);}
 let next=text.replace(/^ADMIN_CHAT_ID=.*$/m,"ADMIN_CHAT_ID="+ids[0]);
 if(!/^ADMIN_CHAT_ID=/m.test(next))next+="\nADMIN_CHAT_ID="+ids[0]+"\n";
 await writeFile(file,next);
 await writeFile(claimFile,JSON.stringify({used:true,created:claim.created}));
 console.log(JSON.stringify({ownerVerified:true,adminSaved:true}));
}else{
 const code="owner_"+randomBytes(24).toString("base64url");
 await writeFile(claimFile,JSON.stringify({code,created:Date.now()}));
 console.log("https://t.me/"+env.BOT_USERNAME.replace(/^@/,"")+"?start="+code);
}

