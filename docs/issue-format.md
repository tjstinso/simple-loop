# Issue format for `factory submit`

`factory submit <issue-url>` turns a GitHub issue into a task for the factory. The issue is the whole brief: the agent reads it, implements it, and a reviewer checks the result against it. This page says what the issue must contain.

## Required sections

The issue body must contain both of these headings:

- `## Goal`: what the work is and why, in a few sentences.
- `## Acceptance criteria`: the list of conditions that must hold when the work is done.

Rules for the headings:

- Each heading must be on a line of its own. A heading that is part of a longer line does not count.
- Matching is case-insensitive, so `## goal` and `## ACCEPTANCE CRITERIA` also work. Leading and trailing whitespace on the line is ignored.
- The heading text must be exactly the required text, including the `## ` prefix.

If either is missing, `factory submit` fails and names the missing section. The issue must also be open and have a non-empty body.

## Other sections

Any other sections are allowed and are passed along with the rest of the body. Common ones are `## Context` (background the agent needs) and `## Out of scope` (things the agent must not do). They are optional and are not checked.

## Example

```markdown
## Goal

Make `greet()` in `src/greet.ts` return an upper-case greeting when called with `{ loud: true }`.

## Context

`greet(name)` currently returns `Hello, <name>`. Callers that want emphasis build the string themselves.

## Acceptance criteria

1. `greet(name, { loud: true })` returns `HELLO, <NAME>!`, with the name upper-cased.
2. `greet(name)` and `greet(name, {})` still return `Hello, <name>` exactly as before.
3. `test/greet.test.ts` has a test for the loud case and one for the default case.
4. `npm test`, `npx tsc --noEmit` and `npm run build` pass.

## Out of scope

- Changes to any file other than `src/greet.ts` and `test/greet.test.ts`.
- Localisation of the greeting.
```

## What makes a good acceptance criterion

- It is checkable by running a command or reading a file. "`npm test` passes" and "`docs/x.md` contains a section titled `Y`" are checkable; "the code is clean" is not.
- It names exact file paths, identifiers and values where they matter: `src/greet.ts`, `greet`, `HELLO, <NAME>!`, not "the greeting file" or "an upper-case string".
- It states what is out of scope, either in a criterion ("no other file is changed") or in an `## Out of scope` section, so the agent does not wander.
- It covers one thing. Several small numbered criteria are easier to verify than one long one.
