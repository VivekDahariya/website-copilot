// Metadata-only, observation-only evidence ledger for one Website CoPilot run.
// Follows the pre-existing workflow verifier: it NEVER authorizes an action,
// verifies a goal independently, or changes task outcomes.
// No prompts, user data, raw field values, URLs, labels, HTML, or screenshots.
import { AsyncLocalStorage } from 'node:async_hooks';
import { assessEvidenceGraphV2 } from './state-verifier-v2.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const scope = new AsyncLocalStorage();
const KINDS = new Set(['form_state','visible_content','page_destination','visible_form',
  'element_count','paragraph_count','modal_closed','other']);
const OPS = new Set(['fill','select','check','uncheck','click','press','switch_tab',
  'back','scroll','download','human_handover','other']);
const PROOFS = new Set(['browser_element','action_receipt','human_handover',
  'confirmed_transition','previously_witnessed','verifier_boolean','unmatched']);
const SAFE_STATUSES = /^[a-z][a-z0-9_]{0,63}$/;
function ref(v) { return typeof v === 'string' && /^e\d{1,6}$/.test(v) ? v : null; }
function status(v) { return typeof v === 'string' && SAFE_STATUSES.test(v) ? v : 'unknown'; }
function operation(v) { return OPS.has(v) ? v : 'other'; }
function int(v, max = 1e7) { return Number.isSafeInteger(v) && v >= 0 && v <= max ? v : 0; }
function capPush(array, item, max = 120) {
  array.push(item);
  if (array.length > max) array.shift();
}
function snapshot(graph, event) {
  const reqs = Array.isArray(event.requirements) ? event.requirements.slice(0, 40) : [];
  const index = graph.snapshotsSeen++;
  const nodes = [];
  for (let i = 0; i < reqs.length; i++) {
    const source = reqs[i];
    const id = `r${i + 1}`;
    const matched = source?.matched === true;
    const elementRef = ref(source?.elementRef);
    const proof = PROOFS.has(source?.proof) ? source.proof : 'unmatched';
    let node = graph.requirements.get(id);
    if (!node) {
      node = {id, kind: KINDS.has(source?.kind) ? source.kind : 'other',
        matched: false, firstMatchedSnapshot: null, lastProof: 'unmatched', elementRef: null};
      graph.requirements.set(id, node);
    }
    // Match status represents the latest observation, not a permanent success.
    if (matched && !node.matched) {
      const action = [...graph.actions].reverse().find(item =>
        item.executed && elementRef && item.elementRef === elementRef);
      capPush(graph.edges, {
        requirement: id, proof, snapshot: index,
        action: action?.id ?? null
      });
      if (node.firstMatchedSnapshot === null) node.firstMatchedSnapshot = index;
    }
    node.matched = matched;
    node.lastProof = proof;
    node.elementRef = elementRef;
    nodes.push({id, matched, proof, elementRef});
  }
  graph.lastSnapshot = {
    index, step: int(event.step, 50),
    phase: event.phase === 'post_action' ? 'post_action' : 'pre_action',
    complete: event.complete === true,
    explicitFailureEvidence: event.explicitFailureEvidence === true,
    finalizingActionObserved: event.finalizingActionObserved === true,
    finalTransitionVerified: event.finalTransitionVerified === true,
    conditions: nodes
  };
  capPush(graph.checkpoints, {
    index, step: graph.lastSnapshot.step, phase: graph.lastSnapshot.phase,
    matched: nodes.filter(n => n.matched).length, total: nodes.length,
    complete: graph.lastSnapshot.complete
  });
}
function selectedAction(graph, event) {
  const item = {id:`a${++graph.actionsSeen}`, operation:operation(event.operation),
    elementRef:ref(event.ref), executed:false, verified:false, failed:false};
  capPush(graph.actions, item);
}
function actionOutcome(graph, event, failed = false) {
  const op = operation(event.operation), elementRef = ref(event.ref);
  let item = [...graph.actions].reverse().find(x =>
    !x.executed && !x.failed && x.operation === op && x.elementRef === elementRef);
  if (!item) {
    item = {id:`a${++graph.actionsSeen}`, operation:op, elementRef,
      executed:false, verified:false, failed:false};
    capPush(graph.actions, item);
  }
  item.executed = event.executionCompleted === true && !failed;
  item.verified = event.verified === true && item.executed;
  item.failed = failed || event.executionCompleted === false;
}
export function recordEvidenceEvent(event) {
  const graph = scope.getStore();
  if (!graph || !event || typeof event !== 'object') return;
  try {
    switch (event.type) {
      case 'evidence_snapshot': snapshot(graph, event); break;
      case 'evidence_invariant':
        graph.protectedStateChecks++;
        if (event.passed === false) graph.protectedStateViolations++;
        break;
      case 'action_selected': selectedAction(graph, event); break;
      case 'action_executed': actionOutcome(graph, event); break;
      case 'action_failed': actionOutcome(graph, event, true); break;
      case 'goal_verified': graph.goalVerifiedEvents++; break;
      default: break;
    }
  } catch { /* Observation cannot affect the browser agent. */ }
}
async function save(graph, directory) {
  try {
    await mkdir(directory, {recursive:true,mode:0o700});
    const file = `${graph.startedAt.replaceAll(':','-').replaceAll('.','-')}-${graph.runId}.json`;
    await writeFile(join(directory,file),JSON.stringify(graph,null,2)+'\n',{
      mode:0o600,flag:'wx'
    });
    const files = (await readdir(directory)).filter(name =>
      /^\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f-]{36}\.json$/.test(name)).sort();
    for (const old of files.slice(0,Math.max(0,files.length-50))) await unlink(join(directory,old));
    return true;
  } catch { return false; }
}
export async function withEvidenceGraph(run, {outputDirectory, status: getStatus, onComplete} = {}) {
  if (process.env.COPILOT_EVIDENCE_GRAPH === '0') return run();
  const graph = {
    schemaVersion:1, mode:'observation_only', runId:randomUUID(),
    startedAt:new Date().toISOString(), status:'unknown',
    requirements:new Map(), actions:[], edges:[], checkpoints:[],
    snapshotsSeen:0, actionsSeen:0, protectedStateChecks:0,
    protectedStateViolations:0, goalVerifiedEvents:0, lastSnapshot:null
  };
  return scope.run(graph,async () => {
    try { return await run(); }
    finally {
      let completionStatus = 'unknown';
      try { completionStatus = status(typeof getStatus === 'function' ? getStatus() : getStatus); }
      catch { /* Bad telemetry status cannot fail the browser task. */ }
      const report = {
        schemaVersion:1, mode:'observation_only', runId:graph.runId,
        startedAt:graph.startedAt, endedAt:new Date().toISOString(),
        status:completionStatus,
        requirements:[...graph.requirements.values()],
        actions:graph.actions, edges:graph.edges, checkpoints:graph.checkpoints,
        snapshotsSeen:graph.snapshotsSeen, actionsSeen:graph.actionsSeen,
        protectedStateChecks:graph.protectedStateChecks,
        protectedStateViolations:graph.protectedStateViolations,
        goalVerifiedEvents:graph.goalVerifiedEvents,
        lastSnapshot:graph.lastSnapshot
      };
      // V2 audits only redacted V1 metadata, never controls the agent.
      // The audit is fail-open for execution: errors cannot alter task results.
      if (process.env.COPILOT_STATE_VERIFIER_V2 !== '0') {
        try { report.shadowVerifierV2 = assessEvidenceGraphV2(report); }
        catch { report.shadowVerifierV2 = {
          schemaVersion:2, mode:'shadow_only', scope:'metadata_consistency_only',
          assessment:'insufficient_evidence', issues:['shadow_audit_unavailable']
        }; }
      }
      if (outputDirectory) await save(report,outputDirectory);
      try { onComplete?.(report); } catch { /* never affect the task */ }
    }
  });
}
