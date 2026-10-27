// Read-only, bounded evidence requested by the planner AFTER its normal
// browser overview. The existing DOM observer remains the authority for
// actionable references and independent goal verification.
export async function readSelectiveEvidence(page, scope, observedUrl) {
  const known = new Set(['forms', 'links', 'text', 'headings', 'tables', 'all']);
  if (!known.has(scope)) return { unavailable: 'unknown_scope' };
  if (page.url() !== observedUrl) return { unavailable: 'page_changed' };

  if (scope === 'forms' || scope === 'links') {
    // The first observation already contains controls and destinations.
    // The planner requests their expanded catalog without another DOM read.
    return { source: 'cached_dom_elements', scope };
  }

  const evidence = await page.evaluate(requested => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 &&
        style.visibility !== 'hidden' && style.display !== 'none' &&
        !element.closest('[hidden],[inert],[aria-hidden="true"]');
    };
    const result = {};
    if (['headings', 'all'].includes(requested)) {
      result.headings = [...document.querySelectorAll('main h1,main h2,main h3,article h1,article h2,article h3,h1,h2,h3')]
        .filter(visible).slice(0, 55).map(h => ({
          level: h.tagName.toLowerCase(),
          text: h.innerText.trim().slice(0, 180)
        }));
    }
    if (['text', 'all'].includes(requested)) {
      result.paragraphs = [...document.querySelectorAll('main p,article p,p')]
        .filter(visible).slice(0, 55)
        .map(p => p.innerText.trim().slice(0, 650))
        .filter(Boolean);
    }
    if (['tables', 'all'].includes(requested)) {
      result.tables = [...document.querySelectorAll('table')].filter(visible)
        .slice(0, 6).map(table => ({
          caption: table.caption?.innerText.trim().slice(0, 140) || '',
          rows: [...table.rows].slice(0, 12).map(row =>
            [...row.cells].slice(0, 8).map(cell => cell.innerText.trim().slice(0, 140)))
        }));
    }
    return result;
  }, scope).catch(() => ({ unavailable: 'dom_read_failed' }));
  if (page.url() !== observedUrl) return { unavailable: 'page_changed' };
  // Bound the serialized evidence even on pathological pages.
  const serialized = JSON.stringify(evidence);
  if (serialized.length <= 8500) return evidence;
  return { excerpt: serialized.slice(0, 8500), truncated: true };
}
