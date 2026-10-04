// One self-contained page: inline CSS and JavaScript, no external resources. The script builds the DOM
// with createElement/createTextNode only (never innerHTML), so text from GitHub or an agent is never parsed as markup.
// The script must not contain backticks or `${`; backslashes are doubled: it is embedded in a template literal.

const CSS = `
:root { color-scheme: light dark; --bg:#f6f7f9; --fg:#1b1f24; --muted:#5b6570; --card:#fff; --line:#d5dae0; --accent:#0b5fd1; --warn:#9a5b00; --bad:#b3261e; --good:#1a7f37; }
@media (prefers-color-scheme: dark) { :root { --bg:#14171a; --fg:#e6e9ec; --muted:#98a2ad; --card:#1d2125; --line:#343a41; --accent:#6aa7ff; --warn:#f0b24a; --bad:#ff7b72; --good:#56d364; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 system-ui, sans-serif; }
header { display:flex; flex-wrap:wrap; gap:8px 24px; align-items:baseline; padding:12px 20px; border-bottom:1px solid var(--line); background:var(--card); position:sticky; top:0; }
header h1 { font-size:16px; margin:0; }
.stat b { font-size:16px; }
.muted { color:var(--muted); }
.banner { background:var(--bad); color:#fff; padding:8px 20px; font-weight:600; }
main { padding:12px 20px 40px; max-width:1100px; margin:0 auto; }
h2 { font-size:15px; margin:24px 0 8px; }
.empty { color:var(--muted); padding:6px 0; }
details.chain { background:var(--card); border:1px solid var(--line); border-radius:6px; margin:6px 0; }
details.chain > summary { cursor:pointer; padding:8px 12px; display:flex; flex-wrap:wrap; gap:4px 12px; align-items:baseline; }
.badge { display:inline-block; border:1px solid currentColor; border-radius:10px; padding:0 8px; font-size:12px; font-weight:600; }
.s-person { color:var(--warn); } .s-dead, .s-stuck { color:var(--bad); } .s-run { color:var(--accent); } .s-queue { color:var(--muted); } .s-done { color:var(--good); }
.stuck { border-left:4px solid var(--bad); }
.stale { border-left:4px solid var(--warn); }
.notchecked { font-weight:600; }
.body { padding:4px 12px 10px; border-top:1px solid var(--line); }
table { border-collapse:collapse; width:100%; margin:6px 0; }
th, td { text-align:left; padding:2px 10px 2px 0; vertical-align:top; font-size:13px; }
th { color:var(--muted); font-weight:600; }
.ev { font-family: ui-monospace, monospace; font-size:12px; white-space:pre-wrap; word-break:break-word; }
a { color:var(--accent); }
`;

