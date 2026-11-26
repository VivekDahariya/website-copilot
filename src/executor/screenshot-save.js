// Saving a screenshot of the page, checked from the file itself. A screenshot
// counts only when the browser produced a real PNG, the file is on disk, and
// reading it back gives the same size and hash. Local files only.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024;
export const MAX_FULL_PAGE_HEIGHT = 16000;

function failure(reason) {
  const error = new Error("MEDIA_SAVE_FAILED: " + reason);
  error.code = "MEDIA_SAVE_FAILED";
  return error;
}

// Width and height from the PNG header, or null when this is not a PNG.
export function readPngSize(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!bytes || bytes.length < 24) return null;
  if (!signature.every((value, index) => bytes[index] === value)) return null;
  if (bytes.slice(12, 16).toString("latin1") !== "IHDR") return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export async function saveScreenshot(page, directory, { fullPage = false } = {}) {
  if (typeof directory !== "string" || !directory) {
    throw failure("no folder is set for saved media.");
  }
  if (fullPage) {
    const height = await page.evaluate(() => Math.max(
      document.documentElement?.scrollHeight ?? 0, document.body?.scrollHeight ?? 0
    )).catch(() => 0);
    if (height > MAX_FULL_PAGE_HEIGHT) {
      throw failure(`the page is ${height} px tall, more than the ${MAX_FULL_PAGE_HEIGHT} px limit for a full-page screenshot.`);
    }
  }

  let bytes;
  try {
    bytes = await page.screenshot({ type: "png", fullPage, animations: "disabled", timeout: 20000 });
  } catch (error) {
    throw failure("the browser could not take the screenshot (" +
      String(error?.message ?? "error").split("\n")[0].slice(0, 80) + ").");
  }
  if (bytes.length > MAX_SCREENSHOT_BYTES) throw failure("the screenshot is larger than the 25 MB limit.");
  const size = readPngSize(bytes);
  if (!size) throw failure("the browser did not produce a valid PNG image.");

  const hash = sha256(bytes);
  let host = "page";
  try { host = new URL(page.url()).hostname.replace(/[^a-z0-9.-]+/gi, "-") || "page"; } catch { /* keep default */ }
  const fileName = `screenshot-${host.slice(0, 40)}-${fullPage ? "full" : "view"}-${hash.slice(0, 8)}.png`;
  const path = join(directory, fileName);

  await mkdir(directory, { recursive: true });
  try {
    await writeFile(path, bytes, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw failure("the file could not be written.");
  }
  const written = await readFile(path).catch(() => null);
  const verified = written !== null && written.length === bytes.length && sha256(written) === hash;
  if (!verified) throw failure("the saved file does not match the screenshot.");

  return {
    fileName, path, bytes: bytes.length, type: "png", kind: "screenshot",
    width: size.width, height: size.height, fullPage, sha256: hash, source: host, verified: true
  };
}
