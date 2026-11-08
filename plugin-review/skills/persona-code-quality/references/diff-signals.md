# persona-code-quality diff signals

One line per case this persona owns that can be seen in a diff. After applying your numbered rules, check every changed hunk against these lines. Report a match only when you can name the changed line, the input or steps that break it, and the wrong result; otherwise drop it. Lines marked `(rule N)` are already covered by that rule.

## Falsy-but-valid values

- `||` defaults on numbers, `v-if="num"`, or `filter(Boolean)` on a numeric array, so a real 0 is dropped → Use `??`, `!= null`, or `Number.isFinite(x)` [default: change-requested] (rule 10)
- `|| '-'` on a numeric field, `v-if="x.price"`, `v-show="total"`, `if (!price)` or `filter(Boolean)` where 0 is a real value → Use `??`, `x != null` or `Number.isFinite` [default: nit] (rule 10)

## Dates and time

- Millisecond arithmetic for days such as `+ 86400000`, or `setHours` across a DST change → Calendar arithmetic with the repo's date library (`add({ days: 1 })`, `addDays`) [default: change-requested]

## Lifecycle

- `addEventListener` in mount or a watcher with no removal on unmount/scope dispose; uncleared `setInterval` → Use an auto-cleaning listener helper, or remove on dispose [default: nit] (rule 9)

## Formatting

- New inline formatting of speed, money, or another unit in a template or computed where a shared `format*` helper already exists → Reuse the shared formatter [default: nit] (rule 11)
