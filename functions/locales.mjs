// 界面语言的 id 白名单。前端 src/lib/i18n.ts 里有一份带自称、方向与译完与否的同序清单，
// 两边的 id 由 dev/check-schema.mjs 对账：服务端不能 import 前端的打包产物，所以清单只能各存一份，
// 但对账保证它俩不会各说各话。
export const LOCALE_IDS = [
  "en", "zh-Hans", "de", "ja", "hi", "fr", "ru", "it", "pt-BR", "es",
  "ko", "tr", "id", "nl", "ar", "pl", "sv", "he",
];

export const DEFAULT_LOCALE = "zh-Hans";
