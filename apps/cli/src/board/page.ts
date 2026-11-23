export const BOARD_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Turbine tasks</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f1ea;
      --ink: #1c1915;
      --muted: #5c564c;
      --line: #ddd6c8;
      --card: #fffdf8;
      --done: #1f6b45;
      --done-bg: #e5f4eb;
      --now: #8a4b08;
      --now-bg: #fff1d6;
      --todo: #8a8175;
      --todo-bg: #f3efe6;
      --bad: #8d2f2f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Iowan Old Style", Palatino, Georgia, serif;
      background: var(--bg);
      color: var(--ink);
    }
    header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: end;
      padding: 28px 32px 12px;
    }
    h1 { font-size: 28px; font-weight: 500; margin: 0; }
    p { margin: 4px 0 0; color: var(--muted); font-family: ui-sans-serif, system-ui, sans-serif; font-size: 14px; }
    button {
      font: 14px ui-sans-serif, system-ui, sans-serif;
      border: 1px solid var(--line);
      background: var(--card);
      color: var(--ink);
      border-radius: 999px;
      padding: 8px 14px;
      cursor: pointer;
    }
    main {
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: 16px;
      padding: 12px 32px 40px;
      align-items: start;
    }
    .list, .detail {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
    }
    .task {
      width: 100%;
      text-align: left;
      border: 0;
      border-bottom: 1px solid var(--line);
      border-radius: 0;
      background: transparent;
      padding: 14px 16px;
      cursor: pointer;
    }
    .task:last-child { border-bottom: 0; }
    .task.selected { background: #f7f1e4; }
    .task strong { display: block; font-family: Georgia, serif; font-size: 16px; font-weight: 500; }
    .meta { margin-top: 6px; color: var(--muted); font-size: 12px; font-family: ui-sans-serif, system-ui, sans-serif; }
    .detail { padding: 22px 24px 28px; min-height: 420px; }
    .state {
      display: inline-block;
      font: 12px ui-sans-serif, system-ui, sans-serif;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      padding: 4px 8px;
      border-radius: 999px;
      background: var(--now-bg);
      color: var(--now);
    }
    h2 { font-size: 26px; font-weight: 500; margin: 12px 0 6px; }
    .next { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 15px; line-height: 1.45; margin: 0 0 18px; }
    ol.stages { list-style: none; display: flex; gap: 8px; padding: 0; margin: 0 0 22px; overflow-x: auto; }
    ol.stages li { flex: 1 0 96px; font: 13px ui-sans-serif, system-ui, sans-serif; padding: 10px 8px; border-radius: 10px; text-align: center; }
    li.done { background: var(--done-bg); color: var(--done); }
    li.now { background: var(--now-bg); color: var(--now); outline: 2px solid #e0b15a; }
    li.todo { background: var(--todo-bg); color: var(--todo); }
    h3 { font: 600 13px ui-sans-serif, system-ui, sans-serif; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); margin: 18px 0 8px; }
    ul { margin: 0; padding-left: 18px; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 15px; line-height: 1.5; }
    li + li { margin-top: 8px; }
    .id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted); }
    .empty { padding: 24px; color: var(--muted); font-family: ui-sans-serif, system-ui, sans-serif; }
    .questions li { color: var(--bad); }
    @media (max-width: 800px) {
      header, main { padding-left: 16px; padding-right: 16px; }
      main { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Turbine tasks</h1>
      <p id="summary">Reading tasks.</p>
    </div>
    <button type="button" id="refresh">Refresh</button>
  </header>
  <main>
    <section class="list" id="list"></section>
    <section class="detail" id="detail"></section>
  </main>
  <script>
    let tasks = [];
    let selected = location.hash.slice(1);
    let lastPayload = '';
    let project = '';

    function esc(value) {
      return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[ch]);
    }

    function renderList() {
      const list = document.getElementById('list');
      if (!tasks.length) {
        list.innerHTML = '<div class="empty">No tasks yet. Create one with turbine task create.</div>';
        return;
      }
      list.innerHTML = tasks.map((task) => \`
        <button class="task\${task.id === selected ? ' selected' : ''}" data-id="\${esc(task.id)}" type="button">
          <strong>\${esc(task.title)}</strong>
          <div class="meta">\${esc(task.state)} · \${esc(task.type)} · \${esc(task.track)}</div>
        </button>
      \`).join('');
      list.querySelectorAll('.task').forEach((button) => {
        button.addEventListener('click', () => {
          selected = button.dataset.id;
          history.replaceState(null, '', '#' + selected);
          render();
        });
      });
    }

    function renderDetail() {
      const detail = document.getElementById('detail');
      const task = tasks.find((item) => item.id === selected) ?? tasks[0];
      if (!task) {
        detail.innerHTML = '<div class="empty">Tasks show up here as soon as they are created.</div>';
        return;
      }
      selected = task.id;
      const stageHtml = task.stages.map((stage) =>
        '<li class="' + stage.status + '">' + (stage.status === 'done' ? '✓' : stage.status === 'now' ? '●' : '○') + ' ' + esc(stage.name) + '</li>',
      ).join('');
      const requirements = task.requirements.length
        ? task.requirements.map((item) => '<li><strong>' + esc(item.id) + '</strong> (' + esc(item.priority) + ') ' + esc(item.statement) + '</li>').join('')
        : '<li>No requirements recorded yet.</li>';
      const questions = task.questions.length
        ? '<h3>Open questions</h3><ul class="questions">' + task.questions.map((q) => '<li>' + esc(q) + '</li>').join('') + '</ul>'
        : '';
      const notes = task.notes.length
        ? '<h3>What just happened</h3><ul>' + task.notes.map((note) => '<li>' + esc(note) + '</li>').join('') + '</ul>'
        : '';
      detail.innerHTML = [
        '<span class="state">' + esc(task.state) + '</span>',
        '<h2>' + esc(task.title) + '</h2>',
        '<p class="id">' + esc(task.id) + ' · risk ' + esc(task.risk) + ' · ' + esc(task.track) + '</p>',
        '<p class="next">' + esc(task.next || task.headline) + '</p>',
        '<ol class="stages">' + stageHtml + '</ol>',
        '<h3>Requirements</h3>',
        '<ul>' + requirements + '</ul>',
        questions,
        notes,
      ].join('');
    }

    function render() {
      const count = tasks.length;
      document.getElementById('summary').textContent = count
        ? count + ' task' + (count === 1 ? '' : 's') + (project ? ' in ' + project : '')
        : 'No tasks yet.';
      renderList();
      renderDetail();
    }

    async function load() {
      const response = await fetch('/turbine/api/tasks', { cache: 'no-store' });
      const body = await response.json();
      const payload = JSON.stringify(body.tasks ?? []);
      if (payload === lastPayload && project === (body.project || '')) return;
      lastPayload = payload;
      project = body.project || '';
      tasks = body.tasks ?? [];
      if (selected && !tasks.some((task) => task.id === selected)) selected = '';
      render();
    }

    document.getElementById('refresh').addEventListener('click', load);
    window.addEventListener('hashchange', () => {
      selected = location.hash.slice(1);
      render();
    });
    load();
    setInterval(load, 5000);
  </script>
</body>
</html>
`;
