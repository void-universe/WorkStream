// 内置默认头像：不配图、不联网，SVG 画在代码里，点一下在浏览器烤成 128×128 WebP 再存库，
// 和上传那条路用同一个字段、同一份 avatarData 校验。
type Palette = { bg: string; shirt: string; skin: string; hair: string; line: string };

/** 一张胸像：底 → 后发 → 颈 → 衣 → 头 → 耳 → 前发 → 五官 →（可选）眼镜/耳饰。 */
function figure(
  p: Palette,
  parts: { back?: string; front: string; glasses?: boolean; earrings?: boolean },
) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">`,
    `<rect width="128" height="128" fill="${p.bg}"/>`,
    parts.back ?? "",
    `<rect x="55" y="58" width="18" height="32" rx="9" fill="${p.skin}"/>`,
    `<path d="M64,90c-25,0-44,14-46,38h92c-2-24-21-38-46-38Z" fill="${p.shirt}"/>`,
    `<circle cx="64" cy="50" r="25" fill="${p.skin}"/>`,
    `<circle cx="39" cy="52" r="4" fill="${p.skin}"/><circle cx="89" cy="52" r="4" fill="${p.skin}"/>`,
    parts.front,
    `<circle cx="55" cy="51" r="2.6" fill="${p.line}"/><circle cx="73" cy="51" r="2.6" fill="${p.line}"/>`,
    `<path d="M58,61q6,5 12,0" fill="none" stroke="${p.line}" stroke-width="2.4" stroke-linecap="round"/>`,
    parts.glasses
      ? `<g fill="none" stroke="${p.line}" stroke-width="2"><circle cx="55" cy="51" r="9"/><circle cx="73" cy="51" r="9"/><path d="M64,49v3"/></g>`
      : "",
    parts.earrings
      ? `<circle cx="39" cy="59" r="2.2" fill="${p.line}"/><circle cx="89" cy="59" r="2.2" fill="${p.line}"/>`
      : "",
    `</svg>`,
  ].join("");
}

// 短发帽：弧顶 + 一条略向下弯的发际线，两侧不留鬓角。
const crop = (p: Palette) => `<path d="M39,50a25,25 0 0 1 50,0v-6q-25,5-50,0Z" fill="${p.hair}"/>`;
// 齐刘海：发际线压得更低，额头只留一条。
const fringe = (p: Palette) => `<path d="M39,50a25,25 0 0 1 50,0v-2q-25,10-50,0Z" fill="${p.hair}"/>`;
// 侧分：一边压得低、一边抬起来，刘海斜着走。
const sidePart = (p: Palette) => `<path d="M39,50a25,25 0 0 1 50,0v-8q-10,10-30,8t-20,-4Z" fill="${p.hair}"/>`;
// 垂到肩前的两缕，叠在衣服上面才有长发的轮廓。
const curtains = (p: Palette) =>
  `<path d="M41,44c-6,20-4,38 2,50 3-18 2-32 0-42Z" fill="${p.hair}"/>`
  + `<path d="M87,44c6,20 4,38-2,50-3-18-2-32 0-42Z" fill="${p.hair}"/>`;
// 脑后的发量：只当长度用，头顶那层由 front 负责，所以半径比头大 3。
const mass = (p: Palette, bottom: number) =>
  `<path d="M36,50a28,28 0 0 1 56,0v${bottom - 50}a9,9 0 0 1-9,9h-38a9,9 0 0 1-9,-9Z" fill="${p.hair}"/>`;

const male: Palette = { bg: "#1f5f56", shirt: "#eee7d9", skin: "#e8bb92", hair: "#2f2a26", line: "#241f1b" };
const maleWarm: Palette = { bg: "#8a5a2b", shirt: "#dfe4dd", skin: "#d9a878", hair: "#221d19", line: "#211b17" };
const maleCool: Palette = { bg: "#3c5a6b", shirt: "#e9e2d3", skin: "#f0c9a4", hair: "#4a3421", line: "#241f1b" };
const female: Palette = { bg: "#0d7a6b", shirt: "#f3e9dc", skin: "#eec19c", hair: "#3a2b25", line: "#241f1b" };
const femaleOchre: Palette = { bg: "#a2593c", shirt: "#eae3d5", skin: "#e6b58c", hair: "#5a3a2a", line: "#241f1b" };
const femaleMoss: Palette = { bg: "#42604c", shirt: "#cfd8cd", skin: "#d8a276", hair: "#241d19", line: "#211b17" };

export const AVATAR_PRESETS: { key: string; label: string; svg: string }[] = [
  { key: "m1", label: "男生 · 短发", svg: figure(male, { front: crop(male) }) },
  { key: "m2", label: "男生 · 侧分", svg: figure(maleCool, { front: sidePart(maleCool) }) },
  { key: "m3", label: "男生 · 眼镜", svg: figure(maleWarm, { front: crop(maleWarm), glasses: true }) },
  {
    key: "f1",
    label: "女生 · 长发",
    svg: figure(female, { back: mass(female, 104), front: fringe(female) + curtains(female) }),
  },
  {
    key: "f2",
    label: "女生 · 齐肩",
    svg: figure(femaleOchre, { back: mass(femaleOchre, 88), front: fringe(femaleOchre) }),
  },
  {
    key: "f3",
    label: "女生 · 马尾",
    svg: figure(femaleMoss, {
      back: `<path d="M90,32c16,10 20,32 10,50-3-18-7-30-16,-38Z" fill="${femaleMoss.hair}"/><circle cx="91" cy="36" r="10" fill="${femaleMoss.hair}"/>`,
      front: sidePart(femaleMoss),
      earrings: true,
    }),
  },
];

/** SVG → 128×128 WebP data URL：与 toAvatarDataUrl 同一档尺寸和编码质量。 */
export async function avatarPresetDataUrl(svg: string) {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("preset_load_failed"));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas_unavailable");
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, 128, 128);
  return canvas.toDataURL("image/webp", 0.86);
}

/** 预览用的地址：chip 里直接放 SVG，点下去才烤成 WebP。 */
export function presetPreviewUrl(svg: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
