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
  // Places a dragged item can be dropped are usually plain containers, so
  // the selector above never lists them. Add the containers that declare
  // drop handling, plus the container of each draggable item and that
  // container's same-kind siblings (columns, lists, slots).
  const dropZoneHandles = new Set();
  try {
    const zones = await page.evaluateHandle(selector => {
      const found = new Set(document.querySelectorAll(
        "[ondrop],[ondragover],[aria-dropeffect],[dropzone]"));
      for (const item of document.querySelectorAll("[draggable='true']")) {
        const parent = item.parentElement;
        if (!parent || parent === document.body ||
            parent === document.documentElement) continue;
        found.add(parent);
        for (const sibling of parent.parentElement?.children ?? []) {
          if (sibling.tagName === parent.tagName) found.add(sibling);
        }
      }
      return [...found].filter(zone => !zone.matches(selector)).slice(0, 12);
    }, SELECTOR);
    for (const property of (await zones.getProperties()).values()) {
      const zone = property.asElement();
      if (zone) { dropZoneHandles.add(zone); handles.push(zone); }
    }
    await zones.dispose();
  } catch { /* Navigating or detached page: continue without drop zones. */ }
  // Things that reveal more when the pointer is over them (image cards,
  // tiles, rows) are usually plain containers too. The page's own style
  // rules say which ones: any rule written for "X:hover ..." names X.
  const hoverHandles = new Set();
  try {
    const hoverZones = await page.evaluateHandle(selector => {
      const found = new Set();
      const collect = rules => {
        for (const rule of rules ?? []) {
          if (rule.cssRules && !rule.selectorText) { collect(rule.cssRules); continue; }
          const text = rule.selectorText || "";
          if (!text.includes(":hover")) continue;
          for (const part of text.split(",")) {
            const at = part.indexOf(":hover");
            // Only rules that change something INSIDE the hovered element
            // reveal content; "a:hover" alone merely restyles the link.
            if (at < 1 || part.slice(at + 6).trim() === "") continue;
            const base = part.slice(0, at).trim();
            try {
              for (const element of document.querySelectorAll(base)) {
                if (found.size < 40) found.add(element);
              }
            } catch { /* Selector the browser cannot query: skip it. */ }
          }
        }
      };
      for (const sheet of document.styleSheets) {
        try { collect(sheet.cssRules); }
        catch { /* Cross-origin stylesheet: its rules cannot be read. */ }
      }
      return [...found].filter(zone => !zone.matches(selector) &&
        zone !== document.body && zone !== document.documentElement).slice(0, 15);
    }, SELECTOR);
    for (const property of (await hoverZones.getProperties()).values()) {
      const zone = property.asElement();
      if (zone) { hoverHandles.add(zone); handles.push(zone); }
    }
    await hoverZones.dispose();
  } catch { /* Navigating or detached page: continue without hover zones. */ }
  // Pictures the page shows, so that a task can ask for one to be saved. They
  // are added last, so the references of every other element stay as they were.
  const mediaHandles = new Set();
  try {
    const pictures = await page.evaluateHandle(() =>
      [...document.images].filter(image => {
        const box = image.getBoundingClientRect();
        return image.complete && image.naturalWidth >= 32 &&
          image.naturalHeight >= 32 && box.width >= 32 && box.height >= 32 &&
          Boolean(image.currentSrc || image.src) &&
          !/\.svg(?:[?#]|$)/i.test(image.currentSrc || image.src) &&
          !/^data:image\/svg/i.test(image.currentSrc || image.src);
      }).slice(0, 30));
    for (const property of (await pictures.getProperties()).values()) {
      const picture = property.asElement();
      if (picture) { mediaHandles.add(picture); handles.push(picture); }
    }
    await pictures.dispose();
  } catch { /* Navigating or detached page: continue without pictures. */ }
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
          // A slider's value is its current position, never its name.
          element.getAttribute("type") === "range"
            ? "" : element.getAttribute("value"),
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
          (isCheckbox ? `Checkbox ${ordinal}` : isRadio ? `Radio ${ordinal}`
            : element.getAttribute("type") === "range" ? "Slider" : "");

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
          // Only items the page itself made draggable. Links and images are
          // draggable by browser default, which is not a page feature.
          draggable: element.getAttribute("draggable") === "true",
          // A hover zone is named by what it visibly shows: its own label,
          // its picture's description, or its visible text.
          hoverZoneName: (element.getAttribute("aria-label") ||
            element.querySelector("img[alt]")?.getAttribute("alt") ||
            element.innerText || element.getAttribute("title") || "")
            .trim().replace(/\s+/g, " ").slice(0, 80),
          // A container is named by its own label or heading, not by the
          // items currently inside it.
          dropZoneName: (element.getAttribute("aria-label") ||
            element.querySelector(":scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > h5,:scope > h6,:scope > legend,:scope > header")?.innerText ||
            element.getAttribute("title") || element.getAttribute("id") || "")
            .trim().replace(/\s+/g, " ").slice(0, 80),
          withinModal: Boolean(element.closest('[role="dialog"],.modal,[class*="modal"]')),
          contextMenuTarget: Boolean(element.oncontextmenu),
          // What a picture is called: its description, or its file name.
          imageAlt: tag === "img"
            ? (element.getAttribute("alt") || element.getAttribute("title") || "")
                .trim().replace(/\s+/g, " ").slice(0, 120) : "",
          imageWidth: tag === "img" ? Math.round(element.getBoundingClientRect().width) : 0,
          imageHeight: tag === "img" ? Math.round(element.getBoundingClientRect().height) : 0,
          imageSrc: tag === "img" ? (() => {
            const source = element.currentSrc || element.src || "";
            return source.startsWith("data:")
              ? "data:" + source.length + ":" + source.slice(-80) : source.slice(0, 500);
          })() : "",
          imageName: tag === "img" ? (() => {
            try {
              return decodeURIComponent(new URL(element.currentSrc || element.src)
                .pathname.split("/").pop() || "").slice(0, 80);
            } catch { return ""; }
          })() : "",
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
      const dropTarget = dropZoneHandles.has(handle);
      const hoverTarget = hoverHandles.has(handle);
      const { dropZoneName, hoverZoneName, imageAlt, imageName, imageWidth, imageHeight, imageSrc, ...described } = data;
      const mediaTarget = mediaHandles.has(handle);
      const mediaOrdinal = mediaTarget
        ? elements.filter(item => item.mediaTarget === true).length + 1 : 0;
      // Several identical zones (three avatars) are told apart by position.
      const hoverOrdinal = hoverTarget
        ? elements.filter(item => item.hoverTarget === true).length + 1 : 0;
      elements.push({
        ref,
        ...described,
        ...(dropTarget
          ? { dropTarget: true, label: dropZoneName || described.label }
          : {}),
        ...(mediaTarget
          ? { mediaTarget: true, mediaKind: "image", mediaOrdinal,
              mediaWidth: imageWidth, mediaHeight: imageHeight, mediaSrc: imageSrc,
              label: (imageAlt || imageName || "image") +
                " (image " + mediaOrdinal + ")" }
          : {}),
        ...(hoverTarget
          ? { hoverTarget: true, hoverOrdinal,
              label: (hoverZoneName || described.label || "Hover area") +
                " (hover area " + hoverOrdinal + ")" }
          : {})
      });

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
