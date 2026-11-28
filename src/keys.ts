/**
 * The one key table every list pane shares. A key means the same action in every pane; a pane declares which
 * actions it supports (its keyset) and `resolve` hands back only those, so a key a pane lacks falls through to
 * pane-specific handling. The legend a pane prints is built from the same keyset, so legend and bindings agree.
 *
 * Pure: no I/O, no terminal. Keys are the names `decodeInput` in `term.ts` produces.
 */

export const Action = {
  Down: "down",
  Up: "up",
  Top: "top",
  Bottom: "bottom",
  Enter: "enter",
  In: "in",
  Back: "back",
  Filter: "filter",
  Sort: "sort",
  View: "view",
  Source: "source",
  New: "new",
  Open: "open",
  Silence: "silence",
  Delete: "delete",
  Freeze: "freeze",
  Refresh: "refresh",
  Expand: "expand",
  Quit: "quit",
} as const;

export type Action = (typeof Action)[keyof typeof Action];

/** Every key bound to an action. The first key of an action is the one the legend shows. */
const KEYS: ReadonlyArray<readonly [Action, readonly string[]]> = [
  [Action.Down, ["j", "down"]],
  [Action.Up, ["k", "up"]],
  [Action.Top, ["g"]],
  [Action.Bottom, ["G"]],
  [Action.Enter, ["enter"]],
  [Action.In, ["l", "right"]],
  [Action.Back, ["escape", "h", "left"]],
  [Action.Filter, ["/"]],
  [Action.Sort, ["s"]],
  [Action.View, ["v"]],
  [Action.Source, ["f"]],
  [Action.New, ["n"]],
  [Action.Open, ["o"]],
  [Action.Silence, ["x"]],
  [Action.Delete, ["d"]],
  [Action.Freeze, ["z"]],
  [Action.Refresh, ["r"]],
  [Action.Expand, [" "]],
  [Action.Quit, ["q", "ctrl-c"]],
];

const BY_KEY = new Map<string, Action>(KEYS.flatMap(([action, keys]) => keys.map((k) => [k, action] as const)));

/** The action a key means everywhere, or undefined. */
export const actionOf = (key: string): Action | undefined => BY_KEY.get(key);

/** `key`'s action when the pane supports it. */
export function resolve(keyset: readonly Action[], key: string): Action | undefined {
  const action = BY_KEY.get(key);

  return action !== undefined && keyset.includes(action) ? action : undefined;
}

/** The key the legend shows for `action`. */
export const keyOf = (action: Action): string => KEYS.find(([a]) => a === action)![1][0]!;

const KEY_LABEL = new Map([
  ["enter", "⏎"],
  [" ", "␣"],
  ["escape", "esc"],
]);

const keyLabel = (action: Action): string => {
  const key = keyOf(action);

  return KEY_LABEL.get(key) ?? key;
};

/** What each action is called in a legend. `Down`/`Up` print together as `j/k move`; `Top`/`Bottom` as `g/G ends`. */
const WORD: Partial<Record<Action, string>> = {
  [Action.Enter]: "go",
  [Action.In]: "open",
  [Action.Back]: "back",
  [Action.Filter]: "filter",
  [Action.Sort]: "sort",
  [Action.View]: "view",
  [Action.Source]: "from",
  [Action.New]: "new",
  [Action.Open]: "open in browser",
  [Action.Silence]: "silence",
  [Action.Delete]: "kill",
  [Action.Freeze]: "freeze",
  [Action.Refresh]: "refresh",
  [Action.Expand]: "more",
  [Action.Quit]: "quit",
};

/**
 * The legend for a keyset: `j/k move   g/G ends   o open in browser …`. `words` renames an action for one pane
 * (`{ [Action.Delete]: "thaw" }`); an action named there with `""` stays out.
 */
export function legendOf(keyset: readonly Action[], words: Partial<Record<Action, string>> = {}): string {
  const has = (a: Action) => keyset.includes(a);
  const parts: string[] = [];

  if (has(Action.Down) && has(Action.Up)) parts.push(`${keyLabel(Action.Down)}/${keyLabel(Action.Up)} ${words[Action.Down] ?? "move"}`);

  if (has(Action.Top) && has(Action.Bottom)) parts.push(`${keyLabel(Action.Top)}/${keyLabel(Action.Bottom)} ${words[Action.Top] ?? "ends"}`);

  for (const action of keyset) {
    if (action === Action.Down || action === Action.Up || action === Action.Top || action === Action.Bottom) continue;
    const word = words[action] ?? WORD[action];

    if (word) parts.push(`${keyLabel(action)} ${word}`);
  }

  return parts.join("   ");
}

/** The row `selected` moves to for a movement action; unchanged for any other. `length` is the list's length. */
export function moveSelection(action: Action | undefined, selected: number, length: number): number {
  const last = Math.max(0, length - 1);

  if (action === Action.Down) return Math.min(last, selected + 1);

  if (action === Action.Up) return Math.max(0, selected - 1);

  if (action === Action.Top) return 0;

  if (action === Action.Bottom) return last;

  return selected;
}

/** Every binding, for the tests: no key may mean two actions. */
export const allBindings = (): ReadonlyArray<readonly [Action, readonly string[]]> => KEYS;

const A = Action;

/**
 * What each pane supports, in legend order. Keys the table has no action for (perf's `b` group-by and `w` window,
 * checks' `K/J` ticket move) stay in their pane and are appended to its legend there.
 */
export const Keyset = {
  prs: [A.Down, A.Up, A.Top, A.Bottom, A.Enter, A.Open, A.Silence, A.Refresh, A.Quit],
  reviews: [A.Down, A.Up, A.Top, A.Bottom, A.Enter, A.Open, A.Sort, A.Silence, A.Refresh, A.Quit],
  worklist: [A.Down, A.Up, A.Top, A.Bottom, A.Enter, A.In, A.New, A.Open, A.Filter, A.Silence, A.Refresh, A.Quit],
  worklistDetail: [A.New, A.Open, A.Back, A.Quit],
  checksQueue: [A.Down, A.Up, A.Top, A.Bottom, A.Delete, A.View, A.Refresh, A.Quit],
  checksRecent: [A.Down, A.Up, A.Top, A.Bottom, A.View, A.Refresh, A.Quit],
  perfDashboard: [A.Down, A.Up, A.Top, A.Bottom, A.View, A.Refresh, A.Quit],
  perfSessions: [A.Down, A.Up, A.Top, A.Bottom, A.View, A.Refresh, A.Quit],
  perfCommands: [A.Down, A.Up, A.Top, A.Bottom, A.View, A.Source, A.Sort, A.Refresh, A.Quit],
  frozen: [A.Down, A.Up, A.Top, A.Bottom, A.Freeze, A.Refresh, A.Quit],
  explore: [A.Down, A.Up, A.Top, A.Bottom, A.Enter, A.Quit],
} as const satisfies Record<string, readonly Action[]>;
