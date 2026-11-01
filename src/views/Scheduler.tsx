// 调度台：每个虚拟员工在各群里的时间片份额、队列状态与手动推进一格。
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { describeError, get, type Agent } from "../api";
import type { Stream } from "../types";
import { shortUuid, timeAgo } from "../lib/format";
import { Notice, PersonAvatar, StatRow } from "../lib/ui";

type Slice = {
  stream_id: string;
  name: string;
  weight: number;
  share: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  slices: number;
  last_error: string | null;
};

type Board = { ok: true; boards: { agent: Agent; streams: Slice[] }[]; budget: number };

export function SchedulerView({ onBusyChanged }: { onBusyChanged?: (busy: boolean) => void }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [next, mine] = await Promise.all([
        get<Board>("scheduler.board"),
        get<{ ok: true; items: Stream[] }>("streams.mine"),
      ]);
      setBoard(next);
      setStreams(mine.items);
    } catch (error) {
      toast.error(describeError(error));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function tick() {
    setBusy(true);
    onBusyChanged?.(true);
    try {
      const result = await get<{ ok: true; ran: unknown[]; queued: number; budget?: number }>("scheduler.tick", { since: 0 });
      toast.success(result.ran.length ? `这一格推进了 ${result.ran.length} 个任务` : "没有待办任务，队列是空的");
      await refresh();
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy(false);
      onBusyChanged?.(false);
    }
  }

  const totals = (board?.boards ?? [])
    .flatMap((entry) => entry.streams)
    .reduce(
      (sum, row) => ({
        queued: sum.queued + row.queued,
        running: sum.running + row.running,
        done: sum.done + row.done,
        failed: sum.failed + row.failed,
      }),
      { queued: 0, running: 0, done: 0, failed: 0 },
    );

  return (
    <div className="mx-auto grid h-full w-full max-w-5xl min-h-0 gap-4 overflow-y-auto p-4 scrollbar-thin md:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-lg font-semibold tracking-tight">调度台</h1>
          <p className="text-sm text-muted-foreground">
            每个虚拟员工按 FIFO 从自己的邮箱取件，跨群按权重切时间片；没有实时抢占，单个任务会跑完再让位。
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="text-xs" onClick={() => void refresh()}>
            刷新
          </Button>
          <Button size="sm" className="text-xs" onClick={() => void tick()} disabled={busy}>
            {busy ? "推进中…" : "手动推进一格"}
          </Button>
        </div>
      </header>

      <div className="grid gap-2 rounded-lg border bg-card p-3 sm:grid-cols-4">
        <StatRow label="每格槽位预算" value={board?.budget ?? "—"} tone="muted" />
        <StatRow label="排队" value={totals.queued} tone="machine" />
        <StatRow label="运行中" value={totals.running} tone="signal" />
        <StatRow label="完成 / 失败" value={`${totals.done} / ${totals.failed}`} tone="muted" />
      </div>

      {!board?.boards.length ? (
        <Notice>还没有可调度的人：先创建虚拟员工，并让 ta 进至少一个群。</Notice>
      ) : null}

      {board?.boards.map((entry) => {
        const totalWeight = entry.streams.reduce((sum, row) => sum + row.weight, 0) || 1;
        return (
          <Card key={entry.agent.id}>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <PersonAvatar name={entry.agent.name} kind="agent" color={entry.agent.color} avatar={entry.agent.avatar} />
                <div className="min-w-0 flex-1">
                  <CardTitle className="truncate text-sm">{entry.agent.name}</CardTitle>
                  <CardDescription className="truncate text-xs">{entry.agent.role}</CardDescription>
                </div>
                <Badge variant={entry.agent.status === "paused" ? "secondary" : "outline"} className="rounded-sm text-xs">
                  {entry.agent.status === "paused" ? "暂停接活" : `${entry.agent.model} · ${entry.agent.api_key_tail}`}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="grid gap-3">
              {entry.streams.map((slice) => (
                <div key={slice.stream_id} className="grid gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <a className="truncate text-sm hover:underline" href={`#/stream/${slice.stream_id}`}>
                      {slice.name || shortUuid(slice.stream_id)}
                    </a>
                    <span className="font-mono text-[11px] text-muted-foreground">权重 {slice.weight}/{totalWeight}</span>
                    <span className="ml-auto flex items-center gap-1.5">
                      {slice.queued ? <Badge variant="secondary" className="rounded-sm font-mono text-[11px]">排队 {slice.queued}</Badge> : null}
                      {slice.running ? <Badge className="rounded-sm font-mono text-[11px]">运行 {slice.running}</Badge> : null}
                      <span className="font-mono text-[11px] text-muted-foreground">片 {slice.slices}</span>
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Progress value={slice.share} className="h-1.5" />
                    <span className="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">{slice.share}%</span>
                  </div>
                  {slice.last_error ? <p className="text-[11px] text-destructive">最近失败：{slice.last_error}</p> : null}
                </div>
              ))}
              <Separator />
              <p className="text-xs text-muted-foreground">
                份额由最大余数法从每格预算里切出；改权重请在群里的「成员」面板由群主或管理员确认。
              </p>
            </CardContent>
          </Card>
        );
      })}

      {streams.length ? (
        <p className="text-xs text-muted-foreground">
          你在 {streams.length} 个群里；最近一次活动 {timeAgo(streams[0]?.created_at)}。
        </p>
      ) : null}
    </div>
  );
}
