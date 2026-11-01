// 办公虚拟机：登记 SSH 目标、连通探测、按群授权；凭据 AES-GCM 入库不外泄。
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { describeError, get, post } from "../api";
import type { Stream, Vm } from "../types";
import { shortUuid, timeAgo } from "../lib/format";
import { Field, Notice, SectionTitle, TextInput } from "../lib/ui";

type Draft = {
  id?: string;
  label: string;
  host: string;
  port: number;
  username: string;
  auth_kind: "password" | "key";
  secret: string;
  workdir: string;
};

const EMPTY: Draft = { label: "", host: "", port: 22, username: "", auth_kind: "password", secret: "", workdir: "" };

export function VmsView() {
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
      toast.error(describeError(error));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const names = new Map(streams.map((stream) => [stream.id, stream.name]));

  async function save() {
    if (!draft.label.trim() || !draft.host.trim() || !draft.username.trim()) {
      toast.error("名字、主机、登录用户都要填。");
      return;
    }
    if (!draft.id && !draft.secret.trim()) {
      toast.error("密码或私钥至少要给一个，探测和后续 runner 都要用。");
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
      };
      if (draft.secret.trim()) body.secret = draft.secret.trim();
      if (draft.id) {
        await post("vms.update", { id: draft.id, ...body });
        toast.success("已更新");
      } else {
        await post("vms.create", body);
        toast.success("虚拟机已登记");
      }
      setDraft(EMPTY);
      await refresh();
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  async function probe(vm: Vm) {
    setProbing(vm.id);
    try {
      const result = await post<{ ok: true; probe: { reachable: boolean; note: string; checked_at: string } }>("vms.probe", { id: vm.id });
      if (result.probe.reachable) toast.success(`${vm.label} 端口可达：${result.probe.note}`);
      else toast.error(`${vm.label} 不可达：${result.probe.note}`);
      await refresh();
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setProbing("");
    }
  }

  async function remove(vm: Vm) {
    try {
      await post("vms.delete", { id: vm.id });
      toast.success("已删除");
      if (draft.id === vm.id) setDraft(EMPTY);
      await refresh();
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  return (
    <div className="mx-auto grid h-full w-full max-w-5xl min-h-0 gap-4 overflow-y-auto p-4 scrollbar-thin md:p-6">
      <header className="grid gap-1">
        <h1 className="text-lg font-semibold tracking-tight">办公虚拟机</h1>
        <p className="text-sm text-muted-foreground">登记你的 SSH 办公机，再按群授权；群里的虚拟员工只看到被授权到本群的那几台。</p>
      </header>

      <Notice tone="warn">
        边缘函数运行时没有 TCP 套接字，所以这里做的是<b>登记 + 按群授权 + 端口连通探测</b>：凭据加密存库、永不回传浏览器，
        真正的 SSH 会话执行需要一台常驻 runner 拿着这些授权去连，属于下一期能力。
      </Notice>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">{draft.id ? `编辑 · ${draft.label}` : "登记一台虚拟机"}</CardTitle>
          <CardDescription className="text-xs">主机名或 IP 都行；口令/私钥保存后即不可读回，只能替换。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <Field label="名字" htmlFor="vm-label">
            <TextInput id="vm-label" value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} placeholder="如：构建机 A" className="h-8 text-xs" />
          </Field>
          <Field label="主机" htmlFor="vm-host">
            <TextInput id="vm-host" value={draft.host} onChange={(event) => setDraft({ ...draft, host: event.target.value })} placeholder="build.internal 或 10.0.0.12" className="h-8 font-mono text-xs" />
          </Field>
          <Field label="端口" htmlFor="vm-port">
            <Input id="vm-port" type="number" min={1} max={65535} value={draft.port} onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) })} className="h-8 text-xs" />
          </Field>
          <Field label="登录用户" htmlFor="vm-user">
            <TextInput id="vm-user" value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} placeholder="ci" className="h-8 text-xs" />
          </Field>
          <Field label="凭据类型">
            <NativeSelect className="h-8 text-xs" value={draft.auth_kind} onChange={(event) => setDraft({ ...draft, auth_kind: event.target.value as "password" | "key" })}>
              <NativeSelectOption value="password">口令</NativeSelectOption>
              <NativeSelectOption value="key">私钥</NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field label="工作目录" htmlFor="vm-workdir">
            <TextInput id="vm-workdir" value={draft.workdir} onChange={(event) => setDraft({ ...draft, workdir: event.target.value })} placeholder="/srv/work" className="h-8 font-mono text-xs" />
          </Field>
          <div className="md:col-span-3">
            <Field label={draft.id ? "替换凭据（留空保持不变）" : "口令或私钥"} htmlFor="vm-secret">
              <Input id="vm-secret" type="password" value={draft.secret} onChange={(event) => setDraft({ ...draft, secret: event.target.value })} className="h-8 text-xs" />
            </Field>
          </div>
          <div className="flex gap-2 md:col-span-3">
            <Button size="sm" className="text-xs" onClick={() => void save()} disabled={busy}>
              {busy ? "保存中…" : draft.id ? "保存修改" : "登记"}
            </Button>
            {draft.id ? (
              <Button size="sm" variant="ghost" className="text-xs" onClick={() => setDraft(EMPTY)}>
                取消编辑
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <SectionTitle>已登记 · {vms.length}</SectionTitle>
      {vms.length === 0 ? <p className="text-xs text-muted-foreground">还没有虚拟机。</p> : null}
      <div className="grid gap-2">
        {vms.map((vm) => (
          <article key={vm.id} className="grid gap-2 rounded-lg border bg-card p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted font-mono text-[11px]">VM</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{vm.label}</p>
                <p className="truncate font-mono text-[11px] text-muted-foreground">
                  {vm.username}@{vm.host}:{vm.port}
                  {vm.workdir ? ` · ${vm.workdir}` : ""} · {vm.auth_kind === "key" ? "私钥" : "口令"}
                </p>
              </div>
              <Badge variant={vm.last_probe?.reachable ? "default" : "secondary"} className="rounded-sm text-[11px]">
                {vm.last_probe ? (vm.last_probe.reachable ? "可达" : "不可达") : "未探测"}
              </Badge>
              <Button size="sm" variant="outline" className="h-7 text-xs" disabled={probing === vm.id} onClick={() => void probe(vm)}>
                {probing === vm.id ? "探测中…" : "探测"}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setDraft({ ...EMPTY, id: vm.id, label: vm.label, host: vm.host, port: vm.port, username: vm.username, auth_kind: vm.auth_kind, secret: "", workdir: vm.workdir })}>
                编辑
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={() => void remove(vm)}>
                删除
              </Button>
            </div>
            {vm.last_probe ? (
              <p className="text-[11px] text-muted-foreground">
                {vm.last_probe.note} · {timeAgo(vm.last_probe.checked_at)}
              </p>
            ) : null}
            <p className="text-[11px] text-muted-foreground">
              {vm.granted_to?.length
                ? `已授权到：${vm.granted_to.map((grant) => `${names.get(grant.stream_id) ?? shortUuid(grant.stream_id)}（${grant.level}）`).join("、")}`
                : "还没授权到任何群；进群的「虚拟机」面板里可以授权。"}
            </p>
          </article>
        ))}
      </div>
    </div>
  );
}
