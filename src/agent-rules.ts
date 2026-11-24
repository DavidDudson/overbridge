import type { AgentKind } from "./agent-kind";

/**
 * One `agent-rules` entry from the root `config.yml`: the agent a new workspace runs when its work item matches.
 * Each list that is set must match (any of its values, ignoring case); an empty list matches every item.
 */
export interface AgentRule {
  agent: AgentKind;
  /** The item's priority name, such as Jira's `Low`. GitHub issues have none, so a rule that sets this never matches one. */
  priority: readonly string[];
  /** At least one of the item's labels. */
  labels: readonly string[];
  /** The id of any item above it (its epic, the epic's initiative), such as `ENG-100` or `#42`. */
  parent: readonly string[];
}

/** What a provider reports about a work item for `agent-rules`. */
export interface ItemFacts {
  /** The provider's priority name; empty when the item has none. */
  priority: string;
  labels: readonly string[];
  /** The ids of the items above it, nearest first. */
  ancestors: readonly string[];
}

/** The keys a rule can match on; a rule needs at least one. */
export const RULE_CRITERIA = ["priority", "labels", "parent"] as const;

const key = (s: string) => s.trim().replace(/^#/, "").toLowerCase();

const anyOf = (wanted: readonly string[], have: readonly string[]) => {
  const haveKeys = new Set(have.map(key));

  return wanted.length === 0 || wanted.some((w) => haveKeys.has(key(w)));
};

/** Whether every criterion `rule` sets matches `facts`. */
export const ruleMatches = (rule: AgentRule, facts: ItemFacts): boolean =>
  anyOf(rule.priority, facts.priority ? [facts.priority] : []) && anyOf(rule.labels, facts.labels) && anyOf(rule.parent, facts.ancestors);

/** The index of the first rule that matches `facts`, or -1. */
export const matchingRule = (rules: readonly AgentRule[], facts: ItemFacts): number => rules.findIndex((r) => ruleMatches(r, facts));
