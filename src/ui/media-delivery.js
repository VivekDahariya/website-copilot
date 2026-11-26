// Delivering a saved picture or screenshot to the dashboard: a preview, a full
// screen view and a download. A file is offered only when it passed the save
// check, sits directly inside the media folder, is a plain file (not a link),
// and still has the size and hash it was saved with. It is checked again on
// every request. Links are random, temporary, and local to this machine.
import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { sniffImageType, MAX_IMAGE_BYTES } from "../executor/media-save.js";

const TOKEN = /^[0-9a-f]{48}$/;
const CONTENT_TYPES = {
  png: "image/png", jpg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp"
};
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

// The verified pictures and screenshots a finished run saved, newest last,
// without duplicates. Only receipts that passed the file check are used.
export function extractVerifiedImages(history, limit = 6) {
  const seen = new Set();
  const found = [];
  for (const entry of Array.isArray(history) ? history : []) {
    const operation = entry?.decision?.operation;
    const media = entry?.execution?.media;
    if (!["save_image", "screenshot"].includes(operation)) continue;
    if (media?.verified !== true || typeof media.path !== "string" ||
        !/^[a-f0-9]{64}$/i.test(String(media.sha256 ?? ""))) continue;
    const key = String(media.sha256).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ ...media, kind: operation === "screenshot" ? "screenshot" : "image" });
  }
  return found.slice(-Math.max(1, limit));
}

export function createMediaDelivery({ directory, ttlMs = 20 * 60 * 1000, maxEntries = 12 } = {}) {
  if (typeof directory !== "string" || !directory.trim()) {
    throw new Error("MEDIA_DIRECTORY_REQUIRED");
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 60 * 60 * 1000) {
    throw new Error("INVALID_MEDIA_TTL");
  }
  const root = resolve(directory);
  const entries = new Map();

  // Reads the file again and proves it is still the saved picture.
  async function check(record) {
    const actualRoot = await realpath(root);
    const actualFile = await realpath(record.path);
    if (dirname(actualFile) !== actualRoot) throw new Error("MEDIA_OUTSIDE_FOLDER");
    const info = await lstat(record.path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("MEDIA_NOT_A_FILE");
    if (info.size < 100 || info.size > MAX_IMAGE_BYTES || info.size !== record.bytes) {
      throw new Error("MEDIA_SIZE_CHANGED");
    }
    const bytes = await readFile(actualFile);
    if (bytes.length !== record.bytes) throw new Error("MEDIA_SIZE_CHANGED");
    if (sha256(bytes) !== String(record.sha256).toLowerCase()) throw new Error("MEDIA_CHANGED");
    const type = sniffImageType(bytes);
    if (!type || !CONTENT_TYPES[type]) throw new Error("MEDIA_NOT_AN_IMAGE");
    return { bytes, type, fileName: basename(actualFile) };
  }

  function prune() {
    for (const [id, entry] of entries) if (Date.now() >= entry.expiresAt) entries.delete(id);
  }

  async function register(record) {
    prune();
    if (record?.verified !== true || typeof record.path !== "string" ||
        !Number.isSafeInteger(record.bytes) ||
        !/^[a-f0-9]{64}$/i.test(String(record.sha256 ?? ""))) {
      throw new Error("INVALID_VERIFIED_MEDIA_RECORD");
    }
    const checked = await check(record);
    while (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
    const id = randomBytes(24).toString("hex");
    const expiresAt = Date.now() + ttlMs;
    entries.set(id, { path: record.path, bytes: record.bytes, sha256: record.sha256, expiresAt });
    return {
      kind: record.kind === "screenshot" ? "screenshot" : "image",
      fileName: checked.fileName,
      bytes: record.bytes,
      type: checked.type,
      width: Number.isSafeInteger(record.width) ? record.width : null,
      height: Number.isSafeInteger(record.height) ? record.height : null,
      sha256: String(record.sha256).toLowerCase(),
      verified: true,
      viewUrl: "/api/media/" + id,
      downloadUrl: "/api/media/" + id + "/download",
      expiresAt
    };
  }

  function fail(res, status) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    res.end(JSON.stringify({ error: status === 410
      ? "This picture link expired or the file changed."
      : "Picture not found." }));
  }

  // `rest` is the part of the path after /api/media/: "<token>" for the
  // preview, "<token>/download" for the download.
  async function serve(rest, res) {
    const [id, extra, ...more] = String(rest ?? "").split("/");
    const download = extra === "download";
    if (!TOKEN.test(id ?? "") || more.length > 0 || (extra !== undefined && !download) ||
        !entries.has(id)) return fail(res, 404);
    const entry = entries.get(id);
    if (Date.now() >= entry.expiresAt) { entries.delete(id); return fail(res, 410); }
    let checked;
    try { checked = await check(entry); } catch { entries.delete(id); return fail(res, 410); }
    const safeName = checked.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\;]/g, "_");
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[checked.type],
      "Content-Length": checked.bytes.length,
      "Content-Disposition": (download ? "attachment" : "inline") + '; filename="' + safeName + '"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox"
    });
    res.end(checked.bytes);
  }

  return { register, serve };
}
