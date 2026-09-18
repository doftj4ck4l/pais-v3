import type { ChatMessage } from "../../types/chat";

const SERVICE = String.raw`(?:nextcloud|nas|network[- ]attached storage)`;
const SERVICE_RE = new RegExp(String.raw`\b${SERVICE}\b`, "i");
const NEXTCLOUD_REFERENCE_RE =
  /nextcloud|(?:^|[^a-z0-9])nas(?:$|[^a-z0-9])|network[- ]attached storage|webdav|(?:^|[^a-z0-9])nc_[a-z0-9_]+/i;
const ACTION = String.raw`(?:use|search|find|look|check|browse|list|read|open|upload|download|save|write|create|delete|remove|share|move|copy|rename|fetch|get|access|inspect|show|connect|sync|guna|cari|semak|lihat|baca|senarai|buka|simpan|kongsi|padam|akses|muat\s+naik|muat\s+turun)`;

/** The newest user message is the only one authorising access for this turn. */
export function currentUserRequest(history: ChatMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message?.role === "user") return String(message.content ?? "");
  }
  return "";
}

/**
 * Nextcloud is opt-in per turn.
 *
 * A bare mention is not enough: users discuss and prohibit services too. The
 * request must connect Nextcloud/NAS to an access action or name it as the
 * location of the files being requested. This deliberately prefers a false
 * negative (the model can ask the user to name the service) over silently
 * searching remote storage that was not requested.
 */
export function explicitlyRequestsNextcloud(request: string): boolean {
  const text = String(request ?? "").trim();
  if (!SERVICE_RE.test(text)) return false;

  const negative = new RegExp(
    String.raw`\b(?:do\s+not|don['’]?t|never|avoid|without|stop|instead\s+of|rather\s+than|jangan|jgn|elak|tanpa|tak\s+mahu)\b.{0,80}\b${SERVICE}\b|\b${SERVICE}\b.{0,50}\b(?:do\s+not|don['’]?t|never|avoid|off[- ]limits?|jangan|jgn|elak|tak\s+mahu)\b`,
    "i",
  );
  const retrospective = new RegExp(
    String.raw`(?:\bwhy\s+(?:did|do|does|is|are|was|were|can|could|would|will|have|has)\b|\bkenapa\b).{0,100}\b${SERVICE}\b`,
    "i",
  );
  const informational = new RegExp(
    String.raw`\b(?:how\s+to|how\s+(?:do|can|should|would)|explain|what\s+is|tell\s+me\s+about|cara|apa\s+itu)\b.{0,100}\b${SERVICE}\b`,
    "i",
  );
  if (negative.test(text) || retrospective.test(text) || informational.test(text)) return false;

  const actionNearService = new RegExp(
    String.raw`\b${ACTION}\b.{0,100}\b${SERVICE}\b|\b${SERVICE}\b.{0,100}\b${ACTION}\b`,
    "i",
  );
  const serviceAsLocation = new RegExp(
    String.raw`\b(?:in|on|from|to|into|through|via|inside|di|dalam|daripada|ke)\s+(?:(?:my|the|our)\s+)?${SERVICE}\b`,
    "i",
  );
  const serviceContent = new RegExp(
    String.raw`\b${SERVICE}\b.{0,50}\b(?:files?|folders?|documents?|photos?|records?|contents?|storage)\b`,
    "i",
  );

  return actionNearService.test(text) || serviceAsLocation.test(text) || serviceContent.test(text);
}

/** Hide learned routes that could reintroduce Nextcloud on an unrelated turn. */
export function referencesNextcloud(text: string): boolean {
  return NEXTCLOUD_REFERENCE_RE.test(String(text ?? ""));
}
