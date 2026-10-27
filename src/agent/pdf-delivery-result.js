import {
  validateDownloadFilename
} from "./verified-download.js";

export function extractVerifiedPdfResult(
  agentResult,
  outerResult
) {
  const candidate = [agentResult, outerResult]
    .find(value => value?.status === "download_ready");

  if (!candidate || candidate.verified !== true) {
    return null;
  }

  let filename;

  try {
    filename = validateDownloadFilename(candidate.filename);
  } catch {
    return null;
  }

  if (
    !Number.isSafeInteger(candidate.bytes) ||
    candidate.bytes < 100 ||
    candidate.bytes > 15 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/i.test(
      String(candidate.sha256 ?? "")
    ) ||
    !/^\/api\/download\/[a-f0-9]{48}$/.test(
      String(candidate.downloadUrl ?? "")
    ) ||
    candidate.identity?.matched !== true ||
    !Number.isSafeInteger(candidate.expiresAt) ||
    candidate.expiresAt <= Date.now()
  ) {
    return null;
  }

  return {
    status: "download_ready",
    verified: true,
    filename,
    bytes: candidate.bytes,
    sha256: candidate.sha256,
    downloadUrl: candidate.downloadUrl,
    expiresAt: candidate.expiresAt
  };
}
