# Nexuss General Intelligence

An autonomous, high-level general intelligence platform. It takes simple intent and input, aligns goals and milestones, then carries out end-to-end execution without human intervention.

AGI is designed here through multi-step, multi-agent autonomous agents that complete complex software engineering tasks and research.

## Purpose

Transform an intent into an executed result. The system handles goal and milestone alignment, then executes. Once the user approves the clarified intent, they can leave the chat and will be notified when the task is done.

## Architecture

There are only three architectural elements:

- **Orchestrator** — controls every workflow and harness which controls the goal.
- **Agent** — an orchestrator-specialised agent that completes a given specific task.
- **Sub agent** — an agent-harnessed sub agent. Sub agents run simultaneous tasks and explore the codebase and related things when the agent needs to automate a specific task. An agent can also complete a given task by itself.

There is no architectural difference between an orchestrator, an agent, and a sub agent. All three have a system prompt + agentic skill + tool skill + tools. They differ only by the skills and tools given to them. There is no code to remember; they are just orchestrating.

Everything else in this document — inspector, debugger agents, QA team, red team — is not inherited from the architecture. Each is only a different skill and tool bundle given to an agent.

### Roles

- **Inspector** — when an agent finishes its work, the agent calls the inspector. The inspector sees the orchestrator's task and the agent's actual work, then synthesises a checklist against it and reports a verdict: completed, partial, or not completed. The report is a markdown report. The agent reads it, reworks anything incomplete, and calls the inspector again. When it passes, the agent reports completion to the orchestrator. It is not like QA: the inspector has no preset checklist, it derives one from the task and the work.
- **Debugger agents** — specialised agents for development agents. When a development agent hits a code error it does not debug it itself; it defers to the debugger team, so the agent stays focused on task completion.
- **QA team** — enhances and makes the platform or software professional. QA inspects and identifies every quality issue. Unlike the other stages this is expected to be multi-tier, so UI/UX quality is handled differently from API design and so on. It produces one rigorous, rich report in a single pass rather than repeated loops, because an LLM does not pass quality-related things easily without making them complicated. The report goes to the orchestrator, which replans.
- **Red team** — security-focused agents. Multi-stage like QA, and one-time like QA. The report goes to the orchestrator, which replans.

### Invariants

- The ledger is the source of truth. All milestones, workflow state, what is done and what remains, including project docs, is persisted.
- A context summary is an index, not a record. After compaction the summary tells the orchestrator what to ask for; the ledger gives the answer. The orchestrator re-reads targeted state before acting and never acts from the summary alone.
- The inspector is called by the agent, so the orchestrator rejects any completion report that lacks a verdict. The verdict is a mechanical header line in the markdown report, checked for presence rather than judged for quality.
- For milestone-level gates only, acceptance criteria trace back to the approved spec, and the inspector sees both. Mid-task, the orchestrator's spec is the contract.
- Inspector, QA, and red team are read-only. Sub agents get a narrower tool grant than the parent agent.

## Categories

An input belongs to one of four categories:

- `build`
- `train`
- `study`
- `compose`

The first three are genuine categories, each with a different verification regime. `compose` is a mode over them, not a peer: it is for non-casual or ambitious projects. The orchestrator either picks a category or composes several, and may create new agentic skills or combine existing ones as needed.

## Tools

fs, terminal, browser, vercel, huggingface, todo, github, and others, used by agents.

## Skills

Two kinds:

- **Agent skill** — the role and capability an agent performs.
- **Tool skill** — the tool access an agent uses.

An agent is defined by its system prompt + agentic skill + tool skill + tools.

## Reusable factuals

Recorded by agents upon completion of their given task, and organised by domain so it stays well organised. When a new project begins, agents start by looking at the domains.

- **Memory**
- **Knowledge**
- **Skill**
- **Experience** — a new introduction for the world
- **Template** — makes different things reusable after finishing any project, such as UI and other tool inventions, to complete future tasks
- **Personalisations** — agents have a lot of personalised identity; they have their own different identity

