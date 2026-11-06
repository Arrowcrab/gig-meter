import {
  FORMATS,
  DECIMAL_CHOICES,
  DEFAULT_DECIMALS,
  parseMoney,
  formatMoney,
  formatAmount,
  buildSchedule,
  validateConfig,
  newSession,
  getStatus,
  toggle,
  reset,
  stop,
  editableTimes,
  startAt,
  setStartTime,
  setEndTime,
} from './meter.js';
import {
  THEMES, DEFAULT_THEME, themeOf, faceOf, viewModel, UNITS, durationLong,
  savedTitle, savedSummary, upsertSaved, removeSaved, matchSaved, readSaved,
  historyEntry, addHistory, removeHistory, readHistory, historyTotals, historyRow,
  wantsInstallHint, receipt, receiptText, receiptFileName, gigFinished,
  undoState, resetLabel, resetTap, primaryBlocked,
  saveRestarts as restartsOnSave, repriceNote, saveEndsGig,
} from './view.js';

const STORAGE_KEY = 'gig-meter:v1';
const $ = (id) => document.getElementById(id);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const form = $('setup-form');
const faces = Object.fromEntries([...document.querySelectorAll('[data-face]')].map((el) => [el.dataset.face, el]));

const view = { theme: null, parts: null, phase: null, cents: -1, dollars: null, fitKey: '', logKey: '', led: -1 };
const loop = { raf: 0, timer: 0 };
// The last Stop or Reset, while it can be undone: { at, kind, before, after, historyId,
// historyBefore, historyAfter } (the gig and the History list before and after).
let undo = null;
let saveConfirmUntil = 0;
let reloadWhenSetupCloses = false;
let rolledDate = null; // { saved, shown } when Setup moved an ended session's date forward
let timesShown = { start: '', end: '' }; // the Start/Stop times Setup opened with, to spot edits
let newGigSetup = false; // Setup was opened from "New gig", so Save always starts fresh
// What Setup's Save last said it would do ('restart', 'keep' or 'ends'), when that was
// worked out, and whether errors were on show. The clock can change the answer while
// Setup is open (a fee gets earned), so Setup refreshes it, and a Save that would now
// do something else shows the new answer first.
const formShown = { decision: '', at: 0, errors: false };

// ---------- small helpers ----------

const pad = (n) => String(n).padStart(2, '0');
const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
const decimalsOf = (config) => (DECIMAL_CHOICES.includes(config.decimals) ? config.decimals : DEFAULT_DECIMALS);

function rateText(status) {
  const perSecond = status.centsPerHour / 3600;
  if (!perSecond) return '';
  const tick = perSecond >= 1
    ? `${perSecond.toFixed(perSecond < 10 ? 1 : 0)}¢ a second`
    : `a cent every ${(1 / perSecond).toFixed(1 / perSecond < 10 ? 1 : 0)} sec`;
  return `${formatMoney(Math.floor(status.centsPerHour / 60))} a minute · ${tick}`;
}

const todayISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function addToTime(time, minutes) {
  const [h, m] = time.split(':').map(Number);
  const total = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

function defaultConfig() {
  const start = new Date();
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() + 1);
  return {
    name: '',
    format: 'service',
    amountCents: 0,
    plannedMinutes: 180,
    mode: 'manual',
    schedule: { date: todayISO(start), start: hhmm(start), end: addToTime(hhmm(start), 180), breaksOn: false, breaks: [] },
    manualPause: false,
    decimals: DEFAULT_DECIMALS,
    theme: DEFAULT_THEME,
  };
}

// ---------- saving ----------

function load() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!data || !Array.isArray(data.events) || validateConfig(data.config)) return null;
    const events = data.events.filter((e) => Number.isFinite(e?.t) && ['resume', 'pause', 'stop'].includes(e.type));
    return { config: data.config, events, scheduleArmed: Boolean(data.scheduleArmed) };
  } catch {
    return null;
  }
}

function persist() {
  hasSaved = true;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Private browsing or storage full: the meter still works, it just won't survive a reload.
  }
}

let hasSaved = false;
let session = load();
if (session) hasSaved = true;
else session = newSession(defaultConfig()); // shown behind the first-run setup, not saved

// Saved gigs: regular gigs kept apart from the meter, loaded into Setup with one tap.
const SAVED_KEY = 'gig-meter:saved:v1';
let savedGigs = [];
try { savedGigs = readSaved(localStorage.getItem(SAVED_KEY)); } catch { savedGigs = []; }
let savedNoteUntil = 0; // "Saved ✓" shows on the button for a moment after adding,
let savedNoteId = ''; // while the form still shows that saved gig

function persistSaved() {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(savedGigs));
  } catch {
    // Storage unavailable: the list still works until the app is closed.
  }
}

// History: what past gigs earned. A gig with money on it is filed here when it's
// replaced by a new one or Reset (with the Pause button on, that's how a gig ends).
const HISTORY_KEY = 'gig-meter:history:v1';
let pastGigs = [];
try { pastGigs = readHistory(localStorage.getItem(HISTORY_KEY)); } catch { pastGigs = []; }

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function persistHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(pastGigs));
  } catch {
    // Storage unavailable: kept until the app is closed.
  }
}

// Returns the new record's id (null when the gig earned nothing), so it can be undone.
function fileInHistory(old, now) {
  const entry = historyEntry(old, now, newId());
  if (!entry) return null;
  pastGigs = addHistory(pastGigs, entry);
  persistHistory();
  return entry.id;
}

// ---------- looks ----------

const fontLinks = {};

// Each look's web fonts are requested only once that look is used; the offline copy
// keeps them after the first time.
function loadFonts(theme) {
  const families = THEMES[theme].fonts;
  if (!families || fontLinks[theme]) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.crossOrigin = 'anonymous'; // lets the offline copy see whether the request worked
  link.href = `https://fonts.googleapis.com/css2?${families}&display=swap`;
  const settled = () => { link.dataset.settled = 'true'; };
  link.addEventListener('load', settled, { once: true });
  link.addEventListener('error', settled, { once: true });
  document.head.append(link);
  fontLinks[theme] = link;
}

// The phone's top-bar color follows the page, including the Poster's phase colors.
function syncTopBar() {
  const bg = getComputedStyle(document.body).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]').content = bg || THEMES[view.theme].color;
}

