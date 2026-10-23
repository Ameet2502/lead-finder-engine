#!/usr/bin/env node
// Runs an exported n8n workflow (Settings node + Code nodes) as plain Node.js - no n8n, no PC.
// usage: node engine/run.js workflows/Email_Checker.json [--state state/checker.json]
// Keys come from environment variables (GitHub Secrets), exactly like $env in n8n.
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const wfFile = args[0];
const stateFile = (() => { const i = args.indexOf('--state'); return i >= 0 ? args[i + 1] : null; })();
if (!wfFile) { console.error('usage: node engine/run.js <workflow.json> [--state file]'); process.exit(2); }
const wf = JSON.parse(fs.readFileSync(wfFile, 'utf8'));

// ---------- persistent memory between runs (n8n "static data") ----------
let staticData = {};
if (stateFile && fs.existsSync(stateFile)) { try { staticData = JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; } catch (e) { staticData = {}; } }
function saveState() {
  if (!stateFile) return;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(staticData));
}

// ---------- keys: one GitHub Secret KEYS_TXT holding the whole keys.txt (NAME=value per line) ----------
for (const line of String(process.env.KEYS_TXT || '').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
delete process.env.KEYS_TXT;

// ---------- n8n expression "={{ ... }}" in the Settings node ----------
const $env = process.env;
function evalValue(v, type) {
  if (typeof v === 'string' && v.startsWith('={{') && v.endsWith('}}')) {
    // eslint-disable-next-line no-new-func
    v = new Function('$env', 'return (' + v.slice(3, -2) + ');')($env);
  }
  if (type === 'number') return Number(v);
  if (type === 'boolean') return v === true || v === 'true';
  return v;
}

// ---------- this.helpers.httpRequest (the subset the engine uses) ----------
async function httpRequest(o) {
  let url = o.url;
  if (o.qs) {
    const u = new URL(url);
    for (const [k, val] of Object.entries(o.qs)) if (val !== undefined && val !== null) u.searchParams.append(k, String(val));
    url = u.toString();
  }
  const headers = Object.assign({}, o.headers || {});
  let body;
  if (o.body !== undefined && o.body !== null && o.method && o.method !== 'GET') {
    if (typeof o.body === 'string') body = o.body;
    else { body = JSON.stringify(o.body); if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json'; }
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Number(o.timeout || 60000));
  let res;
  try {
    res = await fetch(url, { method: o.method || 'GET', headers, body, redirect: 'follow', signal: ctl.signal });
  } catch (e) {
    const err = new Error(e.name === 'AbortError' ? 'timeout of ' + (o.timeout || 60000) + 'ms exceeded' : 'Request failed: ' + (e.cause && e.cause.code || e.message));
    throw err;
  } finally { clearTimeout(timer); }
  const text = await res.text();
  let data = text;
  if (o.json !== false) { try { data = JSON.parse(text); } catch (e) { data = text; } }
  if (!res.ok) {
    const err = new Error('Request failed with status code ' + res.status);
    err.httpCode = String(res.status); err.description = String(typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 300);
    err.response = { status: res.status, data };
    throw err;
  }
  return data;
}

// ---------- run the nodes in connection order ----------
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
const outputs = {};
const trigger = wf.nodes.find((n) => /scheduleTrigger/.test(n.type));
const order = [];
for (let cur = trigger && trigger.name; cur;) {
  const next = (((wf.connections[cur] || {}).main || [])[0] || [])[0];
  cur = next && next.node; if (cur) order.push(cur);
}
const $ = (name) => {
  if (!(name in outputs)) throw new Error(`Node '${name}' hasn't been executed`);
  const items = outputs[name];
  return { first: () => items[0], last: () => items[items.length - 1], all: () => items, item: items[0] };
};
// a step that fails is logged and skipped so the rest of the run still writes its results;
// only these are fatal (nothing useful can happen without them)
const FATAL = new Set(['Settings', 'Load', 'Check emails']);

// can this machine talk to mail servers on port 25? (most clouds block it) - if not, skip the free self-check
function port25Open() {
  return new Promise((resolve) => {
    const net = require('net');
    const sock = net.createConnection({ port: 25, host: 'gmail-smtp-in.l.google.com' });
    const t = setTimeout(() => { sock.destroy(); resolve(false); }, 8000);
    sock.setEncoding('utf8');
    sock.on('data', (d) => { clearTimeout(t); try { sock.end('QUIT\r\n'); } catch (e) { /* */ } resolve(/^220/.test(d)); });
    sock.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

(async () => {
  const t0 = Date.now();
  const p25 = process.env.SMTP_SELFCHECK === 'false' ? false : await port25Open();
  console.log('Free mail-server check (port 25): ' + (p25 ? 'available' : 'blocked here - using email-check APIs only'));
  const summary = { workflow: wf.name, port25: p25, steps: [] };
  let failed = false;
  for (const name of order) {
    const n = byName[name];
    const t1 = Date.now();
    try {
      if (/\.set$/.test(n.type)) {
        const j = {};
        for (const a of n.parameters.assignments.assignments) j[a.name] = evalValue(a.value, a.type);
        if (process.env.RUN_MODE && 'run_mode' in j) j.run_mode = process.env.RUN_MODE;
        if (!p25 && 'smtp_selfcheck' in j) j.smtp_selfcheck = false;
        outputs[name] = [{ json: j }];
      } else if (/\.code$/.test(n.type)) {
        const fn = new AsyncFunction('$', '$getWorkflowStaticData', '$env', 'require', n.parameters.jsCode);
        const out = await fn.call({ helpers: { httpRequest } }, $, () => staticData, $env, require);
        outputs[name] = Array.isArray(out) ? out : [{ json: out || {} }];
      } else continue;
      saveState();
      summary.steps.push({ step: name, ok: true, seconds: Math.round((Date.now() - t1) / 1000) });
      console.log(`OK   ${name}  (${Math.round((Date.now() - t1) / 1000)}s)`);
    } catch (e) {
      const msg = String((e && (e.stack || e.message)) || e).slice(0, 1500);
      console.log(`FAIL ${name}: ${msg}`);
      summary.steps.push({ step: name, ok: false, error: msg.slice(0, 300) });
      saveState();
      if (FATAL.has(name)) { failed = true; break; }
      outputs[name] = [{ json: { failed: true, error: msg.slice(0, 300), peopleNotes: ['Step "' + name + '" failed: ' + msg.slice(0, 120)] } }];
    }
  }
  const lastName = order[order.length - 1];
  if (outputs[lastName]) summary.result = outputs[lastName][0].json;
  summary.minutes = Math.round((Date.now() - t0) / 600) / 100;
  console.log('\n===== RESULT =====\n' + JSON.stringify(summary, null, 1).slice(0, 20000));
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '## ' + wf.name + '\n```json\n' + JSON.stringify(summary, null, 1).slice(0, 60000) + '\n```\n');
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); saveState(); process.exit(1); });
