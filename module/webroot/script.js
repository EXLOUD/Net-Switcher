/*
Net Switcher WebUI — plain HTML/CSS/JS (no build step). Backend: iptables + JSON in /data/adb/.config/net-switcher
*/
const CFG_DIR = '/data/adb/.config/net-switcher';

const NS = '/data/adb/modules/net-switcher/system/bin/netswitcher';

const RULES_PATH = CFG_DIR + '/rules.conf';

const CHANNELS = ['wifi', 'mobile', 'lan', 'vpn'];

const PROFILES_PATH = CFG_DIR + '/profiles.json';

const DEFAULT_PATH = CFG_DIR + '/default.json';

const LANG_KEY = 'net_switcher_lang';

const DEFAULT_LANG = 'en';

const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /*
      Storage unavailable
      */
    }
  },
};

const S = {
  page: 'apps',
  lang: DEFAULT_LANG,
  bridgeOk: false,
  apps: [], // [{pkg,label,system}]
  rules: new Map(), // Pkg -> Set of blocked channels
  snap: new Set(), /* Isolated apps at last full list render (keeps row order stable) */
  profiles: {},
  current: '',
  filter: 'user',
  q: '',
  ioMode: 'export',
  importPath: '/sdcard/Download/net-switcher-profiles.json',
  ioPath: '/sdcard/Download/net-switcher-profiles.json',
  newName: '',
  armed: '', // Profile armed for deletion
  events: [],
};

const $ = s => document.querySelector(s);

const LOCALES = globalThis.NS_LOCALES || {};

const LANGS = globalThis.NS_LANGS || {en: ['English', 'EN']};

let strings = {};

/*
Missing key -> English -> key itself; {0},{1} placeholders
*/
function t(k, ...a) {
  let v = strings[k] ?? (LOCALES.en || {})[k] ?? k;

  if (typeof v === 'string' && a.length > 0) {
    v = v.replaceAll(/\{(?<idx>\d+)\}/gv, (m, i) => (a[i] === undefined ? m : a[i]));
  }

  return v;
}

const esc = s => {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#39;',
  };

  return String(s).replaceAll(/["&'<>]/gv, c => map[c]);
};

/*
── Language ───────────────────────────────────────────────────────────
*/
function detectLang() {
  const saved = store.get(LANG_KEY);

  if (saved && Object.hasOwn(LOCALES, saved)) {
    return saved;
  }

  const langs = [...(navigator.languages || []), navigator.language].filter(Boolean);

  for (const l of langs) {
    const n = l.toLowerCase().replaceAll('_', '-');

    if (Object.hasOwn(LOCALES, n)) {
      return n;
    }

    const base = n.split('-', 1)[0];
    if (Object.hasOwn(LOCALES, base)) {
      return base;
    }
  }

  return DEFAULT_LANG;
}

function setLang(lang, persist) {
  if (!Object.hasOwn(LOCALES, lang)) {
    lang = DEFAULT_LANG;
  }

  S.lang = lang;
  strings = LOCALES[lang];

  if (persist) {
    store.set(LANG_KEY, lang);
  }

  document.documentElement.lang = lang;

  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';

  $('#langLabel').textContent = (LANGS[lang] || [lang, lang.toUpperCase()])[1];

  $('#langMenu').innerHTML = Object.entries(LANGS).map(([c, [name, short]]) =>
    `<button type="button" role="option" data-lang="${c}" class="${c === lang ? 'active' : ''}">${esc(name)} <span>${short}</span></button>`).join('');

  renderBanner();
  refreshEvents();

  renderNav();

  render();
}

/*
── Bridge (KernelSU / APatch / Magisk WebUI) ──────────────────────────
*/
let cb = 0;

function getBridge() {
  return globalThis.ksu && typeof globalThis.ksu.exec === 'function'
    ? globalThis.ksu
    : (globalThis.$ && typeof globalThis.$.exec === 'function' ? globalThis.$ : null);
}

function setBridge(ok) {
  S.bridgeOk = ok;

  const d = $('#bridge-dot');
  d.classList.toggle('is-ok', ok);
  d.classList.toggle('is-off', !ok);

  renderBanner();
  refreshEvents();
}

function exec(cmd) {
  const b = getBridge();

  if (!b) {
    setBridge(false);

    return Promise.resolve({code: 1, stdout: '', stderr: 'no bridge'});
  }

  setBridge(true);

  return new Promise(resolve => {
    const name = 'ns_cb_' + Date.now() + '_' + (cb++);
    globalThis[name] = (errno, stdout = '', stderr = '') => {
      delete globalThis[name];
      resolve({code: errno, stdout, stderr});
    };

    try {
      b.exec(cmd, '{}', name);
    } catch (error) {
      delete globalThis[name];
      resolve({code: 1, stdout: '', stderr: String(error)});
    }
  });
}

const q = s => '\'' + String(s).replaceAll('\'', String.raw`'\''`) + '\'';

const readFile = async p => {
  const result = await exec(`cat ${q(p)} 2>/dev/null`);

  return result.stdout.trim();
};

const writeFile = (p, text) => exec(`printf '%s' ${q(text)} > ${q(p)}`);

async function readJson(p, fallback = null) {
  try {
    const o = JSON.parse(await readFile(p));

    return o ?? fallback;
  } catch {
    return fallback;
  }
}

/*
── UI helpers ─────────────────────────────────────────────────────────
*/
let toastTimer = 0;

function toast(message, kind) {
  const element = $('#toast');
  element.textContent = message;
  element.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 2800);
}

function busy(on) {
  $('#busyText').textContent = t('loading');

  $('#busy').classList.toggle('hidden', !on);
}