## Categories in detail

### Build: software development

Developing a website, desktop and mobile app, telegram bot, or packages like npm/pip and related work. Software includes both OS and application software, with more promotion and focus on application software. Make it task-agnostic to address anything.

Agent skills are not ordered or specific instructions; they are mapped by the orchestrator.

**Research and clarification**

- **Intent documentation** — the user intent may be a simple to long prompt, a reference, visuals, or even self-contained documentation written by AI. This agent takes the input and any attachments and documents them structurally, without addition or minimisation. Before it reaches the orchestrator, the agent presents the information and the conversation continues until the user is satisfied. Once satisfied, the agent thanks the user for approval, acknowledges that they can leave the chat until the task is done, and that they will be notified.
- **Specs documentation** — the intent is converted into specification format, structured, grouped, separated by new space, for the next analysis to focus on one stage at a time. Bulletpointed, stage separated.
- **Market analysis** — compares the current internet giants in the same field, analyses each competitor's products, services or features, then structures a separate document for each one including their strength and vulnerability. Each report is separated by company.
- **Feature gathering** — takes the market analysis report and synthesises it into one brand's features, including continuing with their strength, their weakness as strength, and new capability or feature as additions. Structured, separated by temporary stages.
- **Feasibility analysis** — not similar to QA. Conducts research and synthesis into complete documentation on how each stage can be implemented, providing multiple approaches and technologies for each stage and recommending one. When there is no option to implement it, it presents an open question on how the agent wants to add this feature, and there is an open ongoing conversation and report between the agents until all stages have at least one and more implementation strategies. When all stages contain feasibly implementable strategies, it synthesises a complete analysis.

**Documentation: task and harness organisation**

- **Project documentation** — the project becomes official features separated by milestones, phases and sub phases. Complete end-to-end feature documentation.
- **System design** — software system design including technology, database design documentation, tools, and so on. Complete end-to-end to implement the offered project docs.

**Backend: core functionality**

- **Database schema** — design the designed database.
- **Backend dev** — finish the backend.
- **API design** — properly design the API from the backend for the frontend and others.
- **Backend documentation** — proper API and backend documentation for the frontend and future work.

**Frontend: user facing**

- **UI/UX design** — colour scheme and typography choice, and other elements including frontend framework and technology choices. Complete end-to-end documentation for the next frontend dev team, plus a fully professional landing page design with the selected UI design plan.
- **Frontend dev** — based on the chosen palette and principle, complete all frontend work.
- **Polishments** — work on beauty, spacing, responsiveness and other things to feel premium and professional.

For application and desktop apps there are separate capacitor and tauri specialised agents.

QA and red team are placed at points in this flow.

**Presentation: DX and deployments**

- **Packaging** — developing cli, npm/pip, docker, vercel, and other pre-deployment packages.
- **Documentation and user manual** — both for the technical developer and for users.
- **Deployment** — deploy or release packages using available tools, or an easy guide for the user to deploy.

### Train: AI and ML development

Fundamentally different from build. It needs several stages: research, proving mathematics first, code, testing code, dataset preparation, pretraining, fine tuning, evaluating, scale.

Flow to be defined later.

### Study: research

A series of information gathering, multi-layer analysis, expandable until a specific goal is achieved, to synthesise a scientific report.

Flow to be defined later.

### Compose: custom

A mix of different things. New agents may be introduced and existing ones reused. The orchestrator has full power to compose things up, creating new agentic skills or composing existing ones. Custom exists to implement non-casual tasks or ambitious projects.

## Delivery model

Agents follow the SDLC. The user selects whether they need the product at the end, or gated approval at some point. The orchestrator decides where those gates sit, such as at the end of research, at some middle part, or before deployment.

Every report has changelog history and checklists. The orchestrator analyses the next step and runs another agent, and the loop continues.

## Out of scope for now

The Train, Study, and Compose flows. Focus is on Build.
