import { describe, expect, test } from "bun:test";
import { invocations, refusalMessage, ScopeRule, scopeRefusal } from "../src/check-scope";

const CAP = 5;
const ruleOf = (argv: string[]) => scopeRefusal(argv, CAP)?.rule;
const shell = (cmd: string) => ["sh", "-c", cmd];

describe("nx run-many", () => {
  test("refuses no -p, --all, a * pattern and a -p list over the cap", () => {
    expect(ruleOf(["nx", "run-many", "-t", "lint"])).toBe(ScopeRule.RunManyAll);
    expect(ruleOf(["nx", "run-many", "-t", "lint", "--all"])).toBe(ScopeRule.RunManyAll);
    expect(ruleOf(["nx", "run-many", "-t", "lint", "-p", "*"])).toBe(ScopeRule.RunManyTooMany);
    expect(ruleOf(["nx", "run-many", "-t", "typecheck", "-p", "a,b,c,d,e,f"])).toBe(ScopeRule.RunManyTooMany);
    expect(ruleOf(["nx", "run-many", "-t", "typecheck", "-p", "a", "b", "c", "d", "e", "f", "--parallel=3"])).toBe(ScopeRule.RunManyTooMany);
    expect(ruleOf(["nx", "run-many", "-t", "typecheck", "--projects=a,b,c", "-p=d,e,f"])).toBe(ScopeRule.RunManyTooMany);
  });

  test("allows a -p list within the cap", () => {
    expect(ruleOf(["nx", "run-many", "-t", "typecheck", "-p", "a,b,c,d,e"])).toBeUndefined();
    expect(ruleOf(["nx", "run-many", "--target=lint", "--projects", "portal"])).toBeUndefined();
    expect(scopeRefusal(["nx", "run-many", "-t", "lint", "-p", "a,b,c,d,e,f"], 10)).toBeUndefined();
  });

  test("names the cap and the target", () => {
    const r = scopeRefusal(["nx", "run-many", "-t", "typecheck", "-p", "a,b,c,d,e,f"], CAP);
    expect(r?.reason).toContain("6 projects, over the cap of 5 (check-queue.max-projects)");
    expect(r?.target).toBe("typecheck");
  });
});

describe("nx affected", () => {
  test("allows a base and refuses --all", () => {
    expect(ruleOf(["nx", "affected", "-t", "test:unit", "--base=origin/main"])).toBeUndefined();
    expect(ruleOf(["nx", "affected", "-t", "lint", "--all"])).toBe(ScopeRule.AffectedAll);
  });
});

describe("test targets", () => {
  test("refuses an unscoped test target", () => {
    expect(ruleOf(["nx", "test", "portal"])).toBe(ScopeRule.UnscopedTest);
    expect(ruleOf(["nx", "run", "portal:test:unit"])).toBe(ScopeRule.UnscopedTest);
    expect(ruleOf(["nx", "run-many", "-t", "test", "-p", "a,b"])).toBe(ScopeRule.UnscopedTest);
    expect(ruleOf(["pnpm", "test"])).toBe(ScopeRule.UnscopedTest);
    expect(ruleOf(["pnpm", "run", "test:unit"])).toBe(ScopeRule.UnscopedTest);
    expect(ruleOf(["pnpm", "--filter", "portal", "test:unit"])).toBe(ScopeRule.UnscopedTest);
    expect(ruleOf(["npm", "test"])).toBe(ScopeRule.UnscopedTest);
    expect(ruleOf(["yarn", "test", "--", "--reporter=dot"])).toBe(ScopeRule.UnscopedTest);
    expect(ruleOf(["vitest", "run"])).toBe(ScopeRule.UnscopedTest);
    expect(ruleOf(["npx", "vitest", "run", "--root", "apps/portal"])).toBe(ScopeRule.UnscopedTest);
    expect(ruleOf(["jest"])).toBe(ScopeRule.UnscopedTest);
  });

  test("allows --changed, --related and spec paths", () => {
    expect(ruleOf(["nx", "test", "portal", "--changed", "origin/main"])).toBeUndefined();
    expect(ruleOf(["pnpm", "test:unit", "--", "--changed=origin/main"])).toBeUndefined();
    expect(ruleOf(["vitest", "run", "--changed", "origin/main"])).toBeUndefined();
    expect(ruleOf(["vitest", "related", "src/a.ts"])).toBeUndefined();
    expect(ruleOf(["vitest", "run", "--related", "src/a.ts"])).toBeUndefined();
    expect(ruleOf(["vitest", "run", "--run", "src/a.spec.ts"])).toBeUndefined();
    expect(ruleOf(["pnpm", "vitest", "run", "src/components/"])).toBeUndefined();
    expect(ruleOf(["nx", "run", "portal:test", "--testFile=src/a.spec.ts"])).toBeUndefined();
    expect(ruleOf(["jest", "--findRelatedTests", "src/a.ts"])).toBeUndefined();
  });

  test("leaves other commands and scripts alone", () => {
    expect(ruleOf(["pnpm", "lint"])).toBeUndefined();
    expect(ruleOf(["just", "test"])).toBeUndefined();
    expect(ruleOf(["bun", "test", "test/a.test.ts"])).toBeUndefined();
    expect(ruleOf(["nx", "run", "portal:build"])).toBeUndefined();
    expect(ruleOf(["true"])).toBeUndefined();
    expect(ruleOf([])).toBeUndefined();
  });
});

