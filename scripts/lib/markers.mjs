// scripts/lib/markers.mjs
/** The last `STATUS:` line of a final message — a HINT for the judge, never the gate (§4.4). */
export function statusHint(text) {
  const all = [...String(text ?? "").matchAll(/STATUS:[^\n]*/g)];
  return all.length ? all[all.length - 1][0].trim() : null;
}
export function hasPromise(text) { return /<promise>[^<]*<\/promise>/.test(String(text ?? "")); }
/** Both markers: enough to override a session the registry still calls busy (v2 `signedOff`). */
export function signedOff(text) { return statusHint(text) !== null && hasPromise(text); }
/** A "waiting" session that wrote its STATUS line and has no pending question is done (v2 `waitingIsDone`). */
export function waitingIsDone(h) {
  if (!h || h.question) return false;
  return statusHint(h.lastText) !== null;
}
export function formatQuestion(input) {
  const qs = Array.isArray(input?.questions) ? input.questions : [];
  return qs.map((q) => {
    const opts = (q.options ?? []).map((o) => o.label).filter(Boolean).join(" / ");
    const parts = [q.header, opts].filter(Boolean).join(": ");
    return `  "${q.question}"${parts ? `  ${parts}` : ""}`;
  });
}
export function formatFinal(text, cap) {
  if (!text) return "(no final message)";
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n… truncated at ${cap} of ${text.length} chars; the full text is in the log.`;
}
export function fmtDuration(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(mins / 60);
  if (!h) return `${mins}m`;
  return mins % 60 ? `${h}h ${mins % 60}m` : `${h}h`;
}
export function fmtCost(c) { return c == null ? "$?" : `$${c.toFixed(2)}`; }
