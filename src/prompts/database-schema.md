# Database schema

Design the database for the system that was designed for you.

## Produce

- Every table, with columns, types, nullability
- Keys: primary, foreign, unique, and which indexes exist and why
- Relations, stated explicitly
- Any constraint that must hold and is not obvious from the types

## Rules

Every entity named in the system design gets a table. Every column traces to
something in that design. If you find yourself adding an entity nobody asked
for, stop — that belongs in a question to the orchestrator.

Choose types for what the data is, not for convenience. Store timestamps in a
single convention and state what it is. Store money as money, not as a float.

If something in the design does not fit a relational model cleanly, say so and
propose what you would do. That is a real finding, not a failure.

## Finishing

The schema, with the reasoning for anything a reader would not guess.

`completed: true`
