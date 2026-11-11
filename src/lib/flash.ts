// Stream 面板的群状态闪烁颜色：按群存在本机，没配就走主题里的 --flash-* 默认色。
import type { CSSProperties } from "react";

export type FlashScene = "queued" | "mention" | "live";
export type FlashColors = Partial<Record<FlashScene, string>>;

const KEY = "workstream.flash";
const HEX = /^#[0-9a-f]{6}$/i;
const SCENES: FlashScene[] = ["queued", "mention", "live"];

export function readFlashColors(): Record<string, FlashColors> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>;
    const result: Record<string, FlashColors> = {};
    for (const [streamId, value] of Object.entries(raw)) {
      if (!streamId || typeof value !== "object" || value === null) continue;
      const entry: FlashColors = {};
      for (const scene of SCENES) {
        const color = (value as Record<string, unknown>)[scene];
        if (typeof color === "string" && HEX.test(color)) entry[scene] = color.toLowerCase();
      }
      if (SCENES.some((scene) => entry[scene])) result[streamId] = entry;
    }
    return result;
  } catch {
    return {};
  }
}

export function readStreamFlash(streamId: string): FlashColors {
  return readFlashColors()[streamId] ?? {};
}

export function saveFlashColors(streamId: string, colors: FlashColors) {
  const all = readFlashColors();
  if (SCENES.some((scene) => colors[scene])) all[streamId] = colors;
  else delete all[streamId];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // 颜色只是本机偏好，存不下就用默认色。
  }
}

export function flashVars(colors?: FlashColors): CSSProperties | undefined {
  if (!colors || !SCENES.some((scene) => colors[scene])) return undefined;
  const style = {} as CSSProperties & Record<string, string>;
  for (const scene of SCENES) {
    if (colors[scene]) style[`--flash-${scene}`] = colors[scene];
  }
  return style;
}

export function defaultFlashColors(): Required<FlashColors> {
  const styles = getComputedStyle(document.documentElement);
  const read = (scene: FlashScene, fallback: string) =>
    (styles.getPropertyValue(`--flash-${scene}`).trim() || fallback).toLowerCase();
  return {
    queued: read("queued", "#d97706"),
    mention: read("mention", "#ca8a04"),
    live: read("live", "#15803d"),
  };
}
