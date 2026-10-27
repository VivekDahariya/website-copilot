// Repository selection based on observed GitHub search results.
// No known repository names or owners are hardcoded.

function parseRequest(task) {
  const match = String(task || "").match(
    /\b(?:find|open|locate|show)\s+(?:the\s+)?([a-z0-9_.-]+(?:\/[a-z0-9_.-]+)?)\s+(?:repository|repo)\s+(?:on|at|in)\s+github\b/i
  );

  if (!match) return null;

  const requested = match[1].toLowerCase();
  const parts = requested.split("/");

  return {
    requested,
    owner: parts.length === 2 ? parts[0] : null,
    name: parts.at(-1)
  };
}

function parseRepositoryLink(element, baseUrl) {
  if (element?.tag !== "a" || !element.href) return null;

  try {
    const url = new URL(element.href, baseUrl);

    if (url.hostname.toLowerCase() !== "github.com") {
      return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);

    if (segments.length !== 2) return null;

    const [owner, name] = segments.map(value =>
      decodeURIComponent(value).toLowerCase()
    );

    const excluded = new Set([
      "search", "topics", "login", "signup",
      "settings", "features", "marketplace"
    ]);

    if (excluded.has(owner)) return null;

    const observedLabel = String(element.label || "")
      .trim()
      .toLowerCase();

    // Require the displayed repository identity to agree
    // with the link destination.
    if (observedLabel !== `${owner}/${name}`) {
      return null;
    }

    return {
      ref: element.ref,
      owner,
      name
    };
  } catch {
    return null;
  }
}

export function planRepositoryResultAction(task, observation) {
  const request = parseRequest(task);

  if (!request || !Array.isArray(observation?.actionableElements)) {
    return null;
  }

  let pageUrl;

  try {
    pageUrl = new URL(observation.url);
  } catch {
    return null;
  }

  if (
    pageUrl.hostname.toLowerCase() !== "github.com" ||
    pageUrl.pathname !== "/search" ||
    pageUrl.searchParams.get("type") !== "repositories"
  ) {
    return null;
  }

  const query = String(pageUrl.searchParams.get("q") || "")
    .trim()
    .toLowerCase();

  // Do not choose results from an unrelated or stale search.
  if (!query.includes(request.name)) return null;

  const candidates = observation.actionableElements
    .map(element => parseRepositoryLink(element, pageUrl.href))
    .filter(Boolean)
    .filter(repo => repo.name === request.name);

  let selected = null;

  if (request.owner) {
    const exact = candidates.filter(repo =>
      repo.owner === request.owner
    );

    if (exact.length === 1) selected = exact[0];
  } else if (candidates.length === 1) {
    selected = candidates[0];
  } else {
    // A self-named organization/repository is a strong
    // identity signal, but still requires destination verification.
    const selfNamed = candidates.filter(repo =>
      repo.owner === request.name
    );

    if (selfNamed.length === 1) {
      selected = selfNamed[0];
    }
  }

  if (!selected) return null;

  return {
    ref: selected.ref,
    operation: "click",
    value: ""
  };
}


// Construct a navigation goal from an explicit, simple GitHub
// repository request. Never derive a precise owner from a guess.
export function buildRepositoryDestinationGoal(instruction) {
  const text = String(instruction || "").trim();

  const standalone =
    /^(?:find|open|locate|show)\s+(?:the\s+)?[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)?\s+(?:repository|repo)\s+(?:on|at|in)\s+github\s*[.!?]?$/i.test(text);

  if (!standalone) return null;

  const request = parseRequest(text);
  if (!request) return null;

  const escapedName = request.name.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );

  return {
    type: "page_destination",
    hostname: "github.com",
    ...(request.owner
      ? {
          pathname: `/${request.owner}/${request.name}`
        }
      : {
          pathnamePattern: `^/[^/]+/${escapedName}/?$`
        }),
    identity: request.name
  };
}
