// Deliver only internally consistent, source-grounded comparisons.
const normalize = value => String(value ?? "")
  .normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

function priceParts(value) {
  const match = String(value ?? "").trim().match(
    /^([£₹$€])\s*(\d[\d,]*(?:\.\d{1,2})?)$/
  );
  if (!match) return null;

  const number = Number(match[2].replace(/,/g, ""));
  const cents = Math.round(number * 100);

  return Number.isSafeInteger(cents) && cents >= 0
    ? { currency: match[1], cents }
    : null;
}

export function extractVerifiedNamedComparison(run) {
  const task = run?.interpretedTask;
  const execution = run?.execution;
  const raw = execution?.result;

  if (
    run?.status !== "verified_complete" ||
    execution?.status !== "verified_complete" ||
    raw?.status !== "verified_complete" ||
    task?.type !== "product_comparison" ||
    raw?.comparisonMode !== "named_products" ||
    !Array.isArray(task.titles) ||
    task.titles.length !== 2 ||
    !Array.isArray(raw.requestedNames) ||
    raw.requestedNames.length !== 2 ||
    raw.requested !== 2 ||
    raw.collected !== 2 ||
    !Array.isArray(raw.books) ||
    raw.books.length !== 2 ||
    !Array.isArray(raw.comparison) ||
    raw.comparison.length !== 2
  ) return null;

  const names = task.titles.map(name =>
    typeof name === "string" ? name.trim() : ""
  );

  if (
    names.some(name => !name || name.length > 160) ||
    normalize(names[0]) === normalize(names[1]) ||
    !names.every((name, i) =>
      normalize(name) === normalize(raw.requestedNames[i])
    )
  ) return null;

  let origin;
  try {
    const start = new URL(task.startUrl);
    if (!["http:", "https:"].includes(start.protocol) ||
        start.username || start.password) return null;
    origin = start.origin;
  } catch {
    return null;
  }

  const products = [];

  for (const name of names) {
    const matches = raw.books.filter(book =>
      normalize(book?.title) === normalize(name)
    );

    const records = raw.comparison.filter(item =>
      normalize(item?.title) === normalize(name)
    );

    if (matches.length !== 1 || records.length !== 1)
      return null;

    const book = matches[0];
    const record = records[0];
    const price = priceParts(book.price);

    let source;
    try {
      source = new URL(book.url);
      if (
        !["http:", "https:"].includes(source.protocol) ||
        source.origin !== origin ||
        source.username ||
        source.password
      ) return null;
    } catch {
      return null;
    }

    if (
      !price ||
      typeof book.title !== "string" ||
      typeof book.availability !== "string" ||
      !book.availability.trim() ||
      book.availability.length > 300 ||
      record.price !== book.price ||
      record.availability !== book.availability ||
      record.url !== book.url ||
      record.currency !== price.currency ||
      typeof record.numericPrice !== "number" ||
      !Number.isFinite(record.numericPrice) ||
      Math.round(record.numericPrice * 100) !== price.cents
    ) return null;

    products.push({
      title: book.title,
      price: book.price,
      availability: book.availability.trim(),
      url: source.href,
      currency: price.currency,
      cents: price.cents
    });
  }

  if (
    products[0].url === products[1].url ||
    products[0].currency !== products[1].currency
  ) return null;

  const differenceCents = Math.abs(
    products[0].cents - products[1].cents
  );

  const tied = differenceCents === 0;
  const cheaper = tied ? null :
    products[0].cents < products[1].cents
      ? products[0] : products[1];

  const difference = products[0].currency +
    (differenceCents / 100).toFixed(2);

  if (
    raw.priceDifference?.currency !== products[0].currency ||
    raw.priceDifference?.display !== difference ||
    raw.priceDifference?.tied !== tied ||
    Math.round(raw.priceDifference?.amount * 100) !==
      differenceCents ||
    (tied
      ? raw.cheapest !== null
      : normalize(raw.cheapest?.title) !==
        normalize(cheaper.title))
  ) return null;

  return {
    verified: true,
    mode: "named_products",
    products: products.map(
      ({ title, price, availability, url }) => ({
        title, price, availability, url
      })
    ),
    cheaperTitle: cheaper?.title ?? null,
    difference,
    tied
  };
}
