# quest-log

Self-hosted project/idea tracker — checkboxes, status pills (idea / active / blocked / done),
and a running mission log. Built as a themed personal tool, not a generic app.

State lives in `data/state.json` on disk (volume-mounted in Docker so it survives rebuilds).
**This file is gitignored and never committed** — the actual project/idea content stays local
to wherever this is deployed and never lands in this (public) repo; only the app code does.
The client fetches nothing on load — the server embeds the current state directly into the
page — and every checkbox toggle, status cycle, or new idea posts the full updated state back
to `POST /api/state`, which overwrites the file. No database, no auth — this is meant to run
on a trusted local network.

## Running locally

```bash
cp data/state.example.json data/state.json  # first time only
npm install
npm start
```

The server refuses to start if `data/state.json` doesn't exist, rather than silently creating
an empty one — `data/state.example.json` (committed, generic, no real content) is the starting
shape to copy from.

## Running with Docker

```bash
docker compose up -d --build
```

`docker-compose.yml` mounts `./data` into the container so state persists across rebuilds.
Exposed on port 4242 by default (see `docker-compose.yml` / `PORT` env var to change it).

## HTTPS

`docker-entrypoint.sh` generates a self-signed cert into `./certs` (also volume-mounted) on
first boot if one isn't already there, then starts the server — no manual setup needed for a
fresh deployment. `server.js` serves over HTTPS automatically whenever `certs/cert.pem` and
`certs/key.pem` exist, falling back to plain HTTP otherwise (e.g. for local dev without a
cert). Configure what the cert covers via `CERT_SAN_DNS` (default `questlog.local`) and
`CERT_SAN_IP` (unset by default) env vars — set `CERT_SAN_IP` to whatever address this is
actually reachable at. Since it's self-signed, browsers still show a one-time "not trusted"
warning to click through; a self-signed cert avoids a hard connection failure on `https://`,
not that warning.

`./certs` is gitignored — the private key never leaves the machine it's generated on.

## mDNS

If you want a `.local` hostname instead of a raw IP (matching `CERT_SAN_DNS` above so the
cert's name actually matches what's in the address bar), that's a host-level concern outside
this app — e.g. a systemd unit running `avahi-publish -a -R questlog.local <ip>` on the
Linux host serving this. Not something Docker or this repo can do on their own since it needs
to talk to the host's own mDNS responder.

## Editing the design

`template.html` holds the styles and the static page shell (head, panels, form). `public/app.js`
holds all client-side rendering and interaction logic. `server.js` just serves the template with
the current state spliced in and handles the `/api/state` save endpoint.