/* ── Custom scrollbar ─────────────────────────────────────────────────────
 * One thumb for the active scroll container (events popup > apps list > page).
 * It is not a child of the scroller and is moved only via translate3d once per frame. */
let customScroll = null;

let customScrollRAF = 0;

let customScrollHideTimer = 0;

let customScrollDrag = null;

let customScrollRect = null;

function customScrollHost() {
  if (!$('#fbModal').classList.contains('hidden')) {
    return $('#fbList');
  }

  if (!$('#evModal').classList.contains('hidden')) {
    return $('#evLog');
  }

  return S.page === 'apps' ? (document.querySelector(':scope .list') || $('#main')?.querySelector(':scope .list')) : $('#main');
}

function customScrollMeasure() {
  const element = customScrollHost();

  if (!element) {
    return null;
  }

  const r = element.getBoundingClientRect();

  const inset = 14;

  const top = Math.round(r.top + inset);
  const bottom = Math.round(r.bottom - inset);

  const track = Math.max(0, bottom - top);

  const max = Math.max(0, element.scrollHeight - element.clientHeight);

  if (track <= 0 || max <= 0) {
    return null;
  }

  const thumb = Math.max(28, Math.min(track, Math.round(track * element.clientHeight / element.scrollHeight)));

  const inner = element.id === 'main' ? 6 : 8;

  return {
    el: element, top, track, thumb, max, x: Math.round(r.right - inner),
  };
}

function customScrollRender(isShow = false) {
  customScrollRAF = 0;

  if (!customScroll) {
    return;
  }

  const m = customScrollMeasure();
  customScrollRect = m;

  if (!m) {
    customScroll.classList.remove('is-visible');
    return;
  }

  const ratio = m.max ? m.el.scrollTop / m.max : 0;

  const y = m.top + ((m.track - m.thumb) * ratio);
  customScroll.style.height = m.thumb + 'px';
  customScroll.style.transform = `translate3d(${m.x}px,${Math.round(y)}px,0)`;

  if (!isShow) {
    return;
  }

  customScroll.classList.add('is-visible');
  clearTimeout(customScrollHideTimer);
  customScrollHideTimer = setTimeout(() => {
    if (!customScrollDrag) {
      customScroll.classList.remove('is-visible');
    }
  }, 700);
}

function customScrollSchedule(isShow = true) {
  if (isShow && customScroll) {
    customScroll.classList.add('is-visible');
    clearTimeout(customScrollHideTimer);
  }

  customScrollRAF ||= requestAnimationFrame(() => customScrollRender(isShow));
}

function installCustomScrollbar() {
  if (!customScroll) {
    customScroll = document.createElement('div');
    customScroll.className = 'custom-scroll-thumb';
    customScroll.setAttribute('aria-hidden', 'true');

    document.body.append(customScroll);
    customScroll.addEventListener('pointerdown', event_ => {
      const m = customScrollRect || customScrollMeasure();

      if (!m) {
        return;
      }

      event_.preventDefault();
      customScrollDrag = {
        el: m.el, startY: event_.clientY, startScroll: m.el.scrollTop, track: m.track, thumb: m.thumb, max: m.max,
      };
      customScroll.classList.add('is-dragging', 'is-visible');
      customScroll.setPointerCapture?.(event_.pointerId);
    });
    customScroll.addEventListener('pointermove', event_ => {
      const d = customScrollDrag;

      if (!d) {
        return;
      }

      d.el.scrollTop = d.startScroll + (((event_.clientY - d.startY) * d.max) / Math.max(1, d.track - d.thumb));
      customScrollSchedule(true);
    });

    const endDrag = () => {
      customScrollDrag = null;
      customScroll.classList.remove('is-dragging');
      customScrollSchedule(false);
    };

    customScroll.addEventListener('pointerup', endDrag);
    customScroll.addEventListener('pointercancel', endDrag);
  }

  const host = customScrollHost();

  if (customScroll._host !== host) {
    if (customScroll._onScroll) {
      customScroll._host?.removeEventListener('scroll', customScroll._onScroll);
    }

    customScroll._host = host;
    customScroll._onScroll = () => customScrollSchedule(true);
    host?.addEventListener('scroll', customScroll._onScroll, {passive: true});
  }

  customScrollSchedule(false);
}

globalThis.addEventListener('resize', () => installCustomScrollbar(), {passive: true});

globalThis.visualViewport?.addEventListener('resize', () => installCustomScrollbar(), {passive: true});

function showAlert(title, text) {
  const element = $('#alert');
  element.querySelector('.banner-title').textContent = title;
  element.querySelector('.banner-text').textContent = text;
  element.classList.remove('hidden');
}

const hideAlert = () => $('#alert').classList.add('hidden');

/*
Imported profiles must be { "name": { "pkg": ['wifi', ...] } } (or legacy { "name": ["pkg", ...] }) with at least one app rule
*/
function validateProfiles(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return 'import_err_format';
  }

  const names = Object.keys(data);

  if (names.length === 0) {
    return 'import_err_empty';
  }

  let apps = 0;

  for (const n of names) {
    const prof = data[n];

    if (Array.isArray(prof)) {
      if (prof.some(p => !(typeof p === 'string' && isValidPkg(p)))) {
        return 'import_err_format';
      }

      apps += prof.length;
    } else if (prof && typeof prof === 'object') {
      for (const [pkg, ch] of Object.entries(prof)) {
        const list = Array.isArray(ch) ? ch : (typeof ch === 'string' ? ch.split(',') : null);

        if (!list || !isValidPkg(pkg) || list.some(c => !CHANNELS.includes(String(c).trim()))) {
          return 'import_err_format';
        }

        apps += list.length > 0 ? 1 : 0;
      }
    } else {
      return 'import_err_format';
    }
  }

  return apps ? '' : 'import_err_empty';
}

