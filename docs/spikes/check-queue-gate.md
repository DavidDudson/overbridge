# Moving the check-queue gate into the server

Evaluation for [#165 chore(server): evaluate moving the check-queue gate into the server](https://github.com/DavidDudson/overbridge/issues/165),
part of [#157 epic: single long-running bun server for refreshes and shared caching](https://github.com/DavidDudson/overbridge/issues/157).

**Decision: do not move it.** The gate costs next to nothing, and moving it would add a second code path rather than remove one.

## What the gate does today

Every `overbridge check` that has to wait polls once a second (`TURN_POLL_MS` in `src/check-queue.ts`). Each poll lists
`<meta>/check-queue/`, reads every ticket, asks `pidAlive` for each owner, reads the 1-minute load average and runs the pure
`gateFor`. With 10 tickets waiting that is 10 processes each doing one such poll a second. Execution (the process group, the
timeout and stall kill) stays in the caller either way; only the waiting could move.

## Measurements

Machine: 28 cores, Linux, bun 1.4.2. One running ticket and 10 waiting ones, tickets owned by live processes.

| What | Result |
| --- | --- |
| One poll (`readTickets` + `splitQueue` + `gateFor` + `loadavg`), 11 tickets, 2000 runs | 0.073 ms |
| `loadavg()` alone | 0.14 µs |
| 10 waiting processes running the poll, 20 s | 110 to 117 ms CPU each (median 113) |
| 10 idle bun processes holding a 1 s timer, 20 s | 77 to 89 ms CPU each (median 83) |
| Cost the gate adds per waiter | about 30 ms CPU over 20 s, or 0.15% of one core (the poll itself is 0.007%; the rest is timer wake-ups and `/proc` reads) |
| 10 waiters together | about 1.5% of one core, 0.05% of this machine |
| RSS per waiting process | 37 MB with the gate, 31 MB idle |

The 77 to 89 ms in the idle row is bun starting and loading modules, which every waiter pays whatever the gate does.

## Why not move it

- **The saving is small.** A shared poller would do one read of the directory instead of ten, which saves roughly 1.4 ms of CPU a
  second across the 10 waiters. The waiters' own start (about 80 ms each) and their 31 MB of memory stay, because each is
  still an `overbridge check` process that owns a command and a ticket.
- **The server cannot be required.** The acceptance criterion says tickets must still work with the server down, so the file
  gate stays as the fallback. Moving the gate would add a server path next to it: two implementations of the same ordering
  rules to keep in agreement, and a reason for a waiter to switch between them mid-wait.
- **The queue is deliberately lock-free.** Only a ticket's owner writes it and only the first waiting ticket may start, so there
  is no shared state to coordinate. A server holding the gate would become the thing that decides who starts, which is
  new shared state with a failure mode (a hung server holds every check) that the files do not have.
- **A server push does not remove the poll.** A waiter still has to notice a dead owner ahead of it and a load average that
  drops, neither of which the server sees sooner than a poll would.

## When to revisit

If waiters were threads of one process rather than separate `overbridge check` processes, or if the poll interval had to drop
well under a second, the shared read would start to matter. Neither is true today.

## Reproducing

A waiter is the loop `readTickets(dir)`, `splitQueue(tickets, pidAlive)`, `gateFor(me, live, settings, { load1, cores }, now)`,
`await Bun.sleep(1000)`. Run 10 of those as separate bun processes against a directory of 11 tickets (the first with a
`runPid`) and compare each process's `process.cpuUsage()` after 20 s with a process that only sleeps in a 1 s loop.
