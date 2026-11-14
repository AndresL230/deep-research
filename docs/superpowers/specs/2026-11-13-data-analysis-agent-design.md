# Data analysis deep agent, with Trov's Ask UI

Date: 2026-11-13

> **Superseded (2026-11-14).** The chat app this spec describes (`server/`, `/api/ask`) was retired when the repo
> was unified around the batch experiment. Its look lives on in `web/`. See `README.md` and `docs/api-contract.md`;
> the code is in git history at 828cd79.

## Intent

A basic, working deep agent built on LangChain's `deepagents` library that analyzes data: you hand it a CSV
and a question, it plans, writes and runs Python in an isolated sandbox, and answers with findings and
charts. The interaction screen is lifted from Andres's other project, Trov (`~/Projects/trov`), whose
"Ask Trov" screen already renders a streaming agent well: thinking, activity steps, streamed markdown, blocks.

This is a starting point to build on, not a product. "Basic" is the operative word.

## Goals

- Ask a question about an uploaded CSV in a browser and watch the agent work: its plan (todos), each tool
  call as an activity step, then a streamed markdown answer with the charts it made shown inline.
- Follow-up questions in the same conversation reuse the same data and the files the agent already wrote.
- Code runs in a Daytona sandbox, never on the local machine.
- Looks and streams like Trov's Ask screen.

## Non-goals (for now)

- Trov's thread list, inspector, reference cards/hover cards, write (approval) cards, ⌘J panel, modes/Auto,
  settings, phone drawer, follow-up suggestions, artifacts, share/delete.
- Persistence across server restarts, accounts/auth, deployment. It runs on localhost.
- Slack or any other external sharing. Web research. Subagents.
- A CLI (the web UI replaces the CLI from the earlier draft of this design).

## Anti-goals

- Agent-written code executing on the host machine.
- Sandboxes left running (and billing) after a conversation ends.
- Copying Trov wholesale and stubbing its domain (tickets, sprints, people, refs) — dead code we'd carry forever.

## Constraints

- Model: Anthropic only. `anthropic:claude-sonnet-5-5` via `langchain-anthropic`.
- Sandbox: Daytona via `langchain-daytona` (`DaytonaSandbox`).
- Keys in a git-ignored `.env`: `ANTHROPIC_API_KEY`, `DAYTONA_API_KEY` (neither is set in the shell today).
  `.env.example` committed.
- Python via `uv`, pinned to 3.12 (the system Python is 3.14, which some dependencies may not ship wheels for).
- Trov is AGPL-3.0 with Andres as copyright holder; copied files keep a one-line "ported from Trov" header.
  Licensing this repo is Andres's call and out of scope here.

## Approaches considered (UI)

1. **Lift the look and the stream core, rebuild a small shell — chosen.** Copy `ask-sse.ts` (SSE reader) and
   `ask-stream.ts` (pure event → turn-state fold) nearly as-is; port the conversation, activity, thinking-orb,
   and composer rendering plus the CSS they use; drop everything Trov-domain. ~1.5–2.5k lines. Looks and
   streams like Trov; dropped pieces would have to be ported later if wanted.
2. Copy the whole Ask screen and stub the Trov parts. Every feature kept, but half the code dead or stubbed and
   bound to Trov's render/morph loop. Rejected: slow to get working, hard to change.
3. Reuse only the event protocol, build a fresh UI. Fastest, but not Trov's UI, which is the point. Rejected.

(Earlier choices, made in conversation: data analysis over web research; Daytona over local shell.)

## Design

### Shape

```
browser (Vite + vanilla TS, Trov Ask look)
   │  POST /api/ask  (multipart: conversation id?, message, optional CSV)
   │  ◄── text/event-stream in Trov's Ask event shapes
   ▼
Python server (FastAPI + uvicorn)
   │  one deep agent; one Daytona sandbox + LangGraph thread per conversation
   ▼
Daytona sandbox  (agent's files + execute; plots written to /home/daytona/outputs)
```

`uv run` starts the server, which also serves the built frontend. Vite dev server proxies `/api` in development.

### Backend

- `create_deep_agent(model=..., backend=DaytonaSandbox(...), checkpointer=InMemorySaver(),
  middleware=[TodoListMiddleware()], system_prompt=...)`. The system prompt tells it: the dataset is at
  `/home/daytona/data/<name>.csv`; explore before concluding; install what it needs with pip; save every chart
  as PNG under `/home/daytona/outputs/`; answer in markdown and reference charts by filename.
