import type { Ranked } from "./worklist";

/**
 * A `/` filter as terms. `label:x` matches a label, `stream:3` or `s3` the stream, `status:blocked` the status;
 * anything else is text matched against the key and title. Every term must match, case-insensitively.
 */
export function matchesFilter(item: Ranked, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((term) => {
    const [field, ...rest] = term.split(":");
    const value = rest.join(":");
    if (rest.length > 0 && value) {
      if (field === "label") return item.labels.some((l) => l.toLowerCase().includes(value));
      if (field === "stream") return String(item.stream) === value.replace(/^s/, "");
      if (field === "status") return item.status === value;
    }
    if (/^s\d+$/.test(term)) return String(item.stream) === term.slice(1);
    return item.key.toLowerCase().includes(term) || item.title.toLowerCase().includes(term);
  });
}

/** The ranked items that match, in rank order. An empty query keeps everything. */
export const filterRanked = (list: readonly Ranked[], query: string): Ranked[] => (query.trim() ? list.filter((i) => matchesFilter(i, query)) : [...list]);

/** The detail view of one item as plain lines: what it is, why it sits where it does, what blocks it, and where it lives. */
export function detailLines(item: Ranked, all: readonly Ranked[]): string[] {
  const byKey = new Map(all.map((i) => [i.key, i]));
  const blockers = item.blockedBy.map((k) => {
    const b = byKey.get(k);
    return b ? `${k} ${b.title} (${b.status})` : `${k} (not on the list, assumed open)`;
  });
  return [
    `${item.key}  ${item.title}`,
    `status: ${item.status}   rank: ${item.rank}   stream: s${item.stream}${item.ready ? "   ready" : ""}`,
    `why: ${item.reasons.join(", ")}`,
    `labels: ${item.labels.length ? item.labels.join(", ") : "none"}`,
    ...(item.parent ? [`parent: ${item.parent}`] : []),
    blockers.length ? "blocked by:" : "blocked by: nothing",
    ...blockers.map((b) => `  ${b}`),
    `link: ${item.url}`,
  ];
}
