/** The editors `ide` names; `none` means no editor link, only the GitHub permalink. */
export const IdeName = { VsCode: "vscode", Zed: "zed", WebStorm: "webstorm", None: "none" } as const;

export type IdeName = (typeof IdeName)[keyof typeof IdeName];

export const IDES: readonly IdeName[] = Object.values(IdeName);

/** The resolved `ide` key: `ide: zed` or `ide: { name, link?, github? }`. */
export interface IdeConfig {
  name: IdeName;
  /** Editor link template for a file reference: `link`, else the ide's default; unset for `none`. */
  link?: string;
  /** Add a GitHub permalink after the editor link. Default true. */
  github: boolean;
}

/** `$OVERBRIDGE_IDE` when it names a known ide, so file links follow the same editor as the top panel's button. */
export function ideFromEnv(value: string | undefined): IdeName | undefined {
  const name = value?.trim();

  return IDES.find((ide) => ide === name);
}
