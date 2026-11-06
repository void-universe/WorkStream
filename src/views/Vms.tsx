// 办公虚拟机：登记 SSH 目标、连通探测、按群授权；凭据 AES-GCM 入库不外泄。
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";
import { describeError, get, post } from "../api";
import type { Stream, Vm } from "../types";
import { shortUuid, timeAgo } from "../lib/format";
import { Field, Notice, SectionTitle, TextInput } from "../lib/ui";
import { useI18n } from "../lib/i18n";

type Draft = {
  id?: string;
  label: string;
  host: string;
  port: number;
  username: string;
  auth_kind: "password" | "key";
  secret: string;
  workdir: string;
  gateway_url: string;
};

const EMPTY: Draft = { label: "", host: "", port: 22, username: "", auth_kind: "password", secret: "", workdir: "", gateway_url: "" };

// 7681 是 ttyd 自己的默认端口，不是本机可调的旋钮；网关通常就开在这台机器身上，所以新登记时按主机填一个默认值。
const CONSOLE_PORT = 7681;

function defaultGateway(draft: Draft): Draft {
  if (draft.id || draft.gateway_url || !/^[A-Za-z0-9._-]+$/.test(draft.host)) return draft;
  return { ...draft, gateway_url: `ws://${draft.host}:${CONSOLE_PORT}` };
}

