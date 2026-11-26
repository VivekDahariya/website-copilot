import { runAgent } from "./agent.js";
import { DIRECT_INSTRUCTION_GOAL } from "./direct-instruction.js";
import {
  runAutonomousBookWorkflow
} from "./autonomous-workflow.js";

export async function executeTask(
  page,
  task,
  options = {}
) {
  if (!page) {
    throw new Error("A browser page is required.");
  }

  if (!task || typeof task !== "object") {
    throw new Error("A structured task is required.");
  }

  const { type } = task;

  if (type === "browser_goal") {
    if (
      typeof task.instruction !== "string" ||
      !task.instruction.trim() ||
      !task.goal ||
      typeof task.goal !== "object"
    ) {
      throw new Error(
        "browser_goal requires instruction and goal."
      );
    }

    if (task.startUrl) {
      await page.goto(task.startUrl, {
        waitUntil: "domcontentloaded"
      });
    }

    const result = await runAgent(
      page,
      task.instruction,
      task.goal,
      {
        ...(options.agentOptions ?? {}),
        originalInstruction:
          options.originalInstruction ?? task.instruction
      }
    );

    return {
      taskType: type,
      status: result.status,
      result
    };
  }

  // Direct-instruction mode: the original instruction is the only intent.
  // No structured goal is generated or required.
  if (type === "direct_instruction") {
    if (
      typeof task.instruction !== "string" ||
      !task.instruction.trim()
    ) {
      throw new Error("direct_instruction requires an instruction.");
    }

    const result = await runAgent(
      page,
      task.instruction,
      DIRECT_INSTRUCTION_GOAL,
      {
        ...(options.agentOptions ?? {}),
        originalInstruction:
          options.originalInstruction ?? task.instruction
      }
    );

    return {
      taskType: type,
      status: result.status,
      result
    };
  }

  if (type === "product_comparison") {
    if (
      typeof task.startUrl !== "string" ||
      (
        typeof task.category !== "string" &&
        !Array.isArray(task.titles)
      ) ||
      !task.startUrl.trim() ||
      (
        !task.category?.trim() &&
        !(
          Array.isArray(task.titles) &&
          task.titles.length === 2
        )
      )
    ) {
      throw new Error(
        "product_comparison requires startUrl and category."
      );
    }

    const result = await runAutonomousBookWorkflow(
      page,
      {
        startUrl: task.startUrl,
        category: task.category,
        productNames: task.titles ?? null,
        limit: task.limit ?? 3,
        ...(options.reasoner
          ? { reasoner: options.reasoner }
          : {})
      }
    );

    return {
      taskType: type,
      status: result.status,
      result
    };
  }

  throw new Error(
    `Unsupported task type: ${String(type)}`
  );
}
