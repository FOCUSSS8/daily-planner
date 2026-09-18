const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const GROUP_KEYS = ['study', 'work', 'health', 'other'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function normalizeTask(raw) {
  const text = typeof raw?.text === 'string' ? raw.text : String(raw?.text ?? '');
  return {
    id: typeof raw?.id === 'string' && raw.id ? raw.id : crypto.randomUUID(),
    text,
    done: Boolean(raw?.done),
  };
}

function normalizeDay(raw) {
  const base = emptyDay();
  if (!raw || typeof raw !== 'object') return base;

  const out = {
    goals: { ...base.goals, ...(raw.goals && typeof raw.goals === 'object' ? raw.goals : {}) },
    groups: {},
    review: { ...base.review, ...(raw.review && typeof raw.review === 'object' ? raw.review : {}) },
  };

  for (const key of ['morning', 'afternoon', 'evening']) {
    out.goals[key] = typeof out.goals[key] === 'string' ? out.goals[key] : '';
  }
  for (const key of ['completed', 'wasted', 'improve']) {
    out.review[key] = typeof out.review[key] === 'string' ? out.review[key] : '';
  }
  for (const key of GROUP_KEYS) {
    const list = raw.groups && Array.isArray(raw.groups[key]) ? raw.groups[key] : [];
    out.groups[key] = list.map(normalizeTask).filter((t) => t.text !== '');
  }
  return out;
}

async function createStore(file) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  let data = { version: 1, days: {} };
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !parsed.days || typeof parsed.days !== 'object') {
        throw new Error('数据文件结构无效');
      }
      for (const [date, day] of Object.entries(parsed.days)) {
        if (!isValidDate(date)) throw new Error(`数据文件中含非法日期: ${date}`);
        parsed.days[date] = normalizeDay(day);
      }
      data = { version: 1, days: parsed.days };
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(`数据文件不是合法 JSON，请用备份恢复: ${file}`);
      }
      throw err;
    }
  }

  let writeChain = Promise.resolve();

  function persist(next) {
    writeChain = writeChain.then(() => {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    });
    return writeChain.then(() => next);
  }

  return {
    emptyDay,

    async getDay(date) {
      if (!isValidDate(date)) throw new Error(`非法日期: ${date}`);
      return normalizeDay(data.days[date]);
    },

    async setDay(date, day) {
      if (!isValidDate(date)) throw new Error(`非法日期: ${date}`);
      data.days[date] = normalizeDay(day);
      return persist(async () => normalizeDay(data.days[date]));
    },

    async listDays() {
      return Object.keys(data.days).sort();
    },

    async exportData() {
      return { version: 1, days: structuredClone(data.days) };
    },

    async importData(incoming) {
      if (!incoming || typeof incoming !== 'object' || !incoming.days || typeof incoming.days !== 'object') {
        throw new Error('备份文件格式无效：缺少 days 对象');
      }
      const days = {};
      for (const [date, day] of Object.entries(incoming.days)) {
        if (!isValidDate(date)) throw new Error(`备份中含非法日期: ${date}`);
        days[date] = normalizeDay(day);
      }
      data = { version: 1, days };
      return persist(async () => Object.keys(data.days).length);
    },
  };
}

module.exports = { createStore, emptyDay, normalizeDay, isValidDate, GROUP_KEYS };
