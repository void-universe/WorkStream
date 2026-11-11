// 消息渲染器注册表：谁能渲染一条消息由插件自己声明，view 不认识任何具体格式。
//
// 与 fileRenderers 同一套纪律：重复 id 抛错、缺字段在 list 时抛错、dispose 只摘自己那条；
// 按 priority 升序取第一个 match，都不命中就落到内置纯文本——插件坏掉最多退回原样，不会让消息空白。
import type { ReactNode } from "react";

export type MessageRenderer = {
  id: string;
  priority: number;
  match: (message: MessageLike) => boolean;
  render: (props: MessageRenderProps) => ReactNode;
};

export type MessageLike = {
  content: string;
  kind?: string | null;
  sender_type?: string | null;
};

export type MessageRenderProps = {
  message: MessageLike;
  mentions?: string[];
};

const renderers = new Map<string, MessageRenderer>();

export function registerMessageRenderer(renderer: MessageRenderer): () => void {
  if (!renderer || typeof renderer !== "object") throw new Error("message_renderer_invalid");
  for (const field of ["id", "match", "render"] as const) {
    if (!renderer[field]) throw new Error(`message_renderer_missing_${field}`);
  }
  if (renderers.has(renderer.id)) throw new Error(`message_renderer_duplicate_${renderer.id}`);
  const entry: MessageRenderer = {
    ...renderer,
    priority: Number.isFinite(renderer.priority) ? renderer.priority : 100,
  };
  renderers.set(entry.id, entry);
  return () => {
    if (renderers.get(entry.id) === entry) renderers.delete(entry.id);
  };
}

export function listMessageRenderers(): Array<{ id: string; priority: number }> {
  return [...renderers.values()]
    .sort((a, b) => a.priority - b.priority)
    .map(({ id, priority }) => ({ id, priority }));
}

export function messageRendererFor(message: MessageLike): MessageRenderer | null {
  for (const renderer of [...renderers.values()].sort((a, b) => a.priority - b.priority)) {
    try {
      if (renderer.match(message)) return renderer;
    } catch {
      // 插件自己的判断炸了只影响它自己：继续试下一个，最后仍有纯文本兜底。
      continue;
    }
  }
  return null;
}
