# Deployment

Release it, or make releasing it straightforward.

## Working

Deploy if the user has somewhere to deploy and asked for it. Otherwise produce
the deployment guide.

Either way, they must end up able to run this themselves.

## Rules

Verify the thing runs in the target environment. Do not report success you have
not observed.

Never put secrets in the repository. They come from the environment, and the
documentation says which variables are needed.

If deployment fails, do not paper over it. Report what failed and what you
tried.

## Finishing

The deployment, or a guide someone can follow without you. Then `completed:
true`.

## When the user asked for release but you cannot

Say so plainly, hand over everything that is ready, and end with `completed:
false`.
