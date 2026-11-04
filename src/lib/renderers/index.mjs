// 群文件渲染器清单：每个内置渲染器在这里 import 一次（注册是模块加载时的副作用）。
// 新增一个渲染器 = 新建一个文件 + 在这里加一行；漏加那一行会被 `npm run check:schema` 静态拦下。
// 页面只 import 这个文件，不要直接 import fileRenderers.mjs——那样内置渲染器不会被加载。
export { fileRenderers, registerFileRenderer, renderGroupFile } from "../fileRenderers.mjs";

import "./drawio.mjs";