/*
Parse + validate + save; returns true on success, otherwise shows the closable banner
*/
async function applyImport(text) {
  let data;
  let error = '';

  try {
    data = JSON.parse(text);
  } catch {
    error = 'import_err_json';
  }

  error ||= validateProfiles(data);

  if (error) {
    showAlert(t('import_failed'), t(error));
    return false;
  }

  await exec(`[ -f ${q(PROFILES_PATH)} ] && cp ${q(PROFILES_PATH)} ${q(CFG_DIR + '/old_profiles.json')}`);

  const r = await writeFile(PROFILES_PATH, JSON.stringify(data));

  if (r.code !== 0) {
    showAlert(t('import_failed'), (r.stderr || '').trim());
    return false;
  }

  await exec(`chmod 644 ${q(PROFILES_PATH)}`);

  S.profiles = await readJson(PROFILES_PATH, {});
  hideAlert();

  toast(t('import_success'), 'ok');

  render();

  return true;
}

function evRows() {
  return S.events.length > 0
    ? S.events.map(ev => `<div class="logrow"><time>${ev.time}</time><span>${esc(ev.text)}</span><em class="${ev.tone}">●</em></div>`).join('')
    : `<div class="empty">${esc(t('no_events'))}</div>`;
}

function refreshEvents() {
  const cnt = $('#evCnt');
  cnt.textContent = S.events.length;
  cnt.classList.toggle('hidden', S.events.length === 0);

  $('#evBtn').setAttribute('aria-label', t('events'));

  $('#evTitle').textContent = t('events');

  $('#evClose').textContent = t('close');

  $('#evMeta').textContent = `${S.events.length} ${t('records')}`;

  $('#evLog').innerHTML = evRows();
}

