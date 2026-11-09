// 群转录对模型的那一种写法：一行一条，序号、发言者类型、名字、正文、附图数。
// 它同时是上下文的计费口径——装配窗口和超预算裁剪都按这一种写法的字符数扣预算，
// 所以三处必须用同一个函数，否则预算扣的量和服务真正发出去的量不一致。
export const imageMark = (row) => {
  const count = Array.isArray(row.attachments) ? row.attachments.length : 0;
  return count ? `（附 ${count} 图）` : "";
};

const renderLine = (row) =>
  `${row.kind === "system" ? "·" : "#"}${row.seq} [${row.sender_type === "agent" ? "虚拟" : row.sender_type === "human" ? "人" : "系统"}] ${row.sender_name}：${row.content}${imageMark(row)}`;

export function renderTranscript(rows) {
  return rows.map(renderLine).join("\n");
}

const LINE = /^([#·])(\d+) \[(人|虚拟|系统)\] ([^：]*)：(.*)$/;

// 拆回渲染好的转录。行格式只在这一个文件里定义，反向解析也得在这儿：
// 别处另写一份正则，渲染改一个字它就静默失配，读出来的是空而不是报错。
export function parseTranscript(text) {
  return String(text).split("\n")
    .map((line) => LINE.exec(line))
    .filter(Boolean)
    .map(([, , seq, kind, sender, body]) => ({
      seq: Number(seq),
      kind,
      sender,
      body: body.replace(/（附 \d+ 图）$/, ""),
    }));
}

/** 单条记录渲染后的字符数（不含行间的分隔符，加多少由调用处按用法决定）。 */
export const rowChars = (row) => renderLine(row).length;
