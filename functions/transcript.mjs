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

/** 单条记录渲染后的字符数（不含行间的分隔符，加多少由调用处按用法决定）。 */
export const rowChars = (row) => renderLine(row).length;
