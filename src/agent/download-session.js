import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { captureVerifiedDownload } from "./verified-download.js";

export function createDownloadSession(
  context,
  {
    directory,
    maxBytes = 15 * 1024 * 1024,
    captureTimeoutMs = 45000,
    onEvent
  } = {}
) {
  if (
    !context ||
    typeof context.pages !== "function" ||
    typeof context.on !== "function" ||
    typeof context.off !== "function"
  ) {
    throw new Error("VALID_BROWSER_CONTEXT_REQUIRED");
  }

  if (typeof directory !== "string" || !directory.trim()) {
    throw new Error("DOWNLOAD_DIRECTORY_REQUIRED");
  }

  const events = new EventEmitter();
  const attachedPages = new Set();

  let closed = false;
  let started = false;
  let completedFile = null;
  let failure = null;

  function report(event) {
    if (typeof onEvent !== "function") return;

    try {
      onEvent(event);
    } catch {
      // Dashboard activity callbacks cannot break file capture.
    }
  }

  function onDownload(download) {
    if (closed || started) return;

    // One verified file per session for now.
    // This prevents unrelated downloads from being delivered.
    started = true;

    report({ type: "download_started" });

    void (async () => {
      try {
        const file = await captureVerifiedDownload(download, {
          directory,
          maxBytes,
          timeoutMs: captureTimeoutMs
        });

        if (closed) {
          await rm(dirname(file.internalPath), {
            recursive: true,
            force: true
          });
          return;
        }

        completedFile = file;

        report({
          type: "download_verified",
          id: file.id,
          filename: file.filename,
          bytes: file.bytes,
          sha256: file.sha256
        });

      } catch (error) {
        if (!closed) {
          failure = error;

          report({
            type: "download_failed",
            reason: error.message
          });
        }

      } finally {
        events.emit("settled");
      }
    })();
  }

  function attachPage(page) {
    if (
      closed ||
      !page ||
      attachedPages.has(page) ||
      typeof page.on !== "function"
    ) {
      return;
    }

    attachedPages.add(page);
    page.on("download", onDownload);
  }

  function onPage(page) {
    attachPage(page);
  }

  for (const page of context.pages()) {
    attachPage(page);
  }

  context.on("page", onPage);

  function waitForFile({ timeoutMs = 60000 } = {}) {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 180000
    ) {
      return Promise.reject(
        new Error("INVALID_DOWNLOAD_WAIT_TIMEOUT")
      );
    }

    return new Promise((resolve, reject) => {
      let timer;

      const cleanup = () => {
        clearTimeout(timer);
        events.off("settled", check);
      };

      const check = () => {
        if (completedFile) {
          cleanup();
          resolve(completedFile);
        } else if (failure) {
          cleanup();
          reject(failure);
        } else if (closed) {
          cleanup();
          reject(new Error("DOWNLOAD_SESSION_CLOSED"));
        }
      };

      events.on("settled", check);

      timer = setTimeout(() => {
        cleanup();
        reject(new Error("VERIFIED_DOWNLOAD_TIMEOUT"));
      }, timeoutMs);

      check();
    });
  }

  function dispose() {
    if (closed) return;

    closed = true;
    context.off("page", onPage);

    for (const page of attachedPages) {
      page.off("download", onDownload);
    }

    attachedPages.clear();
    events.emit("settled");
  }

  function getStatus() {
    return {
      active: !closed,
      downloadObserved: started,
      verified: Boolean(completedFile),
      failed: Boolean(failure),
      filename: completedFile?.filename ?? null
    };
  }

  return {
    waitForFile,
    getStatus,
    dispose
  };
}
