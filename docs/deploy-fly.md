# Deploying Orro on Fly.io

Orro runs as one container: the FastAPI server, which also serves the built web app, with MuJoCo for scoring robot
controllers (`Dockerfile`). Saved batches and uploads are kept on a Fly volume mounted at `/data`
(`scripts/fly-start.sh` links `batches/`, `datasets/`, `user_scripts/`, `controllers/` and `runs/` into it).
The agents themselves run in Daytona and the models are Anthropic's, as when Orro runs locally.

## What it costs

With `fly.toml` as it is (one `shared-cpu-1x` machine with 1 GB, stopped while nobody uses the site, a 1 GB volume):

- About $6.70 a month if the machine never stopped, much less when it does; Fly waives monthly bills under $5.
- The volume: $0.15 per GB per month.
- Running live batches comfortably: `fly scale memory 2048` (about $13.40 a month while running).

Each batch's own cost is the Anthropic tokens and Daytona sandboxes, as when Orro runs locally (the Costs screen
shows it).

## First deploy

1. Install the CLI and sign in (opens a browser):

   ```sh
   brew install flyctl
   fly auth login
   ```

2. Create the app. The name in `fly.toml` (`orro-research`) must be unique on Fly; if it is taken, pick another and
   change `app =` in `fly.toml` to match.

   ```sh
   fly apps create orro-research
   ```

3. Create the volume, in the same region as `primary_region` in `fly.toml`:

   ```sh
   fly volumes create orro_data --region iad --size 1
   ```

4. Set the keys as secrets (the same names as in `.env.example`; only the two API keys are required to start
   batches, the rest are optional):

   ```sh
   fly secrets set ANTHROPIC_API_KEY=... DAYTONA_API_KEY=... DAYTONA_SNAPSHOT=deep-research-lab
   # optional: ANALYST_MODEL, INVESTIGATOR_MODEL, LANGSMITH_API_KEY, LANGSMITH_TRACING, HUB_URL, HUB_TOKEN, HUB_MACHINE
   ```

5. Deploy (Fly builds the image on its own builders; Docker is not needed locally). `--ha=false` keeps it to one
   machine, which the volume and the server's in-memory batches need:

   ```sh
   fly deploy --ha=false
   fly open
   ```

Without any keys the site still works as a showcase: the landing page and the demo batch replay need none.

## Later

- Deploy a new version: `fly deploy --ha=false`.
- Logs: `fly logs`. Status: `fly status`.
- More memory or CPU: `fly scale memory 2048`, `fly scale vm shared-cpu-2x`.
- A custom domain: `fly certs add orro.example.com`, then point the domain at the app as `fly certs show` says.

## Running live batches

A batch runs on the server. With `auto_stop_machines = "stop"`, Fly stops the machine a few minutes after the last
request, which can cut a running batch short if nobody has it open in a browser. Before running live batches, keep
the machine running: in `fly.toml` set `auto_stop_machines = "off"` and `min_machines_running = 1`, then
`fly deploy --ha=false`.

Switch back to `"stop"` afterwards to stop paying while it is idle.
