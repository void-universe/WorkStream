// A minimal OpenAI-compatible upstream for exercising the migration path without a real model.
// It streams one chunk, a finish chunk, a usage chunk and [DONE], which is exactly the shape
// functions/agents.mjs reads, so a migrated executor can be checked end to end on a laptop.
//
// Usage: node dev/fake-openai.mjs [port]   (default 8791, listens on 127.0.0.1)
// FAKE_LOG=<file> appends every request body as one JSON line, which is how a test can prove that
// the prompt still carried the employee's memory after a migration.
// FAKE_NEEDLE=<text> makes the reply say whether that text appeared anywhere in the request, which
// is how a test proves the conversation transcript travelled with the employee.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8791);
const logFile = process.env.FAKE_LOG ?? null;
const needle = process.env.FAKE_NEEDLE ?? "";

const frame = (res, payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

const server = createServer(async (req, res) => {
  if (req.method !== "POST" || !(req.url ?? "").endsWith("/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body = {};
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    // A malformed body still gets a reply: the point of this fixture is the transport, not validation.
  }
  const lastUser = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
  const wire = JSON.stringify(body);
  if (logFile) appendFileSync(logFile, `${wire}\n`);
  const prompt = typeof lastUser?.content === "string" ? lastUser.content : "";
  // chars + needle describe what the model could actually see in this request: after a migration
  // the transcript block must still be there, otherwise the conversation was cut.
  const seen = needle ? (wire.includes(needle) ? "seen" : "none") : "off";
  const reply = `fake upstream (${body.model ?? "no-model"}) chars=${wire.length} needle=${seen}: ${prompt.slice(0, 40) || "ping"}`;

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  frame(res, { choices: [{ index: 0, delta: { content: reply } }] });
  frame(res, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  frame(res, { choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } });
  res.write("data: [DONE]\n\n");
  res.end();
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fake openai upstream: http://127.0.0.1:${port}/v1`);
});
