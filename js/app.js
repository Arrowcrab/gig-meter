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
} from './meter.js';
import { THEMES, DEFAULT_THEME, themeOf, viewModel, UNITS, durationLong } from './view.js';

const STORAGE_KEY = 'gig-meter:v1';
const $ = (id) => document.getElementById(id);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const form = $('setup-form');
const faces = Object.fromEntries([...document.querySelectorAll('[data-face]')].map((el) => [el.dataset.face, el]));

const view = { theme: null, parts: null, phase: null, cents: -1, dollars: null, fitKey: '', logKey: '', led: -1 };
const loop = { raf: 0, timer: 0 };
let resetConfirmUntil = 0;
let stopConfirmUntil = 0;
let saveConfirmUntil = 0;
let reloadWhenSetupCloses = false;
let rolledDate = null; // { saved, shown } when Setup moved an ended session's date forward
let newGigSetup = false; // Setup was opened from "New gig", so Save always starts fresh

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
  document.head.append(link);
  fontLinks[theme] = link;
}

// The phone's top-bar color follows the page, including the Poster's phase colors.
function syncTopBar() {
  const bg = getComputedStyle(document.body).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]').content = bg || THEMES[view.theme].color;
}

function applyTheme(theme) {
  if (theme === view.theme) return;
  const face = faces[theme];
  for (const [name, el] of Object.entries(faces)) el.hidden = name !== theme;
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
    primaries: [...face.querySelectorAll('[data-action="primary"]')],
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
  const key = `${view.theme}|${text.length}|${width}`;
  if (width <= 0 || key === view.fitKey) return;
  view.fitKey = key;
  const style = getComputedStyle(el);
  const spacing = (parseFloat(style.letterSpacing) || 0) / parseFloat(style.fontSize);
  Object.assign(probe.style, {
    fontFamily: style.fontFamily, fontWeight: style.fontWeight, fontStretch: style.fontStretch,
    fontSize: '100px', letterSpacing: `${spacing * 100}px`,
  });
  probe.textContent = text;
  const max = parseFloat(style.getPropertyValue('--amount-max')) || 72;
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
  const confirming = now < resetConfirmUntil;
  vm.resetLabel = confirming ? 'Sure?' : status.phase === 'waiting' ? 'Cancel' : 'Reset';
  const confirmingStop = vm.primaryAction === 'stop' && now < stopConfirmUntil;
  if (confirmingStop) vm.primary = 'Sure?';
  applyView(vm);
  for (const button of view.parts.resets) {
    button.disabled = status.phase === 'idle';
    button.classList.toggle('confirm', confirming);
  }
  for (const button of view.parts.primaries) button.classList.toggle('confirm', confirmingStop);
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
function frame() {
  cancelAnimationFrame(loop.raf);
  clearTimeout(loop.timer);
  const status = render(Date.now());
  if (document.hidden) return;
  if (status.running) loop.raf = requestAnimationFrame(frame);
  loop.timer = setTimeout(frame, 250);
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
// pause, stop (after a "Sure?", since it can't be undone), or set up a new gig.
function pressPrimary() {
  const now = Date.now();
  const status = getStatus(session, now);
  const { primaryAction } = viewModel(session, status, now, decimalsOf(session.config));
  if (primaryAction === 'newGig') return openSetup({ newGig: true });
  if (primaryAction === 'stop') {
    if (now >= stopConfirmUntil) {
      stopConfirmUntil = now + 3000;
      return kick();
    }
    stopConfirmUntil = 0;
    session = stop(session, now);
  } else if (primaryAction === 'toggle') {
    session = toggle(session, now);
  } else {
    return;
  }
  persist();
  kick();
}

// Reset asks "Sure?" first whenever there's money on the meter.
function pressReset() {
  const now = Date.now();
  if (getStatus(session, now).cents > 0 && now >= resetConfirmUntil) {
    resetConfirmUntil = now + 3000;
    return kick();
  }
  resetConfirmUntil = 0;
  stopConfirmUntil = 0;
  session = reset(session);
  persist();
  kick();
}

document.addEventListener('click', (e) => {
  const button = e.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const { action } = button.dataset;
  if (action === 'setup') openSetup();
  else if (action === 'primary') pressPrimary();
  else if (action === 'reset') pressReset();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) kick();
  syncWakeLock();
});
window.addEventListener('pageshow', kick);
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

function fillForm(config) {
  $('f-name').value = config.name || '';
  form.elements.format.value = config.format;
  $('f-amount').value = config.amountCents ? (config.amountCents / 100).toFixed(2).replace(/\.00$/, '') : '';
  const planned = config.plannedMinutes > 0 ? config.plannedMinutes : 180;
  $('f-hours').value = Math.floor(planned / 60);
  $('f-minutes').value = planned % 60;
  form.elements.mode.value = config.mode;

  const schedule = { ...defaultConfig().schedule, ...config.schedule };
  // A past session comes back with the same times on the next day they're still ahead.
  const now = Date.now();
  const savedDate = schedule.date;
  for (let d = new Date(); buildSchedule(schedule).endMs <= now; d.setDate(d.getDate() + 1)) {
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
  form.elements.theme.value = themeOf(config);
}

function readForm() {
  const hours = Math.max(0, Number($('f-hours').value) || 0);
  const minutes = Math.max(0, Number($('f-minutes').value) || 0);
  return {
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
  };
}

// Only changes to pay or timing start a fresh meter; a new name, look, decimal places
// or Pause button setting keep it running. Fields that don't apply to the chosen setup
// are ignored, and only breaks that count (unpaid breaks switched on) are compared.
function payKey(config) {
  const flat = FORMATS[config.format]?.kind === 'flat';
  const scheduled = config.mode === 'scheduled';
  const s = config.schedule || {};
  const breaks = s.breaksOn === false ? [] : (s.breaks || []).map((b) => [b.start, Number(b.minutes)]);
  return JSON.stringify([
    config.format,
    config.amountCents,
    config.mode,
    !scheduled && flat ? config.plannedMinutes : null,
    scheduled ? [s.date, s.start, s.end, breaks] : null,
  ]);
}

// The form as it would be saved without Setup's automatic date change: an ended
// session's date shown moved forward but left untouched isn't a change.
function asSaved(config) {
  if (!rolledDate || config.schedule.date !== rolledDate.shown) return config;
  return { ...config, schedule: { ...config.schedule, date: rolledDate.saved } };
}

// Saving restarts the meter when pay or timing changed, to switch a schedule that
// Reset turned off back on, or when Setup was opened from "New gig".
function saveRestarts(config) {
  const rearm = config.mode === 'scheduled' && !session.scheduleArmed;
  return !hasSaved || newGigSetup || rearm || payKey(asSaved(config)) !== payKey(session.config);
}

function formError(config, now) {
  const error = validateConfig(config);
  if (error) return error;
  if (config.mode === 'scheduled' && buildSchedule(config.schedule).endMs <= now) {
    return 'That session has already ended. Pick a later date or time.';
  }
  return null;
}

function updateForm(showErrors = false) {
  const now = Date.now();
  const config = readForm();
  const format = FORMATS[config.format];
  setText($('f-unit'), UNITS[config.format]);
  $('format-note').hidden = !format.note;
  setText($('format-note'), format.note || '');
  $('planned-field').hidden = !(format.kind === 'flat' && config.mode === 'manual');
  $('schedule-fields').hidden = config.mode !== 'scheduled';
  $('breaks-area').hidden = !config.schedule.breaksOn;

  const summary = $('summary');
  const error = formError(config, now);
  summary.classList.toggle('error', Boolean(error) && (showErrors || config.amountCents > 0));
  if (error && !showErrors && !$('f-amount').value.trim()) {
    setText(summary, 'Enter your pay to see how fast it adds up.');
  } else if (error) {
    setText(summary, error);
    summary.classList.add('error');
  } else {
    const preview = getStatus(newSession(config), now);
    const rate = rateText(preview);
    setText(summary, preview.plannedMs ? `${durationLong(preview.plannedMs)} of work · ${rate}` : rate);
  }

  setText($('save'), saveLabel(config, now));
}

// When saving would restart a meter with money on it, Save asks for a second tap.
function moneyAtRisk(config, now) {
  if (!saveRestarts(config)) return 0;
  const live = getStatus(session, now);
  return hasSaved && live.cents > 0 && live.phase !== 'paid' ? live.cents : 0;
}

function saveLabel(config, now) {
  const cents = moneyAtRisk(config, now);
  if (!cents) return 'Save';
  return now < saveConfirmUntil ? `Tap again to clear ${formatMoney(cents)}` : 'Save & restart meter';
}

function openSetup({ newGig = false } = {}) {
  saveConfirmUntil = 0;
  newGigSetup = newGig;
  $('setup').classList.remove('peek');
  fillForm(session.config);
  $('cancel-setup').style.visibility = hasSaved ? '' : 'hidden'; // keeps the title centered
  $('setup').hidden = false;
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

$('add-break').addEventListener('click', () => {
  addBreak();
  updateForm();
});

$('cancel-setup').addEventListener('click', closeSetup);
$('setup').addEventListener('click', (e) => {
  if (e.target === $('setup') && hasSaved) closeSetup();
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const config = readForm();
  if (formError(config, Date.now())) {
    updateForm(true);
    const save = $('save');
    save.classList.remove('shake');
    void save.offsetWidth;
    save.classList.add('shake');
    return;
  }
  const now = Date.now();
  if (moneyAtRisk(config, now) && now >= saveConfirmUntil) {
    saveConfirmUntil = now + 4000;
    updateForm();
    setTimeout(() => updateForm(), 4100);
    return;
  }
  saveConfirmUntil = 0;
  if (saveRestarts(config)) {
    session = newSession(config);
    Object.assign(view, { phase: null, dollars: null });
    resetConfirmUntil = 0;
    stopConfirmUntil = 0;
  } else {
    session = { ...session, config: asSaved(config) };
  }
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
    if ($('setup').hidden) location.reload();
    else reloadWhenSetupCloses = true;
  });
  navigator.serviceWorker.register('sw.js').catch(() => {});
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) navigator.serviceWorker.getRegistration().then((reg) => reg?.update()).catch(() => {});
  });
}
