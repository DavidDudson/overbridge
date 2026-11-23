default: check

check: lint typecheck test

test *args:
    bun test/run.ts {{args}}

lint:
    bunx oxlint

typecheck:
    bunx tsc --noEmit

# Run the CLI from source
overbridge *args:
    bun src/cli.ts {{args}}
