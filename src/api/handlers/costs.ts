/**
 * Cost Tracking API Handler
 *
 * Aggregates cost data from task checkpoints and results.
 */

import type { TaskQueue } from "../../tasks/TaskQueue.js";
import type { CostSummary } from "../../tasks/types.js";

export type CostHandlerDeps = {
  taskQueue: TaskQueue;
};

// GET /api/costs
export async function handleGetCosts(
  deps: CostHandlerDeps,
): Promise<{ status: number; body: unknown }> {
  const allTasks = await deps.taskQueue.list({});
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const weekStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - now.getDay(),
  ).toISOString();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const summary: CostSummary = {
    total: { today: 0, thisWeek: 0, thisMonth: 0 },
    byAgent: {},
    byModel: {},
    topTasks: [],
  };

  const taskCosts: Array<{ id: string; title: string; cost: number; agent: string }> = [];

  for (const task of allTasks) {
    if (!task.result) {
      continue;
    }

    const cost = task.result.totalCost;
    const completedAt = task.result.completedAt ?? "";
    const agent = task.assignee;
    const model = task.result.model ?? "unknown";

    // Aggregate totals by time period
    if (completedAt >= monthStart) {
      summary.total.thisMonth += cost;
      if (completedAt >= weekStart) {
        summary.total.thisWeek += cost;
        if (completedAt >= todayStart) {
          summary.total.today += cost;
        }
      }
    }

    // By agent
    if (!summary.byAgent[agent]) {
      summary.byAgent[agent] = { today: 0, thisWeek: 0, thisMonth: 0 };
    }
    if (completedAt >= monthStart) {
      summary.byAgent[agent].thisMonth += cost;
      if (completedAt >= weekStart) {
        summary.byAgent[agent].thisWeek += cost;
        if (completedAt >= todayStart) {
          summary.byAgent[agent].today += cost;
        }
      }
    }

    // By model
    if (!summary.byModel[model]) {
      summary.byModel[model] = { tokens: { input: 0, output: 0 }, cost: 0 };
    }
    summary.byModel[model].cost += cost;
    if (task.result.totalTokens) {
      summary.byModel[model].tokens.input += task.result.totalTokens.input;
      summary.byModel[model].tokens.output += task.result.totalTokens.output;
    }

    // Collect for top tasks
    taskCosts.push({ id: task.id, title: task.title, cost, agent });
  }

  // Top 5 most expensive tasks
  taskCosts.sort((a, b) => b.cost - a.cost);
  summary.topTasks = taskCosts.slice(0, 5);

  return { status: 200, body: summary };
}
