import {
  FORMATS,
  DECIMAL_CHOICES,
  DEFAULT_DECIMALS,
  parseMoney,
  formatMoney,
  formatAmount,
  formatClock,
  buildSchedule,
  validateConfig,
  newSession,
  getStatus,
  unitsEarned,
  toggle,
  reset,
} from './meter.js';

const STORAGE_KEY = 'gig-meter:v1';
const $ = (id) => document.getElementById(id);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const UNITS = {
  hourly: 'per hour', service: 'per service', day: 'per day', flat: 'for the job',
  minute: 'per minute', weekly: 'per week', yearly: 'per year',
};
const STATUS_TEXT = {
  idle: 'Ready', waiting: 'Scheduled', running: 'Earning', paused: 'Paused',
  break: 'On break', over: 'Session over', paid: 'Paid in full',
};
const NEXT_TEXT = { start: 'Starts at', break: 'Break at', breakEnd: 'Back at', end: 'Ends at' };

const QUIPS = {
  idle: [() => 'Tap Start and watch the money roll in.', () => 'Ready when you are. The money is always ready.'],
  waiting: [
    () => 'The meter starts on its own. Go warm up.',
    (s) => `Payday begins at ${clockTime(s.schedule.startMs)}.`,
    () => 'Relax. The money knows when to show up.',
  ],
  running: [
    () => 'Smile. It’s billable.',
    () => 'You’re not bored. You’re earning.',
    () => 'Somewhere, a cent just became yours.',
    (s) => `This is fine. This is ${formatMoney(Math.round(s.centsPerHour))}-an-hour fine.`,
    (s) => (s.centsPerHour >= 900 ? `That sigh just earned you ${centsText(s.centsPerHour / 900)}.` : null),
    () => 'Look busy. The meter is.',
    () => 'Not fun? Still pays.',
    () => 'A very slow slot machine that always pays out.',
  ],
  break: [() => 'The meter’s on break too.', () => 'Snack responsibly. The money resumes shortly.'],
  paused: [() => 'Paused. The money will wait for you.', () => 'Tap Resume when you’re ready to get paid again.'],
  over: [() => 'That’s a wrap. You’re off the clock.', () => 'Session over. Go home.'],
  paid: [() => 'Paid in full. You may stop smiling now.', () => 'Every last cent. You survived.'],
};

const meterEl = $('meter');
const amountEl = $('amount');
const amountNumEl = $('amount-num');
const quipEl = $('quip');
const form = $('setup-form');

const view = { phase: null, cents: -1, shown: '', dollars: null, second: -1, em: 0, quipIndex: -1, quipAt: 0 };
const loop = { raf: 0, timer: 0 };
let resetConfirmUntil = 0;
let saveConfirmUntil = 0;
let reloadWhenSetupCloses = false;

// ---------- small helpers ----------

const pad = (n) => String(n).padStart(2, '0');
const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
const clockTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function clockLabel(ms, now) {
  const sameDay = new Date(ms).toDateString() === new Date(now).toDateString();
  return sameDay ? clockTime(ms) : new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function durationText(ms) {
  const mins = Math.round(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
}

const centsText = (c) => (c < 100 ? `${Math.round(c)}¢` : formatMoney(Math.round(c)));
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
    schedule: { date: todayISO(start), start: hhmm(start), end: addToTime(hhmm(start), 180), breaks: [] },
    decimals: DEFAULT_DECIMALS,
  };
}

// ---------- saving ----------

function load() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!data || !Array.isArray(data.events) || validateConfig(data.config)) return null;
    const events = data.events.filter((e) => Number.isFinite(e?.t) && (e.type === 'resume' || e.type === 'pause'));
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

// ---------- meter rendering ----------

function renderConfig() {
  const { config } = session;
  const status = getStatus(session, Date.now());
  setText($('gig-name'), config.name || 'Your gig');
  let pay = `${formatMoney(config.amountCents)} ${UNITS[config.format]}`;
  if (status.plannedMs) pay += ` · ${durationText(status.plannedMs)} of work`;
  setText($('gig-pay'), pay);
  setText($('rate'), rateText(status));
  $('progress').hidden = status.capCents == null;
}

