# Review gates

This file is read at review time and prepended to every reviewer's instructions.
It is the one file that makes the panel yours. Without it the panel still works,
but it reviews generically: correctness, security, leaked secrets, missing
authorization, obvious performance traps.

Write down the mistakes your project actually makes. Be specific. A gate that
says "check for bugs" changes nothing; a gate that names your own recurring
failure is worth ten generic ones.

Delete every line below that does not apply to you.

## Gates

1. **Does the change do what the pull request says it does?** A description that
   promises more than the diff delivers is a finding.
2. **Every new query path:** is it inside a loop? Does it have an index on the
   columns it filters or sorts by?
3. **Every new endpoint:** does it check that the caller is allowed to see this
   specific record, not merely that they are logged in? Authentication is not
   authorization.
4. **Every failure path:** does it reach your error tracker, or does it only
   print to a console nobody reads?
5. **Any client-supplied identifier** used to look up data: is it verified
   server-side rather than trusted?
6. **New environment variables:** is there a fallback that will silently do the
   wrong thing when the variable is missing in production?
7. **Anything that could contain personal data** in a log line, an error
   message, or a third-party payload.
8. **Numbers that can legitimately be zero:** are they defaulted with `||`,
   which turns a real zero into the fallback?

## Gates this package earned the hard way

These four shipped in `examples/review-gates.md` — the starter file handed to every
consumer — and were missing from the package's own gates for weeks. Every one of them
names a defect that then happened here. A tool that does not apply its own advice to
itself is the joke it looks like.

9. **Silent success is the worst outcome.** A check that cannot tell whether it ran must
   fail loudly, never exit zero. Flag any code path that can report a pass without having
   done the work.
10. **Three copies of a check are three chances to get it wrong.** Prefer one shared
    helper over a pattern repeated across files. If two files must both exist, one is
    generated from the other and a test fails when they differ.
11. **A credential decision must forward exactly one credential.** Two in one environment
    means whichever the tool prefers wins silently.
12. **A control that cannot be turned off is not a control.** Anything that spends money
    must name the command that stops it, at the moment you agree to it.
13. **A capability granted by default is granted.** When a process holds a credential and
    reads untrusted input, list what it is REFUSED rather than what it is asked not to do.
    A sandbox that blocks writes is not blocking reads or egress.

## Tone

Report blockers, suggestions, and nits, in that order. Say what is wrong, why it
matters, and the smallest fix. Do not invent findings to fill space. If the diff
is clean, say so and stop.
