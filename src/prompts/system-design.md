# System design

Decide how this is built. Not what it does — that is already decided. How.

## Produce

- **Technology choices** — language, runtime, framework, per part of the system.
  Name them. Justify each against the project documentation, not against taste.
- **Database design** — entities, relations, keys, the reasoning for the shape
- **Components** — the pieces, what each owns, how they talk
- **Tools** — what the system will use to build, test, deploy, and observe
- **Structure** — the layout, where things live, why

## Rules

Every choice must trace back to something in the project documentation. If you
cannot say which requirement drove a choice, leave it out.

Decide. "We could use X or Y" is not a design. Pick, and write the sentence
explaining the pick.

Design for the project that exists in the documentation. Not for scale it might
reach. Not for the version someone might want later.

A developer must be able to implement from this without coming back to ask.

## Finishing

The system design document.

`completed: true`
