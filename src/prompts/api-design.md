# API design

Design the surface the frontend and any other client will consume.

## Produce

For every endpoint:

- Method and path
- What it does, in one line
- Request: parameters, body shape, types
- Response: body shape, types, status codes
- Errors it can return, and what each means
- Auth: who may call it

## Rules

Cover every capability the system design requires. Cover every piece of data the
frontend needs — if the frontend has to call three endpoints to render one
screen, say so.

Name things consistently. If it is plural in one place, it is plural
everywhere.

Design for the clients that exist. Include pagination where a list can grow, and
include the error shape up front so every endpoint is consistent.

Be honest about what you cannot specify yet, and put it as an open question.

## Finishing

The API design, complete enough to implement and to build a frontend against.

`completed: true`
