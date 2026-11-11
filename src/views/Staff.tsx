// Market 的「员工」区：一组内置岗位模板，选好建档目标后一键按模板建档。
// 模板只带名称、职责与系统提示词——凭据属于账号，由顶部的部署 server 选择器提供。
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { describeError, get, post, type Agent } from "../api";
import { navigate } from "../lib/route";
import { STAFF_PRESETS, type StaffPreset } from "../lib/staffPresets";
import { Notice } from "../lib/ui";
import { useI18n } from "../lib/i18n";
import type { ServerRow } from "../types";

const DEMO_TARGET = "demo://local";

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function StaffPanel() {
  const i18n = useI18n();
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [target, setTarget] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState("");

  useEffect(() => {
    let alive = true;
    void get<{ ok: true; items: ServerRow[] }>("servers.list")
      .then((result) => {
        if (!alive) return;
        setServers(result.items);
        // 有 server 就默认用第一台；一台都没有时落到演示端点，先用它把流程跑通。
        setTarget(result.items[0]?.id ?? DEMO_TARGET);
      })
      .catch((error) => toast.error(describeError(i18n, error)))
      .finally(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function hire(preset: StaffPreset) {
    const name = i18n.t(preset.nameKey);
    const role = i18n.t(preset.roleKey);
    const systemPrompt = i18n.t(preset.systemKey);
    const server = servers.find((row) => row.id === target) ?? null;
    setBusy(preset.id);
    try {
      const result = server
        ? await post<{ ok: true; agent: Agent }>("agents.create", {
          name,
          role,
          system_prompt: systemPrompt,
          backend: "stream",
          server_id: server.id,
          // 规范对接那一档的模型名要发给它自己的执行器：用它声明过的第一个，没有就用 default。
          model: server.models[0] ?? "default",
        })
        : await post<{ ok: true; agent: Agent }>("agents.create", {
          name,
          role,
          system_prompt: systemPrompt,
          backend: "openai",
          api_base_url: DEMO_TARGET,
          api_key: "demo",
          model: "demo",
        });
      toast.success(i18n.tf("staff.hired", { name: result.agent.name }));
      navigate(`/agents/${result.agent.id}`);
    } catch (error) {
      toast.error(describeError(i18n, error));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <p className="max-w-[560px] text-xs leading-relaxed text-muted-foreground">{i18n.t("staff.intro")}</p>
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {i18n.t("staff.targetLabel")}
          <NativeSelect
            size="sm"
            className="text-[11px]"
            value={target}
            disabled={!loaded}
            onChange={(event) => setTarget(event.target.value)}
          >
            {servers.map((server) => (
              <NativeSelectOption key={server.id} value={server.id}>
                {server.name} · {hostOf(server.base_url)}
              </NativeSelectOption>
            ))}
            <NativeSelectOption value={DEMO_TARGET}>{i18n.t("staff.targetDemo")}</NativeSelectOption>
          </NativeSelect>
        </label>
      </div>

      {loaded && !servers.length ? <Notice>{i18n.t("staff.noServer")}</Notice> : null}

      <div className="grid gap-3 md:grid-cols-2">
        {STAFF_PRESETS.map((preset) => (
          <section key={preset.id} className="ws-surface grid gap-2 rounded-xl bg-card p-3.5">
            <header className="flex flex-wrap items-baseline gap-2">
              <h3 className="text-sm font-medium">{i18n.t(preset.nameKey)}</h3>
              <span className="text-[11px] text-muted-foreground">{i18n.t(preset.roleKey)}</span>
            </header>
            <p className="text-xs leading-relaxed text-muted-foreground">{i18n.t(preset.summaryKey)}</p>
            <div className="grid gap-1">
              <span className="text-[11px] text-muted-foreground">{i18n.t("staff.promptLabel")}</span>
              <p className="whitespace-pre-wrap rounded-md border border-border/60 bg-muted/40 p-2 text-[11px] leading-relaxed">
                {i18n.t(preset.systemKey)}
              </p>
            </div>
            <div className="flex items-center justify-end">
              <Button
                size="sm"
                className="h-7 rounded-full text-xs"
                disabled={!target || busy !== ""}
                onClick={() => void hire(preset)}
              >
                {busy === preset.id ? i18n.t("staff.hiring") : i18n.t("staff.hire")}
              </Button>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
