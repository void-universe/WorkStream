// Markdown 消息插件：只认得员工真正在用的那几种语法，认不出的原样保留。
//
// 全部返回 React 元素、不做 innerHTML——从构造上就没有 XSS 面；链接只放行 http(s)/mailto。
import type { ReactNode } from "react";
import { registerMessageRenderer, type MessageRenderer } from "../messageRenderers";

const STRONG_MARKER = /```|^\s{0,3}#{1,4}\s|^\s{0,3}\|.*\|\s*$|^\s{0,3}[-*]\s+\S|^\s{0,3}\d+\.\s+\S|^\s{0,3}>\s|\*\*[^*\n]+\*\*/m;

const MENTION = /@([A-Za-z0-9_\u4e00-\u9fa5-]{1,32})/g;

function withMentions(text: string, mentions: string[], keyBase: string): ReactNode[] {
  if (!mentions.length) return [text];
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION)) {
    const name = match[1];
    if (!mentions.includes(name)) continue;
    const start = match.index ?? 0;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <span key={`${keyBase}-m${start}`} className="font-medium text-signal">{match[0]}</span>,
    );
    last = start + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length ? parts : [text];
}

/** 行内：`code`、**粗**、*斜*、[文本](链接)。顺序固定，避免互相吃掉。 */
function inline(text: string, mentions: string[], keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\))/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(...withMentions(text.slice(last, start), mentions, `${keyBase}-${last}`));
    const token = match[0];
    if (match[1]) {
      nodes.push(<code key={`${keyBase}-c${start}`} className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{token.slice(1, -1)}</code>);
    } else if (match[2]) {
      nodes.push(<strong key={`${keyBase}-b${start}`}>{token.slice(2, -2)}</strong>);
    } else if (match[3]) {
      nodes.push(<em key={`${keyBase}-i${start}`}>{token.slice(1, -1)}</em>);
    } else if (match[4]) {
      const label = token.slice(1, token.indexOf("]"));
      const href = match[5];
      nodes.push(
        <a key={`${keyBase}-a${start}`} href={href} target="_blank" rel="noopener noreferrer" className="text-signal underline">
          {label}
        </a>,
      );
    }
    last = start + token.length;
  }
  if (last < text.length) nodes.push(...withMentions(text.slice(last), mentions, `${keyBase}-${last}`));
  return nodes.length ? nodes : [text];
}

function paragraph(lines: string[], mentions: string[], keyBase: string): ReactNode {
  return (
    <p key={keyBase} className="whitespace-pre-wrap leading-relaxed">
      {lines.flatMap((line, index) => [
        index ? "\n" : null,
        ...inline(line, mentions, `${keyBase}-${index}`),
      ])}
    </p>
  );
}

function table(rows: string[], mentions: string[], keyBase: string): ReactNode {
  const cells = rows.map((row) => row.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()));
  const header = cells[0];
  const body = cells.filter((row, index) => index > 0 && !row.every((cell) => /^:?-{2,}:?$/.test(cell)));
  return (
    <div key={keyBase} className="my-1.5 overflow-x-auto rounded-md border">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="bg-muted/60">
            {header.map((cell, index) => (
              <th key={index} className="border-b px-2 py-1 text-left font-medium">{inline(cell, mentions, `${keyBase}-h${index}`)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => (
                <td key={index} className="border-b px-2 py-1 align-top last:border-b-0">{inline(cell, mentions, `${keyBase}-${rowIndex}-${index}`)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function renderMarkdown(content: string, mentions: string[] = []): ReactNode {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const language = line.replace(/^\s*```/, "").trim();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push(
        <pre key={`b${blocks.length}`} className="my-1.5 overflow-x-auto rounded-md border bg-muted/40 p-2 text-[11px]">
          <code className="font-mono" data-language={language || undefined}>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    if (/^\s{0,3}#{1,4}\s/.test(line)) {
      const level = line.match(/^\s{0,3}(#{1,4})\s/)![1].length;
      const text = line.replace(/^\s{0,3}#{1,4}\s/, "");
      const Tag = (`h${level}` as unknown) as "h3";
      const className = level <= 2 ? "mt-2 mb-0.5 text-sm font-semibold" : "mt-1.5 mb-0.5 text-xs font-semibold";
      blocks.push(<Tag key={`b${blocks.length}`} className={className}>{inline(text, mentions, `b${blocks.length}`)}</Tag>);
      index += 1;
      continue;
    }
    if (/^\s{0,3}(\|.*\|\s*)$/.test(line)) {
      const rows: string[] = [];
      while (index < lines.length && /^\s{0,3}\|.*\|\s*$/.test(lines[index])) {
        rows.push(lines[index]);
        index += 1;
      }
      blocks.push(table(rows, mentions, `b${blocks.length}`));
      continue;
    }
    if (/^\s{0,3}[-*]\s+\S/.test(line) || /^\s{0,3}\d+\.\s+\S/.test(line)) {
      const ordered = /^\s{0,3}\d+\.\s+\S/.test(line);
      const items: string[] = [];
      while (index < lines.length && (ordered ? /^\s{0,3}\d+\.\s+\S/ : /^\s{0,3}[-*]\s+\S/).test(lines[index])) {
        items.push(lines[index].replace(/^\s{0,3}([-*]|\d+\.)\s+/, ""));
        index += 1;
      }
      const ListTag = ordered ? "ol" : "ul";
      blocks.push(
        <ListTag key={`b${blocks.length}`} className={ordered ? "my-1 list-decimal pl-5" : "my-1 list-disc pl-5"}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex} className="leading-relaxed">{inline(item, mentions, `b${blocks.length}-${itemIndex}`)}</li>
          ))}
        </ListTag>,
      );
      continue;
    }
    if (/^\s{0,3}>\s/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s{0,3}>\s?/.test(lines[index])) {
        quoted.push(lines[index].replace(/^\s{0,3}>\s?/, ""));
        index += 1;
      }
      blocks.push(
        <blockquote key={`b${blocks.length}`} className="my-1 border-l-2 pl-2 text-muted-foreground">{paragraph(quoted, mentions, `b${blocks.length}`)}</blockquote>,
      );
      continue;
    }
    if (/^\s{0,3}(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push(<hr key={`b${blocks.length}`} className="my-2 border-border" />);
      index += 1;
      continue;
    }
    const para: string[] = [];
    while (index < lines.length && lines[index].trim() && !/^\s{0,3}(#{1,4}\s|```|\||[-*]\s+\S|\d+\.\s+\S|>\s)/.test(lines[index])) {
      para.push(lines[index]);
      index += 1;
    }
    blocks.push(paragraph(para, mentions, `b${blocks.length}`));
  }
  return <div className="grid gap-0.5">{blocks}</div>;
}

const markdown: MessageRenderer = {
  id: "markdown",
  priority: 100,
  match: (message) => Boolean(message.content) && STRONG_MARKER.test(message.content),
  render: ({ message, mentions = [] }) => renderMarkdown(message.content, mentions),
};

registerMessageRenderer(markdown);
