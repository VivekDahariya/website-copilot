// Turns the browser's network error for an address that could not be opened into
// a short cause a person can act on. Never claims more than the error says.
export function describeUnreachableSite(error, url = "") {
  const text = String(error?.message ?? error ?? "");
  let host = "";
  try { host = new URL(url).host; } catch { host = ""; }
  const name = host || "the website";
  const code = (text.match(/net::(ERR_[A-Z_]+)/) ?? [])[1] ?? "";
  let cause;
  if (code === "ERR_NAME_NOT_RESOLVED") cause = "the address does not exist (its name could not be found)";
  else if (code === "ERR_CONNECTION_REFUSED") cause = "it refused the connection";
  else if (["ERR_CONNECTION_RESET", "ERR_CONNECTION_CLOSED", "ERR_EMPTY_RESPONSE"].includes(code)) cause = "it closed the connection without answering";
  else if (code === "ERR_INTERNET_DISCONNECTED" || code === "ERR_NETWORK_CHANGED") cause = "there is no working internet connection";
  else if (code === "ERR_CONNECTION_TIMED_OUT" || code === "ERR_TIMED_OUT" || /Timeout \d+ms exceeded/i.test(text)) cause = "it did not answer in time";
  else if (/^ERR_CERT_|ERR_SSL_/.test(code)) cause = "its security certificate could not be trusted";
  else cause = "it could not be reached";
  return `${name} could not be opened: ${cause}. Check the address and your connection, then run the task again.`;
}
