// 本机把真实业务 handler 跑在 Node 上（部署时同样的 handler 由 Deno Edge 承载）。
// 用法：node dev/local-function.mjs [端口] [数据文件]
// 数据文件默认 dev/.wsdb.json，清空它即可重来；这里没有任何云端凭据。
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { makeHandler } from "../functions/handler.mjs";
import { createFixtureClient } from "./fixture-supabase.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 8000);
const file = resolve(process.argv[3] ? process.argv[3] : join(here, ".wsdb.json"));

process.env.WORKSTREAM_DEV = "1";
const supabase = createFixtureClient(file);
const handler = makeHandler({ env: (name) => process.env[name] });

const server = createServer(async (req, res) => {
  const origin = `http://${req.headers.host ?? `127.0.0.1:${port}`}`;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = new Request(new URL(req.url, origin), {
    method: req.method,
    headers: new Headers(Object.entries(req.headers)
      .filter(([key]) => key !== "host")
      .map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : value])),
    body: ["POST", "PATCH", "PUT", "DELETE"].includes(req.method) ? Buffer.concat(chunks) : undefined,
  });
  try {
    const response = await handler({ request, supabase });
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: false, error: "local_function_crash", note: String(error?.message ?? error) }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`WorkStream local Function: http://127.0.0.1:${port}/functions/v1/app?action=site.meta`);
  console.log(`本地数据库文件：${file}`);
});
