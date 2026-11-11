// .md / .markdown 预览：交给消息那条同款 markdown 渲染器，群文件里读到的字和聊天里看到的一致。
// 只回数据，不在这里动 React；howToDraw 由预览弹窗决定（view.kind === "markdown"）。
import { registerFileRenderer } from "../fileRenderers.mjs";

const looksMarkdown = (file) =>
  /\.(md|markdown)$/i.test(file.name ?? "") || /^text\/(x-)?markdown/i.test(file.content_type ?? "");

registerFileRenderer({
  id: "markdown-file",
  order: 20,
  match: looksMarkdown,
  // 空文件不接：落回纯文本那一支，弹窗里显示「（空文件）」而不是一张空白排版。
  render: (file) => (String(file.content ?? "").trim() ? { kind: "markdown", text: file.content } : null),
});
