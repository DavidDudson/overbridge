import type { AgentKind } from "./agent-kind";
import type { ItemFacts } from "./pm/provider";

/** One root `agent-rules` entry: each list that is set must match one of its values, ignoring case; an empty list matches every item. */
export interface AgentRule {
  agent: AgentKind;
  /** The item's priority name, such as Jira's `Low`. GitHub issues have none, so a rule that sets this never matches one. */
  priority: readonly string[];
  /** At least one of the item's labels. */
  labels: readonly string[];
  /** The id of any item above it (its epic, the epic's initiative), such as `ENG-100` or `owner/repo#42`. */
  parent: readonly string[];
}

/** The keys a rule can match on; a rule needs at least one. */
export const RULE_CRITERIA = ["priority", "labels", "parent"] as const;

const comparable = (s: string) => s.trim().toLowerCase();

const anyOf = (wanted: readonly string[], have: readonly string[]) => {
  const haveSet = new Set(have.map(comparable));

  return wanted.length === 0 || wanted.some((w) => haveSet.has(comparable(w)));
};

/** Whether every criterion `rule` sets matches `facts`. */
export const ruleMatches = (rule: AgentRule, facts: ItemFacts): boolean =>
  anyOf(rule.priority, facts.priority ? [facts.priority] : []) && anyOf(rule.labels, facts.labels) && anyOf(rule.parent, facts.ancestors);

/** The index of the first rule that matches `facts`, or -1. */
export const matchingRule = (rules: readonly AgentRule[], facts: ItemFacts): number => rules.findIndex((r) => ruleMatches(r, facts));
