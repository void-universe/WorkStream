// Stream Server 参考实现的独立进程入口：一台不挂 WorkStream 数据库的分时执行器。
// 用法：node dev/stream-server.mjs [端口]
//   WORKSTREAM_STREAM_UPSTREAM_URL / _KEY  上游 OpenAI 兼容端点（必填）
//   WORKSTREAM_STREAM_UPSTREAM_MODEL       默认模型名（请求里没带 model 时用它）
//   WORKSTREAM_STREAM_SERVER_TOKEN         调它要带的 Bearer 令牌；不设且 WORKSTREAM_DEV!=1 就冷启动崩
//   WORKSTREAM_STREAM_LABEL / _MODELS      发现响应里的展示名与模型清单（_MODELS 逗号分隔）
//   WORKSTREAM_STREAM_TURN_TTL_MS / _TURN_MAX / _TIMEOUT_MS / _MAX_REQUEST_BYTES  有界表的四个旋钮
// 这里只读 env 与挂 HTTP：路由、帧与错误码全在 functions/streamserver.mjs，从规范表长出来。
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createStreamServer } from "../functions/streamserver.mjs";

/**
 * Web 标准的 Response → node:http。SSE 那条必须真流着写：整份缓冲完再发，客户端的增量、
 * 首字延迟与「静默 800ms 也问一次要不要停」就全都没了，规范里 shared 档的语义也就不成立。
 * 对端提前断开要销毁这条可读流——它连带取消 Web 侧的 ReadableStream，上游才不会继续白烧 token。
 */
export function listenStreamServer({ server, port = 0, host = "127.0.0.1", log = () => {} }) {
  const http = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = new Request(new URL(req.url, `http://${req.headers.host ?? `${host}:${port}`}`), {
      method: req.method,
      headers: new Headers(Object.entries(req.headers)
        .filter(([key]) => key !== "host")
        .map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : value])),
      body: ["POST", "PATCH", "PUT", "DELETE"].includes(req.method) ? Buffer.concat(chunks) : undefined,
      // duplex 是 node 里给带 body 的 Request 的必要开关，不是可选装饰。
      duplex: "half",
    });
    let response;
    try {
      response = await server.handle(request);
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "stream_server_crash", detail: String(error?.message ?? error) }));
      return;
    }
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    // node 只 writeHead 不发头，要等第一个字节。SSE 那条的头必须先出去：客户端的 fetch 是在收到响应头时
    // 才 resolve 的，头卡在缓冲区里，上游迟迟不吐第一个字时客户端连读循环都没进——叫停也就无从问起，
    // 只能干等到整轮超时。规范里 shared 档的「静默 800ms 也问一次」要求头立刻可见。
    res.flushHeaders();
    res.on("error", () => {});
    if (!response.body) {
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    const readable = Readable.fromWeb(response.body);
    res.on("close", () => {
      if (!readable.destroyed) readable.destroy();
    });
    readable.pipe(res);
  });
  return new Promise((resolveListen) => {
    http.listen(port, host, () => {
      // 端口 0 让内核挑一个：夹具与本机开发都靠它免冲突，所以读回来的必须是绑定后的实际端口。
      const bound = http.address()?.port ?? port;
      log(`stream server: http://${host}:${bound}${"/stream-server/v1"}`);
      resolveListen({
        origin: `http://${host}:${bound}`,
        port: bound,
        close: () => new Promise((done) => http.close(() => done())),
      });
    });
  });
}

const isEntry = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  const env = (name) => process.env[name];
  const positional = process.argv.slice(2).filter((item) => !item.startsWith("--"));
  const int = (name, fallback) => {
    const value = Number(env(name));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const server = createStreamServer({
    upstreamUrl: env("WORKSTREAM_STREAM_UPSTREAM_URL") ?? null,
    upstreamKey: env("WORKSTREAM_STREAM_UPSTREAM_KEY") ?? null,
    upstreamModel: env("WORKSTREAM_STREAM_UPSTREAM_MODEL") ?? null,
    token: env("WORKSTREAM_STREAM_SERVER_TOKEN") ?? null,
    dev: env("WORKSTREAM_DEV") === "1",
    label: env("WORKSTREAM_STREAM_LABEL") ?? null,
    models: env("WORKSTREAM_STREAM_MODELS")?.split(",").map((item) => item.trim()).filter(Boolean) ?? null,
    turnTtlMs: int("WORKSTREAM_STREAM_TURN_TTL_MS", undefined),
    turnMax: int("WORKSTREAM_STREAM_TURN_MAX", undefined),
    timeoutMs: int("WORKSTREAM_STREAM_TIMEOUT_MS", undefined),
    maxRequestBytes: int("WORKSTREAM_STREAM_MAX_REQUEST_BYTES", undefined),
  });
  const started = await listenStreamServer({
    server,
    port: Number(positional[0] ?? 8300),
    log: (line) => console.log(line),
  });
  console.log(`上游：${env("WORKSTREAM_STREAM_UPSTREAM_URL") ?? "未配置（每轮回 stream_upstream_unconfigured）"}`);
  console.log(`声明档位：${server.descriptor.profiles.map((entry) => entry.id).join("、")}`);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      console.log(`[stream-server] 收到 ${signal}，退出`);
      void started.close().then(() => process.exit(0));
    });
  }
}
