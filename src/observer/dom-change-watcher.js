const REVISION_KEY = "__websiteCoPilotDomRevision";

export async function getDomRevision(page) {
  return page.evaluate(key => {
    if (!window[key]) {
      const state = {
        revision: 0,
        observer: null
      };

      state.observer = new MutationObserver(mutations => {
        const meaningful = mutations.some(mutation => {
          if (mutation.type === "childList") {
            return mutation.addedNodes.length > 0 ||
              mutation.removedNodes.length > 0;
          }

          return mutation.type === "attributes" &&
            [
              "disabled",
              "hidden",
              "aria-hidden",
              "style",
              "checked",
              "value"
            ].includes(mutation.attributeName);
        });

        if (meaningful) state.revision++;
      });

      state.observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          "disabled",
          "hidden",
          "aria-hidden",
          "style",
          "checked",
          "value"
        ]
      });

      window[key] = state;
    }

    return window[key].revision;
  }, REVISION_KEY);
}

export async function waitForRelevantDomChange(
  page,
  {
    timeoutMs = 1800,
    sinceRevision = null
  } = {}
) {
  return page.evaluate(
    ({ key, timeoutMs, sinceRevision }) => new Promise(resolve => {
      const state = window[key];

      if (
        state &&
        sinceRevision !== null &&
        state.revision !== sinceRevision
      ) {
        resolve(true);
        return;
      }

      let settled = false;
      let observer;

      const finish = changed => {
        if (settled) return;
        settled = true;
        observer?.disconnect();
        clearTimeout(timer);
        resolve(changed);
      };

      const timer = setTimeout(() => finish(false), timeoutMs);

      observer = new MutationObserver(mutations => {
        const meaningful = mutations.some(mutation =>
          mutation.type === "childList"
            ? mutation.addedNodes.length > 0 ||
              mutation.removedNodes.length > 0
            : [
                "disabled",
                "hidden",
                "aria-hidden",
                "style",
                "checked",
                "value"
              ].includes(mutation.attributeName)
        );

        if (meaningful) finish(true);
      });

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          "disabled",
          "hidden",
          "aria-hidden",
          "style",
          "checked",
          "value"
        ]
      });

      if (
        state &&
        sinceRevision !== null &&
        state.revision !== sinceRevision
      ) {
        finish(true);
      }
    }),
    { key: REVISION_KEY, timeoutMs, sinceRevision }
  );
}
