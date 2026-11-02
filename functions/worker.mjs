// 常驻调度进程：站点 Function 自己不能驻留，所以邮箱推进要么靠前端轮询，要么靠这个循环。
// 与前端轮询共用同一个 scheduler.tick；认领是 queued→running 的单行 CAS，两边同时跑不会重复执行。
import { actions, reapStale } from "./engine.mjs";
import { store } from "./store.mjs";

// 允许并发的 tick 数：某个群里的长任务在跑时，别的群的排队不能被它堵在队头。
const MAX_INFLIGHT = 3;

export function startWorker({ supabase, env, tickMs = 1_000, log = (line) => console.log(line) }) {
  const db = store(supabase);
  const tick = actions["scheduler.tick"];
  let inflight = 0;
  let stopped = false;

  log(`[worker] 常驻调度已启动：间隔 ${tickMs}ms，最多 ${MAX_INFLIGHT} 轮并发`);
  // 定时器不等上一轮结束：某个群的长任务在跑时，别的群的排队仍要按间隔被捡起来。
  const timer = setInterval(() => void step(), tickMs);
  void step();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      while (inflight > 0) await new Promise((resolve) => setTimeout(resolve, 50));
    },
  };

  /** 一轮：回收僵尸任务 → 只找真有排队的员工 → 按其主人逐个跑 tick。
   *  不按用户全表扫（store 也禁止空条件查询），空闲时整轮只有两条查询。 */
  async function once() {
    await reapStale(db);
    const queued = await db.mail.list([["status", "queued"]], { columns: "agent_id", limit: 200 });
    if (!queued.length) return { ran: [], queued: 0 };
    const agentIds = [...new Set(queued.map((mail) => mail.agent_id))];
    const agents = await db.agents.list([["id", agentIds]], { columns: "owner_id", limit: 60 });
    const owners = [...new Set(agents.map((agent) => agent.owner_id).filter(Boolean))];
    const results = await Promise.all(owners.map((ownerId) => tick({
      db, env, params: new URLSearchParams(), user: { id: ownerId },
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
