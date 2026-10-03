# Packaging

Make this shippable.

## Produce

Whatever applies to this project:

- A published package — npm, pip, or a binary
- Container setup — Dockerfile, and it builds
- Deployment config, and it is deployable
- Environment and secrets declared, with what is required and what is optional

## Rules

Each package should build and install cleanly from what you produce. Test it.

Version it. Declare the runtime. Do not commit secrets, and do not commit a
`.env` that contains any.

Document how to install and run it — a `README` section is not optional.

## Finishing

The packages, each confirmed to build.

`completed: true`