// Quiet turns dark with the phone, so its top-bar color follows the switch too.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => syncTopBar());

function applyTheme(theme) {
  if (theme === view.theme) return;
  const face = faces[faceOf(theme)];
  for (const el of Object.values(faces)) el.hidden = el !== face;
  document.body.dataset.theme = theme;
  loadFonts(theme);
  view.theme = theme;
  view.parts = {
    binds: [...face.querySelectorAll('[data-bind]')],
    shows: [...face.querySelectorAll('[data-show]')],
    widths: [...face.querySelectorAll('[data-width]')],
    amount: face.querySelector('.amount'),
    log: face.querySelector('[data-log]'),
    leds: [...face.querySelectorAll('.f-led')],
    resets: [...face.querySelectorAll('[data-action="reset"]')],
  };
  Object.assign(view, { cents: -1, fitKey: '', logKey: '', logClock: null, led: -1 });
  syncTopBar();
}

// ---------- meter rendering ----------

// Fill the visible look: every [data-bind] gets its text, [data-show] parts appear or
// hide, [data-width] bars take their width.
function applyView(vm) {
  const { binds, shows, widths, leds } = view.parts;
  for (const el of binds) setText(el, String(vm[el.dataset.bind] ?? ''));
  for (const el of shows) el.hidden = !vm[el.dataset.show];
  for (const el of widths) if (el.style.width !== vm[el.dataset.width]) el.style.width = vm[el.dataset.width];
  if (leds.length && vm.ledLit !== view.led) {
    leds.forEach((el, i) => el.classList.toggle('lit', i < vm.ledLit));
    view.led = vm.ledLit;
  }
}

// Size the number so the widest it will get still fits its space. Flat fees are sized
// for the full fee from the start, so the digits don't shrink partway through.
const probe = Object.assign(document.createElement('span'), { ariaHidden: 'true' });
probe.style.cssText = 'position: absolute; left: -9999px; top: 0; visibility: hidden; white-space: nowrap; font-variant-numeric: tabular-nums';
document.body.append(probe);

function fitAmount(status, decimals) {
  const el = view.parts.amount;
  const box = el.parentElement;
  const boxStyle = getComputedStyle(box);
  const width = box.clientWidth - parseFloat(boxStyle.paddingLeft) - parseFloat(boxStyle.paddingRight);
  const basisCents = Math.max(status.cents, status.capCents ?? 10000);
  const text = formatAmount(basisCents * 10 ** (decimals - 2), decimals);
  const key = `${view.theme}|${text.length}|${width}|${innerHeight}`;
  if (width <= 0 || key === view.fitKey) return;
  view.fitKey = key;
  const style = getComputedStyle(el);
  const spacing = (parseFloat(style.letterSpacing) || 0) / parseFloat(style.fontSize);
  Object.assign(probe.style, {
    fontFamily: style.fontFamily, fontWeight: style.fontWeight, fontStretch: style.fontStretch,
    fontSize: '100px', letterSpacing: `${spacing * 100}px`,
  });
  probe.textContent = text;
  // Sideways (the stand view) the cap is a share of the screen height instead.
  const stand = parseFloat(style.getPropertyValue('--stand-max'));
  const max = stand > 0 ? Math.floor(innerHeight * stand) : parseFloat(style.getPropertyValue('--amount-max')) || 72;
  el.style.fontSize = `${Math.min(max, Math.floor((width * 100) / probe.getBoundingClientRect().width))}px`;
}

// Once per cent: the spoken label, and a small pulse on every new whole dollar.
function renderCents(status) {
  if (status.cents === view.cents) return;
  const el = view.parts.amount;
  el.setAttribute('aria-label', formatMoney(status.cents));
  const dollars = Math.floor(status.cents / 100);
  if (view.dollars != null && dollars > view.dollars && !reducedMotion.matches) {
    el.classList.remove('bump');
    void el.offsetWidth; // restart the animation
    el.classList.add('bump');
  }
  view.dollars = dollars;
  view.cents = status.cents;
}

// The Pay stub's printed log. The live "Running" line's clock is updated in place, so
// the list (and its blinking cursor) is only rebuilt when the history changes.
function renderLog(log, running) {
  const ol = view.parts.log;
  if (!ol) return;
  const key = log.map((l, i) => (running && i === log.length - 1 ? 'live' : `${l.time} ${l.what} ${l.current}`)).join('|');
  if (key !== view.logKey) {
    view.logKey = key;
    view.logClock = null;
    ol.replaceChildren(...log.map((l, i) => {
      const li = document.createElement('li');
      const time = Object.assign(document.createElement('span'), { className: 't', textContent: l.time });
      const what = Object.assign(document.createElement('span'), { textContent: l.what });
      li.append(time, what);
      if (l.current) li.append(Object.assign(document.createElement('span'), { className: 'cursor' }));
      if (running && i === log.length - 1) view.logClock = time;
      return li;
    }));
  }
  if (view.logClock) setText(view.logClock, log.at(-1).time);
}

function render(now) {
  const status = getStatus(session, now);
  const phaseChanged = status.phase !== view.phase;
  if (phaseChanged) {
    document.body.dataset.phase = status.phase;
    syncTopBar();
    wakeWanted = status.running;
    syncWakeLock();
  }

  const decimals = decimalsOf(session.config);
  const vm = viewModel(session, status, now, decimals);
  const undoing = undoState(undo, session, now) !== 'none';
  vm.resetLabel = resetLabel(status.phase, undoing);
  applyView(vm);
  for (const button of view.parts.resets) {
    button.disabled = status.phase === 'idle' && !undoing;
    button.classList.toggle('undo', undoing);
  }
  fitAmount(status, decimals);
  renderCents(status);
  renderLog(vm.log, status.running);
  view.phase = status.phase;
  return status;
}

