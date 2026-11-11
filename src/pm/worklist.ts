/**
 * Work list model for the project management panel (spike #108).
 * Pure: the same rows always give the same order. No clock, no randomness, no model.
 */

export type WorkStatus = "todo" | "in-progress" | "blocked" | "done";

export interface WorkRow {
  repo: string;
  id: string;
  title: string;
  url: string;
  status: WorkStatus;
  labels: string[];
  /** Keys (`repo#id`) of rows that must finish first. */
  blockedBy: string[];
  /** Key of the parent item, if any. */
  parent?: string;
  /** ISO timestamp from the provider. Compared as a string, never against now. */
  updatedAt: string;
}

export interface Ranked extends WorkRow {
  key: string;
  rank: number;
  ready: boolean;
  stream: number;
  /** Why this row sits where it does, in rule order. */
  reasons: string[];
}

export const keyOf = (r: Pick<WorkRow, "repo" | "id">): string => `${r.repo}#${r.id}`;

/** `p0`..`p3` or `priority: high|medium|low`. Lower is more urgent; no label sorts last. */
export function priorityOf(labels: string[]): number {
  let best = 9;
  for (const raw of labels) {
    const l = raw.toLowerCase();
    const p = /^p([0-3])$/.exec(l)?.[1] ?? /^priority[:/ -]*(critical|high|medium|low)$/.exec(l)?.[1];
    if (p === undefined) continue;
    const n = /^\d$/.test(p) ? Number(p) : { critical: 0, high: 1, medium: 2, low: 3 }[p as "critical"];
    if (n < best) best = n;
  }
  return best;
}

/** Map a board column or issue state to a status. Unknown columns count as todo. */
export function statusFromColumn(column: string | undefined, columns: Record<string, WorkStatus> = {}): WorkStatus {
  if (!column) return "todo";
  const key = column.trim().toLowerCase();
  if (columns[key]) return columns[key];
  if (/^(done|closed|complete|completed|released)$/.test(key)) return "done";
  if (/(progress|doing|review|started)/.test(key)) return "in-progress";
  if (/blocked/.test(key)) return "blocked";
  return "todo";
}

/** Connected components over blocker and parent edges. Numbered by smallest member key, so stable. */
export function streams(rows: WorkRow[]): Map<string, number> {
  const keys = rows.map(keyOf).sort();
  const parent = new Map(keys.map((k) => [k, k]));
  const find = (k: string): string => {
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(k, root);
    return root;
  };
  const union = (a: string, b: string) => {
    if (!parent.has(a) || !parent.has(b)) return;
    const [ra, rb] = [find(a), find(b)].sort();
    parent.set(rb!, ra!);
  };
  for (const r of rows) {
    for (const b of r.blockedBy) union(keyOf(r), b);
    if (r.parent) union(keyOf(r), r.parent);
  }
  const ids = new Map<string, number>();
  const out = new Map<string, number>();
  for (const k of keys) {
    const root = find(k);
    if (!ids.has(root)) ids.set(root, ids.size + 1);
    out.set(k, ids.get(root)!);
  }
  return out;
}

/** Open, not started, and every blocker known and done. A blocker outside the list counts as open. */
export function isReady(row: WorkRow, byKey: Map<string, WorkRow>): boolean {
  if (row.status !== "todo") return false;
  return row.blockedBy.every((b) => byKey.get(b)?.status === "done");
}

/**
 * Rules, in order; the first that differs decides:
 *  1. ready before not ready
 *  2. priority label (p0 before p3, none last)
 *  3. unblocks more open items (fan-out)
 *  4. parent already in progress
 *  5. least recently updated first
 *  6. `repo#id` ascending
 */
export function rank(rows: WorkRow[]): Ranked[] {
  const open = rows.filter((r) => r.status !== "done");
  const byKey = new Map(rows.map((r) => [keyOf(r), r]));
  const stream = streams(rows);
  const fanOut = new Map<string, number>();
  for (const r of open) for (const b of r.blockedBy) fanOut.set(b, (fanOut.get(b) ?? 0) + 1);

  const scored = open.map((r) => {
    const key = keyOf(r);
    const ready = isReady(r, byKey);
    const prio = priorityOf(r.labels);
    const unblocks = fanOut.get(key) ?? 0;
    const inProgressParent = r.parent !== undefined && byKey.get(r.parent)?.status === "in-progress";
    const reasons: string[] = [ready ? "ready" : r.status === "in-progress" ? "in progress" : "waiting on blockers"];
    if (prio < 9) reasons.push(`priority p${prio}`);
    if (unblocks > 0) reasons.push(`unblocks ${unblocks}`);
    if (inProgressParent) reasons.push("parent in progress");
    return { r, key, ready, prio, unblocks, inProgressParent, reasons };
  });

  scored.sort(
    (a, b) =>
      Number(b.ready) - Number(a.ready) ||
      a.prio - b.prio ||
      b.unblocks - a.unblocks ||
      Number(b.inProgressParent) - Number(a.inProgressParent) ||
      (a.r.updatedAt < b.r.updatedAt ? -1 : a.r.updatedAt > b.r.updatedAt ? 1 : 0) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );

  return scored.map((s, i) => ({
    ...s.r,
    key: s.key,
    rank: i + 1,
    ready: s.ready,
    stream: stream.get(s.key) ?? 0,
    reasons: s.reasons,
  }));
}
