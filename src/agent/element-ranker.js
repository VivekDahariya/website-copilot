const STOP_WORDS = new Set([
  "a", "an", "and", "are", "at", "be", "by",
  "can", "category", "find", "for", "from",
  "go", "in", "into", "is", "its", "me",
  "navigate", "of", "on", "open", "page",
  "please", "search", "show", "site", "the",
  "this", "to", "website", "with"
]);

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenize(value) {
  return normalize(value)
    .split(/\s+/)
    .filter(token =>
      token.length > 2 &&
      !STOP_WORDS.has(token)
    );
}

export function rankElements(task, elements) {
  const tokens = [...new Set(tokenize(task))];

  const ranked = elements.map(element => {
    const label = normalize(element.label);
    const href = normalize(element.href);

    const labelTokens = new Set(tokenize(label));
    const hrefTokens = new Set(tokenize(href));

    let score = 0;

    for (const token of tokens) {
      if (labelTokens.has(token)) {
        score += 10;
      }

      if (hrefTokens.has(token)) {
        score += 3;
      }
    }

    if (
      label &&
      tokens.some(token => label === token)
    ) {
      score += 20;
    }

    return {
      ...element,
      relevanceScore: score
    };
  });

  ranked.sort(
    (a, b) => b.relevanceScore - a.relevanceScore
  );

  return ranked;
}

export function selectRelevantElements(
  task,
  elements,
  limit = 30
) {
  const ranked = rankElements(task, elements);

  // Keep the most relevant controls first, but do not discard
  // observed controls merely because their labels share no
  // tokens with the overall task.
  //
  // Multi-step workflows often require intermediate actions
  // whose labels have little lexical overlap with the goal.

  const relevant = ranked.filter(
    element => element.relevanceScore > 0
  );

  const remaining = ranked.filter(
    element => element.relevanceScore === 0
  );

  return [
    ...relevant,
    ...remaining
  ].slice(0, limit);
}
