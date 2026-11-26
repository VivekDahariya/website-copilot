// Privacy-safe, observation-only runtime metrics for the local Website CoPilot dashboard.
// Uses Node's undici diagnostics channels to count actual Ollama HTTP requests;
// no requests, responses, URLs, prompts, form values or browser contents are recorded.
import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const scope = new AsyncLocalStorage();
const requestSpans = new WeakMap();
let listenersInstalled = false;

function isOllamaRequest(request) {
  try {
    const origin = new URL(request?.origin);
    const target = new URL(process.env.COPILOT_OLLAMA_URL || 'http://127.0.0.1:11434/api/chat');
    const isConfiguredEndpoint = origin.origin === target.origin;
    const isDefaultOllama = (origin.hostname === '127.0.0.1' || origin.hostname === 'localhost') &&
      origin.port === '11434';
    return (isConfiguredEndpoint || isDefaultOllama) &&
      /^\/(?:api\/(?:chat|generate|embed|embeddings)|v1\/(?:chat\/completions|responses|embeddings))(?:[/?]|$)/.test(String(request?.path || ''));
  } catch {
    return false;
  }
}

function finishRequest(request, failed = false) {
  const span = requestSpans.get(request);
  if (!span || span.finished) return;
  span.finished = true;
  const duration = Math.max(0, performance.now() - span.start);
  span.trace.model.totalMs += Math.round(duration);
  if (failed || span.httpFailed) span.trace.model.failedCalls++;
  requestSpans.delete(request);
}

function installListeners() {
  if (listenersInstalled) return;
  listenersInstalled = true;
  channel('undici:request:create').subscribe(({ request }) => {
    const trace = scope.getStore();
    if (!trace || !isOllamaRequest(request)) return;
    trace.model.calls++;
    requestSpans.set(request, { trace, start: performance.now(), finished: false, httpFailed: false });
  });
  channel('undici:request:headers').subscribe(({ request, response }) => {
    const span = requestSpans.get(request);
    if (span) span.httpFailed = Number(response?.statusCode) >= 400;
  });
  channel('undici:request:trailers').subscribe(({ request }) => finishRequest(request));
  channel('undici:request:error').subscribe(({ request }) => finishRequest(request, true));
}

export function recordAgentMetric(event) {
  const trace = scope.getStore();
  if (!trace || !event || typeof event !== 'object') return;
  switch (event.type) {
    case 'page_observed': trace.agent.observations++; break;
    case 'planning_started': trace.agent.planningAttempts++; break;
    case 'action_selected': trace.agent.selectedActions++; break;
    case 'action_executed':
      trace.agent.executedActions += event.executionCompleted === true ? 1 : 0;
      trace.agent.verifiedActions += event.verified === true ? 1 : 0;
      break;
    case 'form_fast_path_planned':
      trace.agent.fastPathPlans++;
      if (event.source === 'goal_grounded') trace.agent.groundedFastPathPlans++;
      break;
    case 'form_fast_path_next': trace.agent.cachedActions++; break;
    case 'form_fast_path_fallback':
      trace.agent.fastPathFallbacks++;
      // Only known internal reason codes; never persist raw model/page text.
      {
        const reason = event.reason === 'no_safe_batch' ? 'no_safe_batch' : 'other';
        trace.agent.fastPathFallbackReasons[reason] =
          (trace.agent.fastPathFallbackReasons[reason] || 0) + 1;
      }
      break;
    case 'plan_invalidated': trace.agent.stalePlans++; break;
    default: break;
  }
}

export function recordExecutionDurations(history) {
  const trace = scope.getStore();
  if (!trace || !Array.isArray(history)) return;
  for (const step of history) {
    const duration = step?.execution?.durationMs;
    if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) {
      trace.browser.measuredActions++;
      trace.browser.executionMs += Math.round(duration);
    }
  }
}

function safeStatus(status) {
  const value = String(status ?? 'unknown');
  return /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : 'unknown';
}

async function saveSummary(summary, directory) {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = `${summary.startedAt.replaceAll(':', '-').replaceAll('.', '-')}-${summary.runId}.json`;
    await writeFile(join(directory, filename), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    // Keep at most 50 metadata-only runs; never touch unrelated files.
    const files = (await readdir(directory)).filter(name =>
      /^\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f-]{36}\.json$/.test(name)).sort();
    for (const old of files.slice(0, Math.max(0, files.length - 50))) {
      await unlink(join(directory, old));
    }
    return true;
  } catch {
    // Telemetry must never interfere with a browser task.
    return false;
  }
}

export async function withRunMetrics(run, { outputDirectory, status, onComplete } = {}) {
  if (process.env.COPILOT_TRACE === '0') return run();
  installListeners();
  const startedMs = performance.now();
  const trace = {
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    model: { calls: 0, failedCalls: 0, totalMs: 0 },
    agent: {
      observations: 0, planningAttempts: 0, selectedActions: 0,
      executedActions: 0, verifiedActions: 0, fastPathPlans: 0,
      groundedFastPathPlans: 0, cachedActions: 0, fastPathFallbacks: 0, fastPathFallbackReasons: {}, stalePlans: 0
    },
    browser: { measuredActions: 0, executionMs: 0 }
  };
  return scope.run(trace, async () => {
    try {
      return await run();
    } finally {
      const summary = {
        schemaVersion: 1,
        runId: trace.runId,
        startedAt: trace.startedAt,
        endedAt: new Date().toISOString(),
        status: safeStatus(typeof status === 'function' ? status() : status),
        totalMs: Math.round(performance.now() - startedMs),
        model: trace.model,
        agent: trace.agent,
        browser: trace.browser
      };
      if (outputDirectory) await saveSummary(summary, outputDirectory);
      try { onComplete?.(summary); } catch { /* no effect on run */ }
    }
  });
}
