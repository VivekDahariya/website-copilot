import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { createDownloadSession } from "./download-session.js";
import {
  isExplicitPdfDownloadRequest,
  verifyRequestedPdfIdentity
} from "./pdf-download-identity.js";

export async function captureApprovedPdfAndRegister({
  context,
  registry,
  directory,
  performApprovedAction,
  waitTimeoutMs = 60000,
  captureTimeoutMs = 45000,
  maxBytes = 15 * 1024 * 1024,
  onEvent,
  validateCapturedFile = null
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

    const file = await pending;

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

    validateCapturedFile: async file => {
      const identity = verifyRequestedPdfIdentity({
        instruction,
        filename: file.filename,
        linkText: selectedLink.label ?? "",
        linkHref: selectedLink.href ?? "",
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