// While running, redraw every frame so each cent appears the moment it's earned.
// A timer also checks four times a second: it drives countdowns and the schedule
// starting the meter on its own, and keeps the number moving if the browser stops
// delivering frames (Low Power Mode, background webviews).
// The timer is never allowed to stop. It is set before drawing, so a drawing error
// can't end the loop, and it keeps ticking once a second while the page is hidden, so
// if the phone shows the page again without announcing it, the next tick picks the
// meter back up. (iPhones pause hidden pages anyway, so this costs no battery.)
function frame() {
  cancelAnimationFrame(loop.raf);
  clearTimeout(loop.timer);
  loop.timer = setTimeout(frame, document.hidden ? 1000 : 250);
  if (!$('setup').hidden && Date.now() - formShown.at >= 1000) updateForm(formShown.errors);
  const status = render(Date.now());
  if (!document.hidden && status.running) loop.raf = requestAnimationFrame(frame);
}

function kick() {
  frame();
}

// ---------- keep the screen awake while earning ----------

let wakeWanted = false;
let wakeLock = null;
let wakePending = false;

async function syncWakeLock() {
  if (!('wakeLock' in navigator) || wakePending) return;
  if (wakeWanted && !wakeLock && document.visibilityState === 'visible') {
    wakePending = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
      wakeLock = lock;
    } catch {
      // Not allowed here; the phone's normal auto-lock applies. The amount stays right anyway.
    }
    wakePending = false;
  }
  if (!wakeWanted && wakeLock) {
    const lock = wakeLock;
    wakeLock = null;
    lock.release().catch(() => {});
  }
}

// ---------- meter controls (every look's buttons) ----------

// The big button does whatever this look and setting show on it: start or resume,
// pause, stop, or set up a new gig. Stop happens on the first tap; the Reset button
// then offers Undo for a few seconds.
function pressPrimary() {
  const now = Date.now();
  if (primaryBlocked(undo, session, now)) return; // the second tap of the old "tap, Sure?, tap" habit
  const status = getStatus(session, now);
  const { primaryAction } = viewModel(session, status, now, decimalsOf(session.config));
  if (primaryAction === 'newGig') return openSetup({ newGig: true });
  if (primaryAction === 'stop') {
    const before = session;
    session = stop(session, now);
    undo = { at: now, kind: 'stop', before, after: session, historyId: null };
  } else if (primaryAction === 'toggle') {
    session = toggle(session, now);
  } else {
    return;
  }
  persist();
  kick();
}

// Reset (Cancel, while a schedule waits) happens on the first tap, filing the gig in
// History; the same button then reads Undo for a few seconds.
function pressReset(button) {
  const now = Date.now();
  const tap = resetTap(undo, session, now, button?.classList.contains('undo'));
  if (tap === 'ignore') return;
  if (tap === 'undo') return undoLast();
  const before = session;
  const historyBefore = pastGigs;
  const historyId = hasSaved ? fileInHistory(session, now) : null;
  session = reset(session);
  undo = { at: now, kind: 'reset', before, after: session, historyId, historyBefore, historyAfter: pastGigs };
  persist();
  kick();
}

// Puts the gig back exactly as it was before the Stop or Reset. An undone Stop counts
// the seconds in between, as if it had never stopped; an undone Reset takes the gig
// back out of History (restoring the whole list when nothing else changed it, so a
// full History gets back the oldest record it dropped to make room).
function undoLast() {
  if (undo.historyId) {
    pastGigs = pastGigs === undo.historyAfter ? undo.historyBefore : removeHistory(pastGigs, undo.historyId);
    persistHistory();
  }
  session = undo.before;
  undo = null;
  Object.assign(view, { cents: -1, dollars: null, fitKey: '', logKey: '' });
  persist();
  kick();
}

document.addEventListener('click', (e) => {
  const button = e.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const { action } = button.dataset;
  if (action === 'setup') openSetup();
  else if (action === 'primary') pressPrimary();
  else if (action === 'reset') pressReset(button);
  else if (action === 'receipt') {
    const now = Date.now();
    openReceipt(historyEntry(session, now, 'current'), !gigFinished(getStatus(session, now)));
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) kick();
  syncWakeLock();
});
window.addEventListener('pageshow', kick);
window.addEventListener('focus', kick);
window.addEventListener('resize', () => { view.fitKey = ''; kick(); });
document.fonts?.addEventListener?.('loadingdone', () => { view.fitKey = ''; kick(); });

// ---------- setup sheet ----------

for (const [key, format] of Object.entries(FORMATS)) {
  const label = document.createElement('label');
  const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'format', value: key });
  const span = document.createElement('span');
  span.textContent = format.label;
  label.append(input, span);
  $('f-format').append(label);
}

function breakRow(b) {
  const li = $('break-row').content.firstElementChild.cloneNode(true);
  li.querySelector('.b-start').value = b.start || '';
  li.querySelector('.b-min').value = b.minutes || 10;
  li.querySelector('.remove').addEventListener('click', () => {
    li.remove();
    updateForm();
  });
  return li;
}

// Money typed into a box: "15" or "12.50" back from whole cents.
const moneyText = (cents) => (cents ? (cents / 100).toFixed(2).replace(/\.00$/, '') : '');

function extraRow(x = {}) {
  const li = $('extra-row').content.firstElementChild.cloneNode(true);
  li.querySelector('.x-label').value = x.label || '';
  li.querySelector('.x-amount').value = moneyText(x.amountCents);
  li.querySelector('.remove').addEventListener('click', () => {
    li.remove();
    updateForm();
  });
  return li;
}

// Overtime needs a planned end: a fee (with its planned length or schedule), or a schedule.
const overtimeApplies = (config) => FORMATS[config.format]?.kind === 'flat' || config.mode === 'scheduled';