// Size the number so it fits the screen. For flat fees it is sized for the full fee
// from the start, so the digits don't shrink partway through the gig.
function fitAmount(status, decimals) {
  const basisCents = Math.max(status.cents, status.capCents ?? 10000);
  const text = formatAmount(basisCents * 10 ** (decimals - 2), decimals);
  const em = [...text].reduce((sum, ch) => sum + (ch === '.' || ch === ',' ? 0.3 : 0.62), 0);
  if (em === view.em) return;
  view.em = em;
  const width = Math.min(meterEl.clientWidth - 40, 520);
  amountEl.style.fontSize = `${Math.min(104, Math.floor(width / em))}px`;
}

// Digital display: the digits simply change, every frame if they need to, like a
// stopwatch's hundredths.
function renderNumber(status, decimals) {
  const text = formatAmount(unitsEarned(status, decimals), decimals);
  if (text === view.shown) return;
  amountNumEl.textContent = text.slice(1); // the "$" is its own element so it can be green
  view.shown = text;
}

// Things that only change once per cent: the spoken label, the progress bar, and a
// small pulse on every new whole dollar.
function renderCents(status) {
  amountEl.setAttribute('aria-label', formatMoney(status.cents));
  const dollars = Math.floor(status.cents / 100);
  if (view.dollars != null && dollars > view.dollars && !reducedMotion.matches) {
    amountEl.classList.remove('bump');
    void amountEl.offsetWidth; // restart the animation
    amountEl.classList.add('bump');
  }
  view.dollars = dollars;
  if (status.capCents != null) {
    $('progress-fill').style.width = `${(status.progress * 100).toFixed(2)}%`;
    setText($('progress-text'), status.phase === 'paid'
      ? `All ${formatMoney(status.capCents)} earned`
      : `${Math.floor(status.progress * 100)}% · ${formatMoney(status.capCents - status.cents)} to go`);
  }
  view.cents = status.cents;
}

function renderQuip(status, now, phaseChanged) {
  if (!phaseChanged && (status.phase !== 'running' || now - view.quipAt < 14000)) return;
  const list = QUIPS[status.phase];
  if (phaseChanged) view.quipIndex = Math.floor(Math.random() * list.length) - 1;
  let text = null;
  for (let tries = 0; tries < list.length && !text; tries++) {
    view.quipIndex = (view.quipIndex + 1) % list.length;
    text = list[view.quipIndex](status);
  }
  view.quipAt = now;
  if (!text || text === quipEl.textContent) return;
  if (!quipEl.textContent || reducedMotion.matches) return setText(quipEl, text);
  quipEl.classList.add('fading');
  setTimeout(() => {
    quipEl.textContent = text;
    quipEl.classList.remove('fading');
  }, 350);
}

function renderButtons(status, now) {
  const primary = $('primary');
  const label = { idle: 'Start', waiting: 'Start now', running: 'Pause', paid: 'New gig' }[status.phase] ?? 'Resume';
  setText(primary, label);
  primary.classList.toggle('pause', status.running);
  primary.classList.toggle('start', !status.running);

  const resetBtn = $('reset');
  const confirming = now < resetConfirmUntil;
  resetBtn.disabled = status.phase === 'idle';
  setText(resetBtn, confirming ? 'Sure?' : status.phase === 'waiting' ? 'Cancel' : 'Reset');
  resetBtn.classList.toggle('confirm', confirming);
}

function renderNext(status, now) {
  let text = '';
  if (status.next) {
    const left = Math.ceil((status.next.t - now) / 1000) * 1000;
    text = `${NEXT_TEXT[status.next.kind]} ${clockLabel(status.next.t, now)} · in ${formatClock(left)}`;
  } else if (session.config.mode === 'scheduled' && !session.scheduleArmed && status.phase !== 'paid') {
    text = 'Schedule off · save Setup to turn it back on';
  }
  setText($('next'), text);
}

