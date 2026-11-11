// .json 预览：能解析就按两空格缩进铺开，解析不了就落回纯文本——坏 JSON 至少还能看见原文。
import { registerFileRenderer } from "../fileRenderers.mjs";

registerFileRenderer({
  id: "json-file",
  order: 40,
  match: (file) => /\.json$/i.test(file.name ?? "") || /^application\/(ld\+)?json/i.test(file.content_type ?? ""),
  render: (file) => {
    try {
      return { kind: "text", text: JSON.stringify(JSON.parse(String(file.content ?? "")), null, 2) };
    } catch {
      return null;
    }
  },
});
