default: check

check: lint typecheck test

test:
    bun test

lint:
    bunx oxlint

typecheck:
    bunx tsc --noEmit

# Run the CLI from source
overbridge *args:
    bun src/cli.ts {{args}}
