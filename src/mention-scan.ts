import { isJsonObject, type JsonObject, type JsonValue, objectField, parseJson, stringField } from "./json";
import type { RunResult } from "./util";

/**
 * Finds the newest comment that mentions the user on each watched issue or PR: one `gh api graphql` call per
 * `URLS_PER_QUERY` items, through `resource(url:)`, reading issue comments, review bodies and review comments.
 */

export const URLS_PER_QUERY = 20;

const TEXT = "author{login} body createdAt";

const ITEM = `...on Issue{comments(last:50){nodes{${TEXT}}}} ...on PullRequest{comments(last:50){nodes{${TEXT}}} reviews(last:30){nodes{${TEXT} comments(last:30){nodes{${TEXT}}}}}}`;

/** The query for `count` URLs, passed as `$u0`..`$u<count-1>` so no URL is spliced into the query text. */
export function mentionQuery(count: number): string {
  const vars = Array.from({ length: count }, (_, i) => `$u${i}:URI!`).join(",");
  const items = Array.from({ length: count }, (_, i) => `m${i}:resource(url:$u${i}){${ITEM}}`).join(" ");

  return `query(${vars}){${items}}`;
}

/** The `gh api graphql` command for one page of URLs. */
export const mentionCommand = (urls: readonly string[]): string[] => ["gh", "api", "graphql", "-f", `query=${mentionQuery(urls.length)}`, ...urls.flatMap((u, i) => ["-f", `u${i}=${u}`])];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `body` mentions `@login`: not inside an email, a path or a longer handle. */
export function mentions(body: string, login: string): boolean {
  return new RegExp(`(^|[^\\w/.@-])@${escapeRegExp(login)}(?![\\w-])`, "i").test(body);
}

interface Text {
  author: string;
  body: string;
  createdAt: string;
}

const nodes = (connection: JsonValue | undefined): JsonObject[] => {
  const list = isJsonObject(connection) ? connection.nodes : undefined;

  return Array.isArray(list) ? list.filter(isJsonObject) : [];
};

const textOf = (n: JsonObject): Text => ({
  author: stringField(objectField(n, "author") ?? {}, "login") ?? "",
  body: stringField(n, "body") ?? "",
  createdAt: stringField(n, "createdAt") ?? "",
});

/** Every comment-like text on one resource node: issue comments, review bodies, and review comments. */
function textsOf(item: JsonObject): Text[] {
  const reviews = nodes(item.reviews);

  return [...nodes(item.comments), ...reviews, ...reviews.flatMap((r) => nodes(r.comments))].map(textOf);
}

/** The newest time someone other than `me` mentioned `me` in `texts`, or undefined. */
export function newestMention(texts: readonly Text[], me: string): string | undefined {
  const times = texts.flatMap((t) => (t.author.toLowerCase() !== me.toLowerCase() && t.createdAt && mentions(t.body, me) ? [t.createdAt] : []));

  return times.toSorted((a, b) => Date.parse(b) - Date.parse(a))[0];
}

/**
 * The mentions in one reply, by URL. An item GitHub returned null for (deleted, or out of reach) has none; a reply with
 * no `data` fails the page.
 */
export function parseMentionReply(out: string, urls: readonly string[], me: string): Map<string, string> {
  let body: JsonValue;

  try {
    body = parseJson(out);
  } catch {
    throw new Error("GitHub reply to the mention scan was not JSON");
  }

  const data = isJsonObject(body) ? objectField(body, "data") : undefined;

  if (!data) {
    const errors = isJsonObject(body) && Array.isArray(body.errors) ? body.errors.filter(isJsonObject) : [];

    throw new Error((errors[0] && stringField(errors[0], "message")) || "GitHub reply to the mention scan had no data");
  }

  const found = new Map<string, string>();

  for (const [i, url] of urls.entries()) {
    const item = objectField(data, `m${i}`);
    const at = item ? newestMention(textsOf(item), me) : undefined;

    if (at !== undefined) found.set(url, at);
  }

  return found;
}

type Runner = (cmd: string[]) => RunResult;

const firstLine = (r: RunResult) => (r.stderr || r.stdout).trim().split("\n")[0] || `exit ${r.code}`;

/** Scan `urls` for mentions of `me`. Throws with `gh`'s message when a page fails with no data. */
export function scanMentions(urls: readonly string[], me: string, runner: Runner): Map<string, string> {
  const found = new Map<string, string>();

  for (let i = 0; i < urls.length; i += URLS_PER_QUERY) {
    const page = urls.slice(i, i + URLS_PER_QUERY);
    const r = runner(mentionCommand(page));

    // `gh api graphql` exits 1 when one alias errors (a deleted issue) yet still prints the rest, so the body decides
    try {
      for (const [url, at] of parseMentionReply(r.stdout, page, me)) found.set(url, at);
    } catch (e) {
      if (r.ok) throw e;

      throw new Error(`gh api graphql failed: ${firstLine(r)}`);
    }
  }

  return found;
}
