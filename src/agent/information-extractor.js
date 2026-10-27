export async function extractBookInformation(page) {
  return await page.evaluate(() => {
    const title =
      document.querySelector(".product_main h1")
        ?.textContent?.trim() ?? "";

    const price =
      document.querySelector(".product_main .price_color")
        ?.textContent?.trim() ?? "";

    const availability =
      document.querySelector(
        ".product_main .availability"
      )?.textContent?.replace(/\s+/g, " ").trim() ?? "";

    const breadcrumb = Array.from(
      document.querySelectorAll(
        ".breadcrumb li"
      )
    ).map(element =>
      element.textContent.replace(/\s+/g, " ").trim()
    );

    return {
      title,
      price,
      availability,
      breadcrumb,
      url: location.href
    };
  });
}

export async function extractBookLinks(page, limit = 3) {
  return await page.evaluate(limit => {
    return Array.from(
      document.querySelectorAll(
        "article.product_pod h3 a"
      )
    )
      .slice(0, limit)
      .map(element => ({
        title: element.getAttribute("title") || "",
        url: element.href
      }));
  }, limit);
}
