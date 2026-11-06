// 群窗口右侧的终端：真人敲的是 VM 上那个 WebSocket 网关，不是 WorkStream 转发的会话。
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { RotateCcwIcon, TerminalIcon, XIcon } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import type { StreamVm } from "../../types";
import { connectTerminal, terminalTheme, type TermHandle, type TermStatus } from "../../lib/terminal";
import { Notice } from "../../lib/ui";
import { useI18n, type MsgKey } from "../../lib/i18n";

// 连接状态到文案：字典对账只认字面取词，所以这里用一张显式的表，不拼键名。
const STATUS_LABEL: Record<TermStatus, MsgKey> = {
  connecting: "term.connecting",
  open: "term.open",
  closed: "term.closed",
  blocked: "term.blocked",
};

export function TerminalPane({
  vms,
  vmId,
  onPick,
  onClose,
}: {
  vms: StreamVm[];
  vmId: string;
  onPick: (vmId: string) => void;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const vm = vms.find((item) => item.id === vmId) ?? vms[0];
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<TermStatus>("connecting");
  const [detail, setDetail] = useState("");
  const [attempt, setAttempt] = useState(0);
  const handleRef = useRef<TermHandle | null>(null);
  const gateway = vm.gateway_url ?? "";

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !gateway) return;

    const term = new Terminal({
      fontSize: 12.5,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      cursorBlink: true,
      scrollback: 4000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    let columns = term.cols;
    let rows = term.rows;
    const handle = connectTerminal(gateway, {
      onOutput: (chunk) => term.write(chunk),
      onStatus: (next, why) => {
        setStatus(next);
        setDetail(why ?? "");
        if (next === "open") term.focus();
      },
    });
    handleRef.current = handle;
    handle.resize(columns, rows);

    term.onData((data) => handle.send(data));

    // 尺寸只在真的变了时才往外报：fit() 之后紧接着再来一次同值的 resize，
    // 网关会把PTY重画一遍，屏幕上就多出一次没来由的清屏。
    const syncSize = () => {
      fit.fit();
      if (term.cols === columns && term.rows === rows) return;
      columns = term.cols;
      rows = term.rows;
      handle.resize(columns, rows);
    };
    const observer = new ResizeObserver(syncSize);
    observer.observe(host);

    // 换主题时配色仍由 CSS 变量决定，这里只把它们抄给 xterm，不在样式表里另设一份。
    const repaint = () => term.options.theme = terminalTheme();
    const themeWatch = new MutationObserver(repaint);
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    term.focus();
    return () => {
      observer.disconnect();
      themeWatch.disconnect();
      handle.close();
      handleRef.current = null;
      term.dispose();
    };
  }, [gateway, attempt]);

  const closed = status === "closed";
  const blocked = status === "blocked";

  return (
    <div className="flex h-full min-h-0 flex-col border-l bg-card">
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <TerminalIcon className="size-4 shrink-0 text-machine" />
        {vms.length > 1 ? (
          <NativeSelect
            className="h-7 max-w-[10rem] shrink-0 text-xs"
            value={vm.id}
            onChange={(event) => onPick(event.target.value)}
          >
            {vms.map((item) => (
              <NativeSelectOption key={item.id} value={item.id}>{item.label}</NativeSelectOption>
            ))}
          </NativeSelect>
        ) : (
          <p className="max-w-[9rem] shrink-0 truncate text-xs font-medium">{vm.label}</p>
        )}
        <p className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{gateway || vm.host}</p>
        <Badge variant={status === "open" ? "default" : closed || blocked ? "destructive" : "secondary"} className="shrink-0 rounded-sm text-[11px]">
          {i18n.t(STATUS_LABEL[status])}
        </Badge>
        {status === "open" ? (
          <Button size="icon-xs" variant="ghost" title={i18n.t("term.detach")} onClick={() => handleRef.current?.close()}>
            <RotateCcwIcon className="size-3.5" />
          </Button>
        ) : null}
        {closed || blocked ? (
          <Button size="xs" variant="outline" className="shrink-0 text-xs" onClick={() => setAttempt((current) => current + 1)}>
            {i18n.t("term.reconnect")}
          </Button>
        ) : null}
        <Button size="icon-xs" variant="ghost" className="shrink-0" title={i18n.t("common.close")} onClick={onClose}>
          <XIcon className="size-3.5" />
        </Button>
      </header>

      {!gateway ? (
        <div className="grid gap-2 p-3">
          <Notice tone="warn">{i18n.t("term.noGateway")}</Notice>
        </div>
      ) : (
        <div className="relative min-h-0 flex-1 px-1.5 pb-1.5 pt-1.5">
          <div ref={hostRef} className="h-full min-h-0 w-full overflow-hidden rounded-md" />
          {closed || blocked ? (
            <div className="absolute inset-x-3 top-3 z-10">
              {blocked ? (
                <Notice tone="warn">{detail === "bad_url" ? i18n.t("term.bad_url") : i18n.t("term.mixed")}</Notice>
              ) : (
                <Notice tone="warn">{i18n.tf("term.refused", { code: detail || i18n.t("term.noCode") })}</Notice>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
