import { DurableObject } from "cloudflare:workers";

export interface Env {
  BLOCKER: DurableObjectNamespace<BlockerDO>;
  RESPONDER: DurableObjectNamespace<ResponderDO>;
}

type JsonRecord = Record<string, unknown>;

function json(data: JsonRecord, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init?.headers,
    },
  });
}

function getWorkIterations(request: Request): number {
  const url = new URL(request.url);
  const rawIterations = url.searchParams.get("iterations");
  if (rawIterations !== null) {
    const iterations = Number(rawIterations);
    if (Number.isFinite(iterations)) {
      return Math.max(1_000_000, Math.min(300_000_000, Math.trunc(iterations)));
    }
  }

  // Back-compat for quick curl experiments with ?ms=3000. This is intentionally
  // not a wall-clock loop; production Workers may not advance Date.now() during
  // tight CPU loops.
  const rawMs = Number(url.searchParams.get("ms") ?? "1500");
  const ms = Number.isFinite(rawMs) ? Math.max(100, Math.min(8000, rawMs)) : 3000;
  return Math.trunc(ms * 33_000);
}

function busyLoop(iterations: number): { accumulator: number; iterations: number } {
  let accumulator = 0;

  for (let i = 0; i < iterations; i++) {
    accumulator =
      (accumulator + Math.sqrt((i % 997) + (accumulator % 13))) % 1_000_000;
  }

  return { accumulator, iterations };
}

export class BlockerDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const iterations = getWorkIterations(request);
    const startedAt = Date.now();
    const work = busyLoop(iterations);
    const finishedAt = Date.now();

    return json({
      durableObject: "BlockerDO",
      requestedIterations: iterations,
      observedBlockMs: finishedAt - startedAt,
      startedAt,
      finishedAt,
      accumulator: work.accumulator,
    });
  }
}

export class ResponderDO extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    return json({
      durableObject: "ResponderDO",
      message: "pong",
      respondedAt: Date.now(),
    });
  }
}

async function callBlocker(env: Env, request: Request): Promise<Response> {
  const id = env.BLOCKER.idFromName("single-blocker-instance");
  const stub = env.BLOCKER.get(id);
  return stub.fetch(request);
}

async function callResponder(env: Env): Promise<Response> {
  const id = env.RESPONDER.idFromName("single-responder-instance");
  const stub = env.RESPONDER.get(id);
  return stub.fetch("https://do.internal/ping");
}

