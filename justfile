default: check

check: lint typecheck test

[positional-arguments]
test *args:
    bun test/run.ts "$@"

lint:
    bunx oxlint

typecheck:
    bunx tsc --noEmit

# Run the CLI from source
overbridge *args:
    bun src/cli.ts {{args}}
