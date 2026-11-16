import type { ReviewerStatus } from "./reviewers";
import type { CiState } from "./pr-look";
import type { SortMode } from "./sort-mode";

/** Rows the frame uses besides the PR rows: top border, header, legend, bottom border. */
export const CHROME = 4;

export interface PrRow {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  draft: boolean;
  updatedAt: string;
  /** GitHub's `mergeable`: `CONFLICTING` is a merge conflict. */
  mergeable?: string;
  ci?: CiState;
  /** GitHub's `reviewDecision`. */
  decision?: string;
  /** Copilot and CodeRabbit, from `reviewerStatuses`. */
  bots?: ReviewerStatus[];
  /** Reviews tab: whether the review was asked of me directly or of a team of mine. */
  group?: "direct" | "team";
  /** Reviews tab: the team (`org/slug`) the request named, for a team row. */
  via?: string;
  /** ISO time the row first appeared in its list: when a team review's silence starts. */
  seenAt?: string;
}

/** Age as `5m`, `3h`, `2d`; empty for an unreadable date. */
export function age(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);

  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60_000);

  if (m < 60) return `${m}m`;

  if (m < 60 * 24) return `${Math.floor(m / 60)}h`;

  return `${Math.floor(m / 60 / 24)}d`;
}

/** What a view needs to draw: the cursor, the scroll and the size of the pane, a footer message and the clock. */
export interface ViewState {
  selected: number;
  offset: number;
  height: number;
  width: number;
  message: string;
  now: number;
  /** How the rows are ordered, for a view to name in its legend. */
  sort?: SortMode;
  /** URLs of the rows silenced now, drawn dim with a bell. */
  silenced?: ReadonlySet<string>;
}
