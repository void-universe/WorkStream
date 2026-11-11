// .csv 预览：按 RFC 4180 那颗最小状态机切成表头 + 数据行，双引号里的逗号与换行不切列。
// 超出行数/列数只截断并标出来，不静默吞行——预览里少一行而没人知道，比不预览更糟。
import { registerFileRenderer } from "../fileRenderers.mjs";

const MAX_ROWS = 500;
const MAX_COLS = 40;
const MAX_CELL = 200;
const BOM = /^\uFEFF/;

export function parseCsv(source, { maxRows = MAX_ROWS, maxCols = MAX_COLS, maxCell = MAX_CELL } = {}) {
  const text = String(source ?? "").replace(BOM, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  let truncated = false;

  const endCell = () => {
    if (row.length < maxCols) row.push(cell.slice(0, maxCell));
    else truncated = true;
    cell = "";
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
    } else if (ch === ",") {
      endCell();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      endRow();
      if (rows.length > maxRows) {
        truncated = true;
        break;
      }
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length) endRow();

  // 末尾那个换行会切出一行空的：它不是数据，别让表格多一行。
  while (rows.length && rows[rows.length - 1].every((value) => value === "")) rows.pop();
  if (!rows.length) return null;
  return {
    head: rows[0],
    rows: rows.slice(1),
    truncated: truncated || rows.length - 1 > maxRows,
  };
}

registerFileRenderer({
  id: "csv-file",
  order: 30,
  match: (file) => /\.(csv|tsv)$/i.test(file.name ?? "") || /^text\/(tab-separated|csv)/i.test(file.content_type ?? ""),
  render: (file) => {
    const source = String(file.content ?? "");
    // .tsv 用制表符分隔：换一个分隔符走同一颗状态机不值当，先把制表符换成逗号（字段里真有制表符的极少）。
    const table = parseCsv(/\.tsv$/i.test(file.name ?? "") ? source.replace(/\t/g, ",") : source);
    return table ? { kind: "table", ...table } : null;
  },
});
