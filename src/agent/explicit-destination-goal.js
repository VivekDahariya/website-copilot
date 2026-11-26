// Preserve explicit hostname and main-heading requirements.
// Does not navigate, invent URLs, or claim task completion.

export function createExplicitDestinationGoal(instruction) {
  const text = String(instruction ?? "");

  const hostMatch = text.match(
    /\b(?:belongs?\s+to|(?:hostname|domain)\s+(?:is|must\s+be|should\s+be|equals?)|(?:on|at))\s+(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,63})(?=$|[^\w.-])/i
  );

  const headingMatch = text.match(
    /\b(?:main|primary|page)\s+heading\s+(?:is|must\s+be|should\s+be|equals?|reads?)\s*["“]([^"”\r\n]{2,160})["”]/i
  );

  if (!hostMatch || !headingMatch) return null;

  const hostname = hostMatch[1].toLowerCase();
  const heading = headingMatch[1].trim();

  if (!heading) return null;

  const labels = hostname.split(".");

  if (
    labels.length < 2 ||
    labels.some(label =>
      !label ||
      label.length > 63 ||
      label.startsWith("-") ||
      label.endsWith("-")
    )
  ) return null;

  return {
    type: "page_destination",
    hostname,
    heading
  };
}
