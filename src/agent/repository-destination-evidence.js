import {
  buildRepositoryDestinationGoal,
  planRepositoryResultAction
} from "./repository-result-planner.js";

export function requiresRepositorySelection(instruction, goal) {
  const expected = buildRepositoryDestinationGoal(instruction);

  return Boolean(
    expected?.pathnamePattern &&
    goal?.type === "page_destination" &&
    String(goal.hostname || "").toLowerCase() === "github.com" &&
    goal.pathnamePattern === expected.pathnamePattern &&
    String(goal.identity || "").toLowerCase() === expected.identity
  );
}

export function captureRepositorySelection(
  instruction,
  observation,
  action
) {
  if (action?.operation !== "click") return null;

  const planned = planRepositoryResultAction(
    instruction,
    observation
  );

  if (!planned || planned.ref !== action.ref) return null;

  const element = observation.actionableElements.find(
    item => item.ref === action.ref
  );

  if (!element?.href) return null;

  try {
    const url = new URL(element.href, observation.url);

    if (url.hostname.toLowerCase() !== "github.com") {
      return null;
    }

    const parts = url.pathname.split("/").filter(Boolean);

    if (parts.length !== 2) return null;

    const identity = parts.join("/").toLowerCase();

    if (
      String(element.label || "").trim().toLowerCase() !==
      identity
    ) {
      return null;
    }

    return Object.freeze({
      hostname: "github.com",
      pathname: `/${parts.join("/")}`,
      identity
    });
  } catch {
    return null;
  }
}

export function verifyRepositorySelection(observation, selection) {
  if (!selection) return false;

  try {
    const url = new URL(observation?.url);

    if (
      url.hostname.toLowerCase() !== selection.hostname ||
      url.pathname.replace(/\/$/, "").toLowerCase() !==
        selection.pathname.toLowerCase()
    ) {
      return false;
    }

    const title = String(observation.title || "")
      .trim()
      .toLowerCase();

    const prefix = `github - ${selection.identity}`;

    if (!title.startsWith(prefix)) return false;

    const suffix = title.charAt(prefix.length);

    return (
      suffix === "" ||
      suffix === ":" ||
      suffix === " " ||
      suffix === "·"
    );
  } catch {
    return false;
  }
}
