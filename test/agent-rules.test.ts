import { describe, expect, test } from "bun:test";
import { AgentKind } from "../src/agent-kind";
import { type AgentRule, type ItemFacts, matchingRule, ruleMatches } from "../src/agent-rules";
import { parseYaml, rootLayersFrom } from "../src/project-config";

const rule = (over: Partial<AgentRule> = {}): AgentRule => ({ agent: AgentKind.Agy, priority: [], labels: [], parent: [], ...over });
const facts = (over: Partial<ItemFacts> = {}): ItemFacts => ({ priority: "Medium", labels: [], ancestors: [], ...over });

describe("ruleMatches", () => {
  test("every criterion a rule sets must match, any value within one, ignoring case", () => {
    const debt = rule({ priority: ["Low", "Lowest"], labels: ["tech-debt"] });

    expect(ruleMatches(debt, facts({ priority: "lowest", labels: ["infra", "Tech-Debt"] }))).toBe(true);
    expect(ruleMatches(debt, facts({ priority: "High", labels: ["tech-debt"] }))).toBe(false);
    expect(ruleMatches(debt, facts({ priority: "Low", labels: ["infra"] }))).toBe(false);
  });

  test("a priority rule never matches an item with no priority", () => {
    expect(ruleMatches(rule({ priority: ["Low"] }), facts({ priority: "" }))).toBe(false);
  });

  test("a parent matches any item above, with or without a leading #", () => {
    expect(ruleMatches(rule({ parent: ["eng-100"] }), facts({ ancestors: ["ENG-200", "ENG-100"] }))).toBe(true);
    expect(ruleMatches(rule({ parent: ["#42"] }), facts({ ancestors: ["42"] }))).toBe(true);
    expect(ruleMatches(rule({ parent: ["42"] }), facts({ ancestors: ["acme/other#42"] }))).toBe(false);
  });
});

describe("matchingRule", () => {
  test("the first matching rule wins, and -1 means none", () => {
    const rules = [rule({ labels: ["spike"], agent: AgentKind.Claude }), rule({ labels: ["tech-debt"] }), rule({ labels: ["tech-debt"], agent: AgentKind.Claude })];

    expect(matchingRule(rules, facts({ labels: ["tech-debt"] }))).toBe(1);
    expect(matchingRule(rules, facts({ labels: ["feature"] }))).toBe(-1);
  });
});

describe("agent-rules in config.yml", () => {
  const load = (yaml: string) => rootLayersFrom(parseYaml(yaml, "config.yml"), "config.yml");

  test("parses each rule, leaving unset criteria empty", () => {
    expect(load("agent-rules:\n  - { agent: agy, priority: [Low], labels: [tech-debt] }\n  - { agent: claude, parent: [ENG-1] }\n").agentRules).toEqual([
      rule({ priority: ["Low"], labels: ["tech-debt"] }),
      rule({ agent: AgentKind.Claude, parent: ["ENG-1"] }),
    ]);
    expect(load("agent: agy\n").agentRules).toEqual([]);
  });

  test.each([
    ["agent-rules: agy\n", "agent-rules: expected a list of { agent, priority, labels, parent }"],
    ["agent-rules:\n  - agy\n", "agent-rules[0]: expected a mapping with agent and at least one of priority, labels, parent"],
    ["agent-rules:\n  - { labels: [x] }\n", "agent-rules[0].agent: required"],
    ["agent-rules:\n  - { agent: codex, labels: [x] }\n", 'agent-rules[0].agent: expected one of claude, agy (got "codex")'],
    ["agent-rules:\n  - { agent: agy }\n", "agent-rules[0]: set at least one of priority, labels, parent"],
    ["agent-rules:\n  - { agent: agy, label: [x] }\n", "agent-rules[0].label: unknown key, did you mean 'labels'?"],
    ["agent-rules:\n  - { agent: agy, labels: tech-debt }\n", "agent-rules[0].labels: expected a list of strings"],
  ])("rejects %j", (yaml, message) => {
    expect(() => load(yaml)).toThrow(message);
  });
});