function fillForm(config) {
  $('f-name').value = config.name || '';
  form.elements.format.value = config.format;
  $('f-amount').value = config.amountCents ? (config.amountCents / 100).toFixed(2).replace(/\.00$/, '') : '';
  const planned = config.plannedMinutes > 0 ? config.plannedMinutes : 180;
  $('f-hours').value = Math.floor(planned / 60);
  $('f-minutes').value = planned % 60;
  form.elements.mode.value = config.mode;

  const schedule = { ...defaultConfig().schedule, ...config.schedule };
  // A past session comes back with the same times on the next day they're still ahead,
  // unless it's the gig on the meter and it's still going in overtime.
  const now = Date.now();
  const savedDate = schedule.date;
  const live = config === session.config ? getStatus(session, now) : null;
  const inOvertime = Boolean(live) && !live.stopped && (live.phase === 'overtime' || live.overtimeMs > 0);
  for (let d = new Date(); !inOvertime && buildSchedule(schedule).endMs <= now; d.setDate(d.getDate() + 1)) {
    schedule.date = todayISO(d);
    if (d - now > 2 * 86400000) break;
  }
  rolledDate = schedule.date !== savedDate ? { saved: savedDate, shown: schedule.date } : null;
  $('f-date').value = schedule.date;
  $('f-start').value = schedule.start;
  $('f-end').value = schedule.end;
  const breaks = Array.isArray(schedule.breaks) ? schedule.breaks : [];
  $('f-breaks').replaceChildren(...breaks.map(breakRow));
  // Gigs saved before the switch existed have breaks on exactly when they listed any.
  // (Read the saved gig's own value: the defaults merged into `schedule` say off.)
  $('f-breaks-on').checked = config.schedule?.breaksOn ?? breaks.length > 0;
  $('f-pause').checked = config.manualPause === true;
  form.elements.decimals.value = String(decimalsOf(config));

  const { start, end } = editableTimes(session);
  timesShown = { start: start ? hhmm(new Date(start.t)) : '', end: end ? hhmm(new Date(end.t)) : '' };
  $('f-begin-at').value = '';
  $('f-start-at').value = timesShown.start;
  $('f-end-at').value = timesShown.end;
  setText($('end-at-label'), end?.type === 'pause' ? 'Paused at' : 'Stopped at');
  form.elements.theme.value = themeOf(config);
  $('f-extras').replaceChildren(...(Array.isArray(config.extras) ? config.extras : []).map(extraRow));
  $('f-ot-on').checked = config.overtime?.on === true;
  $('f-ot-rate').value = moneyText(config.overtime?.amountCents);
}

function readForm() {
  const hours = Math.max(0, Number($('f-hours').value) || 0);
  const minutes = Math.max(0, Number($('f-minutes').value) || 0);
  const config = {
    name: $('f-name').value.trim().slice(0, 40),
    format: form.elements.format.value,
    amountCents: parseMoney($('f-amount').value) ?? 0,
    plannedMinutes: Math.round(hours * 60 + minutes),
    mode: form.elements.mode.value,
    schedule: {
      date: $('f-date').value,
      start: $('f-start').value,
      end: $('f-end').value,
      breaksOn: $('f-breaks-on').checked,
      breaks: [...$('f-breaks').children].map((li) => ({
        start: li.querySelector('.b-start').value,
        minutes: Number(li.querySelector('.b-min').value),
      })),
    },
    manualPause: $('f-pause').checked,
    decimals: Number(form.elements.decimals.value) || DEFAULT_DECIMALS,
    theme: themeOf({ theme: form.elements.theme.value }),
    // A row left completely blank is ignored; one with a label but no amount is an error.
    extras: [...$('f-extras').children]
      .map((li) => ({ label: li.querySelector('.x-label').value.trim().slice(0, 30), text: li.querySelector('.x-amount').value.trim() }))
      .filter((x) => x.label || x.text)
      .map((x) => ({ label: x.label, amountCents: parseMoney(x.text) ?? 0 })),
    overtime: { on: false, amountCents: parseMoney($('f-ot-rate').value) ?? 0 },
  };
  config.overtime.on = $('f-ot-on').checked && overtimeApplies(config);
  if (overtimeLocked(config)) config.overtime = session.config.overtime ?? { on: false, amountCents: 0 };
  return config;
}

// The form as it would be saved without Setup's automatic date change: an ended
// session's date shown moved forward but left untouched isn't a change.
function asSaved(config) {
  if (!rolledDate || config.schedule.date !== rolledDate.shown) return config;
  return { ...config, schedule: { ...config.schedule, date: rolledDate.saved } };
}

// Saving starts a fresh meter on first run, from "New gig", and for a different gig
// (new timing, a schedule switched back on, new pay once a gig is finished: see
// saveRestarts in view.js). New pay on a gig under way re-prices it and keeps it going;
// a new name, look, decimal places or Pause button setting never restart.
function saveRestarts(config) {
  return !hasSaved || newGigSetup || restartsOnSave(session, asSaved(config), Date.now());
}

// Once the gig on the meter is past its planned end (in overtime, or finished), its
// overtime setting is locked: switching it then would wake a finished gig or erase
// overtime already earned. It unlocks when Save is going to start a fresh gig anyway.
function overtimeLocked(config) {
  if (saveRestarts(config)) return false;
  const live = getStatus(session, Date.now());
  return ['over', 'paid', 'overtime'].includes(live.phase) || live.overtimeMs > 0;
}

// "This gig" offers one of two things. For a gig that hasn't started (or that Save will
// start fresh), "Already working? Started at" starts the meter from a past time. For a
// gig under way, its Start and its Stop (or last Pause) can be corrected. It isn't shown
// when the corrections would be thrown away, or for a schedule's own start.
function timesMode(config) {
  const fresh = saveRestarts(config) || !session.events.length;
  if (fresh) return config.mode === 'manual' ? 'begin' : null;
  const { start, end } = editableTimes(session);
  return start || end ? 'fix' : null;
}

// The gig with the times entered in "This gig" applied (only fields that were changed).
function applyTimes(base, mode, now) {
  if (mode === 'begin') {
    const value = $('f-begin-at').value;
    return value ? startAt(base, value, now) : { session: base };
  }
  if (mode !== 'fix') return { session: base };
  let fixed = base;
  const startValue = $('f-start-at').value;
  const endValue = $('f-end-at').value;
  if (timesShown.start && startValue && startValue !== timesShown.start) {
    const result = setStartTime(fixed, startValue, now);
    if (result.error) return result;
    fixed = result.session;
  }
  if (timesShown.end && endValue && endValue !== timesShown.end) {
    const result = setEndTime(fixed, endValue, now);
    if (result.error) return result;
    fixed = result.session;
  }
  return { session: fixed };
}

const timesChanged = (mode) => (mode === 'begin'
  ? Boolean($('f-begin-at').value)
  : mode === 'fix' && ($('f-start-at').value !== timesShown.start || $('f-end-at').value !== timesShown.end));

