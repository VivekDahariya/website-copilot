const clean = value => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 180);

export function createNavigationActionTree() {
  let nodes = [];
  let edges = [];
  let activeNodeId = null;
  let pendingEdgeId = null;

  function snapshot() {
    return {
      nodes: nodes.map(node => ({...node})),
      edges: edges.map(edge => ({...edge})),
      activeNodeId,
      truncated: nodes.length >= 120 || edges.length >= 160
    };
  }

  function reset() {
    nodes = [];
    edges = [];
    activeNodeId = null;
    pendingEdgeId = null;
    return snapshot();
  }

  function newNode(event, parentId = null) {
    if (nodes.length >= 120) return null;

    const node = {
      id: "p" + (nodes.length + 1),
      parentId,
      title: clean(event.title || event.url || "Browser page"),
      url: clean(event.url),
      verified: event.goalVerified === true
    };

    nodes.push(node);
    return node;
  }

  function record(event) {
    if (!event || typeof event !== "object") return snapshot();

    if (event.type === "page_observed") {
      const previous = nodes.find(n => n.id === activeNodeId);
      const pending = edges.find(e => e.id === pendingEdgeId);

      if (!previous) {
        const root = newNode(event);
        if (root) activeNodeId = root.id;
      } else if (pending?.status === "executed" ||
                 pending?.status === "action_verified") {
        const observedUrl=clean(event.url);
        const samePageLink=
          pending.operation==="click" &&
          pending.targetIsLink===true &&
          previous.url===observedUrl;

        const revisited=(
          !samePageLink &&
          previous.url!==observedUrl
        )
          ? [...nodes].reverse().find(
              node=>node.url===observedUrl
            )
          : null;

        if(samePageLink) {
          pending.to=null;
          pending.status="no_navigation_change";
        } else {
          const child=revisited ??
            newNode(event,pending.from);

          if(child) {
            pending.to=child.id;
            pending.status=revisited
              ? "returned_to_observed_page"
              : event.goalVerified
                ? "goal_verified"
                : "observed_after_action";

            child.verified ||= event.goalVerified===true;
            activeNodeId=child.id;
          }
        }

        pendingEdgeId = null;
      } else {
        if (pending?.status === "selected")
          pending.status = "not_executed";

        pendingEdgeId = null;
        previous.verified ||= event.goalVerified === true;
      }
    }

    if (event.type === "action_selected" && activeNodeId) {
      // A field handed to the person was first chosen as a fill. That fill was
      // never carried out by CoPilot: the handover replaces it.
      if (event.operation === "human_handover") {
        const last = edges[edges.length - 1];
        if (last && last.ref === clean(event.ref) &&
            last.operation !== "human_handover" &&
            ["selected", "not_executed"].includes(last.status)) {
          edges.pop();
          pendingEdgeId = null;
        }
      }
      const old = edges.find(e => e.id === pendingEdgeId);
      if (old && old.status === "selected")
        old.status = "not_executed";

      if (edges.length < 160) {
        const edge = {
          id: "a" + (edges.length + 1),
          from: activeNodeId,
          to: null,
          operation: clean(event.operation),
          ref: clean(event.ref),
          label: clean(event.targetLabel || event.ref),
          ...(event.destinationLabel
            ? { destination: clean(event.destinationLabel) } : {}),
          ...(event.setValue ? { setValue: clean(event.setValue) } : {}),
          ...(event.scrollTo ? { scrollTo: clean(event.scrollTo) } : {}),
          ...(event.pressKey ? { pressKey: clean(event.pressKey) } : {}),
          targetIsLink:event.targetIsLink===true,
          status: "selected"
        };

        edges.push(edge);
        pendingEdgeId = edge.id;
      }
    }

    if (event.type === "action_executed") {
      const edge = edges.find(e => e.id === pendingEdgeId);

      if (edge) {
        edge.status = event.executionCompleted === false
          ? "execution_unconfirmed"
          : event.verified === true
            ? "action_verified" : "executed";
        if (event.acknowledgedAlert === true) edge.alert = true;
        if (event.openedTab === true) edge.openedTab = true;
        if (event.dialogStopped) edge.dialogStopped = clean(event.dialogStopped);
      }
    }

    if (event.type === "action_failed") {
      const edge = edges.find(e => e.id === pendingEdgeId);
      if (edge) edge.status = "failed";
      pendingEdgeId = null;
    }

    if (event.type === "navigation_backtracked") {
      const source = activeNodeId;

      const target = [...nodes].reverse().find(
        node => node.url === clean(event.url) &&
          node.id !== source
      );

      if (source && edges.length < 160) {
        edges.push({
          id: "a" + (edges.length + 1),
          from: source,
          to: target?.id ?? null,
          operation: "back",
          ref: "",
          label: "Backtrack to previous page",
          status: "backtracked"
        });
      }

      if (target) activeNodeId = target.id;
      pendingEdgeId = null;
    }

    if (event.type === "goal_verified") {
      const node = nodes.find(n => n.id === activeNodeId);
      if (node) node.verified = true;
    }

    return snapshot();
  }

  return {record, snapshot, reset};
}

