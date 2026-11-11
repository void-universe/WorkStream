// PDF 预览：链接型群文件直接用它的地址；存成 base64 的拼 data URL 交给浏览器自带的阅读器。
// 存储型群文件现在只收文本，二进制 PDF 传不进来（读到的是乱码），那种情况不接、落回纯文本。
import { registerFileRenderer } from "../fileRenderers.mjs";

const BASE64 = /^[A-Za-z0-9+/=\s]+$/;

registerFileRenderer({
  id: "pdf-file",
  order: 60,
  match: (file) => file.content_type === "application/pdf" || /\.pdf$/i.test(file.name ?? ""),
  render: (file) => {
    // 只存链接的素材字节不经过我们：地址就是预览源，弹窗用 iframe 让浏览器自己画。
    if (file.url) return { kind: "pdf", src: file.url };
    const content = String(file.content ?? "").trim();
    if (!content || /^%PDF-/.test(content)) return null;
    return BASE64.test(content)
      ? { kind: "pdf", src: `data:application/pdf;base64,${content.replace(/\s+/g, "")}` }
      : null;
  },
});
