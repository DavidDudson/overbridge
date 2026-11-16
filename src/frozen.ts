import { isIceboxed, type State } from "./state";
import { age } from "./pr-rows";
import { bold, boxBottom, boxRow, boxTop, cell, colorize, dim, fit, inverse } from "./term";
import { naturalSort } from "./util";

/** One iceboxed workspace as the @frozen tab lists it. */
export interface FrozenRow {
  ws: string;
  /** When it was iceboxed (ISO). */
  since: string;
  /** `repo:branch` per claim, with its PR number when it has one. */
  claims: string[];
  /** Whether `icebox --drop-worktree` gave back its worktrees. */
  dropped: boolean;
}

/** The iceboxed workspaces of `state`, oldest first; a malformed record is skipped. */
export function frozenRows(state: State): FrozenRow[] {
  return Object.entries(state.workspaces)
    .flatMap(([ws, w]): FrozenRow[] => {
      try {
        if (!isIceboxed(w) || !w.iceboxed) {
          return [];
        }

        // a record a hand edit broke is skipped, so one bad entry never hides the rest
        const claims = Object.entries(w.repos ?? {}).map(([repo, c]) => `${repo}:${c.branch ?? "?"}${c.pr ? ` #${c.pr}` : ""}`);

        return [{ ws, since: w.iceboxed.since, claims, dropped: (w.iceboxed.dropped?.length ?? 0) > 0 }];
      } catch {
        return [];
      }
    })
    .toSorted((a, b) => a.since.localeCompare(b.since) || naturalSort(a.ws, b.ws));
}

const EMPTY = "nothing frozen; press f in a workspace's sidebar to freeze it";
const LEGEND = "j/k move   t thaw   q quit";

/** Rows the frame takes beyond the list: top border, header, footer, bottom border. */
export const FROZEN_CHROME = 4;

export interface FrozenView {
  selected: number;
  offset: number;
  height: number;
  width: number;
  message: string;
  now: number;
}

/** The @frozen panel as screen rows. Pure, so it is snapshot-tested. */
export function renderFrozen(rows: readonly FrozenRow[], { selected, offset, height, width, message, now }: FrozenView): string[] {
  const inner = width - 4;
  const body = Math.max(1, height - FROZEN_CHROME);
  const head = `${cell("workspace", 28)} ${cell("age", 4)} claims`;
  const visible = rows.slice(offset, offset + body);

  const lines = visible.map((r, i) => {
    const text = fit(`${cell(r.ws.slice(0, 28), 28)} ${cell(age(r.since, now), 4)} ${r.claims.join("  ")}${r.dropped ? "  · dropped" : ""}`, inner);

    return boxRow(offset + i === selected ? inverse(text) : text);
  });

  const padding = Array.from({ length: body - visible.length }, (_, i) => boxRow(rows.length === 0 && i === 0 ? dim(fit(EMPTY, inner)) : fit("", inner)));

  const footer = message.startsWith("error: ") ? colorize(fit(message, inner), "red") : message ? bold(fit(message, inner)) : dim(fit(LEGEND, inner));

  return [boxTop("Frozen", width), boxRow(dim(fit(head, inner))), ...lines, ...padding, boxRow(footer), boxBottom(width, `${rows.length} frozen`, "blue")];
}
