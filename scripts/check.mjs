import {readFile,readdir} from "node:fs/promises";
import {spawnSync} from "node:child_process";
const files=["public/app.js","public/config.js","supabase/functions/_shared/core.js"];
for(const f of files){ const r=spawnSync(process.execPath,["--check",f],{stdio:"inherit"});if(r.status)process.exit(r.status);}
const html=await readFile("public/index.html","utf8");
for(const path of ["./styles.css","./config.js","./app.js"])if(!html.includes(path))throw new Error("Missing asset "+path);
for(const f of await readdir("public")){
 if(/\.js$|\.html$|\.css$/.test(f)){
  const s=await readFile("public/"+f,"utf8");
  if(/\b\d{7,12}:[A-Za-z0-9_-]{25,}\b|sb_secret_|service_role\s*[:=]|SUPABASE_SERVICE_ROLE_KEY/.test(s))throw new Error("Possible secret in public/"+f);
 }
}
console.log("Синтаксис, ресурсы и публичные файлы проверены");

