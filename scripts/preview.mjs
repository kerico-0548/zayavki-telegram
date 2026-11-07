import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
const root = resolve("public"), port = Number(process.env.PORT || 4173);
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
http.createServer(async (req,res) => {
  try { let pathname = decodeURIComponent(new URL(req.url,"http://localhost").pathname); if (pathname.endsWith("/")) pathname += "index.html";
    const file = resolve(root, "." + pathname); if (!file.startsWith(root + sep)) throw new Error();
    const body = await readFile(file); res.writeHead(200,{"Content-Type":types[extname(file)]||"application/octet-stream","Cache-Control":"no-store"});res.end(body);
  } catch { res.writeHead(404);res.end("Not found"); }
}).listen(port,"127.0.0.1",()=>console.log("Local: http://127.0.0.1:" + port));

