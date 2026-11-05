// Screen text for every look. Pure: given a session, its status and the time, it
// returns the strings and numbers the four looks show, so they all agree.

import { FORMATS, formatAmount, formatMoney, formatClock, unitsEarned, history, getStatus, validateConfig } from './meter.js';

// The looks the app can wear. `fonts` is the Google Fonts family list each needs
// (loaded only when that look is on); `color` is its top-of-screen color.
export const THEMES = {
  quiet: { label: 'Quiet', fonts: null, color: '#F2F2F7' },
  fare: { label: 'Fare meter', fonts: 'family=Barlow+Condensed:wght@500;600;700&family=Share+Tech+Mono', color: '#1B1A18' },
  stub: { label: 'Pay stub', fonts: 'family=IBM+Plex+Mono:wght@400;500;600;700', color: '#2B2A27' },
  poster: { label: 'Poster', fonts: 'family=Archivo:wdth,wght@62..125,400..900', color: '#FF6B1A' },
  // Extra-dim versions of Quiet for dark rooms (an orchestra pit): same layout, own colors.
  stagegray: { label: 'Stage gray', fonts: null, color: '#000000', face: 'quiet' },
  stagered: { label: 'Stage red', fonts: null, color: '#000000', face: 'quiet' },
};
export const DEFAULT_THEME = 'quiet';
export const themeOf = (config) => (Object.hasOwn(THEMES, config?.theme ?? '') ? config.theme : DEFAULT_THEME);
// Which layout on the page draws a look.
export const faceOf = (theme) => THEMES[theme]?.face ?? theme;

export const UNITS = {
  hourly: 'per hour', service: 'per service', day: 'per day', flat: 'for the job',
  minute: 'per minute', weekly: 'per week', yearly: 'per year',
};

export const STATUS_TEXT = {
  idle: 'Ready', waiting: 'Scheduled', running: 'Running', paused: 'Paused',
  break: 'On break', over: 'Session over', paid: 'Paid in full',
};

// The Fare meter's roof-lamp wording.
const LAMP_TEXT = {
  idle: 'Off the clock', waiting: 'Scheduled', running: 'On the clock', paused: 'Paused',
  break: 'On break', over: 'Off the clock', paid: 'Paid in full',
};

const PAY_LABEL = {
  hourly: 'Hourly rate', service: 'Service fee', day: 'Day rate', flat: 'Flat fee',
  minute: 'Per minute', weekly: 'Weekly salary', yearly: 'Yearly salary',
};
const PAY_SUFFIX = { hourly: '/hr', minute: '/min', weekly: '/wk', yearly: '/yr' };
const LOG_TEXT = { start: 'Started', resume: 'Resumed', pause: 'Paused', break: 'Break', back: 'Back', end: 'Ended', stop: 'Stopped', paid: 'Paid in full' };

// The big button's label and what it does. With the Pause button switched off (the
// default) a gig goes Start → Stop → New gig, and a scheduled break ends on its own.
// A gig paused before that setting existed can still be resumed.
function mainButton(phase, pauseOn, stopped) {
  if (phase === 'paid') return ['New gig', 'newGig'];
  if (phase === 'over') return stopped || !pauseOn ? ['New gig', 'newGig'] : ['Resume', 'toggle'];
  if (phase === 'running') return pauseOn ? ['Pause', 'toggle'] : ['Stop', 'stop'];
  if (phase === 'break') return pauseOn ? ['Resume', 'toggle'] : ['', 'none'];
  if (phase === 'idle') return ['Start', 'toggle'];
  if (phase === 'waiting') return ['Start now', 'toggle'];
  return ['Resume', 'toggle'];
}
const NEXT_TEXT = { start: 'Starts at', break: 'Break at', breakEnd: 'Back at', end: 'Ends at' };
const NEXT_SHORT = { start: 'Starts in', break: 'Break in', breakEnd: 'Back in', end: 'Ends in' };
const NEXT_ROW = { start: 'Starts', break: 'Next break', breakEnd: 'Back at', end: 'Ends' };
const NEXT_WORD = { start: 'start', break: 'break', breakEnd: 'back', end: 'end' };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LOG_LINES = 6;