function formError(config, now) {
  const error = validateConfig(config);
  if (error) return error;
  // Only a fresh start needs a schedule still ahead; a gig running on (overtime) can be edited.
  if (config.mode === 'scheduled' && saveRestarts(config) && buildSchedule(config.schedule).endMs <= now) {
    return 'That session has already ended. Pick a later date or time.';
  }
  return null;
}

function updateForm(showErrors = false) {
  const now = Date.now();
  const config = readForm();
  Object.assign(formShown, { decision: saveDecision(config, now), at: now, errors: showErrors });
  const format = FORMATS[config.format];
  setText($('f-unit'), UNITS[config.format]);
  $('format-note').hidden = !format.note;
  setText($('format-note'), format.note || '');
  $('planned-field').hidden = !(format.kind === 'flat' && config.mode === 'manual');
  $('schedule-fields').hidden = config.mode !== 'scheduled';
  $('breaks-area').hidden = !config.schedule.breaksOn;
  $('ot-field').hidden = !overtimeApplies(config);
  const otLocked = overtimeLocked(config);
  if (otLocked) {
    $('f-ot-on').checked = config.overtime.on;
    $('f-ot-rate').value = moneyText(config.overtime.amountCents);
  }
  $('f-ot-on').disabled = otLocked;
  $('f-ot-rate').disabled = otLocked;
  $('ot-rate-wrap').hidden = !$('f-ot-on').checked;
  setText($('ot-hint'), otLocked
    ? 'This gig is past its planned end, so its overtime can’t be changed now. Tap Stop to end it.'
    : 'When the planned work is done, the meter keeps going at this rate until you tap Stop.');

  const mode = timesMode(config);
  $('times-field').hidden = !mode;
  $('begin-wrap').hidden = mode !== 'begin';
  $('fix-wrap').hidden = mode !== 'fix';
  $('clear-begin').style.visibility = $('f-begin-at').value ? '' : 'hidden';
  $('start-at-wrap').hidden = !timesShown.start;
  $('end-at-wrap').hidden = !timesShown.end;
  setText($('times-hint'), mode === 'begin'
    ? 'Leave blank to start with the Start button, or enter a time to start the meter from then.'
    : 'Forgot to tap Start or Stop? Set the real time and the total updates. This doesn’t restart the meter.');

  const summary = $('summary');
  const error = formError(config, now);
  // Corrected times: check them, and show the total they give.
  let timesNote = null;
  let timesError = null;
  if (!error && mode && timesChanged(mode)) {
    const base = mode === 'begin' && saveRestarts(config) ? newSession(config) : { ...session, config: asSaved(config) };
    const result = applyTimes(base, mode, now);
    if (result.error) timesError = result.error;
    else timesNote = `With these times: ${formatMoney(getStatus(result.session, now).cents)} earned so far`;
  }

  summary.classList.toggle('error', Boolean(error || timesError) && (showErrors || config.amountCents > 0 || Boolean(timesError)));
  if (error && !showErrors && !$('f-amount').value.trim()) {
    setText(summary, 'Enter your pay to see how fast it adds up.');
  } else if (error || timesError) {
    setText(summary, error || timesError);
    summary.classList.add('error');
  } else if (timesNote) {
    setText(summary, timesNote);
  } else {
    // Saving keeps the gig: say what it does to the total so far, when it changes it.
    const note = saveRestarts(config) ? '' : repriceNote(session, asSaved(config), now);
    const preview = getStatus(newSession(config), now);
    const rate = rateText(preview);
    setText(summary, note || (preview.plannedMs ? `${durationLong(preview.plannedMs)} of work · ${rate}` : rate));
  }

  const label = saveLabel(config, now);
  setText($('save'), label === 'Save' && mode === 'begin' && timesChanged(mode) ? 'Save & start' : label);
  markSaved(config);
}

// ---------- saved gigs in Setup ----------

const SAVED_HINT = 'Keeps this gig’s pay, times and look, to fill in with one tap next time.';

function savedHint(text, isError = false) {
  setText($('save-gig-hint'), text);
  $('save-gig-hint').classList.toggle('error', isError);
}

// Outline the saved gig that matches the one being edited, and offer to update it.
function markSaved(config) {
  const match = matchSaved(savedGigs, config);
  for (const li of $('saved-list').children) {
    li.querySelector('.saved-load').setAttribute('aria-current', String(li.dataset.id === match?.id));
  }
  if (Date.now() < savedNoteUntil && match?.id === savedNoteId) return;
  $('save-gig').classList.remove('done');
  setText($('save-gig'), match ? `Update “${savedTitle(match.config)}” in saved gigs` : '+ Add to saved gigs');
}

function savedRow(entry) {
  const li = $('saved-row').content.firstElementChild.cloneNode(true);
  li.dataset.id = entry.id;
  const title = savedTitle(entry.config);
  const summary = savedSummary(entry.config);
  setText(li.querySelector('.saved-title'), title);
  setText(li.querySelector('.saved-sub'), summary);
  li.querySelector('.saved-sub').hidden = summary === title; // an unnamed gig's title already says it
  li.querySelector('.saved-load').addEventListener('click', () => loadSaved(entry));
  twoTapRemove(li.querySelector('.remove'), title, () => {
    savedGigs = removeSaved(savedGigs, entry.id);
    persistSaved();
    renderSaved();
    updateForm();
  });
  return li;
}

// Removing takes two taps: × turns into "Remove" for a few seconds.
function twoTapRemove(button, what, onRemove) {
  let timer = 0;
  const unarm = () => {
    button.classList.remove('confirm');
    button.textContent = '×';
    button.setAttribute('aria-label', `Remove ${what}`);
  };
  unarm();
  button.addEventListener('click', () => {
    if (!button.classList.contains('confirm')) {
      button.classList.add('confirm');
      button.textContent = 'Remove';
      button.setAttribute('aria-label', `Tap again to remove ${what}`);
      timer = setTimeout(unarm, 3000);
      return;
    }
    clearTimeout(timer);
    onRemove();
  });
}

// ---------- Add to Home Screen hint ----------

const INSTALL_KEY = 'gig-meter:install-hint';

function installHintWanted() {
  let dismissed = false;
  try { dismissed = localStorage.getItem(INSTALL_KEY) === 'done'; } catch { /* show it */ }
  return wantsInstallHint({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    standalone: navigator.standalone === true || matchMedia('(display-mode: standalone)').matches,
    dismissed,
  });
}

