// 图片预览：群文件里存成 base64 的图片直接画出来；已经带 data: 前缀的原样用。
// 不是 base64（有人把二进制硬塞进文本列）就不接，落回纯文本，不画一张破图。
import { registerFileRenderer } from "../fileRenderers.mjs";

const BASE64 = /^[A-Za-z0-9+/=\s]+$/;

registerFileRenderer({
  id: "image-file",
  order: 50,
  match: (file) => /^image\//i.test(file.content_type ?? ""),
  render: (file) => {
    const content = String(file.content ?? "").trim();
    if (!content) return null;
    const src = /^data:/i.test(content)
      ? content
      : BASE64.test(content)
        ? `data:${file.content_type};base64,${content.replace(/\s+/g, "")}`
        : null;
    return src ? { kind: "image", src, alt: file.name ?? "" } : null;
  },
});
