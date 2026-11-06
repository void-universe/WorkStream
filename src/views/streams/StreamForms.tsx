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
import { useI18n } from "../../lib/i18n";
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
  const i18n = useI18n();
  const [name, setName] = useState("");
  const [policy, setPolicy] = useState<"request" | "invite_only">("request");
  const [announcement, setAnnouncement] = useState("");
  const [pickedAgents, setPicked] = useState<string[]>([]);
  const [pickedVms, setPickedVms] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!name.trim()) {
      toast.error(i18n.t("streamForm.needName"));
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
      toast.success(i18n.tf("streamForm.createdToast", { uuid: shortUuid(result.stream.id) }));
      await onCreated();
      navigate(`/stream/${result.stream.id}`);
    } catch (error) {
      toast.error(describeError(i18n, error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid gap-3 rounded-lg border bg-card p-3">
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="text-sm font-semibold">{i18n.t("streamForm.createTitle")}</h2>
        <p className="text-[11px] text-muted-foreground">{i18n.t("streamForm.createHint")}</p>
      </header>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={i18n.t("streamForm.nameLabel")} htmlFor="new-stream-name">
          <Input
            id="new-stream-name"
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            placeholder={i18n.t("streamForm.namePlaceholder")}
            className="h-8 text-xs"
          />
        </Field>
        <Field label={i18n.t("streamForm.joinPolicyLabel")}>
          <NativeSelect className="h-8 text-xs" value={policy} onChange={(event) => setPolicy(event.target.value as "request" | "invite_only")}>
            <NativeSelectOption value="request">{i18n.t("streamForm.policyRequest")}</NativeSelectOption>
            <NativeSelectOption value="invite_only">{i18n.t("streamForm.policyInviteOnly")}</NativeSelectOption>
          </NativeSelect>
        </Field>
        <Field label={i18n.t("streamForm.firstAgentsLabel")} hint={i18n.t("streamForm.firstAgentsHint")}>
          <ChipPick
            items={agents.map((agent) => ({ id: agent.id, label: agent.name, color: agent.color }))}
            picked={pickedAgents}
            onToggle={(id) => setPicked((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]))}
            empty={i18n.t("streamForm.noAgents")}
          />
        </Field>
        <Field label={i18n.t("streamForm.bindVmLabel")} hint={i18n.t("streamForm.bindVmHint")}>
          <ChipPick
            items={vms.map((vm) => ({ id: vm.id, label: vm.label }))}
            picked={pickedVms}
            onToggle={(id) => setPickedVms((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]))}
            empty={i18n.t("streamForm.noVms")}
          />
        </Field>
        <div className="md:col-span-2">
          <Field label={i18n.t("streamForm.announcementLabel")}>
            <Textarea
              rows={2}
              value={announcement}
              onChange={(event) => setAnnouncement(event.target.value)}
              className="text-xs"
              placeholder={i18n.t("streamForm.announcementPlaceholder")}
            />
          </Field>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" className="text-xs" onClick={() => void create()} disabled={busy}>
          {busy ? i18n.t("streamForm.creating") : i18n.t("streamForm.createAction")}
        </Button>
        <Button size="sm" variant="ghost" className="text-xs" onClick={onCancel} disabled={busy}>
          {i18n.t("streamForm.cancel")}
        </Button>
      </div>
    </section>
  );
}

export function JoinByUuid({ onDone, onCancel }: { onDone: () => Promise<void>; onCancel: () => void }) {
  const i18n = useI18n();
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
      toast.error(describeError(i18n, error));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    setBusy(true);
    try {
      const result = await post<{ ok: true; already_member?: boolean; status?: string }>("streams.apply", { stream_uuid: uuid.trim() });
      toast.success(result.already_member ? i18n.t("streamForm.alreadyMemberToast") : i18n.t("streamForm.appliedToast"));
      setUuid("");
      setPreview(null);
      await onDone();
    } catch (error) {
      toast.error(describeError(i18n, error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid gap-3 rounded-lg border bg-card p-3">
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="text-sm font-semibold">{i18n.t("streamForm.joinTitle")}</h2>
        <p className="text-[11px] text-muted-foreground">{i18n.t("streamForm.joinHint")}</p>
      </header>
      <div className="flex max-w-xl gap-2">
        <Input
          value={uuid}
          onChange={(event) => setUuid(event.target.value)}
          placeholder={i18n.t("streamForm.uuidPlaceholder")}
          className="h-8 font-mono text-xs"
        />
        <Button size="sm" variant="outline" className="h-8 shrink-0 text-xs" onClick={() => void lookup()} disabled={busy || uuid.trim().length < 20}>
          {i18n.t("streamForm.lookup")}
        </Button>
      </div>
      {preview ? (
        <div className="grid max-w-xl gap-2">
          <div className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate">{preview.name}</span>
            <Badge variant="secondary" className="rounded-sm text-[11px]">
              {i18n.tf("streamForm.memberCount", { n: preview.member_count })} · {preview.join_policy === "invite_only" ? i18n.t("streamForm.policyInviteShort") : i18n.t("streamForm.policyRequestShort")}
            </Badge>
          </div>
          {already ? (
            <Button size="sm" variant="outline" className="justify-self-start text-xs" onClick={() => navigate(`/stream/${preview.uuid}`)}>
              {i18n.t("streamForm.alreadyEnter")}
            </Button>
          ) : preview.join_policy === "invite_only" ? (
            <Notice>{i18n.t("streamForm.inviteOnlyNotice")}</Notice>
          ) : (
            <Button size="sm" className="justify-self-start text-xs" onClick={() => void apply()} disabled={busy}>
              {i18n.t("streamForm.applyAction")}
            </Button>
          )}
          <CopyButton value={preview.uuid} label="UUID" className="justify-self-start" />
        </div>
      ) : null}
      <Button size="sm" variant="ghost" className="justify-self-start text-xs" onClick={onCancel} disabled={busy}>
        {i18n.t("streamForm.cancel")}
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