$('install-done').addEventListener('click', () => {
  try { localStorage.setItem(INSTALL_KEY, 'done'); } catch { /* hidden for now only */ }
  $('install-hint').hidden = true;
});

// ---------- history sheet ----------

// The current gig shows on top and counts in the totals, but stays out of the stored
// list until it's replaced or Reset.
function renderHistory() {
  const now = Date.now();
  const current = hasSaved ? historyEntry(session, now, 'current') : null;
  const newestFirst = [...pastGigs].sort((a, b) => b.startedAt - a.startedAt); // a corrected time can reorder them
  const all = current ? [current, ...newestFirst] : newestFirst;
  const totals = historyTotals(all, now);
  setText($('t-week'), formatMoney(totals.week));
  setText($('t-month'), formatMoney(totals.month));
  setText($('t-year'), formatMoney(totals.year));
  $('history-empty').hidden = all.length > 0;
  $('history-list').replaceChildren(...all.map((entry) => historyItem(entry, now, entry === current)));
}

function historyItem(entry, now, isCurrent) {
  const li = $('history-row').content.firstElementChild.cloneNode(true);
  const row = historyRow(entry, now);
  setText(li.querySelector('.h-title'), row.title);
  setText(li.querySelector('.h-sub'), isCurrent ? `Current gig · ${row.sub}` : row.sub);
  setText(li.querySelector('.h-amount'), row.amount);
  li.querySelector('.h-open').addEventListener('click', () => {
    if (!isCurrent) return openReceipt(entry, false);
    const at = Date.now(); // the current gig may have earned more since the list was drawn
    openReceipt(historyEntry(session, at, 'current') ?? entry, !gigFinished(getStatus(session, at)));
  });
  const remove = li.querySelector('.remove');
  if (isCurrent) {
    li.classList.add('now');
    remove.style.visibility = 'hidden'; // keeps the amounts lined up
    remove.disabled = true;
  } else {
    twoTapRemove(remove, `${row.title} from history`, () => {
      pastGigs = removeHistory(pastGigs, entry.id);
      persistHistory();
      renderHistory();
    });
  }
  return li;
}

const closeHistory = () => { $('history').hidden = true; };
$('open-history').addEventListener('click', () => {
  renderHistory();
  $('history').hidden = false;
  $('history').querySelector('.sheet').scrollTop = 0;
});
$('close-history').addEventListener('click', closeHistory);
$('history').addEventListener('click', (e) => {
  if (e.target === $('history')) closeHistory();
});

// ---------- receipt ----------

// Always printed in the Pay stub's colors and type, whatever look is on.
const PRINT = { desk: '#2B2A27', paper: '#F3EFE6', ink: '#23201B', dim: '#5D584F', rule: '#8C867C', dots: '#9C968B', stamp: '#B3311B' };
const MONO = '"IBM Plex Mono", "Courier New", monospace';
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// The Pay stub's typeface, fetched if this phone hasn't used that look yet. With no
// connection and no saved copy, the receipt prints in Courier instead.
async function receiptFonts(text) {
  loadFonts('stub');
  const link = fontLinks.stub;
  if (!link.dataset.settled) {
    await Promise.race([
      new Promise((resolve) => { link.addEventListener('load', resolve, { once: true }); link.addEventListener('error', resolve, { once: true }); }),
      wait(3000),
    ]);
  }
  try {
    await Promise.race([Promise.all([400, 500, 600, 700].map((w) => document.fonts.load(`${w} 16px "IBM Plex Mono"`, text))), wait(3000)]);
  } catch {
    // prints with the fallback
  }
}

// Shorten text with "…" until it fits.
function fitText(g, text, max) {
  if (g.measureText(text).width <= max) return text;
  const chars = [...text];
  while (chars.length && g.measureText(`${chars.join('').trimEnd()}…`).width > max) chars.pop();
  return `${chars.join('').trimEnd()}…`;
}

function wrapText(g, text, max, maxLines) {
  const lines = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const joined = lines.length ? `${lines.at(-1)} ${word}` : word;
    if (lines.length && g.measureText(joined).width <= max) lines[lines.length - 1] = joined;
    else lines.push(word);
  }
  const kept = lines.slice(0, maxLines);
  if (lines.length > maxLines) kept[maxLines - 1] += ` ${lines.slice(maxLines).join(' ')}`;
  return kept.map((line) => fitText(g, line, max));
}

