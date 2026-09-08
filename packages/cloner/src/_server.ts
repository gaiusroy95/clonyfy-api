import http from 'http';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { runClone } from './runClone.js';

interface ActiveJob {
  url: string;
  outDir: string;
  started: number;
  status: 'running' | 'done' | 'error';
  log: string[];
  error?: string;
  result?: { pages: number; assets: number; apiRoutes: number };
}

const jobs = new Map<string, ActiveJob>();
let jobSeq = 0;

function uid(): string {
  return `${Date.now()}-${++jobSeq}`;
}

function listSites(outBase: string): Array<{ name: string; url: string; pages: number; clonedAt: string }> {
  if (!existsSync(outBase)) return [];
  return readdirSync(outBase, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = join(outBase, d.name);
      const manifestPath = join(dir, 'manifest.json');
      if (!existsSync(manifestPath)) return null;
      try {
        const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
        return {
          name: d.name,
          url: m.targetOrigin ?? d.name,
          pages: Array.isArray(m.pages) ? m.pages.length : 0,
          clonedAt: m.capturedAt ?? statSync(manifestPath).mtime.toISOString(),
        };
      } catch { return null; }
    })
    .filter(Boolean) as Array<{ name: string; url: string; pages: number; clonedAt: string }>;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pageHtml(outBase: string): string {
  const sites = listSites(outBase);
  const sitesRows = sites.length
    ? sites.map((s) => `
        <tr>
          <td><strong>${esc(s.name)}</strong></td>
          <td><a href="${esc(s.url)}" target="_blank">${esc(s.url)}</a></td>
          <td>${s.pages}</td>
          <td>${new Date(s.clonedAt).toLocaleString()}</td>
        </tr>`).join('')
    : '<tr><td colspan="4" style="color:#666;text-align:center">No cloned sites yet</td></tr>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CLONYFY Dev Server</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:#0a0a0a;color:#e5e5e5;min-height:100vh;padding:40px 24px}
  h1{font-size:22px;font-weight:800;background:linear-gradient(135deg,#5b8def,#a855f7);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:4px}
  .sub{color:#666;font-size:13px;margin-bottom:32px}
  .card{background:#111;border:1px solid #222;border-radius:12px;padding:24px;margin-bottom:24px}
  .card h2{font-size:14px;font-weight:700;margin-bottom:16px;color:#aaa;text-transform:uppercase;letter-spacing:.06em}
  .row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
  input[type=text]{flex:1;min-width:220px;background:#1a1a1a;border:1px solid #333;border-radius:8px;color:#e5e5e5;font-size:13px;padding:10px 14px;outline:none}
  input[type=text]:focus{border-color:#5b8def}
  input[type=number]{width:80px;background:#1a1a1a;border:1px solid #333;border-radius:8px;color:#e5e5e5;font-size:13px;padding:10px 10px;outline:none}
  input[type=number]:focus{border-color:#5b8def}
  label{font-size:11px;color:#666;display:block;margin-bottom:5px}
  button{background:linear-gradient(135deg,#5b8def,#a855f7);color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:700;padding:10px 20px;cursor:pointer;transition:opacity .15s}
  button:hover{opacity:.85}
  button:disabled{opacity:.4;cursor:not-allowed}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th{text-align:left;padding:8px 12px;color:#555;font-weight:600;border-bottom:1px solid #1e1e1e}
  td{padding:8px 12px;border-bottom:1px solid #181818;color:#ccc}
  td a{color:#5b8def;text-decoration:none}
  td a:hover{text-decoration:underline}
  #log{background:#0d0d0d;border:1px solid #1e1e1e;border-radius:8px;padding:16px;font-family:'SF Mono',Consolas,monospace;font-size:11px;line-height:1.6;max-height:360px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;color:#88cc88;display:none;margin-top:16px}
  #log.show{display:block}
  #status-msg{font-size:12px;margin-top:10px;color:#888}
  .badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;text-transform:uppercase}
  .badge.done{background:rgba(31,209,122,.1);color:#1fd17a}
  .badge.error{background:rgba(255,69,96,.1);color:#ff4560}
  .badge.running{background:rgba(91,141,239,.1);color:#5b8def}
</style>
</head>
<body>
<h1>CLONYFY</h1>
<p class="sub">Development server — clone websites and preview results locally</p>

<div class="card">
  <h2>New Clone</h2>
  <div class="row">
    <div style="flex:1;min-width:220px">
      <label for="url-input">Target URL</label>
      <input id="url-input" type="text" placeholder="https://example.com" />
    </div>
    <div>
      <label for="max-pages">Max pages</label>
      <input id="max-pages" type="number" value="20" min="1" max="200" />
    </div>
    <div>
      <label for="depth">Depth</label>
      <input id="depth" type="number" value="2" min="1" max="10" />
    </div>
    <div style="padding-bottom:0">
      <button id="clone-btn" onclick="startClone()">Clone</button>
    </div>
  </div>
  <div id="status-msg"></div>
  <div id="log"></div>
</div>

<div class="card">
  <h2>Cloned Sites</h2>
  <table>
    <thead><tr><th>Name</th><th>Origin</th><th>Pages</th><th>Cloned At</th></tr></thead>
    <tbody id="sites-tbody">${sitesRows}</tbody>
  </table>
</div>

<script>
let currentEs = null;

function startClone() {
  const url = document.getElementById('url-input').value.trim();
  if (!url) { alert('Enter a URL first'); return; }
  const maxPages = parseInt(document.getElementById('max-pages').value) || 20;
  const depth = parseInt(document.getElementById('depth').value) || 2;

  const btn = document.getElementById('clone-btn');
  const log = document.getElementById('log');
  const msg = document.getElementById('status-msg');
  btn.disabled = true;
  log.textContent = '';
  log.className = 'show';
  msg.textContent = 'Starting…';

  if (currentEs) { currentEs.close(); currentEs = null; }

  fetch('/api/clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, maxPages, depth }),
  }).then(r => r.json()).then(data => {
    if (data.error) { msg.textContent = 'Error: ' + data.error; btn.disabled = false; return; }
    const jobId = data.jobId;
    msg.textContent = 'Running…';
    const es = new EventSource('/api/clone/' + jobId + '/events');
    currentEs = es;
    es.addEventListener('log', e => {
      log.textContent += e.data + '\\n';
      log.scrollTop = log.scrollHeight;
    });
    es.addEventListener('done', e => {
      es.close();
      const result = JSON.parse(e.data);
      msg.innerHTML = '<span class="badge done">Done</span> ' + result.pages + ' pages · ' + result.assets + ' assets · ' + result.apiRoutes + ' API routes';
      btn.disabled = false;
      refreshSites();
    });
    es.addEventListener('error_event', e => {
      es.close();
      msg.innerHTML = '<span class="badge error">Failed</span> ' + e.data;
      btn.disabled = false;
    });
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) return;
      es.close();
      msg.innerHTML = '<span class="badge error">Connection lost</span>';
      btn.disabled = false;
    };
  }).catch(err => {
    msg.textContent = 'Request failed: ' + err.message;
    btn.disabled = false;
  });
}

function refreshSites() {
  fetch('/api/sites').then(r => r.json()).then(sites => {
    const tbody = document.getElementById('sites-tbody');
    if (!sites.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="color:#666;text-align:center">No cloned sites yet</td></tr>';
      return;
    }
    tbody.innerHTML = sites.map(s => \`
      <tr>
        <td><strong>\${s.name}</strong></td>
        <td><a href="\${s.url}" target="_blank">\${s.url}</a></td>
        <td>\${s.pages}</td>
        <td>\${new Date(s.clonedAt).toLocaleString()}</td>
      </tr>\`).join('');
  }).catch(() => {});
}

document.getElementById('url-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') startClone();
});
</script>
</body>
</html>`;
}

function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export async function startServer(outBase: string, port: number): Promise<void> {
  const outDir = resolve(outBase);

  const server = http.createServer((req, res) => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    const path = url.split('?')[0];

    // GET / — serve UI
    if (method === 'GET' && path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(pageHtml(outDir));
      return;
    }

    // GET /api/sites — list cloned sites
    if (method === 'GET' && path === '/api/sites') {
      json(res, listSites(outDir));
      return;
    }

    // POST /api/clone — start a clone job
    if (method === 'POST' && path === '/api/clone') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let payload: { url?: string; maxPages?: number; depth?: number };
        try { payload = JSON.parse(body || '{}'); } catch { json(res, { error: 'Bad JSON' }, 400); return; }

        const targetUrl = (payload.url ?? '').trim();
        if (!targetUrl) { json(res, { error: 'url is required' }, 400); return; }
        try { new URL(targetUrl); } catch { json(res, { error: 'Invalid URL' }, 400); return; }

        const jobId = uid();
        const job: ActiveJob = {
          url: targetUrl,
          outDir: join(outDir, new URL(targetUrl).hostname.replace(/[^a-zA-Z0-9.-]/g, '_')),
          started: Date.now(),
          status: 'running',
          log: [],
        };
        jobs.set(jobId, job);

        runClone({
          url: targetUrl,
          out: job.outDir,
          maxPages: Math.min(200, Math.max(1, payload.maxPages ?? 20)),
          depth: Math.min(10, Math.max(1, payload.depth ?? 2)),
          concurrency: 1,
          ignoreRobots: false,
          verbose: false,
        }, {
          onLog: (line) => { job.log.push(line); },
        }).then((result) => {
          job.status = 'done';
          job.result = { pages: result.pages, assets: result.assets, apiRoutes: result.apiRoutes };
        }).catch((err: unknown) => {
          job.status = 'error';
          job.error = err instanceof Error ? err.message : String(err);
        });

        json(res, { jobId });
      });
      return;
    }

    // GET /api/clone/:jobId/events — SSE progress stream
    const sseMatch = path.match(/^\/api\/clone\/([^/]+)\/events$/);
    if (method === 'GET' && sseMatch) {
      const jobId = sseMatch[1];
      const job = jobs.get(jobId);
      if (!job) { json(res, { error: 'Job not found' }, 404); return; }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.flushHeaders?.();

      let sent = 0;
      const send = (event: string, data: string) => {
        res.write(`event: ${event}\ndata: ${data}\n\n`);
      };

      const flush = () => {
        while (sent < job.log.length) {
          send('log', job.log[sent++]);
        }
        if (job.status === 'done') {
          send('done', JSON.stringify(job.result));
          clearInterval(timer);
          res.end();
        } else if (job.status === 'error') {
          send('error_event', job.error ?? 'Unknown error');
          clearInterval(timer);
          res.end();
        }
      };

      const timer = setInterval(flush, 200);
      req.on('close', () => clearInterval(timer));
      flush();
      return;
    }

    json(res, { error: 'Not found' }, 404);
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, () => resolve());
    server.once('error', reject);
  });

  console.log(`\nCLONYFY dev server running at http://localhost:${port}`);
  console.log(`Output directory: ${outDir}`);
  console.log('Press Ctrl+C to stop.\n');

  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => { server.close(() => resolve()); });
    process.on('SIGTERM', () => { server.close(() => resolve()); });
  });
}
