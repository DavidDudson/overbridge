import { alternate } from "./anim";
import { ciLook, conflictLook, HEALTH_LOOK, healthOf } from "./pr-look";
import { age, CHROME, type PrRow, type ViewState } from "./pr-rows";
import { REVIEWER_LOOK, type ReviewerStatus } from "./reviewers";
import { bold, boxBottom, boxRow, boxTop, colorize, dim, fit, inverse, textWidth } from "./term";

/** How one PR list draws itself. `order` is the rows in cursor order, which is how the pane indexes them. */
export interface PrView {
  order(rows: readonly PrRow[]): readonly PrRow[];
  render(rows: readonly PrRow[], ui: ViewState): string[];
  /** Whether anything on screen moves, so the pane redraws on a short tick. */
  animated(rows: readonly PrRow[]): boolean;
}

const EMPTY = "no open PRs of yours";
const LEGEND = "j/k move   o open in browser   r refresh   q quit";

/** `s` padded with spaces to `w` columns by display width, so emoji cells line up. */
const cell = (s: string, w: number) => s + " ".repeat(Math.max(0, w - textWidth(s)));

const isConflict = (r: PrRow) => r.mergeable === "CONFLICTING";

/** Review decision as one glyph: approved, changes requested, review still required, or nothing required. */
export function decisionIcon(decision: string | undefined): string {
  if (decision === "APPROVED") return "✅";

  if (decision === "CHANGES_REQUESTED") return "🔴";

  if (decision === "REVIEW_REQUIRED") return "🟡";

  return "·";
}

/** One bot's glyph, or `·` when the repo does not use it. */
export function botIcon(bots: readonly ReviewerStatus[] | undefined, name: ReviewerStatus["name"]): string {
  const b = bots?.find((x) => x.name === name);

  return b ? REVIEWER_LOOK[b.state].icon : "·";
}

/** The merge-state glyph; a conflict pulses between two glyphs of one width, so the row never reflows. */
function mergeIcon(r: PrRow, now: number): string {
  if (!isConflict(r)) return conflictLook(r.mergeable).icon;
  const look = HEALTH_LOOK.conflict;

  return alternate(look.icon, look.alt, now);
}

/** The My PRs panel as screen rows. Pure, so it is snapshot-tested. */
function render(rows: readonly PrRow[], { selected, offset, height, width, message, now }: ViewState): string[] {
  const inner = width - 4;
  const body = Math.max(1, height - CHROME);
  const head = `${cell("repo", 22)} ${cell("#", 5)} ${cell("mrg", 3)} ${cell("ci", 2)} ${cell("rev", 3)} ${cell("cop", 3)} ${cell("rab", 3)} ${cell("age", 4)} title`;
  const out: string[] = [boxTop("My PRs", width), boxRow(dim(fit(head, inner)))];
  const visible = rows.slice(offset, offset + body);

  for (const [i, r] of visible.entries()) {
    const line = [
      cell(r.repo.slice(0, 22), 22),
      cell(String(r.number), 5),
      cell(mergeIcon(r, now), 3),
      cell(ciLook(r.ci).icon, 2),
      cell(decisionIcon(r.decision), 3),
      cell(botIcon(r.bots, "Copilot"), 3),
      cell(botIcon(r.bots, "CodeRabbit"), 3),
      cell(age(r.updatedAt, now), 4),
      r.title,
    ].join(" ");
    const text = fit(line, inner);
    const color = HEALTH_LOOK[healthOf(r)].color;

    out.push(boxRow(offset + i === selected ? inverse(text) : r.draft ? dim(text) : color === "red" ? colorize(text, "red") : text));
  }

  for (let i = visible.length; i < body; i++) out.push(boxRow(rows.length === 0 && i === 0 ? dim(fit(EMPTY, inner)) : fit("", inner)));
  out.push(boxRow(message.startsWith("error: ") ? colorize(fit(message, inner), "red") : message ? bold(fit(message, inner)) : dim(fit(LEGEND, inner))));
  const conflicts = rows.filter(isConflict).length;

  out.push(boxBottom(width, conflicts > 0 ? `${rows.length} open · ${conflicts} conflicting` : `${rows.length} open`, conflicts > 0 ? "red" : "yellow"));

  return out;
}

export const prsView: PrView = { order: (rows) => rows, render, animated: (rows) => rows.some(isConflict) };
