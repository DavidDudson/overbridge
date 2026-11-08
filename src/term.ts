/** Terminal helpers shared by the interactive panes: sizing, styling, drawing and input decoding. */

const ESC = "\x1b";

export const ENTER_SCREEN = `${ESC}[?1049h${ESC}[?25l${ESC}[?1000h${ESC}[?1006h`;
export const LEAVE_SCREEN = `${ESC}[?1000l${ESC}[?1006l${ESC}[?25h${ESC}[?1049l`;

export const inverse = (s: string) => `${ESC}[7m${s}${ESC}[0m`;
export const dim = (s: string) => `${ESC}[2m${s}${ESC}[0m`;
export const bold = (s: string) => `${ESC}[1m${s}${ESC}[0m`;

/** `text` cut or padded to exactly `width` columns; a cut ends in an ellipsis. */
export function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const chars = [...text];
  if (chars.length <= width) return text + " ".repeat(width - chars.length);
  return `${chars.slice(0, width - 1).join("")}…`;
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
