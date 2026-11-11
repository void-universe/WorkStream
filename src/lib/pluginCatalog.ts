// Market「插件」区的渲染插件目录：manifest 是机器可读的那份（plugins/bundled/<id>/manifest.json），
// 屏幕上的文案在字典里。清单、目录与入口文件哈希由 `npm run check:schema` 三向对账。
import markdownMessage from "../../plugins/bundled/markdown-message/manifest.json";
import markdownFile from "../../plugins/bundled/markdown-file/manifest.json";
import csvFile from "../../plugins/bundled/csv-file/manifest.json";
import jsonFile from "../../plugins/bundled/json-file/manifest.json";
import imageFile from "../../plugins/bundled/image-file/manifest.json";
import pdfFile from "../../plugins/bundled/pdf-file/manifest.json";
import type { MsgKey } from "./i18n";

export type BundledPluginManifest = {
  schema: number;
  id: string;
  /** message-renderer：消息气泡怎么画；file-renderer：群文件预览怎么画。 */
  kind: string;
  version: string;
  /** 入口文件相对仓库根；integrity 就是它的 sha256（SRI 格式）。 */
  entry: string;
  integrity: string;
};

export type BundledPlugin = {
  manifest: BundledPluginManifest;
  nameKey: MsgKey;
  summaryKey: MsgKey;
};

export const BUNDLED_PLUGINS: BundledPlugin[] = [
  {
    manifest: markdownMessage,
    nameKey: "plugin.markdownMessage.name",
    summaryKey: "plugin.markdownMessage.summary",
  },
  {
    manifest: markdownFile,
    nameKey: "plugin.markdownFile.name",
    summaryKey: "plugin.markdownFile.summary",
  },
  {
    manifest: csvFile,
    nameKey: "plugin.csvFile.name",
    summaryKey: "plugin.csvFile.summary",
  },
  {
    manifest: jsonFile,
    nameKey: "plugin.jsonFile.name",
    summaryKey: "plugin.jsonFile.summary",
  },
  {
    manifest: imageFile,
    nameKey: "plugin.imageFile.name",
    summaryKey: "plugin.imageFile.summary",
  },
  {
    manifest: pdfFile,
    nameKey: "plugin.pdfFile.name",
    summaryKey: "plugin.pdfFile.summary",
  },
];

/** manifest 原文：复制走剪贴板，下载走 data URL，都不依赖站点有没有托管那份文件。 */
export function manifestText(manifest: BundledPluginManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function manifestDownloadUrl(manifest: BundledPluginManifest): string {
  return `data:application/json;charset=utf-8,${encodeURIComponent(manifestText(manifest))}`;
}
