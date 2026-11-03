// 工具调用回路：pre → execute → post 三段，钩子共享同一个可写 ctx。
// 这是每次工具调用唯一的落笔点：轨迹落库挂在这里，以后要加策略（限流、审计、审批）也挂在这里。
// 钩子只观察、补写，不改工具返回值、不拦调用——拦下调用需要策略层，现在没有第二个消费者，
// 先把接缝留出来，不发明没人用的语义。
export function createPipeline(hooks = []) {
  const list = [...hooks];
  return {
    /** 注册一个钩子，返回注销函数：每次注册都是一个可撤销的副作用。 */
    use(hook) {
      list.push(hook);
      return () => {
        const index = list.indexOf(hook);
        if (index >= 0) list.splice(index, 1);
      };
    },
    get hooks() {
      return [...list];
    },
    async run(ctx, execute) {
      for (const hook of list) await hook.pre?.(ctx);
      let failure = null;
      try {
        ctx.output = await execute(ctx);
      } catch (error) {
        failure = error;
        ctx.error = error;
      }
      try {
        for (const hook of list) await hook.post?.(ctx);
      } catch (error) {
        // 步骤没写上也得报出来；但已经有上游失败时，那条才是这轮真正该记的错误码。
        if (!failure) throw error;
      }
      if (failure) throw failure;
      return ctx.output;
    },
  };
}
