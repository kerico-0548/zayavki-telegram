import {readFile,writeFile,mkdir} from "node:fs/promises";
const core=await readFile("supabase/functions/_shared/core.js","utf8");
await mkdir(".local/dashboard",{recursive:true});
for(const [name,handler] of Object.entries({"create-application":"create","telegram-hook":"webhook","setup-telegram":"setup"})) {
  await writeFile(".local/dashboard/"+name+".ts",core+"\nDeno.serve(makeHandlers(Deno.env.toObject())."+handler+");\n");
}
console.log("Самостоятельные файлы для редактора Supabase: .local/dashboard/");