const SCRIPT = `
(function () {
  var POLL_MS = 5000;
  var data = null, lastOk = null, disconnected = false, timer = null;
  var expanded = {}, timelines = {};
  var root = document.getElementById('root');

  function el(tag, attrs) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) if (attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, String(attrs[k]));
    add(e, Array.prototype.slice.call(arguments, 2));
    return e;
  }
  function add(e, list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) add(e, c);
      else e.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    }
  }
  function link(url, text) {
    if (typeof url !== 'string' || url.indexOf('https://github.com/') !== 0) return null;
    return el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, text);
  }
  function dur(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    return Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
  }
  function clock(ms) { return new Date(ms).toISOString().replace('T', ' ').replace(/\\.[0-9]+Z$/, 'Z'); }
  function money(v) { return v === null || v === undefined ? 'unknown' : '$' + Number(v).toFixed(4); }
  function now() { return data ? data.generatedAt : Date.now(); }

  var KIND = {
    person_merge: ['\\u261D', 'person', 's-person'], person_attention: ['\\u261D', 'person', 's-person'],
    dead_letter: ['\\u2716', 'dead letter', 's-dead'], stuck: ['\\u26A0', 'stuck', 's-stuck'],
    running: ['\\u25B6', 'running', 's-run'], reviewer: ['\\u25B6', 'reviewer', 's-run'],
    worker: ['\\u23F8', 'queued', 's-queue'], none: ['\\u2022', 'idle', 's-queue']
  };
  function badge(chain) {
    if (!chain.waitingOn) {
      var done = chain.status === 'completed';
      return el('span', { class: 'badge ' + (done ? 's-done' : 's-queue') }, (done ? '\\u2714 ' : '\\u2716 ') + chain.status);
    }
    var k = KIND[chain.waitingOn.kind] || KIND.none;
    var running = chain.jobs.some(function (j) { return j.status === 'running'; });
    var text = chain.waitingOn.kind === 'reviewer' && !running ? 'reviewer queued' : k[1];
    return el('span', { class: 'badge ' + k[2] }, k[0] + ' ' + text);
  }
  function subjectText(c) { return c.subject ? c.subject.repo + '#' + c.subject.issueNumber : c.subjectKey; }

  function eventLine(e) {
    var d = e.detail && Object.keys(e.detail).length ? ' ' + JSON.stringify(e.detail) : '';
    var where = (e.jobId === null ? '' : ' job=' + e.jobId) + (e.delivery === null ? '' : ' delivery=' + e.delivery);
    return clock(e.at) + ' ' + e.kind + where + d;
  }
  function eventList(events) {
    if (!events.length) return el('div', { class: 'muted' }, 'no events');
    return el.apply(null, ['div', { class: 'ev' }].concat(events.map(function (e) { return el('div', null, eventLine(e)); })));
  }
  function jobsTable(jobs) {
    var rows = jobs.map(function (j) {
      return el('tr', null, el('td', null, j.id), el('td', null, j.type), el('td', null, j.attempt), el('td', null, j.status),
        el('td', null, j.delivery), el('td', null, j.workerId || ''),
        el('td', null, j.leaseExpiresAt ? clock(j.leaseExpiresAt) : ''), el('td', null, money(j.costUsd)));
    });
    var head = el('tr', null, ['job', 'type', 'attempt', 'status', 'delivery', 'worker', 'lease expires', 'cost'].map(function (h) { return el('th', null, h); }));
    return el.apply(null, ['table', null, head].concat(rows));
  }
  function waitText(c) {
    var w = c.waitingOn;
    if (!w) return null;
    var parts = ['waiting on ' + w.label];
    if (w.detail) parts.push(w.detail);
    if (w.since !== null && (w.kind === 'person_merge' || w.kind === 'person_attention' || w.kind === 'dead_letter')) parts.push('waiting ' + dur(now() - w.since));
    return parts.join(' \\u2014 ');
  }

  function checkText(c) {
    if (c.status !== 'waiting') return null;
    var t = c.lastCheckedAt === null || c.lastCheckedAt === undefined ? 'never checked'
      : 'checked ' + dur(now() - c.lastCheckedAt) + ' ago' + (c.lastCheckResult ? ' (' + c.lastCheckResult + ')' : '');
    return c.checkStale ? el('span', { class: 'notchecked' }, '\\u26A0 not checked recently \\u2014 ' + t) : el('span', { class: 'muted' }, t);
  }

  function chainCard(c, opts) {
    var open = !!expanded[c.id];
    var w = c.waitingOn;
    var sum = el('summary', null, badge(c), el('strong', null, subjectText(c)),
      el('span', { class: 'muted' }, c.engine + ' / ' + c.status + (c.phase ? ' / ' + c.phase : '') + (c.attempt ? ' / attempt ' + c.attempt : '')),
      waitText(c) ? el('span', null, waitText(c)) : null, checkText(c));
    var bodyParts = [];
    var links = [link(c.links.issue, 'issue'), link(c.links.pullRequest, 'pull request')].filter(Boolean);
    if (links.length) bodyParts.push(el.apply(null, ['div', null, 'links: '].concat(links.flatMap(function (l) { return [l, ' ']; }))));
    bodyParts.push(el('div', { class: 'muted' }, 'chain ' + c.id + ' / total cost ' + money(c.totalCostUsd)));
    if (open) {
      var t = timelines[c.id];
      bodyParts.push(el('h3', null, 'Jobs'), jobsTable(c.jobs), el('h3', null, 'Timeline'), t ? eventList(t.events) : el('div', { class: 'muted' }, 'loading\\u2026'));
    } else {
      bodyParts.push(el('div', { class: 'muted' }, 'latest events'), eventList(opts && opts.allEvents ? c.events : c.events.slice(-3)));
    }
    var attrs = { class: 'chain' + (w && w.kind === 'stuck' ? ' stuck' : '') + (c.checkStale ? ' stale' : ''), 'data-chain': c.id };
    if (open) attrs.open = '';
    var d = el.apply(null, ['details', attrs, sum, el.apply(null, ['div', { class: 'body' }].concat(bodyParts))]);
    d.addEventListener('toggle', function () {
      var isOpen = d.hasAttribute('open');
      if (isOpen === !!expanded[c.id]) return;
      if (isOpen) { expanded[c.id] = true; loadTimeline(c.id); } else delete expanded[c.id];
      render();
    });
    return d;
  }

  function section(title, chains, emptyText, opts) {
    var items = chains.length ? chains.map(function (c) { return chainCard(c, opts); }) : [el('div', { class: 'empty' }, emptyText)];
    return el.apply(null, ['section', null, el('h2', null, title + ' (' + chains.length + ')')].concat(items));
  }
  function hasRunning(c) { return c.jobs.some(function (j) { return j.status === 'running'; }); }
  function isPerson(c) { var k = c.waitingOn && c.waitingOn.kind; return k === 'person_merge' || k === 'person_attention' || k === 'dead_letter'; }

  function render() {
    if (!data) { root.replaceChildren(el('main', null, el('div', { class: 'empty' }, disconnected ? 'Waiting for the server\\u2026' : 'Loading\\u2026')), banner()); return; }
    var open = data.openChains;
    var needs = open.filter(isPerson);
    var progress = open.filter(function (c) { return !isPerson(c) && hasRunning(c); });
    var queued = open.filter(function (c) { return !isPerson(c) && !hasRunning(c); });
    var s = data.summary;
    var head = el('header', null, el('h1', null, 'Factory dashboard'),
      el('span', { class: 'stat' }, el('b', null, s.workers), ' workers alive'),
      el('span', { class: 'stat' }, el('b', null, s.runningJobs), ' running'),
      el('span', { class: 'stat' }, el('b', null, s.waitingOnPerson), ' waiting on a person'),
      el('span', { class: 'muted' }, 'total cost ' + money(data.totalCostUsd)),
      el('span', { class: 'muted' }, 'last refresh ' + (lastOk ? clock(lastOk) : 'never')));
    var workerRow = function (w) {
      return el('tr', null, el('td', null, w.id), el('td', null, w.pid), el('td', null, w.host), el('td', null, w.alive ? '\\u2714 alive' : '\\u2716 dead'),
        el('td', null, dur(w.heartbeatAgeMs) + ' ago'), el('td', null, w.currentJobId === null ? 'idle' : 'job ' + w.currentJobId + (w.currentChainId ? ' (chain ' + w.currentChainId + ')' : '')));
    };
    var workerTable = function (list) {
      return el.apply(null, ['table', null, el('tr', null, ['worker', 'pid', 'host', 'state', 'heartbeat', 'job'].map(function (h) { return el('th', null, h); }))].concat(list.map(workerRow)));
    };
    var aliveList = data.workers.filter(function (w) { return w.alive; });
    var stoppedList = data.workers.filter(function (w) { return !w.alive; });
    var workers = el('div', null,
      aliveList.length ? workerTable(aliveList) : el('div', { class: 'empty' }, data.workers.length ? 'no worker is alive' : 'no workers have registered'),
      stoppedList.length
        ? el('details', null, el('summary', null, 'Stopped workers (' + s.stoppedWorkers + ')'), workerTable(stoppedList),
            s.stoppedWorkers > stoppedList.length ? el('div', { class: 'muted' }, 'showing the ' + stoppedList.length + ' most recently seen') : null)
        : null);
    root.replaceChildren(head, banner(), el('main', null,
      section('Needs you', needs, 'Nothing is waiting on you.'),
      section('In progress', progress, 'No job is running.'),
      section('Queued', queued, 'Nothing is queued.'),
      section('Recently finished', data.finishedChains, 'Nothing has finished yet.'),
      el('h2', null, 'Workers'), workers,
      el('p', { class: 'muted' }, 'Shows what the factory records: job and chain state, not the agent\\u2019s live steps or tool calls.')));
  }
  function banner() {
    return disconnected ? el('div', { class: 'banner', role: 'alert' }, '\\u26A0 Disconnected: cannot reach the server. Showing the last data' + (lastOk ? ' from ' + clock(lastOk) : '') + '.') : null;
  }

  function loadTimeline(id) {
    return fetch('/api/chains/' + id, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (t) {
      if (t) { timelines[id] = t; render(); }
    }).catch(function () {});
  }
  function poll() {
    return fetch('/api/overview', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    }).then(function (o) {
      data = o; lastOk = Date.now(); disconnected = false;
      render();
      return Promise.all(Object.keys(expanded).map(function (id) { return loadTimeline(id); }));
    }).catch(function () { disconnected = true; render(); });
  }
  function schedule() {
    timer = setTimeout(function () {
      if (document.hidden) { schedule(); return; }
      poll().then(schedule);
    }, POLL_MS);
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { clearTimeout(timer); poll().then(schedule); }
  });
  render();
  poll().then(schedule);
})();
`;

export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Factory dashboard</title>
<style>${CSS}</style>
</head>
<body>
<div id="root"></div>
<script>${SCRIPT}</script>
</body>
</html>
`;