function logEvent(text, tone) {
  const d = new Date();

  const p = n => String(n).padStart(2, '0');

  S.events.unshift({time: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`, text, tone});

  S.events.length = Math.min(S.events.length, 30);
  refreshEvents();
}

function renderBanner() {
  const b = $('#no-bridge');
  b.querySelector('.banner-title').textContent = t('banner_title');
  b.querySelector('.banner-text').textContent = t('banner_text');
  b.classList.toggle('hidden', S.bridgeOk);
}

const ICON = {
  apps: '<svg viewBox="0 0 24 24">'
    + '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/>'
    + '<rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/>'
    + '<rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/>'
    + '<rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/></svg>',
  profiles: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5"/>'
    + '<path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/></svg>',
  backup: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>',
  trash: '<svg viewBox="0 0 24 24">'
    + '<path d="M5 7h14M10 7V4.5h4V7M7 7l.8 12.5h8.4L17 7M10 11v5M14 11v5"/></svg>',
  wifi: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" '
    + 'stroke="currentColor" stroke-width="1.8" stroke-linecap="round">'
    + '<path d="M3 9.5a13 13 0 0 1 18 0M6 13a8.5 8.5 0 0 1 12 0M9.2 16.4a4 4 0 0 1 5.6 0"/>'
    + '<circle cx="12" cy="19.5" r=".6"/></svg>',
};

const CH_ICON = {
  wifi: '<svg viewBox="0 0 24 24">'
    + '<path d="M3 9.5a13 13 0 0 1 18 0M6 13a8.5 8.5 0 0 1 12 0M9.2 16.4a4 4 0 0 1 5.6 0"/>'
    + '<circle cx="12" cy="19.5" r=".7"/></svg>',
  mobile: '<svg viewBox="0 0 24 24"><path d="M5 19v-3M10 19v-6M15 19V9M20 19V5"/></svg>',
  lan: '<svg viewBox="0 0 24 24"><path d="M4 11 12 4l8 7M6 10v9h12v-9"/></svg>',
  vpn: '<svg viewBox="0 0 24 24">'
    + '<path d="M12 3.5 5 6v5.5c0 4.2 2.9 7.4 7 9 4.1-1.6 7-4.8 7-9V6z"/>'
    + '<path d="m9 12 2.2 2.2L15.2 10"/></svg>',
};

const CHECK = '<span class="check"><svg viewBox="0 0 24 24"><circle class="ring" cx="12" cy="12" r="10"/><path class="tick" d="M7.5 12.5l3 3 6-6.5"/></svg></span>';

const TABS = [['apps', 'tab_apps'], ['profiles', 'tab_profiles']];

function renderNav() {
  $('#nav').innerHTML = TABS.map(([id, key]) =>
    `<button type="button" role="tab" data-page="${id}" class="${S.page === id ? 'active' : ''}" aria-selected="${S.page === id}">${ICON[id]}<span>${esc(t(key))}</span></button>`).join('');
}

/*
── Packages ───────────────────────────────────────────────────────────
*/
const parseJson = v => {
  if (typeof v !== 'string') {
    return v;
  }

  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};

function nativeList(type) {
  const k = globalThis.ksu;

  if (!k || typeof k.listPackages !== 'function') {
    return null;
  }

  try {
    const r = parseJson(k.listPackages(type));
    return Array.isArray(r) ? r.filter(p => typeof p === 'string' && p) : null;
  } catch {
    return null;
  }
}

function nativeInfo(names) {
  const k = globalThis.ksu;

  if (!k || typeof k.getPackagesInfo !== 'function') {
    return [];
  }

  try {
    const r = parseJson(k.getPackagesInfo(JSON.stringify(names)));
    return Array.isArray(r) ? r : (r ? [r] : []);
  } catch {
    return [];
  }
}

const areIconsSupported = () => Boolean(globalThis.ksu && typeof globalThis.ksu.getPackagesInfo === 'function');

async function loadPackages() {
  let user = nativeList('user');
  let sys = nativeList('system');

  if (!user || !sys) {
    const lines = async c => {
      const result = await exec(c);
      return result.stdout.split('\n').map(s => s.trim()).filter(Boolean);
    };

    [user, sys] = await Promise.all([lines('pm list packages -3 | cut -d: -f2'), lines('pm list packages -s | cut -d: -f2')]);
  }

  const seen = new Set();

  const apps = [];

  for (const [list, system] of [[user, false], [sys, true]]) {
    for (const pkg of list) {
      if (seen.has(pkg)) {
        continue;
      }

      seen.add(pkg);
      apps.push({pkg, label: '', system});
    }
  }

  S.apps = apps.toSorted((a, b) => a.pkg.localeCompare(b.pkg));
}

let labelRun = 0;

function loadLabels() {
  if (!areIconsSupported()) {
    return;
  }

  const run = ++labelRun;

  const order = [...S.apps].toSorted((a, b) => a.system - b.system);

  for (let i = 0; i < order.length; i += 60) {
    if (run !== labelRun) {
      return;
    }

    const part = order.slice(i, i + 60);
    const got = new Map(nativeInfo(part.map(x => x.pkg)).map(r => [r && r.packageName, r]));

    for (const x of part) {
      const r = got.get(x.pkg);
      if (r && r.appLabel) {
        x.label = String(r.appLabel);
      }
    }
  }

  if (run === labelRun && S.page === 'apps') {
    fillList(true);
  }
}

/*
── Backend: the `netswitcher` CLI owns iptables + rules.conf ────────────
*/
const EMPTY = new Set();

const isValidPkg = p => /^[\w.]+$/v.test(p);

const ns = (...args) => exec(['sh', NS, ...args].map(arg => q(arg)).join(' '));

const isIso = pkg => (S.rules.get(pkg) || EMPTY).size > 0;

const snapNow = () => {
  S.snap = new Set(S.apps.filter(a => isIso(a.pkg)).map(a => a.pkg));
};

const isoCount = () => {
  let n = 0;
  for (const s of S.rules.values()) {
    if (s.size > 0) {
      n++;
    }
  }

  return n;
};

const parseChans = (s = '') => new Set(
  String(s).split(',').map(x => x.trim()).filter(x => CHANNELS.includes(x)),
);

const chanString = set => CHANNELS.filter(c => set.has(c)).join(',');

const rulesObject = () => {
  const o = {};
  for (const [p, s] of S.rules) {
    if (s.size > 0) {
      o[p] = CHANNELS.filter(c => s.has(c));
    }
  }

  return o;
};

/*
Profiles: legacy = ["pkg", ...] (all channels), new = {"pkg": ['wifi', ...]}
*/
const profileMap = prof => (Array.isArray(prof) ? Object.fromEntries(prof.map(p => [p, CHANNELS])) : (prof && typeof prof === 'object' ? prof : {}));

const profileSize = prof => Object.keys(profileMap(prof)).length;

const saveProfiles = () => writeFile(PROFILES_PATH, JSON.stringify(S.profiles));

async function persistCurrent() {
  const cfg = await readJson(DEFAULT_PATH, {});
  cfg.currentProfile = S.current;

  await writeFile(DEFAULT_PATH, JSON.stringify(cfg));
}

/*
── Actions ────────────────────────────────────────────────────────────
*/
let chain = Promise.resolve();

const queued = fn => {
  chain = chain.then(fn).catch(fn);
};

function setChannels(pkg, next) {
  const previous = new Set(S.rules.get(pkg) || []);
  if (next.size > 0) {
    S.rules.set(pkg, next);
  } else {
    S.rules.delete(pkg);
  }

  if (!refreshRow(pkg)) {
    fillList(true);
  }

  queued(async () => {
    const r = await ns('set', pkg, next.size > 0 ? chanString(next) : 'none');

    if (r.code === 0) {
      if (S.current && Object.hasOwn(S.profiles, S.current)) {
        S.profiles[S.current] = rulesObject();
        await saveProfiles();
      }

      const a = S.apps.find(x => x.pkg === pkg);

      const state = next.size === CHANNELS.length ? t('status_isolated') : (next.size > 0 ? [...CHANNELS.filter(c => next.has(c))].map(c => t('ch_' + c)).join(' · ') : t('status_connected'));

      logEvent(`${(a && a.label) || pkg}: ${state}`, next.size > 0 ? 'block' : 'allow');

      toast(t('operation_completed'), 'ok');
    } else {
      if (previous.size > 0) {
        S.rules.set(pkg, previous);
      } else {
        S.rules.delete(pkg);
      }

      toast(`${t('operation_error')} ${(r.stderr || r.stdout).trim()}`.trim(), 'err');
      if (!refreshRow(pkg)) {
        fillList(true);
      }

      return;
    }

    if (!refreshRow(pkg)) {
      fillList(true);
    }
  });
}

function toggleChannel(pkg, ch) {
  const s = new Set(S.rules.get(pkg) || []);
  if (s.has(ch)) {
    s.delete(ch);
  } else {
    s.add(ch);
  }

  setChannels(pkg, s);
}

function toggleAll(pkg) {
  const s = S.rules.get(pkg);
  setChannels(pkg, s && s.size === CHANNELS.length ? new Set() : new Set(CHANNELS));
}

async function activateProfile(name) {
  if (!(Object.hasOwn(S.profiles, name))) {
    return toast(t('profile_not_found', name), 'err');
  }

  busy(true);

  const installed = new Set(S.apps.map(a => a.pkg));

  const rules = new Map();

  for (const [pkg, ch] of Object.entries(profileMap(S.profiles[name]))) {
    const set = parseChans(Array.isArray(ch) ? ch.join(',') : ch);

    if (installed.has(pkg) && isValidPkg(pkg) && set.size > 0) {
      rules.set(pkg, set);
    }
  }

  const text = [...rules].map(([p, s]) => `${p}=${chanString(s)}`).join('\n');

  await writeFile(RULES_PATH, text ? text + '\n' : '');

  const r = await ns('apply');

  if (r.code === 0) {
    S.rules = rules;

    snapNow();

    S.current = name;

    await persistCurrent();

    logEvent(`${t('evt_profile')}: ${name}`, 'block');

    toast(t('profile_activated', name, rules.size), 'ok');
  } else {
    toast(`${t('operation_error')} ${(r.stderr || r.stdout).trim()}`, 'err');
  }

  busy(false);

  render();
}

async function createProfile() {
  const name = S.newName.trim();

  if (!name) {
    return toast(t('enter_profile_name'), 'err');
  }

  if (!/^[\w \-.]+$/v.test(name)) {
    return toast(t('invalid_profile_name'), 'err');
  }

  if (Object.hasOwn(S.profiles, name)) {
    return toast(t('profile_exists'), 'err');
  }

  S.profiles[name] = rulesObject();

  S.current = name;

  S.newName = '';

  await saveProfiles();

  await persistCurrent();

  toast(t('profile_created', name, isoCount()), 'ok');

  render();
}

async function deleteProfile(name) {
  if (!name) {
    return toast(t('invalid_profile_name'), 'err');
  }

  delete S.profiles[name];

  if (S.current === name) {
    S.current = '';
    await persistCurrent();
  }

  S.armed = '';

  await saveProfiles();

  toast(t('profile_deleted', name), 'ok');

  render();
}

async function exportProfiles() {
  const path = S.ioPath.trim();

  if (!path) {
    return toast(t('invalid_path'), 'err');
  }

  const r = await exec(`cp ${q(PROFILES_PATH)} ${q(path)} && chmod 644 ${q(path)}`);
  if (r.code === 0) {
    toast(t('export_success'), 'ok');
  } else {
    toast(`${t('export_failed')}: ${r.stderr}`, 'err');
  }
}

async function importProfiles() {
  const path = S.importPath.trim();

  if (!path) {
    return showAlert(t('import_failed'), t('invalid_path'));
  }

  const r = await exec(`cat ${q(path)}`);

  if (r.code !== 0) {
    return showAlert(t('import_failed'), (r.stderr || t('invalid_path')).trim());
  }

  await applyImport(r.stdout);
}

/*
In-app file browser (the WebView has no native file chooser): "import" picks a .json file, 'export' picks a folder
*/
const FB = {mode: 'import', dir: '/sdcard'};

const dirOf = p => {
  const i = String(p).lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : '/';
};

async function fbOpen(mode) {
  FB.mode = mode;

  const cur = (mode === 'import' ? S.importPath : S.ioPath).trim();

  const start = dirOf(cur);

  $('#fbSelect').classList.toggle('hidden', mode !== 'export');

  $('#fbTitle').textContent = t(mode === 'import' ? 'fb_file' : 'fb_folder');

  $('#fbSelect').textContent = t('fb_select_folder');

  $('#fbClose').textContent = t('close');

  $('#fbModal').classList.remove('hidden');

  await fbList(/^\/[^\0]*$/v.test(start) ? start : '/sdcard');
}

async function fbList(dir) {
  while (dir.length > 1 && dir.endsWith('/')) {
    dir = dir.slice(0, -1);
  }

  dir ||= '/';

  let r = await exec(`cd ${q(dir)} 2>/dev/null && ls -1p`);
  if (dir !== '/sdcard' && r.code !== 0) {
    dir = '/sdcard';
    r = await exec(`cd ${q(dir)} 2>/dev/null && ls -1p`);
  }

  FB.dir = dir;

  const names = r.stdout.split('\n').map(x => x.trim()).filter(Boolean);

  const dirs = names.filter(n => n.endsWith('/')).toSorted((a, b) => a.localeCompare(b));

  const files = FB.mode === 'import' ? names.filter(n => /\.json$/iv.test(n)).toSorted((a, b) => a.localeCompare(b)) : [];

  const row = (kind, name, label) => (
    `<button type="button" class="fb-row ${kind}" data-kind="${kind}" `
    + `data-name="${esc(name)}"><span class="fb-ico">${kind === 'file' ? '▤' : '▸'}</span>`
    + `<span>${esc(label)}</span></button>`
  );

  $('#fbPath').textContent = dir;

  $('#fbList').innerHTML = (dir === '/' ? '' : row('up', '..', '..'))
    + dirs.map(n => row('dir', n.slice(0, -1), n)).join('') + files.map(n => row('file', n, n)).join('')
    + (dirs.length > 0 || files.length > 0 ? '' : `<div class="empty">${esc(t('fb_empty'))}</div>`);

  $('#fbList').scrollTop = 0;
  installCustomScrollbar();
}

function fbClose() {
  $('#fbModal').classList.add('hidden');
  installCustomScrollbar();
}

function fbPick(path) {
  if (FB.mode === 'import') {
    S.importPath = path;
  } else {
    S.ioPath = path;
  }

  fbClose();

  const inp = $(FB.mode === 'import' ? '#importPath' : '#exportPath');

  if (inp) {
    inp.value = path;
  }
}

/*
── Rendering ──────────────────────────────────────────────────────────
*/
function counts() {
  const iso = isoCount();

  return {iso, total: S.apps.length, conn: Math.max(0, S.apps.length - iso)};
}

function renderApps() {
  const c = counts();

  const hero = `<section class="hero">
    <div class="eyebrow">${esc(t('hero_eyebrow'))}</div>
    <div class="hero-title"><strong>${c.iso}</strong><span class="badge">${esc(S.current || t('profile_none'))}</span></div>
    <p class="hero-sub">${esc(t('hero_sub'))}</p>
</section>`;

  const filters = ['user', 'system', 'isolated'].map(f =>
    `<button type="button" class="filter ${S.filter === f ? 'active' : ''}" data-filter="${f}"><span>${esc(t('filter_' + f))}</span><span class="cnt" data-cnt="${f}">0</span></button>`).join('');

  return `${hero}
    <div class="group"><span>${esc(t('tab_apps'))}</span><span class="cnt-total"></span></div>
    <label class="search">${ICON.search}<input id="search" type="search" autocomplete="off" spellcheck="false" placeholder="${esc(t('search_placeholder'))}" value="${esc(S.q)}"></label>
    <div class="filters">${filters}</div>
    <div class="list" id="list"></div>`;
}

const initial = s => (String(s).match(/[\p{Letter}\p{Number}]/gv) || ['?'])[0].toUpperCase();

function rowHtml(a) {
  const set = S.rules.get(a.pkg) || EMPTY;

  const n = set.size;

  const name = a.label || a.pkg;

  const src = areIconsSupported() ? `<img alt="" loading="lazy" decoding="async" src="ksu://icon/${esc(a.pkg)}">` : '';

  const status = t(n === CHANNELS.length ? 'status_isolated' : (n ? 'status_partial' : 'status_connected'));

  const chips = CHANNELS.map(c =>
    `<button type="button" class="chip ${set.has(c) ? 'on' : ''}" data-ch="${c}" `
    + `aria-pressed="${set.has(c)}" title="${esc(t('ch_' + c))}">`
    + `<span class="chip-in">${CH_ICON[c]}<span>${esc(t('ch_' + c))}</span></span></button>`,
  ).join('');

  return `<div class="app-row" data-pkg="${esc(a.pkg)}">
    <div class="appico" data-l="${esc(initial(name))}">${src}</div>
    <div class="apptext"><div class="appname">${esc(name)}</div>
      <div class="apppkg ${n ? 'is-iso' : ''}">${a.label ? esc(a.pkg) + ' · ' : ''}${esc(status)}</div></div>
    <button type="button" class="toggle-switch ${n === CHANNELS.length ? 'on' : (n ? 'part' : '')}" `
    + `data-all role="switch" aria-checked="${n > 0}" aria-label="${esc(t('block_all'))}">`
    + `<span class="knob"></span></button>
    <div class="chips">${chips}</div></div>`;
}

function refreshRow(pkg) {
  const list = $('#list');
  if (!list) {
    return false;
  }

  const row = list.querySelector('[data-pkg="' + pkg.replaceAll(/"/g, '') + '"]');
  const app = S.apps.find(a => a.pkg === pkg);
  if (!row || !app) {
    return false;
  }

  const top = list.scrollTop;
  const stillVisible = S.filter !== 'isolated' || S.snap.has(pkg) || isIso(pkg);

  if (!stillVisible) {
    row.remove();
  } else {
    row.outerHTML = rowHtml(app);
  }

  list.scrollTop = top;
  requestAnimationFrame(() => {
    list.scrollTop = top;
    customScrollSchedule(false);
  });

  refreshHero();

  const isoN = S.apps.filter(a => S.snap.has(a.pkg) || isIso(a.pkg)).length;
  for (const element of document.querySelectorAll('[data-cnt]')) {
    if (element.dataset.cnt === 'isolated') {
      element.textContent = isoN;
    }
  }

  const tot = $('.cnt-total');
  if (tot && S.filter === 'isolated') {
    tot.textContent = `${isoN} ${t('apps_total')}`;
  }

  customScrollSchedule(false);
  return true;
}

function fillList(keep) {
  const list = $('#list');

  if (!list) {
    return;
  }

  const query = S.q.trim().toLowerCase();

  const match = a => !query || a.pkg.toLowerCase().includes(query) || a.label.toLowerCase().includes(query);

  const pool = S.apps.filter(a => match(a));
  /* S.snap = apps that were isolated when the WebUI started. They live only under "Isolated" (after a restart);
     inside one session a toggled app keeps its place, so rows never jump while you tap. */

  const by = {
    user: pool.filter(a => !a.system && !S.snap.has(a.pkg)),
    system: pool.filter(a => a.system && !S.snap.has(a.pkg)),
    isolated: pool.filter(a => S.snap.has(a.pkg) || isIso(a.pkg)),
  };

  for (const element of document.querySelectorAll('[data-cnt]')) {
    element.textContent = by[element.dataset.cnt].length;
  }

  const tot = $('.cnt-total');

  if (tot) {
    tot.textContent = `${by[S.filter].length} ${t('apps_total')}`;
  }

  const rows = [...by[S.filter]].toSorted((a, b) => (a.label || a.pkg).localeCompare(b.label || b.pkg));

  const top = keep ? list.scrollTop : 0;
  /* Avoid browser scroll-into-view on the recreated focused control */
  if (keep && document.activeElement && list.contains(document.activeElement)) {
    document.activeElement.blur();
  }

  list.innerHTML = rows.length > 0 ? rows.map(a => rowHtml(a)).join('') : `<div class="empty">${esc(t('empty_title'))}</div>`;
  list.scrollTop = top;
  if (keep) {
    requestAnimationFrame(() => {
      list.scrollTop = top;
      customScrollSchedule(false);
    });
  }

  refreshHero();
  customScrollSchedule(false);
}

function refreshHero() {
  const c = counts();

  const h = $('#main')?.querySelector(':scope .hero') || document.querySelector(':scope .hero');

  if (!h) {
    return;
  }

  h.querySelector(':scope .hero-title strong').textContent = c.iso;
  h.querySelector(':scope .badge').textContent = S.current || t('profile_none');
}

function renderProfiles() {
  const names = Object.keys(S.profiles);

  const items = names.map(n => `<div class="prof ${S.current === n ? 'active' : ''}" data-profile="${esc(n)}">
    <div><b>${esc(n)}</b><small>${profileSize(S.profiles[n])} ${esc(t('profile_apps'))}</small></div>${CHECK}
    <button type="button" class="iconbtn ${S.armed === n ? 'armed' : ''}" data-del="${esc(n)}" `
    + `title="${esc(S.armed === n ? t('confirm_delete') : '')}" aria-label="delete">`
    + `${ICON.trash}</button></div>`).join('');

  return `<section class="hero"><div class="eyebrow">${esc(t('tab_profiles'))}</div>
    <div class="hero-title"><strong>${names.length}</strong><span class="badge">${esc(S.current || t('profile_none'))}</span></div>
    <p class="hero-sub">${esc(t('profiles_sub'))}</p></section>
    <div class="group"><span>${esc(t('profiles_title'))}</span><span></span></div>
    <div class="proflist">${items}</div>
    ${names.length > 0 ? '' : `<p class="hint">${esc(t('profiles_empty'))}</p>`}
    <div class="options"><div class="eyebrow">${esc(t('new_profile'))}</div>
      <div class="field"><input class="input" id="newName" maxlength="40" inputmode="latin" `
    + 'autocapitalize="off" autocorrect="off" spellcheck="false" '
    + `placeholder="${esc(t('new_profile_placeholder'))}" value="${esc(S.newName)}">
      <button type="button" class="btn" id="createBtn">${esc(t('create'))}</button></div></div>
    ${renderBackup()}`;
}

/*
Backup block lives inside the Profiles page
*/
function renderBackup() {
  const isExp = S.ioMode === 'export';

  const panel = isExp
    ? `<div class="options"><div class="eyebrow">${esc(t('destination_path'))}</div>
      <div class="field"><input class="input" id="exportPath" spellcheck="false" `
    + 'autocapitalize="off" placeholder="/sdcard/Download/profiles.json" '
    + `value="${esc(S.ioPath)}"><button type="button" class="btn ghost" id="saveBtn">`
    + `${esc(t('choose'))}</button></div>
      <p class="hint">${esc(t('export_desc'))}</p>
      <div class="field"><button type="button" class="btn grow" id="exportBtn">${esc(t('run'))}</button></div></div>`
    : `<div class="options"><div class="eyebrow">${esc(t('source_path'))}</div>
      <div class="field"><input class="input" id="importPath" spellcheck="false" `
      + 'autocapitalize="off" placeholder="/sdcard/Download/profiles.json" '
      + `value="${esc(S.importPath)}"><button type="button" class="btn ghost" id="pickBtn">`
      + `${esc(t('choose'))}</button></div>
      <p class="hint">${esc(t('import_desc'))}</p>
      <div class="field"><button type="button" class="btn grow" id="importBtn">${esc(t('run'))}</button></div></div>`;

  return `<div class="group"><span>${esc(t('backup_title'))}</span><span class="badge">JSON</span></div>
    <p class="hint" style="margin-top:0">${esc(t('backup_sub'))}</p>
    <div class="seg mt">
      <button type="button" class="choice ${isExp ? 'active' : ''}" data-c="block" data-mode='export'><div class="choice-top"><span class="lbl">${esc(t('export_option'))}</span>${CHECK}</div></button>
      <button type="button" class="choice ${isExp ? '' : 'active'}" data-c="block" data-mode="import"><div class="choice-top"><span class="lbl">${esc(t('import_option'))}</span>${CHECK}</div></button>
    </div>
    ${panel}`;
}

function render() {
  const main = $('#main');
  main.className = 'page-' + S.page;
  main.innerHTML = S.page === 'apps' ? `<div class="page">${renderApps()}</div>` : renderProfiles();

  if (S.page === 'apps') {
    fillList(false);
  }

  renderNav();
  installCustomScrollbar();
}

/*
── Events ─────────────────────────────────────────────────────────────
*/
function bind() {
  $('#nav').addEventListener('click', event_ => {
    const b = event_.target.closest('[data-page]');
    if (!b) {
      return;
    }

    S.page = b.dataset.page;
    S.armed = '';
    render();
  });

  $('#langBtn').addEventListener('click', event_ => {
    event_.stopPropagation();
    const open = $('#langMenu').classList.toggle('open');
    $('#langBtn').setAttribute('aria-expanded', open);
  });

  $('#langMenu').addEventListener('click', event_ => {
    const b = event_.target.closest('[data-lang]');
    if (!b) {
      return;
    }

    $('#langMenu').classList.remove('open');
    setLang(b.dataset.lang, true);
  });

  document.addEventListener('click', () => {
    $('#langMenu').classList.remove('open');
  });

  const main = $('#main');
  main.addEventListener('click', event_ => {
    const f = event_.target.closest('[data-filter]');
    if (f) {
      S.filter = f.dataset.filter;
      for (const x of main.querySelectorAll('[data-filter]')) {
        x.classList.toggle('active', x === f);
      }

      return fillList(false);
    }

    const row = event_.target.closest('.app-row');
    if (row) {
      if (event_.target.closest('[data-all]')) {
        return toggleAll(row.dataset.pkg);
      }

      const chip = event_.target.closest('[data-ch]');
      if (chip) {
        return toggleChannel(row.dataset.pkg, chip.dataset.ch);
      }

      return;
    }

    const del = event_.target.closest('[data-del]');
    if (del) {
      event_.stopPropagation();
      if (S.armed === del.dataset.del) {
        return deleteProfile(del.dataset.del);
      }

      S.armed = del.dataset.del;
      render();
      setTimeout(() => {
        if (S.armed !== del.dataset.del) {
          return;
        }

        S.armed = '';
        if (S.page === 'profiles') {
          render();
        }
      }, 3000);
      return;
    }

    const p = event_.target.closest('[data-profile]');
    if (p) {
      return activateProfile(p.dataset.profile);
    }

    if (event_.target.closest('#createBtn')) {
      return createProfile();
    }

    const m = event_.target.closest('[data-mode]');
    if (m) {
      S.ioMode = m.dataset.mode;
      return render();
    }

    if (event_.target.closest('#saveBtn')) {
      return fbOpen('export');
    }

    if (event_.target.closest('#pickBtn')) {
      return fbOpen('import');
    }

    if (event_.target.closest('#exportBtn')) {
      return exportProfiles();
    }

    if (event_.target.closest('#importBtn')) {
      return importProfiles();
    }
  });

  main.addEventListener('input', event_ => {
    if (event_.target.id === 'search') {
      S.q = event_.target.value;
      fillList(false);
      return;
    }

    if (event_.target.id === 'newName') {
      /*
      Profile names: Latin letters, digits, space, "-", "_" and "." only
      */
      const clean = event_.target.value.replaceAll(/[^\w \-.]/gv, '');
      if (clean !== event_.target.value) {
        const pos = event_.target.selectionStart - (event_.target.value.length - clean.length);
        event_.target.value = clean;
        try {
          event_.target.setSelectionRange(pos, pos);
        } catch {
          /*
          ignore
          */
        }
      }

      S.newName = clean;
      return;
    }

    if (event_.target.id === 'exportPath') {
      S.ioPath = event_.target.value;
      return;
    }

    if (event_.target.id === 'importPath') {
      S.importPath = event_.target.value;
    }
  });

  $('#alertClose').addEventListener('click', hideAlert);
  $('#fbClose').addEventListener('click', fbClose);
  $('#fbModal').addEventListener('click', event_ => {
    if (event_.target.id === 'fbModal') {
      fbClose();
    }
  });
  $('#fbSelect').addEventListener('click', () => {
    let base = FB.dir;
    if (base.endsWith('/')) {
      base = base.slice(0, -1);
    }

    fbPick(base + '/net-switcher-profiles.json');
  });
  $('#fbList').addEventListener('click', event_ => {
    const b = event_.target.closest('.fb-row');
    if (!b) {
      return;
    }

    const {kind, name} = b.dataset;
    if (kind === 'up') {
      return fbList(dirOf(FB.dir));
    }

    const full = (FB.dir === '/' ? '' : FB.dir) + '/' + name;
    if (kind === 'dir') {
      return fbList(full);
    }

    fbPick(full);
  });
  $('#evBtn').addEventListener('click', () => {
    refreshEvents();
    $('#evModal').classList.remove('hidden');
    installCustomScrollbar();
  });
  $('#evClose').addEventListener('click', () => {
    $('#evModal').classList.add('hidden');
    installCustomScrollbar();
  });
  $('#evModal').addEventListener('click', event_ => {
    if (event_.target.id !== 'evModal') {
      return;
    }

    event_.target.classList.add('hidden');
    installCustomScrollbar();
  });
  main.addEventListener('keydown', event_ => {
    if (event_.key === 'Enter' && event_.target.id === 'newName') {
      createProfile();
    }
  });
  /*
  Broken icon -> keep the letter placeholder
  */
  main.addEventListener('error', event_ => {
    if (event_.target.tagName === 'IMG') {
      event_.target.remove();
    }
  }, {capture: true});
  main.addEventListener('load', event_ => {
    if (event_.target.tagName === 'IMG') {
      event_.target.parentElement.classList.add('is-ok');
    }
  }, {capture: true});
}

async function init() {
  bind();

  setLang(detectLang(), false);

  busy(true);

  await exec(`mkdir -p ${q(CFG_DIR)}`);

  await loadPackages();

  const installed = new Set(S.apps.map(a => a.pkg));

  S.rules = new Map();
  const dumpResult = await ns('dump');
  for (const line of dumpResult.stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i < 1) {
      continue;
    }

    const set = parseChans(line.slice(i + 1));
    if (set.size > 0) {
      S.rules.set(line.slice(0, i), set);
    }
  }

  if (installed.size > 0) {
    /*
    Drop rules of uninstalled apps
    */
    const stale = [];
    for (const pkg of S.rules.keys()) {
      if (!installed.has(pkg)) {
        stale.push(pkg);
      }
    }

    for (const pkg of stale) {
      S.rules.delete(pkg);
    }

    await Promise.all(stale.map(pkg => ns('set', pkg, 'none')));
  }

  snapNow();

  const profiles = await readJson(PROFILES_PATH, {});

  S.profiles = profiles && typeof profiles === 'object' && !Array.isArray(profiles) ? profiles : {};

  const cfg = await readJson(DEFAULT_PATH, {});

  S.current = cfg.currentProfile && Object.hasOwn(S.profiles, cfg.currentProfile) ? cfg.currentProfile : '';

  busy(false);

  render();
  loadLabels();
}

init();
