// 聊天贴图：先在浏览器里压一遍再上传，免得原图几 MB 直接怼到 Function 的请求体上限上。
// 边缘 1400 够模型读图；JPEG 逐级降质直到 base64 落进服务端 800_000 字符限制。
// GIF 原样透传——重编码会丢掉动图，宁可让用户换一张。
import type { I18n } from "./i18n";

const MAX_EDGE = 1400;
const MAX_B64_CHARS = 800_000;
const QUALITIES = [0.85, 0.7, 0.55];
const ACCEPTED = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export type PickedImage = { name: string; content_type: string; data: string };

// 这几个纯函数在 React 之外抛错，语言只能当参数传进来：模块级存一份 i18n 就成了没人认领的单例。
function readDataUrl(i18n: I18n, blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error(i18n.t("image.readFailed")));
    reader.readAsDataURL(blob);
  });
}

function loadImage(i18n: I18n, src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(i18n.t("image.decodeFailed")));
    image.src = src;
  });
}

const base64Of = (dataUrl: string) => dataUrl.split(",")[1]?.trim() ?? "";

const safeName = (name: string) => (name.split(/[\\/]/).pop() ?? "image").slice(0, 80) || "image";

export async function shrinkImage(i18n: I18n, file: File): Promise<PickedImage> {
  if (!ACCEPTED.includes(file.type)) throw new Error(i18n.t("image.formatUnsupported"));
  const dataUrl = await readDataUrl(i18n, file);
  if (file.type === "image/gif") {
    const data = base64Of(dataUrl);
    if (!data || data.length > MAX_B64_CHARS) throw new Error(i18n.t("image.gifTooLarge"));
    return { name: safeName(file.name), content_type: "image/gif", data };
  }
  const image = await loadImage(i18n, dataUrl);
  const scale = Math.min(1, MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error(i18n.t("image.canvasUnsupported"));
  // JPEG 没有透明通道，先铺白底，免得 PNG 贴图变黑块。
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  for (const quality of QUALITIES) {
    const data = base64Of(canvas.toDataURL("image/jpeg", quality));
    if (data && data.length <= MAX_B64_CHARS) {
      return {
        name: `${safeName(file.name).replace(/\.\w+$/, "") || "image"}.jpg`,
        content_type: "image/jpeg",
        data,
      };
    }
  }
  throw new Error(i18n.t("image.stillTooLarge"));
}

/** 一次粘贴/选择可能带进来一串文件：非图片和超出 4 张的都计入 skipped，由界面如实说明。 */
export async function shrinkImages(i18n: I18n, files: File[]): Promise<{ images: PickedImage[]; skipped: number }> {
  const images: PickedImage[] = [];
  let skipped = 0;
  for (const file of files) {
    if (!file.type.startsWith("image/") || images.length >= 4) {
      skipped += 1;
      continue;
    }
    images.push(await shrinkImage(i18n, file));
  }
  return { images, skipped };
}
