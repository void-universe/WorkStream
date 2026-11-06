// 真人侧终端的传输层：浏览器直连 VM 上那个把 PTY 暴露成 WebSocket 的网关（ttyd 一类）。
//
// 为什么不经过 WorkStream 服务端转发：站点的 Function 是 Edge 运行时，没有原始 TCP/SSH，
// 转不了真会话；而浏览器本来就有 WebSocket。少一跳，VM 的口令也就没有理由下发到前端——
// 网关用它自己的认证，WorkStream 只知道地址。
//
// 线格式照 ttyd：每条都是文本帧，首字符是类型。
//   出：0 键入 / 1 尺寸 JSON / 2 剪贴板
//   入：0 终端输出 / 1 标题 / 2 备用

export type TermStatus = "connecting" | "open" | "closed" | "blocked";

export type TermHandle = {
  send: (data: string) => void;
  resize: (columns: number, rows: number) => void;
  close: () => void;
};

export type TermHandlers = {
  onOutput: (chunk: string) => void;
  onStatus: (status: TermStatus, detail?: string) => void;
  onTitle?: (title: string) => void;
};

/**
 * 网关地址换成 WebSocket 地址。页面是 https 而网关是明文时当场判定连不上：
 * 浏览器会按混合内容直接掐掉这条连接，而且报错只出现在控制台里——
 * 与其让用户对着一个永远转圈的连接状态猜，不如在这里就说清是协议不匹配。
 */
export function socketUrl(gatewayUrl: string): { url: string; blocked: boolean } {
  let parsed;
  try {
    parsed = new URL(gatewayUrl, window.location.origin);
  } catch {
    return { url: "", blocked: true };
  }
  const scheme = parsed.protocol === "wss:" || parsed.protocol === "https:" ? "wss:" : "ws:";
  const url = `${scheme}//${parsed.host}${parsed.pathname || "/"}`;
  return { url, blocked: window.location.protocol === "https:" && scheme === "ws:" };
}

export function connectTerminal(gatewayUrl: string, handlers: TermHandlers): TermHandle {
  const { url, blocked } = socketUrl(gatewayUrl);
  if (blocked) {
    handlers.onStatus("blocked", url ? "mixed" : "bad_url");
    return { send: () => {}, resize: () => {}, close: () => {} };
  }

  let socket: WebSocket | null = null;
  // WebSocket 建连是异步的，而面板在 connect 之后就要把终端尺寸报出去：
  // 此刻 readyState 还是 CONNECTING，直接 send 会被浏览器丢掉，网关那边永远等不到尺寸。
  // 所以未开门期间的帧先攒着，open 之后按序补发。
  const queued: string[] = [];
  const open = () => {
    handlers.onStatus("connecting");
    socket = new WebSocket(url);
    socket.addEventListener("open", () => {
      for (const frame of queued.splice(0)) socket?.send(frame);
      handlers.onStatus("open");
    });
    socket.addEventListener("message", (event) => {
      const frame = typeof event.data === "string" ? event.data : "";
      if (!frame) return;
      const body = frame.slice(1);
      if (frame[0] === "0") handlers.onOutput(body);
      else if (frame[0] === "1") handlers.onTitle?.(body);
    });
    socket.addEventListener("close", (event) => {
      // 网关侧认证失败、路径不对、进程没起，在浏览器里都只表现为一次关闭：
      // 把状态码带出去，界面才有东西可说，不至于只留一句「连不上」。
      handlers.onStatus("closed", event.code ? String(event.code) : undefined);
    });
    socket.addEventListener("error", () => handlers.onStatus("closed", "error"));
  };
  open();

  const write = (type: string, payload: string) => {
    if (!socket) return;
    if (socket.readyState === WebSocket.OPEN) socket.send(type + payload);
    else queued.push(type + payload);
  };

  return {
    send: (data) => write("0", data),
    resize: (columns, rows) => write("1", JSON.stringify({ columns, rows })),
    close: () => {
      socket?.close();
      socket = null;
    },
  };
}

/** 终端配色只有一个决定处：读当前主题的 CSS 变量，别在样式表里再写一遍同名属性。 */
export function terminalTheme(): Record<string, string> {
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    background: read("--card", "#ffffff"),
    foreground: read("--foreground", "#171717"),
    cursor: read("--signal", "#0d7a6b"),
    selectionBackground: read("--signal-soft", "#ddf1ec"),
  };
}
