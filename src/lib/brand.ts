// 顶栏品牌标的显示方式：实心块（默认）或嵌入式（透明底 + 跟随主题的字色）。
// 和主题一样是这台设备的偏好，只写 localStorage，不占服务端字段。
export type BrandMode = "block" | "embed";

const STORAGE_KEY = "workstream.brand";

export function readBrandMode(): BrandMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === "embed" ? "embed" : "block";
  } catch {
    return "block";
  }
}

export function writeBrandMode(mode: BrandMode) {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* 隐私模式下只保留当前会话 */
  }
}
