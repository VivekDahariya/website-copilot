
import { resolveElement } from "../observer/dom-observer.js";

export function buildTargetIdentity(live) {
  return [
    live.tag,
    live.type,
    live.name,
    live.ariaLabel,
    live.href,
    live.label
  ].join("|");
}

export async function inspectLiveTarget(page, action) {
  const handle = await resolveElement(page, action.ref);

  const live = await handle.evaluate(element => {
    const labels = "labels" in element
      ? Array.from(element.labels || [])
          .map(label => label.textContent || "")
          .join(" ")
      : "";

    const labelledBy = (
      element.getAttribute("aria-labelledby") || ""
    )
      .split(/\s+/)
      .filter(Boolean)
      .map(id => document.getElementById(id)?.textContent || "")
      .join(" ");

    const label = [
      element.getAttribute("aria-label"),
      labelledBy,
      labels,
      element.getAttribute("placeholder"),
      element.getAttribute("title"),
      element.innerText,
      element.getAttribute("value")
    ].filter(Boolean).join(" ");

    return {
      connected: element.isConnected,
      tag: element.tagName.toLowerCase(),
      type: (
        element.getAttribute("type") || ""
      ).toLowerCase(),
      name: element.getAttribute("name") || "",
      ariaLabel: element.getAttribute("aria-label") || "",
      href: element.getAttribute("href") || "",
      label
    };
  });

  if (!live.connected) {
    throw new Error("SAFETY_STALE_TARGET: Element detached.");
  }

  return {
    pageUrl: page.url(),
    targetIdentity: buildTargetIdentity(live),
    live
  };
}
