// 模型真正看到的那条请求：把每条 message 的文本按顺序拼起来。
//
// 为什么要有这个函数：易变块落在用户位的运行时快照里（functions/prompt.mjs），
// 断言若只读 messages[0]（system），改一次装配就全绿着失效——压测就吃过这个亏。
export function wireOf(body) {
  return (body?.messages ?? [])
    .map((message) => (typeof message?.content === "string" ? message.content : ""))
    .join("\n\n");
}
