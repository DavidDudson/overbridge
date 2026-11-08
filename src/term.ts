/** Terminal helpers shared by the interactive panes: sizing, styling, drawing and input decoding. */

const ESC = "\x1b";

export const ENTER_SCREEN = `${ESC}[?1049h${ESC}[?25l${ESC}[?1000h${ESC}[?1006h`;
export const LEAVE_SCREEN = `${ESC}[?1000l${ESC}[?1006l${ESC}[?25h${ESC}[?1049l`;

export const inverse = (s: string) => `${ESC}[7m${s}${ESC}[0m`;
export const dim = (s: string) => `${ESC}[2m${s}${ESC}[0m`;
export const bold = (s: string) => `${ESC}[1m${s}${ESC}[0m`;

export const COLORS = { red: 31, green: 32, yellow: 33, blue: 34, purple: 35, cyan: 36, grey: 90 } as const;
export type Color = keyof typeof COLORS;
export const colorize = (s: string, color: Color) => `${ESC}[${COLORS[color]}m${s}${ESC}[0m`;

/** Emoji below U+1F000 that terminals draw two columns wide. Every other emoji the panes use is astral. */
const WIDE_BMP = new Set([0x23f3, 0x2705, 0x2753, 0x274c, 0x26aa, 0x26ab]);

/** Columns one code point takes: 2 for emoji, 0 for variation selectors and joiners, else 1. */
const cpWidth = (cp: number) => (cp === 0xfe0f || cp === 0x200d ? 0 : cp >= 0x1f000 || WIDE_BMP.has(cp) ? 2 : 1);

/** Terminal columns `text` takes (no escape sequences). */
export const textWidth = (text: string): number => [...text].reduce((n, ch) => n + cpWidth(ch.codePointAt(0)!), 0);

/** `text` cut or padded to exactly `width` columns; a cut ends in an ellipsis. */
export function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const full = textWidth(text);
  if (full <= width) return text + " ".repeat(width - full);
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = cpWidth(ch.codePointAt(0)!);
    if (used + w > width - 1) break;
    out += ch;
    used += w;
  }
  return `${out}…${" ".repeat(width - 1 - used)}`;
}

/**
 * Draw `rows` (already styled, each fitted to `width`) top-down in a `height`-row screen.
 * Rows past the end are blanked, so a shrinking list leaves nothing behind.
 */
export function frame(rows: string[], height: number, width: number): string {
  let out = "";
  for (let y = 0; y < height; y++) out += `${ESC}[${y + 1};1H${rows[y] ?? " ".repeat(width)}`;
  return out;
}

export type Input =
  | { kind: "key"; key: string }
  /** Left-button press at a 0-based cell. */
  | { kind: "click"; col: number; row: number };

const NAMED: Record<string, string> = {
  [`${ESC}[A`]: "up",
  [`${ESC}[B`]: "down",
  [`${ESC}[C`]: "right",
  [`${ESC}[D`]: "left",
  [`${ESC}[Z`]: "shift-tab",
  [`${ESC}OA`]: "up",
  [`${ESC}OB`]: "down",
  "\r": "enter",
  "\n": "enter",
  "\t": "tab",
  "\x03": "ctrl-c",
  [ESC]: "escape",
};

const MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
const CSI = /^\x1b\[[0-9;?]*[ -/]*[@-~]/;

/**
 * Decode a chunk read from a raw terminal with SGR mouse reporting on. Wheel turns and
 * mouse movement are dropped; unknown escape sequences are skipped whole.
 */
export function decodeInput(data: string): Input[] {
  const out: Input[] = [];
  let rest = data;
  while (rest) {
    const mouse = MOUSE.exec(rest);
    if (mouse) {
      const button = Number(mouse[1]);
      // plain left press: no wheel (64), motion (32) or other-button bits
      if (mouse[4] === "M" && (button & ~(4 | 8 | 16)) === 0) out.push({ kind: "click", col: Number(mouse[2]) - 1, row: Number(mouse[3]) - 1 });
      rest = rest.slice(mouse[0].length);
      continue;
    }
    const named = Object.keys(NAMED).find((seq) => seq.length > 1 && rest.startsWith(seq));
    if (named) {
      out.push({ kind: "key", key: NAMED[named]! });
      rest = rest.slice(named.length);
      continue;
    }
    if (rest.startsWith(ESC) && rest.length > 1) {
      rest = rest.slice(CSI.exec(rest)?.[0].length ?? 1);
      continue;
    }
    const ch = String.fromCodePoint(rest.codePointAt(0)!);
    out.push({ kind: "key", key: NAMED[ch] ?? ch });
    rest = rest.slice(ch.length);
  }
  return out;
}

/** Box-drawing for a rounded, dim frame around a pane. `width` is the full pane width. */
const edge = (s: string) => colorize(s, "grey");
export const boxTop = (title: string, width: number) => {
  const label = title ? ` ${title} ` : "";
  return edge(`╭─${label}${"─".repeat(Math.max(0, width - 3 - textWidth(label)))}╮`);
};
export const boxDivider = (width: number) => edge(`├${"─".repeat(Math.max(0, width - 2))}┤`);
export const boxBottom = (width: number) => edge(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
/** A row of content (already styled, fitted to `width - 4`) between the side borders with one column of padding. */
export const boxRow = (content: string) => `${edge("│")} ${content} ${edge("│")}`;
