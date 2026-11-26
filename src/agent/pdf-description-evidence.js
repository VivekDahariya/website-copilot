// Read-only evidence tying a quoted document description to exactly
// one observed PDF link. This function never clicks or downloads.
export async function capturePdfDescriptionEvidence(
  page, instruction, selectedHref
) {
  const descriptions = [
    ...String(instruction ?? "").matchAll(
      /["“]([^"”\n]{8,160})["”]/g
    )
  ].map(match => match[1].trim()).filter(text =>
    text.split(/\s+/).length >= 3 &&
    !/\.pdf\b/i.test(text)
  );

  if (!descriptions.length ||
      !/^https?:\/\//i.test(String(selectedHref ?? ""))) {
    return null;
  }

  try {
    return await page.evaluate(
      ({ href, descriptions }) => {
        const normalize = text => String(text ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();

        const matchingLinks = [
          ...document.querySelectorAll("a[href]")
        ].filter(anchor => {
          try {
            return new URL(
              anchor.getAttribute("href"),
              document.baseURI
            ).href === href;
          } catch {
            return false;
          }
        });

        // Duplicated links cannot establish a unique target.
        if (matchingLinks.length !== 1) return null;

        const anchor = matchingLinks[0];

        for (
          let node = anchor.parentElement, depth = 0;
          node && depth < 7;
          node = node.parentElement, depth++
        ) {
          const pdfLinks = [
            ...node.querySelectorAll("a[href]")
          ].filter(link => {
            try {
              return /\.pdf$/i.test(
                new URL(link.href).pathname
              );
            } catch {
              return false;
            }
          });

          // Never use a broad page section containing multiple PDFs.
          if (pdfLinks.length !== 1 ||
              pdfLinks[0] !== anchor) {
            continue;
          }

          const text = String(node.innerText ?? "")
            .replace(/\s+/g, " ")
            .trim();

          const description = descriptions.find(
            phrase => normalize(text).includes(normalize(phrase))
          );

          if (description) {
            return {
              href,
              description,
              nearbyText: text.slice(0, 600),
              pdfLinkCount: 1
            };
          }
        }

        return null;
      },
      { href: selectedHref, descriptions }
    );
  } catch {
    // Missing or ambiguous DOM evidence never grants identity.
    return null;
  }
}
