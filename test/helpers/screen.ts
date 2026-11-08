export interface Cell {
  ch: string;
  inverse: boolean;
  bold: boolean;
  dim: boolean;
}

const blank = (): Cell => ({ ch: " ", inverse: false, bold: false, dim: false });

/**
 * A tiny virtual terminal: enough of the escape sequences the panes emit to see what a user
 * would see. Handles cursor addressing (`H`, `row;colH`), clear (`2J`), and SGR 0/1/2/7.
 * Mode switches (`?1049h`, mouse reporting, cursor visibility) are accepted and ignored.
 * Text past the right edge is clipped, never wrapped, so an overflowing row shows up as a failure.
 */
export class Screen {
  readonly cells: Cell[][];
  private row = 0;
  private col = 0;
  private style = { inverse: false, bold: false, dim: false };

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.cells = Array.from({ length: height }, () => Array.from({ length: width }, blank));
  }

  write(data: string): this {
    const chars = [...data];
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i]!;
      if (ch === "\x1b" && chars[i + 1] === "[") {
        let j = i + 2;
        let params = "";
        while (j < chars.length && /[0-9;?<]/.test(chars[j]!)) params += chars[j++];
        this.csi(params, chars[j] ?? "");
        i = j;
      } else if (ch === "\n") {
        this.row++;
        this.col = 0;
      } else if (ch === "\r") {
        this.col = 0;
      } else {
        this.put(ch);
      }
    }
    return this;
  }

  private put(ch: string) {
    const cell = this.cells[this.row]?.[this.col];
    if (cell) Object.assign(cell, { ch, ...this.style });
    this.col++;
  }

  private csi(params: string, final: string) {
    if (params.startsWith("?")) return; // private modes
    const nums = params.split(";").map((n) => (n === "" ? 0 : Number(n)));
    switch (final) {
      case "H":
        this.row = Math.max(0, (nums[0] || 1) - 1);
        this.col = Math.max(0, (nums[1] || 1) - 1);
        break;
      case "J":
        if (nums[0] === 2) for (const row of this.cells) row.forEach((_, x) => (row[x] = blank()));
        break;
      case "m":
        for (const n of nums) {
          if (n === 0) this.style = { inverse: false, bold: false, dim: false };
          else if (n === 1) this.style.bold = true;
          else if (n === 2) this.style.dim = true;
          else if (n === 7) this.style.inverse = true;
        }
        break;
    }
  }

  /** Row `y` as text, trailing blanks trimmed. */
  line(y: number): string {
    return this.cells[y]!.map((c) => c.ch).join("").trimEnd();
  }

  /** Every row as text, trailing blank rows dropped. */
  lines(): string[] {
    const out = Array.from({ length: this.height }, (_, y) => this.line(y));
    while (out.length && out.at(-1) === "") out.pop();
    return out;
  }

  /** The text of row `y` that is drawn inverse, trimmed. */
  inverseText(y: number): string {
    return this.cells[y]!.filter((c) => c.inverse).map((c) => c.ch).join("").trim();
  }

  /** Rows that contain any inverse cell. */
  inverseRows(): number[] {
    return this.cells.flatMap((row, y) => (row.some((c) => c.inverse) ? [y] : []));
  }
}
