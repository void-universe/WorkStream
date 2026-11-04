// .drawio（diagrams.net 的 mxGraphModel）结构预览。
//
// 只做结构，不做还原：把节点画成带标签的方框、把连线画成带箭头的直线，坐标取 mxGeometry。
// 不引第三方渲染库，是因为这条路径要把群文件的内容交给代码去解析——多一个依赖就多一个能执行
// 群内文本的攻击面，而结构预览只需要 mxCell 的属性。
//
// 颜色默认走 CSS 变量而不是写死的十六进制：这段 SVG 是插进应用 DOM 的，:root 上的主题变量能继承下来，
// 于是同一份图在亮暗两个主题下都看得清；文件里显式写了 fillColor/strokeColor 时才用作者的颜色。
import { registerFileRenderer } from "../fileRenderers.mjs";

/** mxCell 的开标签：属性值里可能有 >，所以按引号配对吃掉整段。 */
const CELL_TAG = /<mxCell\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const GEOMETRY_TAG = /<mxGeometry\b((?:[^>"']|"[^"]*"|'[^']*')*)>/;
const ATTRIBUTE = /([\w:.-]+)\s*=\s*"([^"]*)"/g;

const unescapeXml = (value) => String(value)
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const escapeXml = (value) => String(value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/**
 * 标签取纯文本：drawio 的 value 允许存富文本（style 里 html=1 时 `<b>` 真的会加粗）。
 * 只剥 ASCII 开头的标签，因为属性值在 attributes() 里已经解过一次实体——
 * `value="开始 &lt;测试&gt;"` 解出来是文本 `<测试>`，把它当标签剥掉就把用户写的东西吃了。
 */
const plainText = (value) => String(value ?? "")
  .replace(/<\/?[a-zA-Z][^>]*>/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const attributes = (source) => {
  const found = {};
  for (const match of source.matchAll(ATTRIBUTE)) found[match[1]] = unescapeXml(match[2]);
  return found;
};

const styleColor = (style, key) => {
  const match = new RegExp(`(?:^|;)${key}=([^;]+)`).exec(String(style ?? ""));
  const value = match?.[1];
  return !value || value === "none" ? null : value;
};

/** 图体可能是 base64 + raw DEFLATE（diagrams.net 默认压缩），也可能就是明文 XML。 */
async function diagramXml(body) {
  const text = body.trim();
  if (!text) return "";
  if (text.includes("<mxGraphModel") || text.includes("<mxCell")) return text;
  const bytes = Uint8Array.from(atob(text.replace(/\s+/g, "")), (char) => char.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const inflated = new TextDecoder().decode(await new Response(stream).arrayBuffer());
  try {
    return decodeURIComponent(inflated);
  } catch {
    return inflated;
  }
}

/** 从整份文件里取出各页模型：裸 mxGraphModel、mxfile 多页、压缩页都走这一条。 */
async function modelsOf(source) {
  const bare = /<mxGraphModel\b[\s\S]*?<\/mxGraphModel>/.exec(source);
  if (bare) return [bare[0]];
  const models = [];
  for (const page of source.matchAll(/<diagram\b[^>]*>([\s\S]*?)<\/diagram>/g)) {
    const xml = await diagramXml(page[1]);
    const model = /<mxGraphModel\b[\s\S]*?<\/mxGraphModel>/.exec(xml);
    // 结构预览只认 mxCell，所以页体哪怕不是完整 mxGraphModel（老版本直接放 root）也照样扫。
    if (xml) models.push(model ? model[0] : xml);
  }
  return models;
}

function cellsOf(modelSource) {
  const cells = [];
  for (const match of modelSource.matchAll(CELL_TAG)) {
    const attrs = attributes(match[1]);
    // 自闭合的 mxCell 没有子节点，几何只能在下一个 mxCell 里，绝不能把它误当自己的。
    const selfClosing = match[1].trimEnd().endsWith("/");
    let geometry = null;
    if (!selfClosing) {
      const from = match.index + match[0].length;
      const nextCell = modelSource.indexOf("<mxCell", from);
      const body = modelSource.slice(from, nextCell === -1 ? modelSource.length : nextCell);
      const found = GEOMETRY_TAG.exec(body);
      if (found) geometry = attributes(found[1]);
    }
    cells.push({ ...attrs, geometry });
  }
  return cells;
}

/**
 * @param {string} modelSource 一页 mxGraphModel 的 XML
 * @returns {{ vertices: any[], edges: any[], bounds: {x:number,y:number,w:number,h:number} } | null}
 */
function layoutOf(modelSource) {
  const vertices = [];
  const edges = [];
  for (const cell of cellsOf(modelSource)) {
    const geometry = cell.geometry;
    if (cell.vertex === "1" && geometry) {
      vertices.push({
        id: cell.id,
        label: plainText(cell.value),
        x: Number(geometry.x ?? 0),
        y: Number(geometry.y ?? 0),
        width: Number(geometry.width ?? 0),
        height: Number(geometry.height ?? 0),
        fill: styleColor(cell.style, "fillColor"),
        stroke: styleColor(cell.style, "strokeColor"),
      });
    } else if (cell.edge === "1" && cell.source && cell.target) {
      edges.push({ id: cell.id, source: cell.source, target: cell.target, label: plainText(cell.value) });
    }
  }
  if (!vertices.length) return null;
  const xs = vertices.map((v) => v.x);
  const ys = vertices.map((v) => v.y);
  const right = Math.max(...vertices.map((v) => v.x + v.width));
  const bottom = Math.max(...vertices.map((v) => v.y + v.height));
  return {
    vertices,
    edges,
    bounds: { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(right - Math.min(...xs), 1), h: Math.max(bottom - Math.min(...ys), 1) },
  };
}

const center = (vertex) => ({ x: vertex.x + vertex.width / 2, y: vertex.y + vertex.height / 2 });

/** 相对亮度（sRGB），只认 #rrggbb；认不出来回 null。 */
function luminanceOf(color) {
  const match = /^#([\da-f]{6})$/i.exec(String(color ?? "").trim());
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((byte) => {
    const c = byte / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/**
 * 标签颜色跟着节点自己的底色走，而不是跟着主题走：
 * drawio 的默认配色是浅粉彩，暗色主题下用 var(--foreground)（近白）写字就等于看不见。
 * 没写底色的节点用 var(--card)，主题色正好，交回 var(--foreground)。
 */
const labelColor = (fill) => {
  const light = luminanceOf(fill);
  if (light === null) return "var(--foreground)";
  return light > 0.3 ? "#141416" : "#f4f4f5";
};

function toSvg(layout) {
  const pad = 24;
  const { x, y, w, h } = layout.bounds;
  const byId = new Map(layout.vertices.map((vertex) => [vertex.id, vertex]));
  const parts = [];
  for (const edge of layout.edges) {
    const from = byId.get(edge.source);
    const to = byId.get(edge.target);
    if (!from || !to) continue;
    const a = center(from);
    const b = center(to);
    parts.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" marker-end="url(#ws-arrow)" />`);
    if (edge.label) {
      parts.push(`<text class="ws-edge-label" x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2 - 4}" text-anchor="middle">${escapeXml(edge.label.slice(0, 40))}</text>`);
    }
  }
  for (const vertex of layout.vertices) {
    const fill = vertex.fill ? escapeXml(vertex.fill) : "var(--card)";
    const stroke = vertex.stroke ? escapeXml(vertex.stroke) : "var(--border)";
    parts.push(
      `<rect x="${vertex.x}" y="${vertex.y}" width="${Math.max(vertex.width, 8)}" height="${Math.max(vertex.height, 8)}" rx="6" fill="${fill}" stroke="${stroke}" />`,
    );
    if (vertex.label) {
      const text = vertex.label.slice(0, 60);
      parts.push(
        `<text x="${vertex.x + Math.max(vertex.width, 8) / 2}" y="${vertex.y + Math.max(vertex.height, 8) / 2 + 4}" text-anchor="middle" fill="${labelColor(vertex.fill)}">${escapeXml(text)}</text>`,
      );
    }
  }
  const viewBox = `${x - pad} ${y - pad} ${w + pad * 2} ${h + pad * 2}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet" class="ws-drawio" role="img">`
    + "<defs><marker id=\"ws-arrow\" viewBox=\"0 0 10 10\" refX=\"9\" refY=\"5\" markerWidth=\"7\" markerHeight=\"7\" orient=\"auto-start-reverse\">"
    + "<path d=\"M 0 0 L 10 5 L 0 10 z\" fill=\"var(--muted-foreground)\" /></marker></defs>"
    + parts.join("")
    + "</svg>";
}

const isDrawio = (file) => /\.drawio$/i.test(file.name)
  || /<mxfile\b|<mxGraphModel\b/.test(String(file.content ?? "").slice(0, 4000));

registerFileRenderer({
  id: "drawio",
  order: 10,
  match: isDrawio,
  render: async (file) => {
    const source = String(file.content ?? "");
    const models = await modelsOf(source);
    for (const model of models) {
      const layout = layoutOf(model);
      if (!layout) continue;
      return {
        kind: "svg",
        markup: toSvg(layout),
        summary: `${layout.vertices.length} 个节点 · ${layout.edges.length} 条连线`
          + (models.length > 1 ? ` · 共 ${models.length} 页，显示第 1 页` : ""),
      };
    }
    // 解析不出结构就交回纯文本：用户看到的仍是原文件，而不是一个空白框。
    return null;
  },
});