- **Conversation lifecycle:** the first message of a conversation creates a Daytona sandbox and a thread id;
  later messages reuse both (held in an in-process dict keyed by conversation id). The sandbox is deleted when
  the browser starts a new conversation (`DELETE /api/conversations/{id}`), on server shutdown, and Daytona's
  auto-stop interval is set short (e.g. 15 min) as a safety net.
- **Upload:** a CSV attached to a message is uploaded into the sandbox's `data/` dir before the agent runs.
  Size limit (e.g. 50 MB) → `error { code: "too_large" }`.
- **Streaming:** use deepagents' streaming (event-streaming projections, or `stream_mode=["messages","updates"]`
  — builder's choice, whichever gives tool-call start/finish plus token deltas cleanly) and translate to Trov
  events:

  | Agent | Trov event |
  |---|---|
  | turn starts, before first output | `thinking {state:"run"}`, then `thinking {state:"done", seconds, summary:""}` when output begins |
  | tool call starts (`execute`, `write_file`, `read_file`, `ls`, `grep`, …) | `activity {step, state:"run", tool, icon, label}` — label is a short human line, e.g. "Running analyze.py" |
  | tool call finishes | `activity {step, state:"done", resultLine}` — e.g. exit code / "wrote 42 lines" |
  | `write_todos` | an activity step whose `results` are the todo lines with their status |
  | assistant text tokens | `text {delta}` |
  | new PNG/SVG in `/home/daytona/outputs/` after a tool call | download to `runs/<conversation>/`, emit `block {kind:"image", url, alt}` |
  | turn ends | `done {messageId, cites:[], tokens}` |
  | failure | `error {code, message}` — `no_key` if a key is missing, `timeout`, `failed` otherwise |

  Icons map onto Trov's existing set: `execute`→`ci`, `read_file`/`ls`→`read`, `write_file`/`edit_file`→`docs`,
  `grep`/`glob`→`search`, `write_todos`→`sprint`.
- `GET /api/files/{conversation}/{name}` serves downloaded images; path-checked against the conversation dir.
- Stop: the client aborts the fetch; the server cancels the agent task and sends nothing further (Trov's
  client already handles an aborted stream as stopped).

### Frontend

- New `web/` Vite + TypeScript project, no framework (as Trov).
- **Ported nearly verbatim:** `ask-sse.ts`, `ask-stream.ts`, and the event types from Trov's
  `shared/ai-ask-core.ts` trimmed to the events used (`thinking`, `activity`, `text`, `block`, `done`, `error`)
  plus a new `image` block kind.
- **Ported and trimmed:** the conversation view (user bubble, activity list, thinking orb, streamed markdown
  with Trov's tail-settling, image blocks, error/stop states, jump-to-latest), the composer (textarea, send/stop,
  one CSV file chip via picker or drag-drop), `thinking-orb.ts`, the icons used, markdown rendering, and the
  `trov.css` tokens/rules those pieces use (light and dark).
- **Shell:** one column: header ("New conversation" button), conversation, composer. Empty state with
  "Drop a CSV to start" and the bundled sample.
- **Rendering:** a simple re-render-on-state-change loop. Trov's `morph.ts` (DOM patching that keeps caret and
  scroll) is ported only if the naive approach drops composer focus/scroll while streaming.

### Repo layout

```
pyproject.toml / uv.lock / .python-version (3.12)
.env.example  .gitignore
server/       FastAPI app, agent factory, sandbox lifecycle, event translator
web/          Vite app (src/ported-from-trov files + shell), builds to web/dist
samples/      a small sales CSV
runs/         downloaded outputs (git-ignored)
```

### Testing

- Event translator unit-tested against recorded/fabricated agent stream chunks (no network).
- Trov's own fold logic is pure; port a small test that folds a recorded event transcript into the expected turn.
- One manual end-to-end run with real keys on the sample CSV, checked in the browser.

## Left to the builder

- Exact streaming API (event-streaming vs `stream_mode`), as long as the mapping above holds.
- Exact activity labels and result lines.
- Which of Trov's CSS rules are needed — copy what the ported markup uses, not the whole file.
- Whether `morph.ts` is needed (see Rendering).
