// 群文件预览的渲染器注册表。
//
// 为什么是一张注册表而不是在预览弹窗里继续加 `if (ext === ...)`：弹窗那段代码原本只认纯文本，
// 每加一种格式就要改一次主流程，加的人还得先读懂那串三元判断。注册表把「这种文件怎么显示」收成一个
// 自带匹配条件与渲染函数的条目，主流程只负责按 order 找第一个肯接的。
//
// 注册是一个副作用，所以它必须返回一个精确的注销句柄：句柄只摘掉自己那一条（按对象身份比），
// 同名 id 后来被别人覆盖时不会误伤。自检靠它把「注册前看得见 → 注册后看得见 → 注销后消失」跑成真断言。
//
// render 是异步的：.drawio 的图体默认是 base64 + raw DEFLATE，解压只有异步 API（浏览器的
// DecompressionStream，Node 22 同名全局对象），把这条通道写死成同步就得在渲染器里自己撸解压。
// 返回 null 表示「匹配上了但这轮渲染不出来」，主流程照样落回纯文本，不静默吞掉。

/** @typedef {{ name: string, content_type: string, content: string, url?: string }} CandidateFile */
/** @typedef {{ kind: "svg", markup: string, summary: string }
 *   | { kind: "text", text: string, summary?: string }
 *   | { kind: "markdown", text: string }
 *   | { kind: "table", head: string[], rows: string[][], truncated: boolean }
 *   | { kind: "image", src: string, alt: string }
 *   | { kind: "pdf", src: string }} RenderedView */
/** @typedef {{ id: string, order: number, match: (file: CandidateFile) => boolean, render: (file: CandidateFile) => RenderedView | null | Promise<RenderedView | null> }} FileRenderer */

/** @type {Map<string, FileRenderer>} */
const registry = new Map();

/**
 * @param {FileRenderer} renderer
 * @returns {() => boolean} 精确注销：摘掉的就是传进来的这一条
 */
export function registerFileRenderer(renderer) {
  const { id, order, match, render } = renderer ?? {};
  if (typeof id !== "string" || !id) throw new Error("渲染器缺少 id");
  if (!Number.isInteger(order)) throw new Error(`渲染器 ${id} 的 order 不是整数`);
  if (typeof match !== "function" || typeof render !== "function") {
    throw new Error(`渲染器 ${id} 必须同时提供 match 与 render`);
  }
  if (registry.has(id)) throw new Error(`群文件渲染器 id 重复：${id}`);
  registry.set(id, renderer);
  return () => {
    if (registry.get(id) !== renderer) return false;
    registry.delete(id);
    return true;
  };
}

/** 当前生效的渲染器，按 order 升序；同 order 时按 id 定序，保证两次渲染顺序一致。 */
export function fileRenderers() {
  return [...registry.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/**
 * 交给第一个匹配且真能渲染的渲染器；没人接住就回 null，由调用方落回纯文本预览。
 * @param {CandidateFile} file
 */
export async function renderGroupFile(file) {
  for (const renderer of fileRenderers()) {
    if (!renderer.match(file)) continue;
    const view = await renderer.render(file);
    if (view) return { rendererId: renderer.id, view };
  }
  return null;
}