function render(now) {
  const status = getStatus(session, now);
  const phaseChanged = status.phase !== view.phase;

  if (phaseChanged) {
    if (status.phase === 'paid' && view.phase !== null) celebrate();
    meterEl.dataset.phase = status.phase;
    setText($('status-text'), STATUS_TEXT[status.phase]);
    wakeWanted = status.running;
    syncWakeLock();
  }

  const decimals = decimalsOf(session.config);
  fitAmount(status, decimals);
  renderNumber(status, decimals);
  if (status.cents !== view.cents) renderCents(status);

  const second = Math.floor(status.workedMs / 1000);
  if (second !== view.second) {
    setText($('elapsed'), formatClock(status.workedMs));
    view.second = second;
  }

  renderNext(status, now);
  renderButtons(status, now);
  renderQuip(status, now, phaseChanged);
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

const kick = frame;

function celebrate() {
  if (reducedMotion.matches) return;
  const box = $('confetti');
  const symbols = ['$', '$', '¢', '💵', '💰'];
  for (let i = 0; i < 36; i++) {
    const s = document.createElement('span');
    s.textContent = symbols[i % symbols.length];
    s.style.left = `${Math.random() * 100}%`;
    s.style.color = i % 2 ? 'var(--gold)' : 'var(--green)';
    s.style.setProperty('--dx', `${(Math.random() - 0.5) * 160}px`);
    s.style.setProperty('--rot', `${(Math.random() - 0.5) * 720}deg`);
    s.style.setProperty('--dur', `${2 + Math.random() * 1.6}s`);
    s.style.animationDelay = `${Math.random() * 0.6}s`;
    box.append(s);
  }
  setTimeout(() => box.replaceChildren(), 4500);
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

// ---------- meter controls ----------

$('primary').addEventListener('click', () => {
  const now = Date.now();
  if (getStatus(session, now).phase === 'paid') return openSetup();
  session = toggle(session, now);
  persist();
  kick();
});

// Reset asks "Sure?" first whenever there's money on the meter.
$('reset').addEventListener('click', () => {
  const now = Date.now();
  if (getStatus(session, now).cents > 0 && now >= resetConfirmUntil) {
    resetConfirmUntil = now + 3000;
    return kick();
  }
  resetConfirmUntil = 0;
  session = reset(session);
  persist();
  kick();
});

$('open-setup').addEventListener('click', () => openSetup());

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) kick();
  syncWakeLock();
});
window.addEventListener('pageshow', kick);
window.addEventListener('resize', () => { view.em = 0; kick(); });

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
  for (let d = new Date(); buildSchedule(schedule).endMs <= now; d.setDate(d.getDate() + 1)) {
    schedule.date = todayISO(d);
    if (d - now > 2 * 86400000) break;
  }
  $('f-date').value = schedule.date;
  $('f-start').value = schedule.start;
  $('f-end').value = schedule.end;
  const breaks = Array.isArray(schedule.breaks) ? schedule.breaks : [];
  $('f-breaks').replaceChildren(...breaks.map(breakRow));
  form.elements.decimals.value = String(decimalsOf(config));
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
      breaks: [...$('f-breaks').children].map((li) => ({
        start: li.querySelector('.b-start').value,
        minutes: Number(li.querySelector('.b-min').value),
      })),
    },
    decimals: Number(form.elements.decimals.value) || DEFAULT_DECIMALS,
  };
}

// Only changes to pay or timing start a fresh meter; a new name or decimal places
// keep it running. Fields that don't apply to the chosen setup are ignored.
function payKey(config) {
  const flat = FORMATS[config.format]?.kind === 'flat';
  const scheduled = config.mode === 'scheduled';
  return JSON.stringify([
    config.format,
    config.amountCents,
    config.mode,
    !scheduled && flat ? config.plannedMinutes : null,
    scheduled ? config.schedule : null,
  ]);
}

// Saving restarts the meter when pay or timing changed, or to switch a schedule that
// Reset turned off back on.
function saveRestarts(config) {
  const rearm = config.mode === 'scheduled' && !session.scheduleArmed;
  return !hasSaved || rearm || payKey(config) !== payKey(session.config);
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
    setText(summary, preview.plannedMs ? `${durationText(preview.plannedMs)} of work · ${rate}` : rate);
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

function openSetup() {
  saveConfirmUntil = 0;
  fillForm(session.config);
  $('cancel-setup').style.visibility = hasSaved ? '' : 'hidden'; // keeps the title centered
  $('setup').hidden = false;
  updateForm();
}

function closeSetup() {
  $('setup').hidden = true;
  if (reloadWhenSetupCloses) location.reload();
}

form.addEventListener('input', () => updateForm());
form.addEventListener('change', () => updateForm());

$('add-break').addEventListener('click', () => {
  const rows = [...$('f-breaks').children];
  const from = rows.length ? rows.at(-1).querySelector('.b-start').value : $('f-start').value;
  $('f-breaks').append(breakRow({ start: from ? addToTime(from, 60) : '', minutes: 10 }));
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
  } else {
    session = { ...session, config };
  }
  persist();
  closeSetup();
  Object.assign(view, { cents: -1, shown: '', second: -1, em: 0 });
  renderConfig();
  kick();
});

// ---------- start ----------

renderConfig();
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
