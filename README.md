# quest-log

Self-hosted project/idea tracker — checkboxes, status pills (idea / active / blocked / done),
and a running mission log. Built as a themed personal tool, not a generic app.

State lives in `data/state.json` on disk (volume-mounted in Docker so it survives rebuilds).
The client fetches nothing on load — the server embeds the current state directly into the
page — and every checkbox toggle, status cycle, or new idea posts the full updated state back
to `POST /api/state`, which overwrites the file. No database, no auth — this is meant to run
on a trusted local network.

## Running locally

```bash
npm install
npm start
```

Requires `data/state.json` to already exist (a starting one is committed in this repo) — the
server refuses to start without it rather than silently creating an empty one.

## Running with Docker

```bash
docker compose up -d --build
```

`docker-compose.yml` mounts `./data` into the container so state persists across rebuilds.
Exposed on port 4242 by default (see `docker-compose.yml` / `PORT` env var to change it).

## Editing the design

`template.html` holds the styles and the static page shell (head, panels, form). `public/app.js`
holds all client-side rendering and interaction logic. `server.js` just serves the template with
the current state spliced in and handles the `/api/state` save endpoint.
