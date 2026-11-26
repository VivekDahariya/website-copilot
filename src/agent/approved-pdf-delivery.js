import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { isIP } from "node:net";
import { captureVerifiedPdfBytes } from "./verified-download.js";
import { createDownloadSession } from "./download-session.js";
import {
  isExplicitPdfDownloadRequest,
  verifyRequestedPdfIdentity
} from "./pdf-download-identity.js";

// The browser sometimes renders a clicked PDF inline. In that case there
// is no Playwright "download" event, even though the browser opened the PDF.
// Only allow a second, cookie-aware read of the exact already-opened,
// same-origin HTTPS PDF selected by the approved browser action. Never
// follow redirects, guess another file or read local/private destinations.
function eligibleInlinePdfUrl(context, selectedPdfUrl, sourcePageUrl, beforePages) {
  if (!selectedPdfUrl || !sourcePageUrl || !context ||
      typeof context.pages !== "function" ||
      typeof context.request?.get !== "function") {
    return null;
  }

  try {
    const target = new URL(selectedPdfUrl);
    const source = new URL(sourcePageUrl);
    const host = target.hostname.toLowerCase();

    if (target.protocol !== "https:" ||
        source.protocol !== "https:" ||
        source.origin !== target.origin ||
        target.username || target.password ||
        isIP(host) !== 0 ||
        !host.includes(".") ||
        /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host) ||
        !/\.pdf$/i.test(target.pathname)) {
      return null;
    }

    // Actual browser navigation is required. A model claim or a selected
    // href alone cannot authorize a secondary HTTP request.
    if (!context.pages().some(page =>
      typeof page.url === "function" &&
      page.url() === target.href &&
      beforePages.get(page) !== target.href
    )) {
      return null;
    }

    return target;
  } catch {
    return null;
  }
}

async function captureInlinePdf(context, target, directory, maxBytes) {
  const response = await context.request.get(target.href, {
    timeout: 25000,
    maxRedirects: 0,
    failOnStatusCode: false
  });

  if (response.status() !== 200 || response.url() !== target.href) {
    throw new Error("INLINE_PDF_RESPONSE_NOT_VERIFIED");
  }

  const contentLength = Number(response.headers()["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("DOWNLOAD_SIZE_LIMIT_EXCEEDED");
  }

  const bytes = await response.body();
  let filename;
  try {
    filename = decodeURIComponent(target.pathname.split("/").pop());
  } catch {
    throw new Error("UNSAFE_DOWNLOAD_FILENAME");
  }

  return captureVerifiedPdfBytes(bytes, {
    filename,
    directory,
    maxBytes
  });
}

export async function captureApprovedPdfAndRegister({
  context,
  registry,
  directory,
  performApprovedAction,
  waitTimeoutMs = 60000,
  captureTimeoutMs = 45000,
  maxBytes = 15 * 1024 * 1024,
  onEvent,
  validateCapturedFile = null,
  selectedPdfUrl = null
} = {}) {
  if (
    !registry ||
    typeof registry.register !== "function"
  ) {
    throw new Error("VERIFIED_DOWNLOAD_REGISTRY_REQUIRED");
  }

  if (typeof performApprovedAction !== "function") {
    throw new Error("APPROVED_ACTION_CALLBACK_REQUIRED");
  }

  if (
    validateCapturedFile !== null &&
    typeof validateCapturedFile !== "function"
  ) {
    throw new Error("INVALID_DOWNLOAD_VALIDATOR");
  }

  // The caller must obtain normal agent/user approval first.
  // This function never chooses or approves a browser action.

  // Record the source page before clicking. The candidate URL is supplied
  // only by the existing observed-DOM PDF click guard.
  const beforePages = new Map((context?.pages?.() ?? []).map(page => [
    page,
    typeof page.url === "function" ? page.url() : ""
  ]));
  const sourcePageUrl = selectedPdfUrl && [...beforePages.values()]
    .find(url => {
      try {
        return new URL(url).origin === new URL(selectedPdfUrl).origin;
      } catch {
        return false;
      }
    });

  const session = createDownloadSession(context, {
    directory,
    maxBytes,
    captureTimeoutMs,
    onEvent
  });

  let captured = null;
  let delivered = false;
  let released = false;

  const pending = session.waitForFile({
    timeoutMs: waitTimeoutMs
  }).then(async file => {
    captured = file;

    if (released) {
      await rm(dirname(file.internalPath), {
        recursive: true,
        force: true
      });

      throw new Error("DOWNLOAD_ACTION_ABORTED");
    }

    return file;
  });

  // Prevent an unhandled rejection if the approved action
  // fails before the download settles.
  void pending.catch(() => {});

  try {
    await performApprovedAction();

    // Prefer the existing Playwright download stream. If Chromium opened
    // the approved PDF as an inline document instead, capture its exact
    // browser-confirmed URL through this context's cookie-aware request.
    // This prevents the 60-second wait for an event Chromium never emits.
    const inlineTarget = session.getStatus().downloadObserved
      ? null
      : eligibleInlinePdfUrl(context, selectedPdfUrl, sourcePageUrl, beforePages);

    const file = inlineTarget
      ? await captureInlinePdf(context, inlineTarget, directory, maxBytes)
      : await pending;

    if (inlineTarget) {
      captured = file;
    }

    // The PDF must match the requested document before
    // the registry creates any delivery token.
    if (validateCapturedFile) {
      await validateCapturedFile(file);
    }

    const receipt = await registry.register(file);

    delivered = true;

    return {
      status: "download_ready",
      verified: true,
      filename: receipt.filename,
      bytes: receipt.bytes,
      sha256: receipt.sha256,
      downloadUrl: receipt.downloadUrl,
      expiresAt: receipt.expiresAt
    };

  } finally {
    released = true;
    session.dispose();

    if (captured && !delivered) {
      await rm(dirname(captured.internalPath), {
        recursive: true,
        force: true
      });
    }
  }
}


export async function captureRequestedPdfAndRegister({
  instruction,
  selectedLink,
  pageTitle = "",
  ...options
} = {}) {
  if (!isExplicitPdfDownloadRequest(instruction)) {
    throw new Error("NOT_EXPLICIT_PDF_REQUEST");
  }

  if (
    !selectedLink ||
    typeof selectedLink !== "object" ||
    !String(
      selectedLink.label || selectedLink.href || ""
    ).trim()
  ) {
    throw new Error("PDF_TARGET_METADATA_REQUIRED");
  }

  let identityEvidence = null;
  const extraValidator = options.validateCapturedFile;

  const receipt = await captureApprovedPdfAndRegister({
    ...options,
    selectedPdfUrl: selectedLink.href,

    validateCapturedFile: async file => {
      const identity = verifyRequestedPdfIdentity({
        instruction,
        filename: file.filename,
        bytes: file.bytes,
        linkText: selectedLink.label ?? "",
        linkHref: selectedLink.href ?? "",
        descriptionEvidence:
          selectedLink.descriptionEvidence ?? null,
        pageTitle
      });

      if (!identity.matched) {
        throw new Error(
          "DOWNLOAD_IDENTITY_MISMATCH:" + identity.reason
        );
      }

      if (typeof extraValidator === "function") {
        await extraValidator(file);
      }

      identityEvidence = identity;
    }
  });

  return {
    ...receipt,
    identity: identityEvidence
  };
}
