/**
 * Inbound content sanitizer for untrusted context entries.
 *
 * Strips or neutralizes prompt injection patterns from untrusted content
 * before it reaches agent context. This is a hard gate — content that passes
 * through here has injection vectors defanged.
 *
 * Used by:
 * - inbound-context.ts (UntrustedContext entries from channels)
 * - external-content.ts (email/webhook/API content after marker sanitization)
 */

import { logWarn } from "../logger.js";

/**
 * Patterns that indicate prompt injection attempts.
 * When matched, the offending text is wrapped in backticks to neutralize it.
 */
const INJECTION_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  {
    regex: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?)/gi,
    label: "ignore-instructions",
  },
  { regex: /disregard\s+(all\s+)?(previous|prior|above)/gi, label: "disregard-previous" },
  {
    regex: /forget\s+(everything|all|your)\s+(instructions?|rules?|guidelines?)/gi,
    label: "forget-rules",
  },
  { regex: /you\s+are\s+now\s+(a|an)\s+/gi, label: "role-override" },
  { regex: /new\s+instructions?:/gi, label: "new-instructions" },
  { regex: /system\s*:?\s*(prompt|override|command)/gi, label: "system-override" },
  { regex: /\bexec\b.*command\s*=/gi, label: "exec-command" },
  { regex: /elevated\s*=\s*true/gi, label: "elevation-attempt" },
  { regex: /rm\s+-rf/gi, label: "destructive-command" },
  { regex: /delete\s+all\s+(emails?|files?|data)/gi, label: "mass-delete" },
  { regex: /<\/?system>/gi, label: "system-tag" },
  { regex: /\]\s*\n\s*\[?(system|assistant|user)\]?:/gi, label: "role-injection" },
];

/**
 * Boundary markers that could be used to escape content wrapping.
 */
const BOUNDARY_MARKERS = [
  /<<<EXTERNAL_UNTRUSTED_CONTENT>>>/gi,
  /<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>/gi,
  /<<<[A-Z_]+>>>/gi,
];

export type SanitizeResult = {
  sanitized: string;
  detections: string[];
};

/**
 * Sanitize untrusted content by defanging injection patterns and boundary markers.
 *
 * Matched patterns are wrapped in inline code backticks to render them inert
 * while preserving readability for the agent.
 *
 * @param content - The untrusted content to sanitize
 * @param source - Label for the source (for logging)
 * @returns Object with sanitized content and list of detected pattern labels
 */
export function sanitizeUntrustedContent(content: string, source: string): SanitizeResult {
  if (!content || typeof content !== "string") {
    return { sanitized: content ?? "", detections: [] };
  }

  let result = content;
  const detections: string[] = [];

  // 1. Defang boundary markers (prevent escaping content wrappers)
  for (const marker of BOUNDARY_MARKERS) {
    marker.lastIndex = 0;
    if (marker.test(result)) {
      marker.lastIndex = 0;
      result = result.replace(marker, (match) => `\`${match}\``);
      detections.push("boundary-marker");
    }
  }

  // 2. Defang injection patterns (wrap in backticks to neutralize)
  for (const { regex, label } of INJECTION_PATTERNS) {
    regex.lastIndex = 0;
    if (regex.test(result)) {
      regex.lastIndex = 0;
      result = result.replace(regex, (match) => `\`${match}\``);
      detections.push(label);
    }
  }

  if (detections.length > 0) {
    logWarn(
      "inbound-sanitizer: sanitized untrusted content from " +
        source +
        ": " +
        detections.join(", "),
    );
  }

  return { sanitized: result, detections };
}