describe("--skip-nx-cache", () => {
  test("refuses the flag and the env var", () => {
    expect(ruleOf(["nx", "affected", "-t", "lint", "--base=origin/main", "--skip-nx-cache"])).toBe(ScopeRule.SkipCache);
    expect(ruleOf(["nx", "run", "portal:lint", "--skipNxCache"])).toBe(ScopeRule.SkipCache);
    expect(ruleOf(["NX_SKIP_NX_CACHE=true", "nx", "run", "portal:lint"])).toBe(ScopeRule.SkipCache);
    expect(ruleOf(["nx", "run", "portal:lint", "--skip-nx-cache=false"])).toBeUndefined();
  });

  test("is reported before a missing -p", () => {
    expect(ruleOf(["nx", "run-many", "-t", "lint:ci", "--skip-nx-cache"])).toBe(ScopeRule.SkipCache);
  });
});

describe("wrapped forms", () => {
  test("reads through runners and package managers", () => {
    for (const lead of [["npx"], ["npx", "--yes"], ["pnpm"], ["pnpm", "exec"], ["pnpm", "-C", "web", "exec"], ["pnpm", "dlx"], ["bunx"], ["yarn"]]) {
      expect(ruleOf([...lead, "nx", "run-many", "-t", "lint"])).toBe(ScopeRule.RunManyAll);
    }
  });

  test("reads through sh -c, bash -lc, env and chains", () => {
    expect(ruleOf(shell("pnpm nx run-many -t typecheck"))).toBe(ScopeRule.RunManyAll);
    expect(ruleOf(["bash", "-lc", "cd apps && npx nx run-many -t lint -p a,b,c,d,e,f"])).toBe(ScopeRule.RunManyTooMany);
    expect(ruleOf(["/bin/zsh", "-c", "FOO=1 pnpm exec nx run-many -t lint:ci --skip-nx-cache"])).toBe(ScopeRule.SkipCache);
    expect(ruleOf(["env", "-i", "CI=1", "nx", "run-many", "-t", "lint"])).toBe(ScopeRule.RunManyAll);
    expect(ruleOf(shell("pnpm lint; pnpm test"))).toBe(ScopeRule.UnscopedTest);
    expect(ruleOf(shell("sh -c 'bash -c \"nx run-many -t lint\"'"))).toBe(ScopeRule.RunManyAll);
    expect(ruleOf(shell("nx run-many -t lint > out.log 2>&1"))).toBe(ScopeRule.RunManyAll);
    expect(ruleOf(shell("nx affected -t lint --base=origin/main && echo done"))).toBeUndefined();
  });

  test("unwraps to the program and its arguments", () => {
    expect(invocations(["FOO=1", "pnpm", "exec", "nx", "affected"])).toEqual([{ env: ["FOO=1"], program: "nx", args: ["affected"], script: false }]);
    expect(invocations(["npm", "run", "test:unit", "--", "x"])).toEqual([{ env: [], program: "test:unit", args: ["--", "x"], script: true }]);
  });
});

test("the message names the command and the scoped alternatives", () => {
  const argv = ["nx", "run-many", "-t", "typecheck"];
  const msg = refusalMessage(argv.join(" "), scopeRefusal(argv, CAP)!);
  expect(msg).toContain("overbridge check refused: nx run-many -t typecheck");
  expect(msg).toContain("no -p/--projects runs every project");
  expect(msg).toContain("nx affected -t typecheck --base=origin/<base>");
  expect(msg).toContain("vitest run --changed origin/<base>");
});
