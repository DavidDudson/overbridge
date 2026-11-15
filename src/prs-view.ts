import { age, CHROME, type PrRow, type ViewState } from "./pr-rows";
import { bold, boxBottom, boxRow, boxTop, colorize, dim, fit, inverse } from "./term";

/** How one PR list draws itself. `order` is the rows in cursor order, which is how the pane indexes them. */
export interface PrView {
  order(rows: readonly PrRow[]): readonly PrRow[];
  render(rows: readonly PrRow[], ui: ViewState): string[];
  /** Whether anything on screen moves, so the pane redraws on a short tick. */
  animated(rows: readonly PrRow[]): boolean;
}

const EMPTY = "no open PRs of yours";

/** The My PRs panel as screen rows. Pure, so it is snapshot-tested. */
function render(rows: readonly PrRow[], { selected, offset, height, width, message, now }: ViewState): string[] {
  const inner = width - 4;
  const body = Math.max(1, height - CHROME);
  const out: string[] = [boxTop("My PRs", width), boxRow(dim(fit(`${"repo".padEnd(24)} ${"#".padEnd(5)} ${"state".padEnd(12)} ${"age".padEnd(4)} title`, inner)))];
  const visible = rows.slice(offset, offset + body);

  for (const [i, r] of visible.entries()) {
    const col = r.draft ? "draft" : "open";
    const line = `${r.repo.slice(0, 24).padEnd(24)} ${String(r.number).padEnd(5)} ${col.slice(0, 12).padEnd(12)} ${age(r.updatedAt, now).padEnd(4)} ${r.title}`;
    const text = fit(line, inner);
    out.push(boxRow(offset + i === selected ? inverse(text) : r.draft ? dim(text) : text));
  }

  for (let i = visible.length; i < body; i++) out.push(boxRow(rows.length === 0 && i === 0 ? dim(fit(EMPTY, inner)) : fit("", inner)));
  out.push(boxRow(message.startsWith("error: ") ? colorize(fit(message, inner), "red") : message ? bold(fit(message, inner)) : dim(fit("j/k move   o open in browser   r refresh   q quit", inner))));
  out.push(boxBottom(width, `${rows.length} open`));

  return out;
}

export const prsView: PrView = { order: (rows) => rows, render, animated: () => false };