// The receipt as a picture: paper on the Pay stub's dark desk, torn along the bottom,
// drawn at three times screen size so it stays sharp when zoomed or printed.
function drawReceipt(r) {
  const W = 390;
  const DESK = 16;
  const PAD = 22;
  const SCALE = 3;
  const left = DESK + PAD;
  const right = W - DESK - PAD;
  const inner = right - left;
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d');
  let y = 0;
  let drawing = false;

  const font = (weight, size) => { g.font = `${weight} ${size}px ${MONO}`; };
  const put = (text, x, height, { color = PRINT.ink, align = 'left' } = {}) => {
    if (!drawing) return;
    g.fillStyle = color;
    g.textAlign = align;
    g.textBaseline = 'middle';
    g.fillText(text, x, y + height / 2);
  };
  const say = (text, x, height, options) => {
    put(text, x, height, options);
    y += height;
  };
  const rule = () => {
    y += 12;
    if (drawing) {
      g.strokeStyle = PRINT.rule;
      g.lineWidth = 1.5;
      g.setLineDash([4, 3]);
      g.beginPath();
      g.moveTo(left, y);
      g.lineTo(right, y);
      g.stroke();
      g.setLineDash([]);
    }
    y += 12;
  };
  const row = ([label, value]) => {
    font(400, 14);
    const valueWidth = g.measureText(value).width;
    const shown = fitText(g, label, inner - valueWidth - 18);
    if (drawing) {
      const from = left + g.measureText(shown).width + 6;
      const to = right - valueWidth - 6;
      g.fillStyle = PRINT.dots;
      for (let x = from; x + 1.5 <= to; x += 4) g.fillRect(x, y + 14, 1.5, 1.5);
    }
    put(value, right, 21, { align: 'right' });
    say(shown, left, 21);
  };

  const layout = () => {
    y = DESK + PAD;
    font(700, 16);
    say('GIG METER', W / 2, 22, { align: 'center' });
    if (r.title) {
      font(500, 14);
      for (const line of wrapText(g, r.title, inner, 3)) say(line, W / 2, 20, { align: 'center' });
    }
    font(400, 14);
    say(r.date, W / 2, 20, { color: PRINT.dim, align: 'center' });
    rule();
    r.rows.forEach(row);
    if (r.money.length) {
      rule();
      r.money.forEach(row);
    }
    rule();
    font(600, 14);
    say(r.totalLabel, left, 20);
    font(600, 44);
    const size = Math.min(44, Math.floor((44 * inner) / g.measureText(r.total).width));
    font(600, size);
    say(r.total, left, Math.round(size * 1.2) + 4);
    if (r.stamp) {
      y += 14;
      if (drawing) {
        font(700, 22);
        const w = g.measureText('PAID IN FULL').width + 28;
        g.save();
        g.translate(W / 2, y + 22);
        g.rotate((-6 * Math.PI) / 180);
        g.globalAlpha = 0.9;
        g.strokeStyle = PRINT.stamp;
        g.lineWidth = 3;
        g.beginPath();
        if (g.roundRect) g.roundRect(-w / 2, -21, w, 42, 4);
        else g.rect(-w / 2, -21, w, 42);
        g.stroke();
        g.fillStyle = PRINT.stamp;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText('PAID IN FULL', 0, 1);
        g.restore();
      }
      y += 54;
    }
    y += PAD - 4;
  };

  layout(); // measure
  const bottom = y;
  const height = Math.ceil(bottom + 8 + DESK);
  canvas.width = W * SCALE;
  canvas.height = height * SCALE;
  g.scale(SCALE, SCALE);
  g.fillStyle = PRINT.desk;
  g.fillRect(0, 0, W, height);
  // The paper, with a torn (zigzag) bottom edge like the Pay stub look's.
  const teeth = Math.round((W - 2 * DESK) / 14);
  const step = (W - 2 * DESK) / teeth;
  g.fillStyle = PRINT.paper;
  g.beginPath();
  g.moveTo(DESK, DESK);
  g.lineTo(W - DESK, DESK);
  g.lineTo(W - DESK, bottom);
  for (let i = teeth; i > 0; i -= 1) {
    const x = DESK + i * step;
    g.lineTo(x - step / 2, bottom + 7);
    g.lineTo(x - step, bottom);
  }
  g.closePath();
  g.fill();
  drawing = true;
  layout();
  return canvas;
}

const receiptView = { token: 0, url: '', file: null };

const canShareFile = (file) => {
  try {
    return Boolean(navigator.canShare?.({ files: [file] }));
  } catch {
    return false;
  }
};

// Drops the last picture; also stops one still being printed from showing up.
function clearReceipt() {
  receiptView.token += 1;
  if (receiptView.url) URL.revokeObjectURL(receiptView.url);
  Object.assign(receiptView, { url: '', file: null });
}

function closeReceipt() {
  $('receipt').hidden = true;
  clearReceipt();
  if (reloadWhenSetupCloses && $('setup').hidden) location.reload();
}

// The picture is made as the sheet opens, so it's ready before Share is tapped: the
// phone only opens its share menu straight from a tap.
async function openReceipt(entry, live) {
  if (!entry) return;
  clearReceipt();
  const token = receiptView.token;
  const r = receipt(entry, Date.now(), live);
  const text = receiptText(r);
  const img = $('receipt-img');
  img.hidden = true;
  img.removeAttribute('src');
  img.alt = text;
  setText($('receipt-wait'), 'Printing…');
  $('receipt-wait').hidden = false;
  setText($('receipt-hint'), '');
  $('share-receipt').disabled = true;
  setText($('share-receipt'), 'Share…');
  $('receipt').hidden = false;
  $('receipt').querySelector('.sheet').scrollTop = 0;

  await receiptFonts(text);
  if (token !== receiptView.token) return;
  let blob = null;
  try {
    const canvas = drawReceipt(r);
    blob = await new Promise((resolve) => { canvas.toBlob(resolve, 'image/png'); });
    canvas.width = 0; // let go of the drawing memory now (iPhones limit it)
    canvas.height = 0;
  } catch {
    blob = null;
  }
  if (token !== receiptView.token) return;
  if (!blob) {
    setText($('receipt-wait'), 'Couldn’t print the receipt.');
    return;
  }
  receiptView.file = new File([blob], receiptFileName(entry), { type: 'image/png' });
  receiptView.url = URL.createObjectURL(blob);
  img.src = receiptView.url;
  img.hidden = false;
  $('receipt-wait').hidden = true;
  const sharing = canShareFile(receiptView.file);
  setText($('share-receipt'), sharing ? 'Share…' : 'Save image');
  setText($('receipt-hint'), sharing ? 'Send it, or pick Save Image to keep it in Photos.' : '');
  $('share-receipt').disabled = false;
}

$('share-receipt').addEventListener('click', async () => {
  const { file, url } = receiptView;
  if (!file) return;
  if (!canShareFile(file)) {
    const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
    document.body.append(a);
    a.click();
    a.remove();
    return;
  }
  try {
    await navigator.share({ files: [file] });
  } catch (err) {
    if (err?.name !== 'AbortError') setText($('receipt-hint'), 'The share menu didn’t open. Press and hold the picture to save or share it.');
  }
});
$('close-receipt').addEventListener('click', closeReceipt);
$('receipt').addEventListener('click', (e) => {
  if (e.target === $('receipt')) closeReceipt();
});

function renderSaved() {
  $('saved-field').hidden = !savedGigs.length;
  $('saved-list').replaceChildren(...savedGigs.map(savedRow));
}

// Loading fills in Setup only. Save then starts that gig fresh, as "New gig" does
// (and still asks first if a running gig has money on it); Cancel undoes it all.
function loadSaved(entry) {
  fillForm(entry.config);
  newGigSetup = true;
  saveConfirmUntil = 0;
  applyTheme(themeOf(entry.config)); // preview its look
  kick();
  savedHint(SAVED_HINT);
  updateForm();
}

