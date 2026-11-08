import { describe, expect, test } from "bun:test";
import { reviewerLabel, reviewerStatuses, shortDuration } from "../src/reviewers";

const PR = "https://host/o/r/pull/3";
const limitBody = "<!-- rate limited by coderabbit.ai -->\n> ## Review limit reached\n> **Next included review available in 56 minutes.**\n";
const rabbitCheck = (conclusion: string, status = "COMPLETED") => ({ name: "CodeRabbit", status, conclusion, detailsUrl: "https://coderabbit.ai/x" });
const by = (name: "Copilot" | "CodeRabbit", view: Parameters<typeof reviewerStatuses>[0]) => reviewerStatuses(view, PR).find((r) => r.name === name);

describe("Copilot", () => {
  test("no review and no request is none, which also covers an account out of quota", () => {
    expect(by("Copilot", {})).toEqual({ name: "Copilot", state: "none", url: PR });
  });

  test("a pending request is reviewing; a landed review is reviewed or changes", () => {
    expect(by("Copilot", { reviewRequests: [{ login: "copilot-pull-request-reviewer" }] })?.state).toBe("reviewing");
    expect(by("Copilot", { latestReviews: [{ author: { login: "copilot-pull-request-reviewer" }, state: "COMMENTED", url: "u" }] })).toMatchObject({ state: "reviewed", url: "u" });
    expect(by("Copilot", { latestReviews: [{ author: { login: "Copilot" }, state: "CHANGES_REQUESTED" }] })?.state).toBe("changes");
  });

  test("a human's review is not Copilot's", () => {
    expect(by("Copilot", { latestReviews: [{ author: { login: "alice" }, state: "APPROVED" }] })?.state).toBe("none");
  });
});

describe("CodeRabbit", () => {
  test("left out when the repo never used it", () => {
    expect(by("CodeRabbit", {})).toBeUndefined();
  });

  test("a rate-limit comment is limited, with how long until it is back", () => {
    const s = by("CodeRabbit", { statusCheckRollup: [rabbitCheck("NEUTRAL")], comments: [{ author: { login: "coderabbitai" }, body: limitBody, createdAt: "2026-01-01T10:00:00Z", url: "c" }] });
    expect(s).toEqual({ name: "CodeRabbit", state: "limited", detail: "56m", url: "c" });
    expect(reviewerLabel(s!)).toBe("🚫 CodeRabbit 56m");
  });

  test("a review newer than the rate-limit comment wins; an older one does not", () => {
    const comments = [{ author: { login: "coderabbitai" }, body: limitBody, createdAt: "2026-01-01T10:00:00Z" }];
    expect(by("CodeRabbit", { comments, latestReviews: [{ author: { login: "coderabbitai" }, state: "COMMENTED", submittedAt: "2026-01-01T11:00:00Z" }] })?.state).toBe("reviewed");
    expect(by("CodeRabbit", { comments, latestReviews: [{ author: { login: "coderabbitai" }, state: "COMMENTED", submittedAt: "2026-01-01T09:00:00Z" }] })?.state).toBe("limited");
  });

  test("with no review or limit comment the check decides: skipped, running, done, failed", () => {
    const state = (c: ReturnType<typeof rabbitCheck>) => by("CodeRabbit", { statusCheckRollup: [c] })?.state;
    expect(state(rabbitCheck("NEUTRAL"))).toBe("skipped");
    expect(state(rabbitCheck("SKIPPED"))).toBe("skipped");
    expect(state(rabbitCheck("", "IN_PROGRESS"))).toBe("reviewing");
    expect(state(rabbitCheck("SUCCESS"))).toBe("reviewed");
    expect(state(rabbitCheck("FAILURE"))).toBe("failed");
  });
});

test("durations are shortened", () => {
  expect(shortDuration("56 minutes")).toBe("56m");
  expect(shortDuration("1 hour and 5 minutes")).toBe("1h 5m");
  expect(shortDuration("2 days")).toBe("2d");
});
