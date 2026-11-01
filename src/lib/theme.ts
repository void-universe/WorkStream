// 主题：与 index.html 的首帧脚本共用同一份 localStorage 偏好，
// 同时写 data-theme（CSS 变量）和 .dark（Tailwind dark: 变体）。
export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "workstream.theme";

export function readThemeMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

function prefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolvedTheme(mode: ThemeMode): "light" | "dark" {
  return mode === "system" ? (prefersDark() ? "dark" : "light") : mode;
}

export function applyTheme(mode: ThemeMode): "light" | "dark" {
  const theme = resolvedTheme(mode);
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  root.classList.toggle("dark", theme === "dark");
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* 隐私模式下只用当前会话 */
  }
  return theme;
}

export function onSystemThemeChange(onChange: () => void): () => void {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