async function runServerSideRace(env: Env, request: Request): Promise<Response> {
  const iterations = getWorkIterations(request);
  const startedAt = Date.now();
  const blockerPromise = callBlocker(
    env,
    new Request(`https://do.internal/block?iterations=${iterations}`)
  ).then(async (response) => response.json<JsonRecord>());
  const responderPromise = callResponder(env).then(async (response) => {
    const body = await response.json<JsonRecord>();
    return {
      ...body,
      elapsedSinceRaceStartMs: Date.now() - startedAt,
    };
  });

  const [blocker, responder] = await Promise.all([
    blockerPromise,
    responderPromise,
  ]);

  return json({
    mode: "server-side race",
    note:
      "In local Miniflare, ResponderDO is typically delayed until BlockerDO finishes its CPU loop.",
    totalElapsedMs: Date.now() - startedAt,
    blocker,
    responder,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/block") {
      return callBlocker(env, request);
    }

    if (url.pathname === "/api/ping") {
      return callResponder(env);
    }

    if (url.pathname === "/api/race") {
      return runServerSideRace(env, request);
    }

    return new Response(INDEX_HTML, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Durable Object local concurrency reproduction</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.45;
      background: #f7f7f4;
      color: #202124;
    }
    body {
      margin: 0;
      padding: 32px;
    }
    main {
      max-width: 920px;
      margin: 0 auto;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 28px;
    }
    p {
      margin: 0 0 20px;
      max-width: 760px;
    }
    .controls,
    .results {
      border: 1px solid #d6d6ce;
      background: #fff;
      border-radius: 8px;
      padding: 18px;
      margin-top: 18px;
    }
    label {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-right: 12px;
    }
    input {
      width: 92px;
      padding: 7px 8px;
      border: 1px solid #b9b9af;
      border-radius: 6px;
      font: inherit;
    }
    button {
      border: 0;
      border-radius: 6px;
      background: #1769aa;
      color: white;
      padding: 9px 13px;
      font: inherit;
      cursor: pointer;
    }
    button:disabled {
      opacity: 0.55;
      cursor: wait;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 12px;
      margin-top: 14px;
    }
    .metric {
      border: 1px solid #d6d6ce;
      border-radius: 8px;
      padding: 14px;
      background: #fbfbf8;
      min-height: 94px;
    }
    .metric strong {
      display: block;
      margin-bottom: 6px;
      font-size: 14px;
      color: #4d4f53;
    }
    .metric span {
      font-size: 24px;
      font-weight: 700;
    }
    pre {
      overflow: auto;
      background: #202124;
      color: #f8f8f2;
      border-radius: 8px;
      padding: 14px;
      font-size: 13px;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        background: #17181a;
        color: #f2f2ef;
      }
      .controls,
      .results {
        background: #222326;
        border-color: #44464c;
      }
      .metric {
        background: #1b1c1f;
        border-color: #44464c;
      }
      .metric strong {
        color: #c6c7c9;
      }
      input {
        background: #17181a;
        color: #f2f2ef;
        border-color: #555860;
      }
    }
  </style>
</head>
<body>
  <main>
    <h1>Durable Object local concurrency reproduction</h1>
    <p>
      Click the button to start synchronous CPU work in BlockerDO while concurrently asking ResponderDO for a pong.
      In local Miniflare, ResponderDO is delayed. On Cloudflare, ResponderDO should respond independently.
    </p>

    <section class="controls">
      <label>
        Work iterations
        <input id="iterations" type="number" min="1000000" max="300000000" step="1000000" value="50000000" />
      </label>
      <button id="run">Run reproduction</button>
    </section>

    <section class="results" aria-live="polite">
      <div class="grid">
        <div class="metric">
          <strong>ResponderDO elapsed</strong>
          <span id="pingElapsed">-</span>
        </div>
        <div class="metric">
          <strong>BlockerDO elapsed</strong>
          <span id="blockElapsed">-</span>
        </div>
        <div class="metric">
          <strong>Interpretation</strong>
          <span id="summary">Idle</span>
        </div>
      </div>
      <pre id="details">Click "Run reproduction" to start.</pre>
    </section>
  </main>

  <script>
    const run = document.querySelector("#run");
    const iterationsInput = document.querySelector("#iterations");
    const pingElapsed = document.querySelector("#pingElapsed");
    const blockElapsed = document.querySelector("#blockElapsed");
    const summary = document.querySelector("#summary");
    const details = document.querySelector("#details");

    function setText(el, text) {
      el.textContent = text;
    }

    async function timedJson(url) {
      const startedAt = Date.now();
      const response = await fetch(url, { cache: "no-store" });
      const body = await response.json();
      return {
        elapsedMs: Date.now() - startedAt,
        status: response.status,
        body,
      };
    }

    run.addEventListener("click", async () => {
      const iterations = Math.max(1000000, Math.min(300000000, Number(iterationsInput.value) || 50000000));
      run.disabled = true;
      setText(pingElapsed, "running");
      setText(blockElapsed, "running");
      setText(summary, "Running");
      details.textContent = "Started both requests at " + new Date().toISOString();

      try {
        const blockPromise = timedJson("/api/block?iterations=" + iterations);
        const pingPromise = timedJson("/api/ping");
        const [block, ping] = await Promise.all([blockPromise, pingPromise]);
        const blocked = ping.elapsedMs > Math.max(500, block.elapsedMs * 0.75);

        setText(pingElapsed, ping.elapsedMs + " ms");
        setText(blockElapsed, block.elapsedMs + " ms");
        setText(summary, blocked ? "Blocked locally" : "Independent");
        details.textContent = JSON.stringify({ block, ping }, null, 2);
      } catch (error) {
        setText(summary, "Error");
        details.textContent = error.stack || String(error);
      } finally {
        run.disabled = false;
      }
    });
  </script>
</body>
</html>`;
