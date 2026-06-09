# single-process-do-reproduction

Minimal reproduction for Durable Object concurrency behavior in local Miniflare.

The Worker exposes two Durable Objects:

- `BlockerDO` runs a synchronous CPU loop for a requested number of iterations.
- `ResponderDO` immediately returns `pong`.

The page starts requests to both objects at the same time. In local Miniflare, the `ResponderDO` request is delayed while `BlockerDO` is doing synchronous work. On Cloudflare, the `ResponderDO` request should respond independently.

## Run locally

```sh
npm install
npm run dev
```

Open <http://localhost:8787>, then click **Run reproduction**.

Expected local result:

- `BlockerDO elapsed` reflects the configured CPU work.
- `ResponderDO elapsed` is also delayed by roughly the same amount.
- The page reports `Blocked locally`.

## Deploy

```sh
npm run deploy
```

Production deployment:

<https://single-process-do-reproduction.man4mac.workers.dev>

Expected production result:

- `BlockerDO elapsed` reflects the configured CPU work.
- `ResponderDO elapsed` stays low.
- The page reports `Independent`.

## Server-side race endpoint

The UI uses two browser fetches. There is also a server-side endpoint that starts both subrequests from the Worker:

```sh
curl "http://localhost:8787/api/race?iterations=50000000"
```

This is useful for quickly seeing the same local delay without using the browser UI.
