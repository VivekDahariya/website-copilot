export class AgentRunCancelledError extends Error {
  constructor() {
    super("Agent run cancelled by user.");
    this.name = "AgentRunCancelledError";
  }
}

export function createAgentRunControl({ onPaused = null } = {}) {
  let state = "running";
  let revision = 0;
  const waiters = new Set();

  function releaseWaiters() {
    for (const resolve of waiters) resolve();
    waiters.clear();
  }

  function pause() {
    if (state !== "running") return false;

    state = "pause_requested";
    revision++;
    return true;
  }

  function resume() {
    if (state !== "paused") return false;

    state = "running";
    revision++;
    releaseWaiters();
    return true;
  }

  function cancel() {
    if (state === "cancelled") return false;

    state = "cancelled";
    revision++;
    releaseWaiters();
    return true;
  }

  async function checkpoint(expectedRevision = null) {
    if (state === "cancelled") {
      throw new AgentRunCancelledError();
    }

    // Acknowledge pause only after reaching a safe checkpoint.
    if (state === "pause_requested") {
      state = "paused";

      if (typeof onPaused === "function") {
        try {
          onPaused();
        } catch {
          // UI notifications cannot interrupt the agent.
        }
      }
    }

    while (state === "paused") {
      await new Promise(resolve => waiters.add(resolve));

      if (state === "cancelled") {
        throw new AgentRunCancelledError();
      }
    }

    return {
      revision,
      stale:
        expectedRevision !== null &&
        expectedRevision !== revision
    };
  }

  return {
    pause,
    resume,
    cancel,
    checkpoint,
    getState: () => state,
    getRevision: () => revision,
    isCancelled: () => state === "cancelled"
  };
}