const pad = (n) => String(n).padStart(2, '0');
const hms = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const hm24 = (ms) => hms(ms).slice(0, 5);
export const clockTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function clockLabel(ms, now) {
  const sameDay = new Date(ms).toDateString() === new Date(now).toDateString();
  return sameDay ? clockTime(ms) : new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

// "2 hr 40 min", "3 hr", "45 min".
export function durationLong(ms) {
  const mins = Math.round(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return [h && `${h} hr`, m && `${m} min`].filter(Boolean).join(' ') || '0 min';
}

// $210 when whole, $210.50 otherwise.
const formatPay = (cents) => (cents % 100 ? formatMoney(cents) : `$${(cents / 100).toLocaleString('en-US')}`);

const receiptDate = (ms) => {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} · ${clockTime(ms)}`;
};

export function viewModel(session, status, now, decimals) {
  const { config } = session;
  const isFlat = status.capCents != null;
  const paid = status.phase === 'paid';
  const scheduleOff = config.mode === 'scheduled' && !session.scheduleArmed && !paid && status.phase !== 'over';
  const [primary, primaryAction] = mainButton(status.phase, config.manualPause === true, status.stopped);
  const past = history(session, now);

  // The rate per minute to the nearest ten-thousandth, trailing zeros dropped: $1.40, $1.3125.
  const { amountCents, perMs } = status.payRate;
  const perMinuteUnits = perMs > 0 ? Math.round((amountCents * 100 * 60_000) / perMs) : 0;
  const perMinute = formatAmount(perMinuteUnits, 4).replace(/(\.\d{2}\d*?)0+$/, '$1');

  let next = { hasNext: false, nextText: '', nextShortLabel: '', nextShortValue: '', nextRowLabel: '', nextRowValue: '', stubNext: '' };
  if (status.next) {
    const { t, kind } = status.next;
    // Countdowns read "in 4:12", not the stopwatch's "04:12".
    const nextIn = formatClock(Math.ceil((t - now) / 1000) * 1000).replace(/^0(\d:)/, '$1');
    next = {
      hasNext: true,
      nextText: `${NEXT_TEXT[kind]} ${clockLabel(t, now)} · in ${nextIn}`,
      nextShortLabel: NEXT_SHORT[kind],
      nextShortValue: nextIn,
      nextRowLabel: NEXT_ROW[kind],
      nextRowValue: `${clockLabel(t, now)}, in ${nextIn}`,
      stubNext: `Next: ${NEXT_WORD[kind]} at ${hm24(t)}, in ${nextIn}`,
    };
  } else if (paid) {
    const paidAt = past.at(-1)?.t ?? now;
    next = {
      hasNext: true,
      nextText: `All ${formatMoney(status.capCents)} earned`,
      nextShortLabel: 'Finished',
      nextShortValue: clockTime(paidAt),
      nextRowLabel: 'Finished',
      nextRowValue: clockTime(paidAt),
      stubNext: '',
    };
  } else if (scheduleOff) {
    next = {
      hasNext: true,
      nextText: 'Schedule off · save Setup to turn it back on',
      nextShortLabel: 'Schedule',
      nextShortValue: 'Off',
      nextRowLabel: 'Schedule',
      nextRowValue: 'Off until you save Setup',
      stubNext: 'Schedule off.',
    };
  }

  const log = past.map((e) => ({ time: hms(e.t), what: LOG_TEXT[e.kind], current: false }));
  if (status.running) log.push({ time: hms(now), what: 'Running', current: true });
  else if (log.length && !paid) log.at(-1).current = true;

  const firstMoment = past[0]?.t ?? status.schedule?.startMs ?? now;
  // The one caption kept: it tells you a scheduled gig needs no tap to begin.
  const note = status.phase === 'waiting' ? 'The meter starts on its own.' : '';
  const progress = isFlat ? status.progress : 0;

  return {
    phase: status.phase,
    status: STATUS_TEXT[status.phase],
    lamp: LAMP_TEXT[status.phase],
    gigName: config.name || 'Your gig',
    payShort: `${formatPay(config.amountCents)} ${UNITS[config.format]}`,
    gigPay: `${formatPay(config.amountCents)} ${UNITS[config.format]}${isFlat ? ` · ${durationLong(status.plannedMs)} of work` : ''}`,
    amount: formatAmount(unitsEarned(status, decimals), decimals),
    worked: formatClock(status.workedMs),
    isFlat,
    owed: isFlat ? formatMoney(status.capCents - status.cents) : '',
    pct: `${Math.floor(progress * 100)}%`,
    ledLit: Math.floor(progress * 20),
    rateLong: `${perMinute} a minute`,
    rateShort: `${formatMoney(Math.floor(status.centsPerHour / 60))}/min`,
    payLabel: PAY_LABEL[config.format],
    payValue: `${formatMoney(config.amountCents)}${PAY_SUFFIX[config.format] ?? ''}`,
    planned: isFlat ? formatClock(status.plannedMs) : '',
    ...next,
    primary,
    primaryAction,
    hasPrimary: Boolean(primary),
    note,
    hasNote: Boolean(note),
    totalLabel: paid ? 'TOTAL EARNED' : 'EARNED SO FAR',
    receiptDate: receiptDate(firstMoment),
    log: log.slice(-LOG_LINES),
  };
}

// ---------- saved gigs ----------
// A short list of regular gigs kept on the phone, each a full copy of a Setup
// ({ id, config, savedAt }), newest first. Pure: the app stores and shows the list.

export const SAVED_MAX = 12;

const savedPay = (config) => `${formatPay(config.amountCents)} ${UNITS[config.format]}`;
const time12 = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
};

// The gig's name; an unnamed gig goes by its pay and times instead.
export const savedTitle = (config) => config.name?.trim() || savedSummary(config);

// "$210 per service · 7:00 PM–10:00 PM", "$500 for the job · 3 hr of work", "$60 per hour".
export function savedSummary(config) {
  const pay = savedPay(config);
  if (config.mode === 'scheduled' && config.schedule) return `${pay} · ${time12(config.schedule.start)}–${time12(config.schedule.end)}`;
  if (FORMATS[config.format]?.kind === 'flat' && config.plannedMinutes > 0) return `${pay} · ${durationLong(config.plannedMinutes * 60000)} of work`;
  return pay;
}

// Two saved gigs are the same gig when their names match (ignoring case and spaces);
// unnamed ones when their pay and times match.
const savedKey = (config) => {
  const name = (config.name || '').trim().toLowerCase();
  return name ? `name:${name}` : `pay:${savedSummary(config)}`;
};

export const matchSaved = (list, config) => list.find((e) => savedKey(e.config) === savedKey(config)) ?? null;

// Saving the same gig again updates it (same id) and moves it to the top. A full list
// says so rather than quietly dropping one.
export function upsertSaved(list, config, { id, now }) {
  const found = matchSaved(list, config);
  if (found) return { list: [{ ...found, config, savedAt: now }, ...list.filter((e) => e !== found)], replaced: true };
  if (list.length >= SAVED_MAX) return { list, replaced: false, error: `You can keep up to ${SAVED_MAX} saved gigs. Remove one first.` };
  return { list: [{ id, config, savedAt: now }, ...list], replaced: false };
}

export const removeSaved = (list, id) => list.filter((e) => e.id !== id);

// The stored list, keeping only entries that still make a usable Setup.
export function readSaved(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(data)) return [];
  const seen = new Set();
  const list = [];
  for (const e of data) {
    if (!e || typeof e.id !== 'string' || !e.id || seen.has(e.id) || validateConfig(e.config)) continue;
    seen.add(e.id);
    list.push({ id: e.id, config: e.config, savedAt: Number(e.savedAt) || 0 });
    if (list.length === SAVED_MAX) break;
  }
  return list;
}

// ---------- earnings history ----------
// Past gigs, newest first, each a frozen record of what it earned:
// { id, title, pay, cents, workedMs, startedAt, endedAt }. Pure: the app stores it.

export const HISTORY_MAX = 500;

const time12At = (ms) => { const d = new Date(ms); return time12(`${d.getHours()}:${d.getMinutes()}`); };

// The record for a gig as of `now`, or null when it earned nothing.
export function historyEntry(session, now, id) {
  const status = getStatus(session, now);
  if (!(status.cents > 0)) return null;
  const moments = history(session, now);
  const last = moments.at(-1);
  return {
    id,
    title: savedTitle(session.config),
    pay: savedPay(session.config),
    cents: status.cents,
    workedMs: status.workedMs,
    startedAt: moments[0]?.t ?? Math.floor(now),
    endedAt: status.running || !last ? Math.floor(now) : last.t,
  };
}

export const addHistory = (list, entry) => [entry, ...list].slice(0, HISTORY_MAX);
export const removeHistory = (list, id) => list.filter((e) => e.id !== id);

export function readHistory(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(data)) return [];
  const seen = new Set();
  const list = [];
  for (const e of data) {
    const ok = e && typeof e.id === 'string' && e.id && !seen.has(e.id)
      && typeof e.title === 'string' && typeof e.pay === 'string'
      && Number.isSafeInteger(e.cents) && e.cents > 0
      && [e.workedMs, e.startedAt, e.endedAt].every(Number.isFinite) && e.workedMs >= 0;
    if (!ok) continue;
    seen.add(e.id);
    const { id, title, pay, cents, workedMs, startedAt, endedAt } = e;
    list.push({ id, title, pay, cents, workedMs, startedAt, endedAt });
    if (list.length === HISTORY_MAX) break;
  }
  return list;
}

// Earned this week (from Monday 00:00), this month and this year. A gig counts on
// the day it started.
export function historyTotals(list, now) {
  const d = new Date(now);
  const from = {
    week: new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime(),
    month: new Date(d.getFullYear(), d.getMonth(), 1).getTime(),
    year: new Date(d.getFullYear(), 0, 1).getTime(),
  };
  const total = (start) => list.reduce((sum, e) => sum + (e.startedAt >= start ? e.cents : 0), 0);
  return { week: total(from.week), month: total(from.month), year: total(from.year) };
}

const dayLabel = (ms, now) => {
  const d = new Date(ms);
  const today = new Date(now);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  const year = d.getFullYear() === today.getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
};

// "Today, 9:00 AM · 1 hr 30 min" and "$90.00".
export function historyRow(entry, now) {
  return {
    title: entry.title,
    sub: `${dayLabel(entry.startedAt, now)}, ${time12At(entry.startedAt)} · ${durationLong(entry.workedMs)}`,
    amount: formatMoney(entry.cents),
  };
}

// ---------- Add to Home Screen hint ----------
// iPhones never offer to install a web app, so Setup explains how, but only in an
// iPhone or iPad browser (iPadOS calls itself a Mac; the touch screen gives it away),
// never in the Home Screen app itself, and never again once dismissed.
export function wantsInstallHint({ userAgent = '', maxTouchPoints = 0, standalone = false, dismissed = false }) {
  if (standalone || dismissed) return false;
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}
