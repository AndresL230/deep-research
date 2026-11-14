# API contract (server ⇄ web)

Shared by `server/` (Python, FastAPI) and `web/` (Vite + TS). Event shapes are Trov's Ask events
(`~/Projects/trov/shared/ai-ask-core.ts`), trimmed, plus an `image` block.

## Endpoints

- `POST /api/ask` — `multipart/form-data`:
  - `conversation` (string, required): a UUID the **client** generates per conversation and resends every turn.
  - `message` (string, required)
  - `file` (optional): a CSV. Uploaded into the sandbox at `/home/daytona/data/<filename>`. Over 50 MB → `error {code:"too_large"}`.
  - Response: `text/event-stream`. Each message is `event: <name>\ndata: <json>\n\n`. Stream closes after `done` or `error`.
- `DELETE /api/conversations/{conversation}` → `204`. Deletes the sandbox and forgets the thread. Unknown id → `204`.
- `GET /api/files/{conversation}/{name}` → the downloaded output file (PNG/SVG/etc). 404 if missing; names are path-checked.
- `GET /api/sample` → `samples/sales.csv` as `text/csv` (`Content-Disposition: attachment; filename="sales.csv"`), for the empty state's "Try the sample".
- `GET /api/health` → `{ "ok": true, "keys": { "anthropic": bool, "daytona": bool } }` (whether each key is set; never the value).
- `/` and other paths → static files from `web/dist` if it exists (SPA fallback to `index.html`).

Dev: `uv run uvicorn server.app:app --reload --port 8000`; `cd web && npm run dev` (Vite on 5173, proxies `/api` → `http://localhost:8000`).

## Events (in order within one turn)

```ts
thinking: { state: "run" }                                    // first event of every turn
thinking: { state: "done"; seconds: number; summary: string } // when the first activity or text begins; summary may be ""
activity: { step: number; state: "run"; tool: string; icon: "search" | "read" | "docs" | "ci" | "sprint"; label: string }
activity: { step: number; state: "done"; results?: string[]; resultLine?: string }   // same step number as its run
text:     { delta: string }                                   // markdown tokens of the assistant's answer
block:    { kind: "image"; url: string; alt: string }         // url = /api/files/<conversation>/<name>
done:     { messageId: number; cites: []; tokens: { in: number; out: number; cached: number }; stopped?: boolean }
error:    { code: "no_key" | "timeout" | "too_large" | "failed"; message: string }
```

- `step` numbers start at 1 per turn and increase.
- Icons: `execute`→`ci`; `read_file`, `ls`→`read`; `write_file`, `edit_file`→`docs`; `grep`, `glob`→`search`; `write_todos`→`sprint`; anything else→`read`.
- `write_todos`: one activity step (run then done) whose `done.results` are the todos as `"[x] text"`, `"[~] text"` (in progress), `"[ ] text"`; `resultLine` like `"2 of 5 done"`.
- Text from the model between tool calls is streamed as `text` too; the client appends in order.
- `messageId`: a per-server incrementing integer.
- Client Stop = abort the fetch. Server cancels the agent run; no further events.
