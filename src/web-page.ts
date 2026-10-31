// The routines GUI as one self-contained HTML document (inline CSS/JS, no dependencies, works
// offline). Served by src/web.ts at GET /. All routine data is rendered with textContent, never
// innerHTML, so titles and prompts cannot inject markup. The script avoids template literals so
// this file can hold the page in a single template string.
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cua-bot routines</title>
<style>
 :root { --ink:#17191c; --muted:#5d6470; --line:#d9dce1; --bg:#f4f5f7; --card:#fff; --code:#eef0f2; --danger:#b42318; --focus:#2f6fed; }
 * { box-sizing:border-box; }
 body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 "Segoe UI",system-ui,sans-serif; }
 main { max-width:880px; margin:0 auto; padding:36px 20px 72px; }
 h1 { font-size:24px; margin:0 0 4px; letter-spacing:-.01em; }
 h2 { font-size:16px; margin:0 0 14px; }
 .sub { color:var(--muted); margin:0 0 24px; font-size:14px; }
 section { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:20px 22px; margin:0 0 20px; }
 label { display:block; font-size:13px; font-weight:600; margin:14px 0 4px; }
 label:first-of-type { margin-top:0; }
 input, textarea { width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:6px; font:inherit; font-size:14.5px; background:#fff; color:var(--ink); }
 textarea { resize:vertical; }
 .mono, code { font-family:"Cascadia Code",Consolas,monospace; }
 input.mono { font-size:13.5px; }
 code { background:var(--code); padding:1px 5px; border-radius:4px; font-size:12.5px; }
 .hint { color:var(--muted); font-size:13px; margin:8px 0 0; }
 #preview { font-size:13.5px; margin:8px 0 0; min-height:20px; }
 #preview.bad { color:var(--danger); }
 .actions { display:flex; gap:8px; margin-top:16px; flex-wrap:wrap; }
 button { font:inherit; font-size:14px; padding:7px 14px; border-radius:6px; border:1px solid var(--line); background:#fff; color:var(--ink); cursor:pointer; }
 button:hover { background:var(--code); }
 button.primary { background:var(--ink); border-color:var(--ink); color:#fff; }
 button.primary:hover { background:#2b2e33; }
 button.danger { color:var(--danger); border-color:#e5b6b1; }
 button:disabled { opacity:.55; cursor:default; }
 button:focus-visible, input:focus-visible, textarea:focus-visible { outline:2px solid var(--focus); outline-offset:1px; }
 #error { border:1px solid #e5b6b1; background:#fdf1f0; color:var(--danger); border-radius:6px; padding:10px 14px; font-size:14px; margin:0 0 20px; }
 .list-head { display:flex; align-items:center; justify-content:space-between; gap:12px; }
 .list-head h2 { margin:0; }
 ul { list-style:none; margin:6px 0 0; padding:0; }
 li { display:flex; justify-content:space-between; gap:16px; padding:14px 0; border-bottom:1px solid var(--line); }
 li:last-child { border-bottom:none; padding-bottom:2px; }
 .r-title { font-weight:650; }
 .r-when { font-size:13.5px; margin-top:2px; }
 .r-prompt { color:var(--muted); font-size:13.5px; margin:4px 0 0; white-space:pre-wrap; word-break:break-word; }
 .r-meta { color:var(--muted); font-size:12.5px; margin:4px 0 0; }
 .r-buttons { display:flex; gap:6px; align-items:flex-start; flex-shrink:0; }
 .r-buttons button { padding:5px 10px; font-size:13px; }
 footer { color:var(--muted); font-size:13px; margin-top:4px; }
 @media (max-width:640px) { li { flex-direction:column; gap:8px; } }
</style>
</head>
<body>
<main>
 <h1>cua-bot routines</h1>
 <p class="sub" id="meta">Loading…</p>
 <div id="error" role="alert" hidden></div>

 <section>
  <h2 id="form-heading">Add routine</h2>
  <form id="routine-form">
   <label for="f-title">Title</label>
   <input id="f-title" required maxlength="120" placeholder="Morning agenda">
   <label for="f-prompt">Standing instruction</label>
   <textarea id="f-prompt" required rows="3" placeholder="Email me today's calendar and any unread mail from the landlord."></textarea>
   <label for="f-cron">Schedule (cron)</label>
   <input id="f-cron" class="mono" required placeholder="30 7 * * 1-5" spellcheck="false">
   <p id="preview" aria-live="polite"></p>
   <p class="hint">Five fields: minute hour day-of-month month day-of-week (0 = Sunday). Examples:
    <code>30 7 * * 1-5</code> weekdays 07:30 · <code>0 9 * * 2,5</code> Tue &amp; Fri 09:00 ·
    <code>@daily</code> · <code>@every 30m</code> · prefix <code>CRON_TZ=America/New_York</code> for another timezone.
    Times are this machine's local time unless a timezone is given.</p>
   <div class="actions">
    <button type="submit" class="primary" id="save">Add routine</button>
    <button type="button" id="cancel-edit" hidden>Cancel edit</button>
   </div>
  </form>
 </section>

 <section>
  <div class="list-head"><h2>Scheduled</h2><button type="button" id="refresh">Refresh</button></div>
  <p class="hint" id="empty" hidden>No routines yet. Add one above, ask the bot in chat, or edit <code>routines.json</code> by hand.</p>
  <ul id="routine-list"></ul>
 </section>

 <footer>Served by cua-bot on 127.0.0.1 only. Definitions are saved to <code>routines.json</code> next to the bot;
 editing that file by hand applies within a second or two. Routines the bot creates in chat show up here too.</footer>
</main>
<script>
'use strict';
var byId = function (id) { return document.getElementById(id); };
var routines = [];
var editingId = null;
var previewTimer = null;

function showError(message) {
  var box = byId('error');
  box.textContent = message;
  box.hidden = !message;
}

function fmtLocal(iso) {
  return new Date(iso).toLocaleString(undefined, { weekday:'short', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
}

function fmtRelative(iso) {
  var ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'due now';
  var minutes = Math.round(ms / 60000);
  if (minutes < 60) return 'in ' + Math.max(minutes, 1) + 'm';
  var hours = Math.floor(minutes / 60);
  if (hours < 24) return 'in ' + hours + 'h ' + (minutes % 60) + 'm';
  return 'in ' + Math.floor(hours / 24) + 'd ' + (hours % 24) + 'h';
}

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, action, id, className) {
  var node = el('button', className || '', label);
  node.type = 'button';
  node.dataset.action = action;
  node.dataset.id = id;
  return node;
}

function render() {
  var list = byId('routine-list');
  list.textContent = '';
  byId('empty').hidden = routines.length > 0;
  byId('meta').textContent = routines.length + (routines.length === 1 ? ' routine' : ' routines') + ' · saved to routines.json · hand edits apply automatically';
  routines.forEach(function (routine) {
    var item = el('li');
    var main = el('div');
    main.appendChild(el('div', 'r-title', routine.title));
    var when = el('div', 'r-when');
    when.appendChild(document.createTextNode(routine.label + '  '));
    when.appendChild(el('code', '', routine.cron));
    main.appendChild(when);
    main.appendChild(el('p', 'r-prompt', routine.prompt));
    var last = routine.lastFiredAt ? fmtLocal(routine.lastFiredAt) : 'never';
    main.appendChild(el('p', 'r-meta', 'Next: ' + fmtLocal(routine.nextFire) + ' (' + fmtRelative(routine.nextFire) + ') · Last ran: ' + last));
    var buttons = el('div', 'r-buttons');
    buttons.appendChild(button('Run now', 'run', routine.id));
    buttons.appendChild(button('Edit', 'edit', routine.id));
    buttons.appendChild(button('Delete', 'delete', routine.id, 'danger'));
    item.appendChild(main);
    item.appendChild(buttons);
    list.appendChild(item);
  });
}

function request(method, path, payload) {
  var options = { method: method, headers: { 'content-type': 'application/json' } };
  if (payload !== undefined) options.body = JSON.stringify(payload);
  return fetch(path, options).then(function (response) {
    if (response.status === 204) return undefined;
    return response.json().then(function (data) {
      if (!response.ok) throw new Error(data && data.error ? data.error : 'request failed (' + response.status + ')');
      return data;
    });
  });
}

function load() {
  return request('GET', '/api/routines').then(function (data) {
    routines = data.routines;
    showError('');
    render();
  }).catch(function (error) { showError(error.message); });
}

function setEditing(routine) {
  editingId = routine ? routine.id : null;
  byId('form-heading').textContent = routine ? 'Edit routine' : 'Add routine';
  byId('save').textContent = routine ? 'Save changes' : 'Add routine';
  byId('cancel-edit').hidden = !routine;
  byId('f-title').value = routine ? routine.title : '';
  byId('f-prompt').value = routine ? routine.prompt : '';
  byId('f-cron').value = routine ? routine.cron : '';
  updatePreview();
}

function updatePreview() {
  var value = byId('f-cron').value.trim();
  var target = byId('preview');
  if (!value) { target.textContent = ''; target.className = ''; return; }
  fetch('/api/preview?cron=' + encodeURIComponent(value)).then(function (response) {
    return response.json().then(function (data) {
      if (!response.ok) throw new Error(data && data.error ? data.error : 'invalid schedule');
      target.className = '';
      target.textContent = data.label + ' — next: ' + data.next.map(fmtLocal).join(' · ');
    });
  }).catch(function (error) {
    target.className = 'bad';
    target.textContent = error.message;
  });
}

byId('f-cron').addEventListener('input', function () {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(updatePreview, 300);
});

byId('routine-form').addEventListener('submit', function (event) {
  event.preventDefault();
  var payload = { title: byId('f-title').value, prompt: byId('f-prompt').value, cron: byId('f-cron').value };
  var save = byId('save');
  save.disabled = true;
  var call = editingId ? request('PUT', '/api/routines/' + encodeURIComponent(editingId), payload)
                       : request('POST', '/api/routines', payload);
  call.then(function () { setEditing(null); return load(); })
      .catch(function (error) { showError(error.message); })
      .then(function () { save.disabled = false; });
});

byId('cancel-edit').addEventListener('click', function () { setEditing(null); });
byId('refresh').addEventListener('click', load);

byId('routine-list').addEventListener('click', function (event) {
  var target = event.target.closest('button[data-action]');
  if (!target) return;
  var routine = routines.find(function (r) { return r.id === target.dataset.id; });
  if (!routine) return;
  if (target.dataset.action === 'edit') { setEditing(routine); byId('f-title').focus(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  if (target.dataset.action === 'delete') {
    if (!window.confirm('Delete "' + routine.title + '"?')) return;
    target.disabled = true;
    request('DELETE', '/api/routines/' + encodeURIComponent(routine.id))
      .then(function () { if (editingId === routine.id) setEditing(null); return load(); })
      .catch(function (error) { showError(error.message); target.disabled = false; });
    return;
  }
  if (target.dataset.action === 'run') {
    target.disabled = true;
    request('POST', '/api/routines/' + encodeURIComponent(routine.id) + '/run')
      .then(load)
      .catch(function (error) { showError(error.message); })
      .then(function () { target.disabled = false; });
  }
});

load();
setInterval(load, 30000);
</script>
</body>
</html>
`;
