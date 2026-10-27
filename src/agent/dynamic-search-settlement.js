// Bounded DOM readiness check after a verified search launcher
// opens a dynamically rendered input. No action is executed here.

export async function waitForSearchField(
  page,
  { timeoutMs = 5000 } = {}
) {
  try {
    await page.waitForFunction(() => {
      const fields = document.querySelectorAll(
        'input, textarea, [role="searchbox"], ' +
        '[role="combobox"], [contenteditable="true"]'
      );

      return [...fields].some(element => {
        const metadata = [
          element.getAttribute("type"),
          element.getAttribute("name"),
          element.getAttribute("placeholder"),
          element.getAttribute("aria-label"),
          element.getAttribute("role")
        ].filter(Boolean).join(" ");

        if (!/\b(search|query|find)\b/i.test(metadata)) {
          return false;
        }

        const style = getComputedStyle(element);

        return (
          element.getClientRects().length > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          !element.disabled
        );
      });
    }, null, { timeout: timeoutMs });

    return true;
  } catch {
    return false;
  }
}
