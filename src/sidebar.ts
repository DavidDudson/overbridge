import { requireWs } from "./commands";
import { readState } from "./state";
import { naturalSort } from "./util";

/**
 * Placeholder for the vertical tab sidebar: lists the workspaces and marks this one, then idles
 * so the pane stays open. The interactive sidebar replaces it.
 */
export async function sidebar(wsOpt?: string) {
  const self = requireWs(wsOpt);
  for (const name of Object.keys(readState().workspaces).sort(naturalSort)) console.log(`${name === self ? "▶" : " "} ${name}`);
  await new Promise(() => {});
}
