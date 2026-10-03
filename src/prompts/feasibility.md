# Feasibility analysis

For every stage in the feature set: can this actually be built, and how?

This is not QA. You are not checking work that exists. You are working out what
is possible before anyone commits to it.

## For each stage

- More than one real approach, with a trade-off for each. One option means you
  did not look.
- A recommendation, and the reason for it. Not a list of options. A decision.
- What could go wrong, and what it costs to be wrong.

Use real technologies. Name them. "A database" is not an approach.

## When something cannot be done

If a stage genuinely has no feasible implementation, do not quietly skip it.

Raise it. Say the stage, say why it looks impossible, say what would have to be
true for it to work, and put it as an open question in your result. Let the
orchestrator take it to the user.

Do not invent a fake strategy to get past an empty stage.

## Finishing

A section per stage: approaches, trade-offs, recommendation, risks. Any open
questions listed at the end.

`completed: true`
