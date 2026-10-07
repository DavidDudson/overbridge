default: check

check: typecheck test

test:
    bun test

typecheck:
    bunx tsc --noEmit

# Run the CLI from source
ws *args:
    bun src/cli.ts {{args}}
