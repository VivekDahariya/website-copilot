function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function parsePrice(value) {
  const text = String(value ?? "").trim();

  const match = text.match(
    /^([£₹$€])\s*(\d[\d,]*(?:\.\d{1,2})?)$/
  );

  if (!match) return null;

  const amount = Number(
    match[2].replace(/,/g, "")
  );

  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }

  return {
    currency: match[1],
    amount
  };
}

export function validateExtraction(
  record,
  {
    expectedUrl,
    requiredFields = [
      "title",
      "price",
      "availability"
    ]
  } = {}
) {
  const errors = [];

  if (!record || typeof record !== "object") {
    return {
      valid: false,
      errors: ["Record is missing."]
    };
  }

  for (const field of requiredFields) {
    if (
      typeof record[field] !== "string" ||
      record[field].trim() === ""
    ) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  const actualUrl = normalizeUrl(record.url);

  if (!actualUrl) {
    errors.push("Invalid record URL.");
  }

  if (expectedUrl) {
    const expected = normalizeUrl(expectedUrl);

    if (!expected || actualUrl !== expected) {
      errors.push("Record URL does not match visited URL.");
    }
  }

  const price = parsePrice(record.price);

  if (!price) {
    errors.push("Price is not a valid monetary amount.");
  }

  if (
    typeof record.title === "string" &&
    record.title.trim().length < 3
  ) {
    errors.push("Title is suspiciously short.");
  }

  return {
    valid: errors.length === 0,
    errors,
    parsedPrice: price
  };
}
