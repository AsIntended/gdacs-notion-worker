# GDACS → Notion Worker

A [Notion Worker](https://developers.notion.com/workers/get-started/overview.md)
that pulls the [GDACS](https://www.gdacs.org/) global disaster feed and writes
significant (**Orange** and **Red**) events into a Notion-managed database.

Notion hosts and schedules the worker — there's no server to run. You deploy the
code once with the `ntn` CLI and Notion runs the sync on a schedule.

- **Source:** the GDACS RSS/XML feed (`https://www.gdacs.org/xml/rss_24h.xml`)
- **Destination:** a managed Notion database, *Natural Disasters (GDACS Feed)*
- **Cadence:** once per day (configurable)
- **Behaviour:** incremental upsert — the database is an accumulating historical
  log. Events are added and updated, never deleted.

---

## What it captures

Each qualifying GDACS event becomes one row, keyed by its **GDACS ID** (event
type + event id, e.g. `EQ1234567`), so re-seeing an event updates the same row.

| Property | Type | Notes |
| --- | --- | --- |
| Disaster | Title | Event headline |
| GDACS ID | Text | Primary key |
| Type | Select | Earthquake, Tropical Cyclone, Flood, Volcano, Drought, Wildfire, Tsunami |
| Alert Level | Select | Orange / Red |
| Status | Status | Red → *Active*, Orange → *Monitoring* |
| Location | Place | Lat/lon when the feed provides them |
| Last Update | Date | From the feed's `todate` / `pubDate` |
| Source URL | URL | Link to the GDACS report page |
| Country | Text | |
| Severity | Text | |
| Population Exposed | Number | When present |
| Summary | Text | Cleaned description + key facts |

---

## Prerequisites

- **Node.js ≥ 22** and **npm ≥ 10.9.2** (see `package.json` engines).
- The **`ntn` CLI**:
  ```bash
  curl -fsSL https://ntn.dev | bash
  ```
- Access to a Notion workspace where you can deploy workers.

---

## Configuration

Two optional environment variables control the sync (see `.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `GDACS_FEED` | `rss_24h.xml` | Which GDACS feed file to fetch |
| `MIN_ALERT` | `Orange` | Minimum alert level to record: `Orange` (Orange+Red) or `Red` (Red only) |

For local runs, copy the example file:

```bash
cp .env.example .env
```

The worker only reads the public GDACS feed, so it needs **no Notion API token** —
writes go through the managed-database sync mechanism, not `context.notion`.

---

## Deploy

```bash
# 1. Install dependencies
npm install

# 2. Connect the CLI to your Notion workspace (one-time)
ntn login

# 3. Type-check
npm run check

# 4. Deploy the worker and its capabilities
ntn workers deploy

# 5. (Optional) push your config to the deployed worker
ntn workers env push
```

The first deploy creates the *Natural Disasters (GDACS Feed)* database in your
workspace. `ntn workers deploy` does **not** reset sync state — redeploys resume
from the last cursor.

---

## Run & verify

```bash
# Preview what the sync would write, without touching the database
ntn workers sync trigger gdacsSync --preview

# Run a real sync immediately (bypasses the daily schedule)
ntn workers sync trigger gdacsSync

# Watch sync health (HEALTHY / WARNING / ERROR)
ntn workers sync status

# Inspect logs from the most recent run
ntn workers runs list --plain | grep gdacsSync | head -n1 \
  | cut -f1 | xargs -I{} ntn workers runs logs {}
```

---

## Schedule

The sync runs **once per day** (`schedule: "1d"` in `src/index.ts`). Adjust the
interval string to change cadence (min `"5m"`, max `"7d"`), then redeploy:

```ts
worker.sync("gdacsSync", {
  database: disasters,
  mode: "incremental",
  schedule: "1d", // ← change this
  ...
});
```

---

## Customization notes

- **Rolling window instead of a log.** The sync uses `mode: "incremental"`, so
  events accumulate forever. Switch to `mode: "replace"` if you'd rather keep
  only currently-active events — replace mode deletes rows no longer present in
  the feed via mark-and-sweep.
- **Different severity threshold.** Set `MIN_ALERT=Red` to record only Red
  alerts.
- **Different feed window.** Point `GDACS_FEED` at a longer feed (e.g. the 7-day
  feed) if you increase the schedule interval and want to avoid gaps.

---

## Project layout

```
src/index.ts     Worker definition: database schema + gdacsSync sync
.env.example     Configuration template
workers.json     Generated CLI config (workspace + worker id)
package.json     Dependencies and scripts
```

Build/dev commands:

- `npm run check` — type-check only (no emit)
- `npm run build` — compile TypeScript to `dist/`
