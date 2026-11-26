// Saving an image the page shows, checked from the file itself. A save counts
// only when the bytes are a real image of a supported kind, the file is on
// disk, and reading it back gives the same size and hash. The model's word is
// never evidence. SVG is not saved: it can carry script.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function sniffImageType(bytes) {
  const b = bytes;
  if (!b || b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "gif";
  if (b.slice(0, 4).toString("latin1") === "RIFF" &&
      b.slice(8, 12).toString("latin1") === "WEBP") return "webp";
  if (b[0] === 0x42 && b[1] === 0x4d) return "bmp";
  return null;
}

function failure(reason) {
  const error = new Error("MEDIA_SAVE_FAILED: " + reason);
  error.code = "MEDIA_SAVE_FAILED";
  return error;
}

export function safeBaseName(...candidates) {
  for (const candidate of candidates) {
    const base = String(candidate ?? "")
      .replace(/\.[a-z0-9]{2,5}$/i, "")
      .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
      .slice(0, 48);
    if (base.length >= 2) return base;
  }
  return "image";
}

// A stable name for "this picture on the page", used to avoid saving the same
// picture twice when element references shift between observations. The
// observer builds the same key in the browser.
export function pictureKey(src) {
  const text = String(src ?? "");
  return text.startsWith("data:") ? `data:${text.length}:${text.slice(-80)}` : text.slice(0, 500);
}

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

/**
 * Saves the picture shown by an <img> element into `directory`.
 * Returns a receipt; throws MEDIA_SAVE_FAILED when nothing trustworthy was saved.
 */
export async function saveImage(page, handle, directory) {
  if (typeof directory !== "string" || !directory) {
    throw failure("no folder is set for saved media.");
  }

  const info = await handle.evaluate(element => ({
    tag: element.tagName.toLowerCase(),
    src: element.currentSrc || element.src || "",
    alt: element.getAttribute("alt") || "",
    title: element.getAttribute("title") || ""
  }));
  if (info.tag !== "img" || !info.src) throw failure("the target is not a picture.");

  let bytes;
  let source;
  const dataUrl = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i.exec(info.src);
  if (dataUrl) {
    bytes = Buffer.from(dataUrl[1].replace(/\s+/g, ""), "base64");
    source = "data URL";
  } else if (/^https?:\/\//i.test(info.src)) {
    let response;
    try {
      response = await page.context().request.get(info.src, {
        timeout: 20000,
        maxRedirects: 5,
        headers: { referer: page.url() }
      });
    } catch (error) {
      throw failure("the picture could not be fetched (" +
        String(error?.message ?? "network error").split("\n")[0].slice(0, 80) + ").");
    }
    if (!response.ok()) throw failure(`the site answered ${response.status()} for the picture.`);
    const declared = Number(response.headers()["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      throw failure("the picture is larger than the 20 MB limit.");
    }
    bytes = await response.body();
    source = new URL(info.src).hostname;
  } else {
    throw failure("this kind of picture address is not supported.");
  }

  if (bytes.length === 0) throw failure("the picture is empty.");
  if (bytes.length > MAX_IMAGE_BYTES) throw failure("the picture is larger than the 20 MB limit.");
  const type = sniffImageType(bytes);
  if (!type) throw failure("the file is not a supported image (PNG, JPEG, GIF, WebP or BMP).");

  const hash = sha256(bytes);
  const pathName = (() => {
    try { return decodeURIComponent(new URL(info.src).pathname.split("/").pop() ?? ""); }
    catch { return ""; }
  })();
  const fileName = `${safeBaseName(info.alt, info.title, pathName)}-${hash.slice(0, 8)}.${type}`;
  const path = join(directory, fileName);

  await mkdir(directory, { recursive: true });
  // "wx" never overwrites. The same picture saved twice has the same name,
  // and an existing file is accepted only if it is byte-identical.
  try {
    await writeFile(path, bytes, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw failure("the file could not be written.");
  }

  const written = await readFile(path).catch(() => null);
  const verified = written !== null && written.length === bytes.length && sha256(written) === hash;
  if (!verified) throw failure("the saved file does not match the downloaded picture.");

  return { fileName, path, bytes: bytes.length, type, sha256: hash, source, sourceKey: pictureKey(info.src), verified: true };
}
