// 本地技能源：给远端 Market 做手工验收用（`npm run dev:registry`），然后在 Market → 技能 → 远端源里
// 填 http://127.0.0.1:8123/index.json。只在 WORKSTREAM_DEV=1 的服务端上可用——线上只收 https，内网地址会被 SSRF 规则拦掉。
// index.json 每次现读磁盘，改一下版本号不重启就能看到「可更新」。
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || "8123");

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  res.setHeader("cache-control", "no-store");
  const send = (status, type, file) => {
    try {
      const body = readFileSync(join(here, file), "utf8");
      res.writeHead(status, { "content-type": type });
      res.end(body);
    } catch (error) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end(`not found: ${error.message}`);
    }
  };
  if (path === "/index.json") send(200, "application/json", "fixture-registry/index.json");
  else if (path.startsWith("/skills/")) send(200, "text/markdown; charset=utf-8", `fixture-registry/skills/${path.slice("/skills/".length)}`);
  else {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`本地技能源：http://127.0.0.1:${port}/index.json`));
