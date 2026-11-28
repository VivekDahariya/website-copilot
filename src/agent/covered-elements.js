import { resolveElement } from "../observer/dom-observer.js";

// After a click was covered by a dialog or banner, the controls that are still
// underneath it cannot be clicked. The planner is shown only the controls a real
// click can reach, so it chooses the way past the overlay instead of repeating a
// click that will be covered again. This only removes choices; it never adds or
// picks one. When nothing could be measured, or everything is covered, the full
// list is returned unchanged.
//
// A control below the visible area is not simply reachable: scrolling brings it
// to the middle of the screen, and a layer fixed to the screen (a consent notice,
// a modal) covers the middle of the screen as well. So an off-screen control is
// judged by what sits at the middle of the screen in its column.
export async function reachableElements(page, elements, options) {
  const list = Array.isArray(elements) ? elements : [];
  const { reachable } = await measureCoverage(page, list, options);
  return reachable.length > 0 && reachable.length < list.length ? reachable : list;
}

// The same measurement, with both halves: the controls a click can reach and the
// ones a layer covers. Controls that were not measured count as reachable.
export async function measureCoverage(page, elements, { limit = 400 } = {}) {
  const list = Array.isArray(elements) ? elements : [];
  const measured = [];
  for (const element of list.slice(0, limit)) {
    const handle = await resolveElement(page, element.ref).catch(() => null);
    const covered = handle
      ? await handle.evaluate(node => {
          const box = node.getBoundingClientRect();
          // No size: hidden, nothing to measure.
          if (!box.width || !box.height) return false;
          const centerX = box.left + box.width / 2;
          const centerY = box.top + box.height / 2;
          const onScreen = centerX >= 0 && centerY >= 0 && centerX <= innerWidth && centerY <= innerHeight;
          const overlaps = top => Boolean(top) && (top === node || node.contains(top) || top.contains(node));
          if (onScreen) {
            const top = document.elementFromPoint(centerX, centerY);
            return Boolean(top) && !overlaps(top);
          }
          // Off screen: a scroll brings it to the middle of the screen. It is
          // covered there only by a layer fixed to the screen.
          const column = Math.min(Math.max(centerX, 0), innerWidth - 1);
          const top = document.elementFromPoint(column, innerHeight / 2);
          if (!top || overlaps(top)) return false;
          for (let layer = top; layer && layer !== document.documentElement; layer = layer.parentElement) {
            if (getComputedStyle(layer).position === 'fixed') return !layer.contains(node);
          }
          return false;
        }).catch(() => false)
      : false;
    measured.push({ element, covered });
  }
  const rest = list.slice(limit);
  return {
    reachable: [...measured.filter(item => !item.covered).map(item => item.element), ...rest],
    covered: measured.filter(item => item.covered).map(item => item.element)
  };
}

// Is a layer fixed to the screen stacked over the middle of the screen? (The page
// itself, even when its body is fixed to stop scrolling, does not count.)
export async function coveringLayerPresent(page) {
  return page.evaluate(() => {
    const top = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    for (let layer = top; layer && layer !== document.body && layer !== document.documentElement; layer = layer.parentElement) {
      if (getComputedStyle(layer).position === 'fixed') return true;
    }
    return false;
  }).catch(() => false);
}

// A notice that was standing can be replaced by another a moment after a click
// (a panel of options opening in a new frame). For that moment nothing covers the
// page, which is not evidence that the notice is gone. Wait, within a bound, for a
// covering layer to be there; false means none appeared.
export async function waitForCoveringLayer(page, { timeoutMs = 3000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await coveringLayerPresent(page)) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(intervalMs);
  }
}
