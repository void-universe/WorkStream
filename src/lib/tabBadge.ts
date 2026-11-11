// 浏览器不会因为网页要求就把标签染黄：能改的只有标题和 favicon。
// 有未读 @ 时给标题加一个计数、favicon 右上角加个黄点；读完了原样还回去。
const DOTTED_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E"
  + "%3Crect x='0.75' y='0.75' width='30.5' height='30.5' rx='7' fill='%23fff' stroke='%23171717' stroke-width='1.5'/%3E"
  + "%3Ctext x='16' y='21.5' font-family='monospace' font-size='14' font-weight='700' text-anchor='middle' fill='%23171717'%3E%26gt;_%3C/text%3E"
  + "%3Ccircle cx='26' cy='6' r='6' fill='%23facc15' stroke='%23ffffff' stroke-width='2'/%3E%3C/svg%3E";

let baseTitle: string | null = null;
let baseIcon: string | null = null;

export function applyTabBadge(unseen: number) {
  if (baseTitle === null) baseTitle = document.title;
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link && baseIcon === null) baseIcon = link.href;
  const nextTitle = unseen > 0 ? `(${unseen}) ${baseTitle}` : baseTitle;
  if (document.title !== nextTitle) document.title = nextTitle;
  if (!link) return;
  const nextIcon = unseen > 0 ? DOTTED_ICON : baseIcon;
  if (nextIcon && link.href !== nextIcon) link.href = nextIcon;
}