export function VmsView() {
  const i18n = useI18n();
  const [vms, setVms] = useState<Vm[]>([]);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [mine, list] = await Promise.all([
        get<{ ok: true; items: Vm[] }>("vms.list"),
        get<{ ok: true; items: Stream[] }>("streams.mine"),
      ]);
      setVms(mine.items);
      setStreams(list.items);
    } catch (error) {
      toast.error(describeError(i18n, error));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const names = new Map(streams.map((stream) => [stream.id, stream.name]));
  // 「登记 + 授权 + 探测」在句子里是一段加粗，拆不成一个整句，所以按 {0} 切开、中间自己塞。
  const warningParts = i18n.tp("vm.warning");

  async function save() {
    if (!draft.label.trim() || !draft.host.trim() || !draft.username.trim()) {
      toast.error(i18n.t("vm.needNameHostUser"));
      return;
    }
    if (!draft.id && !draft.secret.trim()) {
      toast.error(i18n.t("vm.needSecret"));
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        label: draft.label.trim(),
        host: draft.host.trim(),
        port: Number(draft.port),
        username: draft.username.trim(),
        auth_kind: draft.auth_kind,
        workdir: draft.workdir.trim(),
        gateway_url: draft.gateway_url.trim(),
      };
      if (draft.secret.trim()) body.secret = draft.secret.trim();
      if (draft.id) {
        await post("vms.update", { id: draft.id, ...body });
        toast.success(i18n.t("common.saved"));
      } else {
        await post("vms.create", body);
        toast.success(i18n.t("vm.toastCreated"));
      }
      setDraft(EMPTY);
      await refresh();
    } catch (error) {
      toast.error(describeError(i18n, error));
    } finally {
      setBusy(false);
    }
  }

  async function probe(vm: Vm) {
    setProbing(vm.id);
    try {
      const result = await post<{ ok: true; probe: { reachable: boolean; note: string; checked_at: string } }>("vms.probe", { id: vm.id });
      if (result.probe.reachable) toast.success(i18n.tf("vm.probeOk", { label: vm.label, note: result.probe.note }));
      else toast.error(i18n.tf("vm.probeFail", { label: vm.label, note: result.probe.note }));
      await refresh();
    } catch (error) {
      toast.error(describeError(i18n, error));
    } finally {
      setProbing("");
    }
  }

  async function remove(vm: Vm) {
    try {
      await post("vms.delete", { id: vm.id });
      toast.success(i18n.t("common.deleted"));
      if (draft.id === vm.id) setDraft(EMPTY);
      await refresh();
    } catch (error) {
      toast.error(describeError(i18n, error));
    }
  }

  return (
    <div className="mx-auto grid h-full w-full max-w-5xl min-h-0 gap-4 overflow-y-auto p-4 scrollbar-thin md:p-6">
      <header className="grid gap-1">
        <h1 className="text-lg font-semibold tracking-tight">{i18n.t("nav.vms")}</h1>
        <p className="text-sm text-muted-foreground">{i18n.t("vm.intro")}</p>
      </header>

      <Notice tone="warn">
        {warningParts[0]}
        <b>{i18n.t("vm.warningBold")}</b>
        {warningParts[1]}
      </Notice>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">{draft.id ? i18n.tf("vm.editTitle", { label: draft.label }) : i18n.t("vm.createTitle")}</CardTitle>
          <CardDescription className="text-xs">{i18n.t("vm.formHint")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <Field label={i18n.t("vm.nameLabel")} htmlFor="vm-label">
            <TextInput id="vm-label" value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} placeholder={i18n.t("vm.namePlaceholder")} className="h-8 text-xs" />
          </Field>
          <Field label={i18n.t("vm.hostLabel")} htmlFor="vm-host">
            <TextInput id="vm-host" value={draft.host} onChange={(event) => setDraft(defaultGateway({ ...draft, host: event.target.value }))} placeholder={i18n.t("vm.hostPlaceholder")} className="h-8 font-mono text-xs" />
          </Field>
          <Field label={i18n.t("vm.portLabel")} htmlFor="vm-port">
            <Input id="vm-port" type="number" min={1} max={65535} value={draft.port} onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) })} className="h-8 text-xs" />
          </Field>
          <Field label={i18n.t("vm.userLabel")} htmlFor="vm-user">
            <TextInput id="vm-user" value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} placeholder="ci" className="h-8 text-xs" />
          </Field>
          <Field label={i18n.t("vm.authLabel")}>
            <NativeSelect className="h-8 text-xs" value={draft.auth_kind} onChange={(event) => setDraft({ ...draft, auth_kind: event.target.value as "password" | "key" })}>
              <NativeSelectOption value="password">{i18n.t("vm.authPassword")}</NativeSelectOption>
              <NativeSelectOption value="key">{i18n.t("vm.authKey")}</NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field label={i18n.t("vm.workdirLabel")} htmlFor="vm-workdir">
            <TextInput id="vm-workdir" value={draft.workdir} onChange={(event) => setDraft({ ...draft, workdir: event.target.value })} placeholder="/srv/work" className="h-8 font-mono text-xs" />
          </Field>
          <div className="md:col-span-3">
            <Field label={i18n.t("vm.gatewayLabel")} htmlFor="vm-gateway" hint={i18n.t("vm.gatewayHint")}>
              <TextInput id="vm-gateway" value={draft.gateway_url} onChange={(event) => setDraft({ ...draft, gateway_url: event.target.value })} placeholder="ws://192.168.1.20:7681" className="h-8 font-mono text-xs" />
            </Field>
          </div>
          <div className="md:col-span-3">
            <Field label={draft.id ? i18n.t("vm.secretReplace") : i18n.t("vm.secretNew")} htmlFor="vm-secret">
              <Input id="vm-secret" type="password" value={draft.secret} onChange={(event) => setDraft({ ...draft, secret: event.target.value })} className="h-8 text-xs" />
            </Field>
          </div>
          <div className="flex gap-2 md:col-span-3">
            <Button size="sm" className="text-xs" onClick={() => void save()} disabled={busy}>
              {busy ? i18n.t("vm.saving") : draft.id ? i18n.t("vm.saveChanges") : i18n.t("vm.register")}
            </Button>
            {draft.id ? (
              <Button size="sm" variant="ghost" className="text-xs" onClick={() => setDraft(EMPTY)}>
                {i18n.t("vm.cancelEdit")}
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <SectionTitle>{i18n.tf("vm.registeredTitle", { n: vms.length })}</SectionTitle>
      {vms.length === 0 ? <p className="text-xs text-muted-foreground">{i18n.t("vm.empty")}</p> : null}
      <div className="grid gap-2">
        {vms.map((vm) => (
          <article key={vm.id} className="grid gap-2 rounded-lg border bg-card p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted font-mono text-[10px]">SSH</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{vm.label}</p>
                <p className="truncate font-mono text-[11px] text-muted-foreground">
                  {vm.username}@{vm.host}:{vm.port}
                  {vm.workdir ? ` · ${vm.workdir}` : ""} · {vm.auth_kind === "key" ? i18n.t("vm.authKey") : i18n.t("vm.authPassword")}
                </p>
              </div>
              <Badge variant={vm.last_probe?.reachable ? "default" : "secondary"} className="rounded-sm text-[11px]">
                {vm.last_probe ? (vm.last_probe.reachable ? i18n.t("vm.reachable") : i18n.t("vm.unreachable")) : i18n.t("vm.unprobed")}
              </Badge>
              <Button size="sm" variant="outline" className="h-7 text-xs" disabled={probing === vm.id} onClick={() => void probe(vm)}>
                {probing === vm.id ? i18n.t("vm.probing") : i18n.t("vm.probe")}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setDraft({ ...EMPTY, id: vm.id, label: vm.label, host: vm.host, port: vm.port, username: vm.username, auth_kind: vm.auth_kind, secret: "", workdir: vm.workdir, gateway_url: vm.gateway_url ?? "" })}>
                {i18n.t("common.edit")}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={() => void remove(vm)}>
                {i18n.t("common.delete")}
              </Button>
            </div>
            {vm.last_probe ? (
              <p className="text-[11px] text-muted-foreground">
                {vm.last_probe.note} · {timeAgo(i18n, vm.last_probe.checked_at)}
              </p>
            ) : null}
            {/* 控制台连的是这一栏地址，不是上面那个 SSH 端口：列表里必须能看出哪台点得开。 */}
            <p className={cn("truncate font-mono text-[11px]", vm.gateway_url ? "text-foreground/70" : "text-muted-foreground")}>
              {vm.gateway_url || i18n.t("vm.gatewayNone")}
            </p>
            {vm.last_probe?.gateway ? (
              <p className="text-[11px] text-muted-foreground">{vm.last_probe.gateway.note}</p>
            ) : null}
            <p className="text-[11px] text-muted-foreground">
              {vm.granted_to?.length
                ? i18n.tf("vm.grantedTo", {
                    list: i18n.list(
                      vm.granted_to.map((grant) =>
                        i18n.tf("vm.grantItem", { name: names.get(grant.stream_id) ?? shortUuid(grant.stream_id), level: grant.level }),
                      ),
                    ),
                  })
                : i18n.t("vm.grantedNone")}
            </p>
          </article>
        ))}
      </div>
    </div>
  );
}
