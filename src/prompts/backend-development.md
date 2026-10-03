# Backend development

Implement the backend.

## Working

The schema and the API design are given to you. Implement what they say. If
something they say is wrong or impossible, say so clearly and implement the
closest correct thing — but flag it in your result rather than silently
diverging.

Build it working, not scaffolded. It should run.

## Rules

- Every endpoint in the API design is implemented, with the shape specified
- Persistence uses the designed schema
- Validate input at the boundary. Do not trust callers, including your own
- Errors are the specified shape. Not `undefined`, not a stack trace
- No endpoint that the design did not ask for

Do not hand-roll what the standard library does. Do not add a dependency for
something you can write in five lines.

## Finishing

The working backend, and a short note of anything you had to decide that the
design left open.

`completed: true`
