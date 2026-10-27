import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  readFile,
  realpath,
  rm
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  validateDownloadFilename,
  validatePdfBytes
} from "./verified-download.js";

const MAX_BYTES = 15 * 1024 * 1024;
const TOKEN_PATTERN = /^[0-9a-f]{48}$/;

export function createVerifiedDownloadRegistry({
  directory,
  ttlMs = 20 * 60 * 1000,
  maxEntries = 8
} = {}) {
  if (typeof directory !== "string" || !directory.trim()) {
    throw new Error("DOWNLOAD_DIRECTORY_REQUIRED");
  }

  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 ||
      ttlMs > 60 * 60 * 1000) {
    throw new Error("INVALID_DOWNLOAD_TTL");
  }

  if (!Number.isSafeInteger(maxEntries) ||
      maxEntries < 1 || maxEntries > 30) {
    throw new Error("INVALID_DOWNLOAD_REGISTRY_LIMIT");
  }

  const root = resolve(directory);
  const entries = new Map();

  async function verify(record) {
    const filename = validateDownloadFilename(record.filename);

    if (
      record.verified !== true ||
      !Number.isSafeInteger(record.bytes) ||
      record.bytes < 100 ||
      record.bytes > MAX_BYTES ||
      !/^[a-f0-9]{64}$/i.test(String(record.sha256 || "")) ||
      typeof record.internalPath !== "string"
    ) {
      throw new Error("INVALID_VERIFIED_DOWNLOAD_RECORD");
    }

    const actualRoot = await realpath(root);
    const actualFile = await realpath(record.internalPath);
    const captureDir = dirname(actualFile);

    if (
      dirname(captureDir) !== actualRoot ||
      !basename(captureDir).startsWith("capture-") ||
      basename(actualFile) !== filename
    ) {
      throw new Error("DOWNLOAD_OUTSIDE_PRIVATE_DIRECTORY");
    }

    const info = await lstat(record.internalPath);

    if (!info.isFile() || info.isSymbolicLink() ||
        info.size !== record.bytes) {
      throw new Error("DOWNLOAD_FILE_CHANGED");
    }

    const bytes = await readFile(actualFile);

    if (bytes.length !== record.bytes ||
        bytes.length > MAX_BYTES) {
      throw new Error("DOWNLOAD_SIZE_MISMATCH");
    }

    validatePdfBytes(bytes);

    const sha256 = createHash("sha256")
      .update(bytes)
      .digest("hex");

    if (sha256 !== record.sha256.toLowerCase()) {
      throw new Error("DOWNLOAD_CHECKSUM_MISMATCH");
    }

    return {
      bytes,
      captureDir,
      filename
    };
  }

  async function discard(id) {
    const entry = entries.get(id);
    if (!entry) return;

    entries.delete(id);

    // Only delete a capture directory that passed the
    // private-directory verification during registration.
    await rm(entry.captureDir, {
      recursive: true,
      force: true
    });
  }

  async function prune() {
    for (const [id, entry] of entries) {
      if (Date.now() >= entry.expiresAt) {
        await discard(id);
      }
    }
  }

  async function register(file) {
    await prune();

    const checked = await verify(file);

    for (const entry of entries.values()) {
      if (entry.internalPath === file.internalPath) {
        throw new Error("DOWNLOAD_ALREADY_REGISTERED");
      }
    }

    while (entries.size >= maxEntries) {
      await discard(entries.keys().next().value);
    }

    const id = randomBytes(24).toString("hex");
    const expiresAt = Date.now() + ttlMs;

    entries.set(id, {
      ...file,
      filename: checked.filename,
      captureDir: checked.captureDir,
      expiresAt
    });

    return {
      id,
      filename: checked.filename,
      bytes: file.bytes,
      sha256: file.sha256,
      downloadUrl: "/api/download/" + id,
      expiresAt
    };
  }

  function errorResponse(res, status) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });

    res.end(JSON.stringify({
      error: status === 410
        ? "Download expired or no longer valid."
        : "Download not found."
    }));
  }

  async function serve(id, res) {
    if (typeof id !== "string" ||
        !TOKEN_PATTERN.test(id) ||
        !entries.has(id)) {
      return errorResponse(res, 404);
    }

    const entry = entries.get(id);

    if (Date.now() >= entry.expiresAt) {
      await discard(id);
      return errorResponse(res, 410);
    }

    let checked;

    try {
      checked = await verify(entry);
    } catch {
      await discard(id);
      return errorResponse(res, 410);
    }

    const fallback = checked.filename
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\;]/g, "_");

    res.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Length": checked.bytes.length,
      "Content-Disposition":
        'attachment; filename="' + fallback +
        '"; filename*=UTF-8' + "''" +
        encodeURIComponent(checked.filename),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
      "Referrer-Policy": "no-referrer"
    });

    res.end(checked.bytes);
  }

  return {
    register,
    serve,
    prune
  };
}
