import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const DEFAULT_MAX_BYTES = 15 * 1024 * 1024;

export function validateDownloadFilename(value) {
  const filename = String(value ?? "")
    .normalize("NFKC")
    .trim();

  if (
    !filename ||
    filename.length > 120 ||
    filename.startsWith(".") ||
    /[/\\]/.test(filename) ||
    /[\u0000-\u001f\u007f<>:"|?*]/.test(filename)
  ) {
    throw new Error("UNSAFE_DOWNLOAD_FILENAME");
  }

  if (!filename.toLowerCase().endsWith(".pdf")) {
    throw new Error("UNSUPPORTED_DOWNLOAD_TYPE");
  }

  return filename;
}

export function validatePdfBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 100) {
    throw new Error("PDF_TOO_SMALL_OR_INVALID");
  }

  const header = bytes.subarray(0, 5).toString("latin1");

  if (header !== "%PDF-") {
    throw new Error("PDF_SIGNATURE_INVALID");
  }

  const tail = bytes
    .subarray(-2048)
    .toString("latin1");

  if (!/startxref\s+\d+\s+%%EOF\s*$/.test(tail)) {
    throw new Error("PDF_TRAILER_INVALID");
  }

  return true;
}

export async function captureVerifiedDownload(
  download,
  {
    directory,
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = 45000
  } = {}
) {
  if (
    !download ||
    typeof download.createReadStream !== "function" ||
    typeof download.suggestedFilename !== "function" ||
    typeof download.failure !== "function"
  ) {
    throw new Error("VALID_PLAYWRIGHT_DOWNLOAD_REQUIRED");
  }

  if (typeof directory !== "string" || !directory.trim()) {
    throw new Error("DOWNLOAD_DIRECTORY_REQUIRED");
  }

  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 100 ||
    maxBytes > DEFAULT_MAX_BYTES
  ) {
    throw new Error("INVALID_DOWNLOAD_SIZE_LIMIT");
  }

  const filename = validateDownloadFilename(
    download.suggestedFilename()
  );

  const root = resolve(directory);

  await mkdir(root, {
    recursive: true,
    mode: 0o700
  });

  const isolatedDirectory = await mkdtemp(
    join(root, "capture-")
  );

  const internalPath = join(
    isolatedDirectory,
    filename
  );

  let downloadedBytes = 0;

  try {
    const source = await download.createReadStream();

    if (!source) {
      throw new Error("DOWNLOAD_STREAM_UNAVAILABLE");
    }

    const sizeLimiter = new Transform({
      transform(chunk, encoding, callback) {
        downloadedBytes += chunk.length;

        if (downloadedBytes > maxBytes) {
          callback(new Error("DOWNLOAD_SIZE_LIMIT_EXCEEDED"));
          return;
        }

        callback(null, chunk);
      }
    });

    await pipeline(
      source,
      sizeLimiter,
      createWriteStream(internalPath, {
        flags: "wx",
        mode: 0o600
      }),
      {
        signal: AbortSignal.timeout(timeoutMs)
      }
    );

    const failure = await download.failure();

    if (failure) {
      throw new Error("DOWNLOAD_FAILED: " + failure);
    }

    const bytes = await readFile(internalPath);

    if (bytes.length !== downloadedBytes) {
      throw new Error("DOWNLOAD_BYTE_COUNT_MISMATCH");
    }

    validatePdfBytes(bytes);

    const sha256 = createHash("sha256")
      .update(bytes)
      .digest("hex");

    return {
      id: randomUUID(),
      filename,
      mediaType: "application/pdf",
      bytes: bytes.length,
      sha256,
      internalPath,
      verified: true
    };

  } catch (error) {
    await rm(isolatedDirectory, {
      recursive: true,
      force: true
    });

    throw error;
  }
}