$('save-gig').addEventListener('click', () => {
  const config = readForm();
  const error = validateConfig(config);
  if (error) {
    savedHint(error, true);
    return;
  }
  const result = upsertSaved(savedGigs, config, { id: newId(), now: Date.now() });
  if (result.error) {
    savedHint(result.error, true);
    return;
  }
  savedGigs = result.list;
  persistSaved();
  // The list above may appear or grow; keep this button where the finger is (iPhone
  // Safari doesn't hold the scroll position steady on its own).
  const before = $('save-gig').getBoundingClientRect().top;
  renderSaved();
  form.scrollTop += $('save-gig').getBoundingClientRect().top - before;
  savedHint(SAVED_HINT);
  savedNoteUntil = Date.now() + 2000;
  savedNoteId = result.list[0].id;
  $('save-gig').classList.add('done');
  setText($('save-gig'), result.replaced ? 'Updated ✓' : 'Saved ✓');
  setTimeout(() => { savedNoteUntil = 0; markSaved(readForm()); }, 2000);
  updateForm();
});

// When saving would restart a meter that's still going with money on it, Save asks
// for a second tap. A finished gig (stopped, schedule over, paid) just goes to History.
function moneyAtRisk(config, now) {
  if (!saveRestarts(config)) return 0;
  const live = getStatus(session, now);
  return hasSaved && live.cents > 0 && live.phase !== 'paid' && live.phase !== 'over' ? live.cents : 0;
}

// 'restart' (a fresh gig), 'keep' (this gig, maybe re-priced) or 'ends' (this gig,
// re-priced in a way that finishes it on the spot).
function saveDecision(config, now) {
  if (saveRestarts(config)) return 'restart';
  return saveEndsGig(session, asSaved(config), now) ? 'ends' : 'keep';
}

function saveLabel(config, now) {
  const cents = moneyAtRisk(config, now);
  if (cents) return now < saveConfirmUntil ? `Tap again · ${formatMoney(cents)} goes to History` : 'Save & restart meter';
  if (saveDecision(config, now) === 'ends') return now < saveConfirmUntil ? 'Tap again · this finishes the gig' : 'Save & finish gig';
  return 'Save';
}

function openSetup({ newGig = false } = {}) {
  saveConfirmUntil = 0;
  newGigSetup = newGig;
  $('setup').classList.remove('peek');
  fillForm(session.config);
  renderSaved();
  savedHint(SAVED_HINT);
  $('install-hint').hidden = !installHintWanted();
  $('cancel-setup').style.visibility = hasSaved ? '' : 'hidden'; // keeps the title centered
  $('setup').hidden = false;
  form.scrollTop = 0; // the sheet is reused, so it would otherwise reopen where it was left
  updateForm();
}

// Closing without saving also undoes a look being previewed.
function closeSetup() {
  $('setup').hidden = true;
  applyTheme(themeOf(session.config));
  kick();
  if (reloadWhenSetupCloses) location.reload();
}

form.addEventListener('input', () => updateForm());
form.addEventListener('change', (e) => {
  if (e.target.name === 'theme') {
    applyTheme(themeOf({ theme: e.target.value }));
    $('setup').classList.add('peek');
    kick();
  }
  // Switching unpaid breaks on with none listed starts you off with one.
  if (e.target.id === 'f-breaks-on' && e.target.checked && !$('f-breaks').children.length) addBreak();
  updateForm();
});

$('all-settings').addEventListener('click', () => {
  $('setup').classList.remove('peek');
  form.querySelector('.look-field').scrollIntoView({ block: 'center' });
});

function addBreak() {
  const rows = [...$('f-breaks').children];
  const from = rows.length ? rows.at(-1).querySelector('.b-start').value : $('f-start').value;
  $('f-breaks').append(breakRow({ start: from ? addToTime(from, 60) : '', minutes: 10 }));
}

$('clear-begin').addEventListener('click', () => {
  $('f-begin-at').value = '';
  updateForm();
});

$('add-extra').addEventListener('click', () => {
  const row = extraRow();
  $('f-extras').append(row);
  row.querySelector('.x-label').focus();
  updateForm();
});

$('add-break').addEventListener('click', () => {
  addBreak();
  updateForm();
});

$('cancel-setup').addEventListener('click', closeSetup);
$('setup').addEventListener('click', (e) => {
  if (e.target === $('setup') && hasSaved) closeSetup();
});

function refuseSave() {
  updateForm(true);
  const save = $('save');
  save.classList.remove('shake');
  void save.offsetWidth;
  save.classList.add('shake');
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const config = readForm();
  if (formError(config, Date.now())) return refuseSave();
  const now = Date.now();
  if (saveDecision(config, now) !== formShown.decision) {
    // What Save does has changed since the screen said (the clock moved on): show it first.
    saveConfirmUntil = 0;
    return updateForm();
  }
  if ((moneyAtRisk(config, now) || formShown.decision === 'ends') && now >= saveConfirmUntil) {
    saveConfirmUntil = now + 4000;
    updateForm();
    setTimeout(() => updateForm(), 4100);
    return;
  }
  const restart = saveRestarts(config);
  const base = restart ? newSession(config) : { ...session, config: asSaved(config) };
  const fixed = applyTimes(base, timesMode(config), now);
  if (fixed.error) return refuseSave();
  saveConfirmUntil = 0;
  if (restart && hasSaved) fileInHistory(session, now);
  session = fixed.session;
  if (restart) Object.assign(view, { phase: null, dollars: null });
  persist();
  Object.assign(view, { cents: -1, fitKey: '', logKey: '' });
  closeSetup();
});

// ---------- start ----------

applyTheme(themeOf(session.config));
kick();
if (!hasSaved) openSetup();

// Offline copy. When a new version finishes downloading, reload into it — straight
// away, or once Setup is closed so nothing being typed is lost. The meter's state is
// saved, so a reload mid-gig costs nothing. Home-screen apps are rarely relaunched,
// so also check for an update whenever the app comes back to the foreground.
if ('serviceWorker' in navigator) {
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return; // first install, already running the current files
    if ($('setup').hidden && $('receipt').hidden) location.reload();
    else reloadWhenSetupCloses = true;
  });
  navigator.serviceWorker.register('sw.js').catch(() => {});
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) navigator.serviceWorker.getRegistration().then((reg) => reg?.update()).catch(() => {});
  });
}
