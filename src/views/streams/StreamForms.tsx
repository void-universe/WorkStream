// Stream 面板上的建群与按 UUID 进群：从左侧栏搬到了面板顶部。
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { describeError, get, post, type Agent } from "../../api";
import type { Stream, Vm } from "../../types";
import { shortUuid } from "../../lib/format";
import { navigate } from "../../lib/route";
import { CopyButton, Field, Notice } from "../../lib/ui";

export function CreateGroup({
  agents,
  vms,
  onCreated,
  onCancel,
}: {
  agents: Agent[];
  vms: Vm[];
  onCreated: () => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [policy, setPolicy] = useState<"request" | "invite_only">("request");
  const [announcement, setAnnouncement] = useState("");
  const [pickedAgents, setPicked] = useState<string[]>([]);
  const [pickedVms, setPickedVms] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!name.trim()) {
      toast.error("给群起个名字。");
      return;
    }
    setBusy(true);
    try {
      const result = await post<{ ok: true; stream: Stream }>("streams.create", {
        name: name.trim(),
        join_policy: policy,
        announcement,
        agent_ids: pickedAgents,
        vm_ids: pickedVms,
      });
      toast.success(`群已建好，UUID ${shortUuid(result.stream.id)}`);
      await onCreated();
      navigate(`/stream/${result.stream.id}`);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid gap-3 rounded-lg border bg-card p-3">
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="text-sm font-semibold">新建群</h2>
        <p className="text-[11px] text-muted-foreground">群就是 stream，一个群推进一个项目。</p>
      </header>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="群名" htmlFor="new-stream-name">
          <Input
            id="new-stream-name"
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            placeholder="如：交付周会"
            className="h-8 text-xs"
          />
        </Field>
        <Field label="进群方式">
          <NativeSelect className="h-8 text-xs" value={policy} onChange={(event) => setPolicy(event.target.value as "request" | "invite_only")}>
            <NativeSelectOption value="request">凭 UUID 申请，群主/管理员审批</NativeSelectOption>
            <NativeSelectOption value="invite_only">只接受邮箱邀请</NativeSelectOption>
          </NativeSelect>
        </Field>
        <Field label="首批虚拟员工" hint="建群时就拉进来，之后群里 @ 得到。">
          <ChipPick
            items={agents.map((agent) => ({ id: agent.id, label: agent.name, color: agent.color }))}
            picked={pickedAgents}
            onToggle={(id) => setPicked((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]))}
            empty="还没有虚拟员工"
          />
        </Field>
        <Field label="绑定办公虚拟机" hint="建群时可以先绑一台或多台，也可以之后在群面板里补。">
          <ChipPick
            items={vms.map((vm) => ({ id: vm.id, label: vm.label }))}
            picked={pickedVms}
            onToggle={(id) => setPickedVms((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]))}
            empty="还没有登记虚拟机"
          />
        </Field>
        <div className="md:col-span-2">
          <Field label="开场公告（可选）">
            <Textarea
              rows={2}
              value={announcement}
              onChange={(event) => setAnnouncement(event.target.value)}
              className="text-xs"
              placeholder="本群的交付节奏与验收口径"
            />
          </Field>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" className="text-xs" onClick={() => void create()} disabled={busy}>
          {busy ? "建群中…" : "建群"}
        </Button>
        <Button size="sm" variant="ghost" className="text-xs" onClick={onCancel} disabled={busy}>
          取消
        </Button>
      </div>
    </section>
  );
}

export function JoinByUuid({ onDone, onCancel }: { onDone: () => Promise<void>; onCancel: () => void }) {
  const [uuid, setUuid] = useState("");
  const [preview, setPreview] = useState<{ uuid: string; name: string; join_policy: string; member_count: number } | null>(null);
  const [already, setAlready] = useState(false);
  const [busy, setBusy] = useState(false);

  async function lookup() {
    setBusy(true);
    try {
      const result = await get<{ ok: true; preview: typeof preview; already_member: boolean }>("streams.lookup", { id: uuid.trim() });
      setPreview(result.preview);
      setAlready(result.already_member);
    } catch (error) {
      setPreview(null);
      toast.error(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    setBusy(true);
    try {
      const result = await post<{ ok: true; already_member?: boolean; status?: string }>("streams.apply", { stream_uuid: uuid.trim() });
      toast.success(result.already_member ? "你已经在这个群里了" : "申请已递交，等群主或管理员审批");
      setUuid("");
      setPreview(null);
      await onDone();
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid gap-3 rounded-lg border bg-card p-3">
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="text-sm font-semibold">凭 UUID 进群</h2>
        <p className="text-[11px] text-muted-foreground">群主把 UUID 发给你，查一下就能申请。</p>
      </header>
      <div className="flex max-w-xl gap-2">
        <Input
          value={uuid}
          onChange={(event) => setUuid(event.target.value)}
          placeholder="粘贴群 UUID"
          className="h-8 font-mono text-xs"
        />
        <Button size="sm" variant="outline" className="h-8 shrink-0 text-xs" onClick={() => void lookup()} disabled={busy || uuid.trim().length < 20}>
          查
        </Button>
      </div>
      {preview ? (
        <div className="grid max-w-xl gap-2">
          <div className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate">{preview.name}</span>
            <Badge variant="secondary" className="rounded-sm text-[11px]">
              {preview.member_count} 人 · {preview.join_policy === "invite_only" ? "仅邀请" : "可申请"}
            </Badge>
          </div>
          {already ? (
            <Button size="sm" variant="outline" className="justify-self-start text-xs" onClick={() => navigate(`/stream/${preview.uuid}`)}>
              我已经在群里，进入
            </Button>
          ) : preview.join_policy === "invite_only" ? (
            <Notice>这个群只接受邀请，让群主按邮箱邀请你。</Notice>
          ) : (
            <Button size="sm" className="justify-self-start text-xs" onClick={() => void apply()} disabled={busy}>
              申请进群
            </Button>
          )}
          <CopyButton value={preview.uuid} label="UUID" className="justify-self-start" />
        </div>
      ) : null}
      <Button size="sm" variant="ghost" className="justify-self-start text-xs" onClick={onCancel} disabled={busy}>
        取消
      </Button>
    </section>
  );
}

function ChipPick({
  items,
  picked,
  onToggle,
  empty,
}: {
  items: { id: string; label: string; color?: string }[];
  picked: string[];
  onToggle: (id: string) => void;
  empty: string;
}) {
  if (!items.length) return <p className="text-xs text-muted-foreground">{empty}</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => {
        const on = picked.includes(item.id);
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onToggle(item.id)}
            className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${
              on ? "border-signal bg-signal-soft text-signal" : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
