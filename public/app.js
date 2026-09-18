'use strict';

const GROUP_META = [
  { key: 'study', label: '学习', dot: 'study' },
  { key: 'work', label: '工作', dot: 'work' },
  { key: 'health', label: '健康', dot: 'health' },
  { key: 'other', label: '其他', dot: 'other' },
];

const state = {
  today: localDateString(new Date()),
  currentDate: null, // YYYY-MM-DD
  days: {}, // date -> day record
  view: 'day',
  unsaved: false,
  saveTimer: null,
  retryTimer: null,
};

const el = {};

const IS_OWNER = new URLSearchParams(location.search).get('owner') === '1';
const IS_LOCAL = ['127.0.0.1', 'localhost', '::1'].includes(location.hostname);

/* ---------- 日期与工具函数 ---------- */

function pad(n) {
  return String(n).padStart(2, '0');
}

function localDateString(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(dateStr, delta) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + delta);
  return localDateString(d);
}

function parseDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatDateCN(dateStr) {
  const d = parseDate(dateStr);
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  return `${d.getMonth() + 1}月${d.getDate()}日 星期${weekdays[d.getDay()]}`;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function emptyDay() {
  return {
    goals: { morning: '', afternoon: '', evening: '' },
    groups: {
      study: [],
      work: [],
      health: [],
      other: [],
    },
    review: { completed: '', wasted: '', improve: '' },
  };
}

function ensureDay(dateStr) {
  if (!state.days[dateStr]) state.days[dateStr] = emptyDay();
  return state.days[dateStr];
}

function currentDay() {
  return ensureDay(state.currentDate);
}

/* ---------- 保存状态提示 ---------- */

function showSave(text, className, autoHide = false) {
  clearTimeout(state.retryTimer);
  el.saveState.textContent = text;
  el.saveState.className = className ? `save-state ${className}` : 'save-state';
  if (autoHide) {
    state.retryTimer = setTimeout(() => {
      el.saveState.textContent = '';
      el.saveState.className = 'save-state';
    }, 2200);
  }
}

async function saveCurrentDay() {
  const date = state.currentDate;
  if (!date || !state.unsaved) return true;
  clearTimeout(state.saveTimer);
  try {
    showSave('保存中…');
    const res = await fetch('/api/day', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date, day: currentDay() }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.unsaved = false;
    showSave('已保存', 'saved', true);
    return true;
  } catch {
    state.unsaved = true;
    showSave('保存失败，稍后重试', 'error');
    state.retryTimer = setTimeout(() => saveCurrentDay(), 5000);
    return false;
  }
}

async function goToDate(dateStr) {
  if (state.unsaved) {
    const saved = await saveCurrentDay();
    if (!saved) {
      showSave('内容尚未保存，暂不切换日期', 'error', true);
      return;
    }
  }
  state.currentDate = dateStr;
  try {
    await loadAll();
  } catch {
    showSave('同步失败，仍在本地浏览', 'error', true);
  }
  render();
}

function scheduleSave() {
  state.unsaved = true;
  clearTimeout(state.saveTimer);
  showSave('待保存');
  state.saveTimer = setTimeout(() => saveCurrentDay(), 400);
}

/* ---------- 数据加载 ---------- */

async function loadAll() {
  const res = await fetch('/api/state');
  if (!res.ok) throw new Error(`加载失败 HTTP ${res.status}`);
  const data = await res.json();
  state.days = data.days || {};
}

/* ---------- 心跳与退出 ---------- */

function sendHeartbeat(active) {
  const body = JSON.stringify({ owner: IS_OWNER, active });
  fetch('/api/heartbeat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {});
}

function sendBye() {
  const body = JSON.stringify({ owner: IS_OWNER });
  if (navigator.sendBeacon) {
    navigator.sendBeacon('/api/bye', new Blob([body], { type: 'application/json' }));
  } else {
    fetch('/api/bye', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  }
}

function flushDayBeacon() {
  if (!state.currentDate) return;
  const body = JSON.stringify({ date: state.currentDate, day: currentDay() });
  if (navigator.sendBeacon) {
    navigator.sendBeacon('/api/day', new Blob([body], { type: 'application/json' }));
  }
}

function startHeartbeat() {
  const tick = () => {
    if (document.visibilityState === 'visible') sendHeartbeat(true);
  };
  tick();
  setInterval(tick, 20_000);
  document.addEventListener('visibilitychange', () => {
    sendHeartbeat(document.visibilityState === 'visible');
  });
  window.addEventListener('pagehide', () => {
    if (state.unsaved) flushDayBeacon();
    sendBye();
  });
}

function showStoppedOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'stopped-overlay';
  const title = document.createElement('h4');
  title.textContent = '每日计划已停止';
  const desc = document.createElement('p');
  desc.textContent = '后台服务已经关闭，可以关闭这个窗口了。';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '关闭窗口';
  closeBtn.addEventListener('click', () => window.close());
  overlay.append(title, desc, closeBtn);
  document.body.appendChild(overlay);
}

async function handleQuit() {
  const confirmed = window.confirm('退出将保存当前内容并停止后台服务，确定吗？');
  if (!confirmed) return;
  el.quitBtn.disabled = true;
  if (state.unsaved) {
    const saved = await saveCurrentDay();
    if (!saved) {
      el.quitBtn.disabled = false;
      window.alert('内容还没保存成功，为避免丢失，已取消退出。');
      return;
    }
  }
  try {
    const res = await fetch('/api/quit', { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
  } catch (err) {
    el.quitBtn.disabled = false;
    window.alert(`退出失败：${err.message}`);
    return;
  }
  showStoppedOverlay();
}

/* ---------- 渲染 ---------- */

function render() {
  const day = currentDay();
  const dateEl = el.dateTitle;
  const text = formatDateCN(state.currentDate);
  dateEl.textContent = text;
  dateEl.innerHTML = escapeHtml(text) + (state.currentDate === state.today ? ' <span class="today-mark">今天</span>' : '');
  el.datePicker.value = state.currentDate;

  renderGroups();

  for (const key of ['morning', 'afternoon', 'evening']) {
    const input = document.querySelector(`[data-goal="${key}"]`);
    if (input && input.value !== day.goals[key]) input.value = day.goals[key];
  }
  for (const key of ['completed', 'wasted', 'improve']) {
    const area = document.querySelector(`[data-review="${key}"]`);
    if (area && area.value !== day.review[key]) area.value = day.review[key];
  }
}

/* ---------- 历史视图 ---------- */

function filled(s) {
  return typeof s === 'string' && s.trim() !== '';
}

function daySummary(day) {
  const goals = [];
  if (filled(day.goals.morning)) goals.push(`上午：${day.goals.morning}`);
  if (filled(day.goals.afternoon)) goals.push(`下午：${day.goals.afternoon}`);
  if (filled(day.goals.evening)) goals.push(`晚上：${day.goals.evening}`);

  let done = 0;
  let total = 0;
  for (const meta of GROUP_META) {
    for (const task of day.groups[meta.key]) {
      total += 1;
      if (task.done) done += 1;
    }
  }
  const reviewFilled = [day.review.completed, day.review.wasted, day.review.improve].some(filled);
  return {
    goalsText: goals.length ? goals.join(' · ') : '今天没有设置重点',
    todoText: `${done}/${total} 项待办完成`,
    reviewText: reviewFilled ? '复盘：已填' : '复盘：未填',
  };
}

function renderHistory() {
  const month = el.monthPicker.value || state.today.slice(0, 7);
  el.monthPicker.value = month;
  const dates = Object.keys(state.days)
    .filter((d) => d.startsWith(month))
    .sort()
    .reverse();

  el.historyEmpty.hidden = dates.length !== 0;
  el.historyList.innerHTML = dates
    .map((date) => {
      const day = state.days[date];
      const summary = daySummary(day);
      const todayMark = date === state.today ? '<span class="today-mark">今天</span>' : '';
      return `
        <li class="history-item" data-date="${date}">
          <header>
            <h3>${formatDateCN(date)} ${todayMark}</h3>
            <button type="button" class="open-btn" data-date="${date}">打开这天</button>
          </header>
          <p class="goals-summary"><strong>重点：</strong>${escapeHtml(summary.goalsText)}</p>
          <p class="meta-summary">${summary.todoText} · <span class="${summary.reviewText.includes('已填') ? 'ok' : 'todo'}">${summary.reviewText}</span></p>
        </li>`;
    })
    .join('');
}

async function setView(view) {
  state.view = view;
  el.dayView.hidden = view !== 'day';
  el.historyView.hidden = view !== 'history';
  document.querySelectorAll('.view-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });

  if (view === 'history') {
    if (state.unsaved) {
      const saved = await saveCurrentDay();
      if (!saved) {
        setView('day');
        showSave('内容尚未保存，无法切换视图', 'error', true);
        return;
      }
    }
    try {
      await loadAll();
    } catch {
      showSave('同步失败，显示本地数据', 'error', true);
    }
    renderHistory();
  } else {
    render();
  }
}

/* ---------- 备份：导出 / 导入 ---------- */

async function handleExport() {
  if (state.unsaved) {
    const saved = await saveCurrentDay();
    if (!saved) return;
  }
  try {
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const fileDate = state.today.replaceAll('-', '');
    a.href = url;
    a.download = `每日计划备份-${fileDate}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showSave('已导出', 'saved', true);
  } catch {
    showSave('导出失败', 'error', true);
  }
}

function handleImportFile(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    let data;
    try {
      data = JSON.parse(reader.result);
      if (!data || typeof data.days !== 'object' || Array.isArray(data.days)) {
        throw new Error('文件格式无效');
      }
    } catch {
      window.alert('备份文件不是有效的每日计划 JSON。');
      return;
    }

    const confirmed = window.confirm('导入将覆盖当前全部数据，确定继续吗？');
    if (!confirmed) return;

    try {
      const res = await fetch('/api/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      await loadAll();
      if (state.view === 'history') {
        renderHistory();
      } else {
        render();
      }
      showSave('已恢复备份', 'saved', true);
    } catch (err) {
      window.alert(`导入失败：${err.message}。原数据未受影响。`);
    }
  };
  reader.readAsText(file, 'utf-8');
}

/* ---------- 待办分组 ---------- */

function taskCounts(groupKey) {
  const tasks = currentDay().groups[groupKey] || [];
  const done = tasks.filter((t) => t.done).length;
  return { done, total: tasks.length };
}

function renderGroups() {
  const day = currentDay();
  const html = GROUP_META.map((meta) => {
    const { done, total } = taskCounts(meta.key);
    const tasks = (day.groups[meta.key] || [])
      .map(
        (t) => `
        <li class="task-item${t.done ? ' done' : ''}" data-group="${meta.key}" data-id="${escapeHtml(t.id)}">
          <button type="button" class="check" aria-label="${t.done ? '取消完成' : '标记完成'}">✓</button>
          <span class="task-text" title="双击编辑">${escapeHtml(t.text)}</span>
          <button type="button" class="task-delete" aria-label="删除">×</button>
        </li>`,
      )
      .join('');

    return `
      <div class="todo-group" data-group="${meta.key}">
        <h4><span class="dot ${meta.dot}"></span>${meta.label}<span class="count">${done}/${total} 已完成</span></h4>
        <form class="add-row" autocomplete="off">
          <input type="text" placeholder="加一件要做的事，回车确认" autocomplete="off">
        </form>
        <ul class="task-list">${tasks}</ul>
      </div>`;
  }).join('');

  el.groupsContainer.innerHTML = html;
}

function findTask(groupKey, id) {
  return (currentDay().groups[groupKey] || []).find((t) => t.id === id);
}

function addTask(groupKey, text) {
  const clean = text.trim();
  if (!clean) return;
  currentDay().groups[groupKey].push({
    id: crypto.randomUUID(),
    text: clean,
    done: false,
  });
  scheduleSave();
  renderGroups();
}

function toggleTask(groupKey, id) {
  const task = findTask(groupKey, id);
  if (!task) return;
  task.done = !task.done;
  scheduleSave();
  renderGroups();
}

function removeTask(groupKey, id) {
  const list = currentDay().groups[groupKey];
  const index = list.findIndex((t) => t.id === id);
  if (index === -1) return;
  list.splice(index, 1);
  scheduleSave();
  renderGroups();
}

function startEdit(itemEl) {
  if (itemEl.querySelector('.task-text-edit')) return;
  const span = itemEl.querySelector('.task-text');
  const groupKey = itemEl.dataset.group;
  const id = itemEl.dataset.id;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'task-text-edit';
  input.value = span.textContent;
  input.autocomplete = 'off';
  span.replaceWith(input);
  input.focus();
  input.select();

  const finish = (save) => {
    if (!input.isConnected) return;
    const newText = input.value.trim();
    if (save) {
      const task = findTask(groupKey, id);
      if (!task) return;
      if (newText) {
        task.text = newText;
        scheduleSave();
      } else {
        removeTask(groupKey, id);
        return;
      }
    }
    renderGroups();
  };

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      finish(true);
    } else if (ev.key === 'Escape') {
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

function onGroupsSubmit(ev) {
  const form = ev.target.closest('.add-row');
  if (!form) return;
  ev.preventDefault();
  const groupEl = form.closest('.todo-group');
  const groupKey = groupEl.dataset.group;
  const input = form.querySelector('input');
  addTask(groupKey, input.value);
  input.value = '';
}

function onGroupsClick(ev) {
  const itemEl = ev.target.closest('.task-item');
  if (!itemEl) return;
  const groupKey = itemEl.dataset.group;
  const id = itemEl.dataset.id;
  if (ev.target.closest('.check')) {
    toggleTask(groupKey, id);
  } else if (ev.target.closest('.task-delete')) {
    removeTask(groupKey, id);
  }
}

function onGroupsDblClick(ev) {
  const itemEl = ev.target.closest('.task-item');
  if (!itemEl) return;
  if (ev.target.closest('.task-text')) {
    startEdit(itemEl);
  }
}

/* ---------- 初始化与事件 ---------- */

function bindStaticEvents() {
  document.querySelectorAll('.view-btn').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });
  el.monthPicker.addEventListener('change', async () => {
    if (state.unsaved) await saveCurrentDay();
    try {
      await loadAll();
    } catch {
      /* 保留本地数据继续显示 */
    }
    renderHistory();
  });
  el.historyList.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.open-btn');
    if (!btn) return;
    setView('day').then(() => goToDate(btn.dataset.date));
  });
  el.exportBtn.addEventListener('click', handleExport);
  el.importBtn.addEventListener('click', () => el.importFile.click());
  el.quitBtn.addEventListener('click', handleQuit);
  el.importFile.addEventListener('change', () => {
    const file = el.importFile.files[0];
    if (file) handleImportFile(file);
    el.importFile.value = '';
  });

  el.prevDay.addEventListener('click', () => goToDate(addDays(state.currentDate, -1)));
  el.nextDay.addEventListener('click', () => goToDate(addDays(state.currentDate, 1)));
  el.datePicker.addEventListener('change', () => {
    if (el.datePicker.value) goToDate(el.datePicker.value);
  });

  el.groupsContainer.addEventListener('submit', onGroupsSubmit);
  el.groupsContainer.addEventListener('click', onGroupsClick);
  el.groupsContainer.addEventListener('dblclick', onGroupsDblClick);

  document.querySelectorAll('[data-goal]').forEach((input) => {
    input.addEventListener('input', () => {
      currentDay().goals[input.dataset.goal] = input.value;
      scheduleSave();
    });
  });

  document.querySelectorAll('[data-review]').forEach((area) => {
    area.addEventListener('input', () => {
      currentDay().review[area.dataset.review] = area.value;
      scheduleSave();
    });
  });
}

function cacheElements() {
  el.saveState = document.getElementById('saveState');
  el.dateTitle = document.getElementById('dateTitle');
  el.datePicker = document.getElementById('datePicker');
  el.prevDay = document.getElementById('prevDay');
  el.nextDay = document.getElementById('nextDay');
  el.groupsContainer = document.getElementById('groupsContainer');
  el.dayView = document.getElementById('dayView');
  el.historyView = document.getElementById('historyView');
  el.monthPicker = document.getElementById('monthPicker');
  el.historyList = document.getElementById('historyList');
  el.historyEmpty = document.getElementById('historyEmpty');
  el.exportBtn = document.getElementById('exportBtn');
  el.importBtn = document.getElementById('importBtn');
  el.importFile = document.getElementById('importFile');
  el.quitBtn = document.getElementById('quitBtn');
}

function watchMidnight() {
  setInterval(() => {
    const oldToday = state.today;
    const newToday = localDateString(new Date());
    if (newToday === oldToday) return;
    state.today = newToday;
    if (state.view === 'day' && state.currentDate === oldToday) {
      goToDate(newToday);
    }
  }, 60_000);
}

async function init() {
  cacheElements();
  el.quitBtn.hidden = !IS_LOCAL;
  bindStaticEvents();
  try {
    await loadAll();
  } catch {
    showSave('加载失败，请刷新', 'error');
  }
  state.currentDate = state.today;
  render();
  watchMidnight();
  startHeartbeat();
}

document.addEventListener('DOMContentLoaded', init);
