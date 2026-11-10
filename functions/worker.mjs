// 常驻调度进程：站点 Function 自己不能驻留，所以邮箱推进要么靠前端轮询，要么靠这个循环。
// 分布式形态下它就是独立 worker 进程（可分布在多台 server），对着同一个库认领与提交；
// 控制面升级/重启时在跑的回合不受影响——回合活在这里，不在控制面进程里。
// 与前端轮询共用同一个 scheduler.tick；认领是 queued→running 的单行 CAS，两边同时跑不会重复执行。
import { dueOwnerIds } from "./cron.mjs";
import { actions, reapStale } from "./engine.mjs";
import { store } from "./store.mjs";
import { newId, now } from "./util.mjs";

// 允许并发的 tick 数：某个群里的长任务在跑时，别的群的排队不能被它堵在队头。
const MAX_INFLIGHT = 3;

export function startWorker({
  supabase, env, tickMs = 1_000, heartbeatMs = 5_000,
  workerId = newId(), label = "worker", version = "",
  log = (line) => console.log(line),
}) {
  const db = store(supabase);
  const tick = actions["scheduler.tick"];
  let inflight = 0;
  let stopped = false;
  let registered = false;
  // 这台 worker 此刻认领且在跑的信：心跳定时器替它们刷新 mail.heartbeat_at，回收据此不误杀长任务。
  const runningMails = new Set();
  const workerHook = {
    id: workerId,
    track: (id) => runningMails.add(id),
    untrack: (id) => runningMails.delete(id),
  };

  log(`[worker] ${label} 常驻调度已启动：间隔 ${tickMs}ms，心跳 ${heartbeatMs}ms，最多 ${MAX_INFLIGHT} 轮并发`);
  // 定时器不等上一轮结束：某个群的长任务在跑时，别的群的排队仍要按间隔被捡起来。
  const timer = setInterval(() => void step(), tickMs);
  const heartbeat = setInterval(() => void beat(), heartbeatMs);
  void step();
  void beat();

  return {
    id: workerId,
    async stop() {
      stopped = true;
      clearInterval(timer);
      clearInterval(heartbeat);
      // 优雅退出：先标 draining（不再被当成活跃 worker），排空在跑的回合，再落 stopped 留作对账。
      await db.workers.patch([["id", workerId]], { status: "draining", updated_at: now() }, { returning: false })
        .catch((error) => log(`[worker] draining 写库失败：${error?.error ?? error?.message ?? String(error)}`));
      while (inflight > 0 || runningMails.size > 0) await new Promise((resolve) => setTimeout(resolve, 50));
      await db.workers.patch([["id", workerId]], { status: "stopped", inflight: 0, last_heartbeat_at: now(), updated_at: now() }, { returning: false })
        .catch((error) => log(`[worker] stopped 写库失败：${error?.error ?? error?.message ?? String(error)}`));
    },
  };

  /** 心跳：先替在跑的信刷新 heartbeat_at（回收的正确性信号，不依赖 workers 行），再写 workers 观测行。
   *  workers 行注册失败只日志、下一轮再试——观测短暂缺位不影响执行；信心跳失败也如实报，不静默吞。 */
  async function beat() {
    if (stopped) return;
    const stamp = now();
    const settled = await Promise.allSettled([...runningMails].map((id) =>
      db.mail.patch([["id", id], ["status", "running"]], { heartbeat_at: stamp }, { returning: false })));
    for (const item of settled) {
      if (item.status === "rejected") {
        log(`[worker] 信心跳写库失败：${item.reason?.error ?? item.reason?.message ?? String(item.reason)}`);
      }
    }
    try {
      if (!registered) {
        await db.workers.upsert({
          id: workerId, label, version, status: "active", inflight: runningMails.size,
          last_heartbeat_at: stamp, created_at: stamp, updated_at: stamp,
        }, { onConflict: "id" });
        registered = true;
      } else {
        await db.workers.patch([["id", workerId]], {
          last_heartbeat_at: stamp, inflight: runningMails.size, updated_at: stamp,
        }, { returning: false });
      }
    } catch (error) {
      log(`[worker] 心跳写库失败：${error?.error ?? error?.message ?? String(error)}`);
    }
  }

  /** 一轮：回收僵尸任务 → 找有活儿的主人（排队的信 + 到期的排程）→ 按其主人逐个跑 tick。
   *  不按用户全表扫（store 也禁止空条件查询），空闲且没到期时整轮只有三条查询。 */
  async function once() {
    await reapStale(db, env);
    const queued = await db.mail.list([["status", "queued"]], { columns: "agent_id", limit: 200 });
    const agentIds = [...new Set(queued.map((mail) => mail.agent_id))];
    // 空闲时也要有人替排程醒着：只看"有没有排队信"的话，一个安静的群永远攒不出第一封，
    // 到点的排程就只会躺在表里等一个不会来的触发。这一步是纯读，真正的投递在 tick 里带 CAS。
    const cronOwners = await dueOwnerIds(db, { nowMs: Date.now() });
    if (!agentIds.length && !cronOwners.length) return { ran: [], queued: 0 };
    const agents = agentIds.length
      ? await db.agents.list([["id", agentIds]], { columns: "owner_id", limit: 60 })
      : [];
    const owners = [...new Set([...agents.map((agent) => agent.owner_id).filter(Boolean), ...cronOwners])];
    const results = await Promise.all(owners.map((ownerId) => tick({
      db, env, params: new URLSearchParams(), user: { id: ownerId }, worker: workerHook,
    }).then((response) => response.json())));
    return {
      ran: results.flatMap((result) => result.ran ?? []),
      queued: results.reduce((sum, result) => sum + Number(result.queued ?? 0), 0),
    };
  }

  async function step() {
    if (stopped || inflight >= MAX_INFLIGHT) return;
    inflight += 1;
    let result = null;
    try {
      result = await once();
      for (const item of result.ran) {
        const tail = item.error ? ` error=${item.error}` : ` ${item.mode ?? "-"} ${item.ms ?? 0}ms`;
        log(`[worker] ${item.status} stream=${item.stream_id} agent=${item.agent_id}${tail}`);
      }
    } catch (error) {
      log(`[worker] tick 失败：${error?.error ?? error?.message ?? String(error)}`);
    } finally {
      inflight -= 1;
    }
    // 时间片预算下一轮才会放剩下的排队，所以还有活就立刻接着跑，别等空闲间隔。
    if (result?.ran?.length && result.queued > 0) void step();
  }
}
