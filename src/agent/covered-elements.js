import { resolveElement } from "../observer/dom-observer.js";

// After a click was covered by a dialog or banner, the controls that are still
// underneath it cannot be clicked. The planner is shown only the controls a real
// click can reach, so it chooses the way past the overlay instead of repeating a
// click that will be covered again. This only removes choices; it never adds or
// picks one. When nothing could be measured, or everything is covered, the full
// list is returned unchanged.
export async function reachableElements(page, elements, { limit = 120 } = {}) {
  const list = Array.isArray(elements) ? elements : [];
  const measured = [];
  for (const element of list.slice(0, limit)) {
    const handle = await resolveElement(page, element.ref).catch(() => null);
    const covered = handle
      ? await handle.evaluate(node => {
          const box = node.getBoundingClientRect();
          const x = box.left + box.width / 2;
          const y = box.top + box.height / 2;
          // Off screen or unmeasurable: a scroll would bring it into reach.
          if (!box.width || !box.height || x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
          const top = document.elementFromPoint(x, y);
          return Boolean(top) && top !== node && !node.contains(top) && !top.contains(node);
        }).catch(() => false)
      : false;
    measured.push({ element, covered });
  }
  const rest = list.slice(limit);
  const reachable = [...measured.filter(item => !item.covered).map(item => item.element), ...rest];
  return reachable.length > 0 && reachable.length < list.length ? reachable : list;
}