export function createBoundedNavigationBacktracker({
  maxBacktracks = 2
} = {}) {
  if (!Number.isInteger(maxBacktracks) ||
      maxBacktracks < 0 || maxBacktracks > 5) {
    throw new Error("Invalid backtracking budget.");
  }

  const checkpoints = [];
  let backtracks = 0;

  function record({
    observation, element, decision, result, actualUrl
  }) {
    if (result?.executionCompleted !== true ||
        decision?.operation !== "click" ||
        !element?.href) {
      checkpoints.length = 0;
      return;
    }

    try {
      const from = new URL(observation.url);
      const to = new URL(actualUrl);
      const href = new URL(element.href, from);

      const unsafe =
        /\b(?:delete|remove|logout|signout|checkout|purchase|buy|pay|submit|download|unsubscribe|reset|transfer)\b/i;

      if(
        from.href===to.href &&
        href.href===from.href &&
        !href.hash &&
        !unsafe.test(element.label ?? "") &&
        !unsafe.test(href.pathname) &&
        !from.username && !from.password &&
        !to.username && !to.password
      ) {
        return;
      }

      if (
        !["http:", "https:"].includes(from.protocol) ||
        to.origin !== from.origin ||
        href.origin !== from.origin ||
        from.href === to.href ||
        href.pathname !== to.pathname ||
        unsafe.test(element.label ?? "") ||
        unsafe.test(href.pathname) ||
        from.username || from.password ||
        to.username || to.password
      ) {
        checkpoints.length = 0;
        return;
      }

      checkpoints.push({
        fromUrl: from.href,
        toUrl: to.href,
        observation,
        element,
        decision
      });

      if (checkpoints.length > 6) checkpoints.shift();
    } catch {
      checkpoints.length = 0;
    }
  }

  async function attempt(page) {
    if (backtracks >= maxBacktracks) {
      return {
        completed:false,
        reason:"backtrack_budget_exhausted"
      };
    }

    const checkpoint = checkpoints.at(-1);

    if (!checkpoint || page.url() !== checkpoint.toUrl) {
      return {
        completed:false,
        reason:"no_safe_navigation_checkpoint"
      };
    }

    checkpoints.pop();
    backtracks++;

    let reachedCheckpoint=false;

    for(let hop=0;hop<3;hop++) {
      try {
        await page.goBack({
          waitUntil:"domcontentloaded",
          timeout:6000
        });
      } catch {
        break;
      }

      const current=page.url();

      if(current===checkpoint.fromUrl) {
        reachedCheckpoint=true;
        break;
      }

      // Never traverse an unrelated intermediate page.
      if(current!==checkpoint.toUrl) break;
    }

    if (!reachedCheckpoint) {
      checkpoints.length = 0;
      return {
        completed:false,
        reason:"history_return_unverified"
      };
    }

    return {
      completed:true,
      ...checkpoint,
      url:page.url(),
      backtracks
    };
  }

  return {
    record,
    attempt,
    getStatus:() => ({
      backtracks,
      maxBacktracks,
      checkpoints:checkpoints.length
    })
  };
}
