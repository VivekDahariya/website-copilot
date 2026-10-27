const SELECTOR = [
  "button", "a[href]", "input", "textarea", "select",
  "[role='button']", "[role='link']", "[role='textbox']",
  "[role='combobox']", "[role='checkbox']", "[role='radio']",
  "[role='switch']", "[role='tab']", "[role='slider']",
  "[contenteditable='true']", "[draggable='true']", "[oncontextmenu]",
  "[data-dismiss]", "[role='dialog'] [tabindex]",
  "[class*='modal'] [class*='close']", "[class*='modal'] p"
].join(",");

const observations = new WeakMap();

export async function observePage(page) {
  const visibleBodyText = await page.evaluate(() => {
    const excluded = new Set([
      "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE",
      "INPUT", "TEXTAREA", "SELECT", "OPTION",
      "BUTTON"
    ]);

    const root = document.body;

    if (!root) return "";

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT
    );

    const collected = [];
    let node;

    while ((node = walker.nextNode())) {
      const text = node.textContent?.trim();

      if (!text) continue;

      let parent = node.parentElement;
      let allowed = true;

      while (parent && parent !== root.parentElement) {
        if (
          excluded.has(parent.tagName) ||
          parent.hidden ||
          parent.getAttribute("aria-hidden") === "true"
        ) {
          allowed = false;
          break;
        }

        const style = getComputedStyle(parent);

        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse"
        ) {
          allowed = false;
          break;
        }

        parent = parent.parentElement;
      }

      if (allowed) collected.push(text);
    }

    return collected.join(" ").slice(0, 50000);
  }).catch(() => "");


  const handles = await page.locator(SELECTOR).elementHandles();
  // Embedded editors use a separate document. Element handles retain
  // their owning frame so Playwright actions work without selector guessing.
  const embeddedFrames = page.frames().filter(frame => frame !== page.mainFrame());
  for (const frame of embeddedFrames) {
    try { handles.push(...await frame.locator(SELECTOR).elementHandles()); }
    catch { /* Cross-origin or unloading iframe: continue safely. */ }
  }
  const references = new Map();
  const elements = [];

  for (const handle of handles) {
    try {
      const data = await handle.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);

        if (
          !element.isConnected ||
          rect.width <= 0 ||
          rect.height <= 0 ||
          style.display === "none" ||
          style.visibility === "hidden" ||
          element.closest("[hidden], [inert]") ||
          element.matches(":disabled")
        ) {
          return null;
        }

        const labelledBy = element.getAttribute("aria-labelledby");

        const referencedLabel = labelledBy
          ? labelledBy.split(/\s+/)
              .map(id => document.getElementById(id)?.textContent || "")
              .join(" ")
          : "";

        const associatedLabel =
          "labels" in element
            ? Array.from(element.labels || [])
                .map(label => label.textContent || "")
                .join(" ")
            : "";

        const label = [
          element.getAttribute("aria-label"),
          referencedLabel,
          associatedLabel,
          element.getAttribute("placeholder"),
          element.getAttribute("title"),
          element.innerText,
          element.getAttribute("value"),
          element.getAttribute("name"),
          element.getAttribute("id")
        ].find(value => value && value.trim()) || "";

        const tag = element.tagName.toLowerCase();
        const isCheckbox = element.matches("input[type='checkbox'],[role='checkbox']");
        const isRadio = element.matches("input[type='radio'],[role='radio']");
        const peers = isCheckbox ? [...document.querySelectorAll("input[type='checkbox'],[role='checkbox']")]
          : isRadio ? [...document.querySelectorAll("input[type='radio'],[role='radio']")]
            : [];
        const ordinal = peers.length ? peers.indexOf(element) + 1 : null;
        const stableKey = ordinal ? `${isCheckbox ? 'checkbox':'radio'}:${ordinal}` : null;
        const accessibleLabel = label.trim().replace(/\s+/g, " ").slice(0,180) ||
          (isCheckbox ? `Checkbox ${ordinal}` : isRadio ? `Radio ${ordinal}` : "");

        const editable =
          element.matches("textarea,[contenteditable='true']") ||
          (tag === "input" &&
            !["button", "submit", "reset", "checkbox", "radio",
              "file", "hidden", "image", "color", "range"]
              .includes(element.type));

        const currentValue =
          tag === "input" || tag === "textarea" || tag === "select"
            ? element.value
            : element.isContentEditable
              ? element.innerText
              : null;

        const secretLike = element.type === "password" ||
          /\b(?:password|passcode|otp|one[-\s]?time[-\s]?(?:password|code)|verification[-\s]?code|security[-\s]?code|cvv|cvc|card[-\s]?number|upi[-\s]?pin)\b/i.test(
            [label, element.name, element.getAttribute("placeholder")]
              .filter(Boolean).join(" ")
          );

        const form = element.form || element.closest("form");


        const formControls = form

          ? Array.from(form.elements || [])

          : [];


        const formFields = formControls

          .filter(control =>

            control.matches("input,textarea,select") &&

            !["hidden", "submit", "button", "reset", "image"]

              .includes(control.type)

          )

          .slice(0, 30)

          .map(control => ({

            tag: control.tagName.toLowerCase(),

            type: control.type || null,

            name: control.name || null,

            label: [

              control.getAttribute("aria-label"),

              control.labels

                ? Array.from(control.labels)

                    .map(label => label.textContent || "")

                    .join(" ")

                : "",

              control.getAttribute("placeholder")

            ].find(Boolean)?.trim().slice(0, 120) || ""

          }));


        const effectiveType = tag === "button"

          ? (element.getAttribute("type") || "submit").toLowerCase()

          : tag === "input"

            ? element.type

            : null;


        const formContext = form

          ? {

              associated: true,

              id: form.id || null,

              name: form.getAttribute("name"),

              method: form.getAttribute("method") || "get",

              action: form.getAttribute("action"),

              fieldCount: formFields.length,

              fields: formFields

            }

          : {

              associated: false,

              id: null,

              name: null,

              method: null,

              action: null,

              fieldCount: 0,

              fields: []

            };


        return {

          tag,

          effectiveType,

          formContext,

          role: element.getAttribute("role") || tag,
          draggable: element.draggable === true,
          withinModal: Boolean(element.closest('[role="dialog"],.modal,[class*="modal"]')),
          contextMenuTarget: Boolean(element.oncontextmenu),
          label: accessibleLabel,
          ordinal,
          stableKey,
          hasValue: typeof currentValue === 'string' && currentValue.length > 0,
          type: element.getAttribute("type"),
          name: element.getAttribute("name"),
          placeholder: element.getAttribute("placeholder"),
          href: element.getAttribute("href"),
          editable,
          // Preserve enough value for independent form-state verification.
          // The former 200-character cut silently invalidated long fills.
          currentValue:
            secretLike ? "[REDACTED]" : currentValue?.slice(0, 8192) ?? null,
          currentValueTruncated:
            typeof currentValue === "string" && currentValue.length > 8192,
          options: tag === "select"
            ? Array.from(element.options).slice(0,30).map(option => ({
                value: option.value, label: option.label
              }))
            : undefined,
          selectedLabel: tag === "select"
            ? (element.selectedOptions?.[0]?.label ?? null)
            : null,
          checked:
            element.matches("input[type='checkbox'],input[type='radio']")
              ? element.checked
              : null
        };
      });

      if (!data) {
        await handle.dispose();
        continue;
      }

      const ref = `e${elements.length + 1}`;

      references.set(ref, handle);
      elements.push({ ref, ...data });

    } catch {
      await handle.dispose().catch(() => {});
    }
  }

  const headings = await page.locator("h1,h2,h3").allTextContents();

  const headingEvidence = await page.evaluate(() =>
    [...document.querySelectorAll("h1,h2,h3")]
      .filter(element => element.getClientRects().length > 0)
      .map(element => ({
        text: element.innerText.trim(),
        tag: element.tagName.toLowerCase(),
        insideNavigation: Boolean(
          element.closest(
            "nav,aside,[role='navigation'],[role='menu'],[role='menubar']"
          ) ||
          [...(function* () {
            let node = element.parentElement;
            while (node) {
              yield node;
              node = node.parentElement;
            }
          })()].some(node => {
            const identity = [
              node.id,
              typeof node.className === "string" ? node.className : ""
            ].join(" ").toLowerCase();

            return /(?:^|[\s_-])(?:sidebar|sidenav|side-nav|leftmenu|left-menu|navigation|nav-menu)(?:$|[\s_-])/.test(identity);
          })
        )
      }))
      .filter(item => item.text)
      .slice(0, 100)
  );

  const previous = observations.get(page);

  if (previous) {
    for (const handle of previous.references.values()) {
      await handle.dispose().catch(() => {});
    }
  }

  const observation = {
    url: page.url(),
    title: await page.title(),
    visibleBodyText,
    activeModalVisible: await page.evaluate(() =>
      [...document.querySelectorAll('[role="dialog"],.modal,[class*="modal"]')]
      .some(element => {
        const r=element.getBoundingClientRect();
        const style=getComputedStyle(element);
        return r.width>0 && r.height>0 && style.display!=='none' &&
          style.visibility!=='hidden';
      })).catch(() => false),
    counts: {
      paragraphs: await page.locator('p').count().catch(() => 0)
    },
    headings: headings
      .map(text => text.trim())
      .filter(Boolean)
      .slice(0, 15),
    headingEvidence,
    totalElements: handles.length,
    actionableElements: elements
  };

  observations.set(page, {
    url: observation.url,
    references
  });

  return observation;
}

export async function resolveElement(page, ref) {
  const observation = observations.get(page);

  if (!observation) {
    throw new Error("No active observation.");
  }

  if (page.url() !== observation.url) {
    throw new Error("Page navigated. Re-observation required.");
  }

  const handle = observation.references.get(ref);

  if (!handle) {
    throw new Error(`Unknown element reference: ${ref}`);
  }

  const connected = await handle.evaluate(element => element.isConnected)
    .catch(() => false);

  if (!connected) {
    throw new Error(`Element ${ref} is detached. Re-observation required.`);
  }

  return handle;
}
