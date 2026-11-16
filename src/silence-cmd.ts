import { isSilenced, readMentions, readStore } from "./silence";
import { listedRows, refreshMentions, toggleSilence } from "./silence-refresh";
import { errorMessage, log, OverbridgeError } from "./util";

const USAGE = "usage: overbridge silence [ls|refresh|toggle <url>]";

/** The rows silenced now, one `url<TAB>since` line each. */
function silencedLines(): string[] {
  const store = readStore();
  const { mentions } = readMentions();

  return listedRows().flatMap((r) => (isSilenced(r, store, mentions) ? [`${r.url}\t${store.get(r.url)?.at ?? "team review"}`] : []));
}

/** `overbridge silence`: list silenced items, scan for mentions, or flip one item by URL. */
export function silenceCommand(args: readonly string[]) {
  const [sub = "ls", url, ...extra] = args;

  if (extra.length) throw new OverbridgeError(USAGE);

  if (sub === "ls" && url === undefined) {
    const lines = silencedLines();
    console.log(lines.length ? lines.join("\n") : "nothing silenced");
  } else if (sub === "refresh" && url === undefined) {
    const cache = refreshMentions();
    log(`silence: ${cache.mentions.size} mentioned item(s)${cache.error ? `; ${cache.error}` : ""}`);
  } else if (sub === "toggle" && url !== undefined) {
    const row = listedRows().find((r) => r.url === url) ?? { url };
    let state: string;

    try {
      state = toggleSilence(row);
    } catch (e) {
      throw new OverbridgeError(`could not save the silence for ${url}: ${errorMessage(e)}`);
    }

    log(`${state} ${url}`);
  } else throw new OverbridgeError(USAGE);
}
