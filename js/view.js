// Screen text for every look. Pure: given a session, its status and the time, it
// returns the strings and numbers the four looks show, so they all agree.

import { FORMATS, formatAmount, formatMoney, formatPrice, currencyOf, CURRENCIES, formatClock, unitsEarned, history, getStatus, validateConfig } from './meter.js';

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
  break: 'On break', over: 'Session over', paid: 'Paid in full', overtime: 'Overtime',
};

// The Fare meter's roof-lamp wording.
const LAMP_TEXT = {
  idle: 'Off the clock', waiting: 'Scheduled', running: 'On the clock', paused: 'Paused',
  break: 'On break', over: 'Off the clock', paid: 'Paid in full', overtime: 'Overtime',
};

const PAY_LABEL = {
  hourly: 'Hourly rate', service: 'Service fee', day: 'Day rate', flat: 'Flat fee',
  minute: 'Per minute', weekly: 'Weekly salary', yearly: 'Yearly salary',
};
const PAY_SUFFIX = { hourly: '/hr', minute: '/min', weekly: '/wk', yearly: '/yr' };
const LOG_TEXT = { start: 'Started', resume: 'Resumed', pause: 'Paused', break: 'Break', back: 'Back', end: 'Ended', stop: 'Stopped', paid: 'Paid in full', overtime: 'Overtime' };

// The big button's label and what it does. With the Pause button switched off (the
// default) a gig goes Start → Stop → New gig, and a scheduled break ends on its own.
// A gig paused before that setting existed can still be resumed.
function mainButton(phase, pauseOn, stopped) {
  if (phase === 'paid') return ['New gig', 'newGig'];
  if (phase === 'over') return stopped || !pauseOn ? ['New gig', 'newGig'] : ['Resume', 'toggle'];
  if (phase === 'running' || phase === 'overtime') return pauseOn ? ['Pause', 'toggle'] : ['Stop', 'stop'];
  if (phase === 'break') return pauseOn ? ['Resume', 'toggle'] : ['', 'none'];
  if (phase === 'idle') return ['Start', 'toggle'];
  if (phase === 'waiting') return ['Start now', 'toggle'];
  return ['Resume', 'toggle'];
}
const NEXT_TEXT = { start: 'Starts at', break: 'Break at', breakEnd: 'Back at', end: 'Ends at', overtime: 'Overtime at' };
const NEXT_SHORT = { start: 'Starts in', break: 'Break in', breakEnd: 'Back in', end: 'Ends in', overtime: 'Overtime in' };
const NEXT_ROW = { start: 'Starts', break: 'Next break', breakEnd: 'Back at', end: 'Ends', overtime: 'Overtime' };
const NEXT_WORD = { start: 'start', break: 'break', breakEnd: 'back', end: 'end', overtime: 'overtime' };
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

// Records filed before currencies existed are dollars.
const KNOWN = new Set(CURRENCIES.map((c) => c.code));
const entryCurrency = (entry) => (KNOWN.has(entry?.currency) ? entry.currency : 'USD');

const receiptDate = (ms) => {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} · ${clockTime(ms)}`;
};

// A gig is over once it's Paid in full or the session is over; paused or on a break,
// it's still going.
export const gigFinished = (status) => status.phase === 'paid' || status.phase === 'over';

export function viewModel(session, status, now, decimals) {
  const { config } = session;
  const cur = currencyOf(config);
  const money = (cents) => formatMoney(cents, cur);
  const isFlat = status.capCents != null;
  const paid = status.phase === 'paid';
  const scheduleOff = config.mode === 'scheduled' && !session.scheduleArmed && !paid && status.phase !== 'over';
  const [primary, primaryAction] = mainButton(status.phase, config.manualPause === true, status.stopped);
  const past = history(session, now);
  // Extras are listed from the start (they're part of the deal); the total adds them once it begins.
  const extrasCents = (Array.isArray(config.extras) ? config.extras : []).reduce((sum, x) => sum + (x?.amountCents > 0 ? x.amountCents : 0), 0);

  // The rate per minute to the nearest ten-thousandth, trailing zeros dropped: $1.40, $1.3125.
  const { amountCents, perMs } = status.payRate;
  let perMinuteUnits = perMs > 0 ? Math.round((amountCents * 100 * 60_000) / perMs) : 0;
  let places = 4;
  while (places > 2 && perMinuteUnits % 10 === 0) { perMinuteUnits /= 10; places -= 1; }
  const perMinute = formatAmount(perMinuteUnits, places, cur);

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
      nextText: status.cents > status.capCents ? `${money(status.capCents)} fee earned in full` : `All ${money(status.capCents)} earned`,
      nextShortLabel: 'Finished',
      nextShortValue: clockTime(paidAt),
      nextRowLabel: 'Finished',
      nextRowValue: clockTime(paidAt),
      stubNext: '',
    };
  } else if (status.phase === 'overtime') {
    const since = past.findLast((e) => e.kind === 'overtime')?.t ?? now;
    next = {
      hasNext: true,
      nextText: `Overtime since ${clockLabel(since, now)}`,
      nextShortLabel: 'Overtime since',
      nextShortValue: clockTime(since),
      nextRowLabel: 'Overtime since',
      nextRowValue: clockTime(since),
      stubNext: `Overtime since ${hm24(since)}`,
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
    payShort: `${formatPrice(config.amountCents, cur)} ${UNITS[config.format]}`,
    gigPay: `${formatPrice(config.amountCents, cur)} ${UNITS[config.format]}${isFlat ? ` · ${durationLong(status.plannedMs)} of work` : ''}`,
    amount: formatAmount(unitsEarned(status, decimals), decimals, cur),
    worked: formatClock(status.workedMs),
    isFlat,
    owed: isFlat ? money(status.capCents - (status.baseCents ?? status.cents)) : '',
    hasExtras: extrasCents > 0,
    extras: money(extrasCents),
    hasOvertime: status.overtimeMs > 0 || status.phase === 'overtime',
    hasAddOns: extrasCents > 0 || status.overtimeMs > 0 || status.phase === 'overtime',
    overtime: money(status.overtimeCents ?? 0),
    pct: `${Math.floor(progress * 100)}%`,
    ledLit: Math.floor(progress * 20),
    rateLong: `${perMinute} a minute`,
    rateShort: `${money(Math.floor(status.centsPerHour / 60))}/min`,
    payLabel: PAY_LABEL[config.format],
    payValue: `${money(config.amountCents)}${PAY_SUFFIX[config.format] ?? ''}`,
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
    // A shareable receipt is offered on the meter screen once the gig is done.
    hasReceipt: gigFinished(status) && status.cents > 0,
  };
}

// ---------- saved gigs ----------
// A short list of regular gigs kept on the phone, each a full copy of a Setup
// ({ id, config, savedAt }), newest first. Pure: the app stores and shows the list.

export const SAVED_MAX = 12;

const savedPay = (config) => `${formatPrice(config.amountCents, currencyOf(config))} ${UNITS[config.format]}`;
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
  return name ? `name:${name}` : `pay:${savedSummary(config)}|${currencyOf(config)}`;
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
  return savedFrom(data);
}

function savedFrom(data) {
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
// { id, title, pay, cents, currency?, workedMs, startedAt, endedAt, breakdown?, asOf?,
// origin? }. Pure: the app stores it. `breakdown` ({ baseCents, overtimeMs, extras:
// [{ label, cents }], feePaid }) is what the total is made of, for its receipt; records
// from before v16 have none. `asOf` marks a gig whose money is only known as of a
// backup (it was still going then); `origin` is the start a restored gig had on the
// old phone (see "backup, restore").

export const HISTORY_MAX = 500;
const isMoment = (t) => Number.isFinite(t) && t >= 0 && t <= 8.64e15; // a real date

const time12At = (ms) => { const d = new Date(ms); return time12(`${d.getHours()}:${d.getMinutes()}`); };

// The record for a gig as of `now`, or null when it earned nothing. A gig brought back
// from a backup passes on the start it had on the old phone (`origin`) and, while it's
// still only a stand-in there, when its money was known (`asOf`).
export function historyEntry(session, now, id) {
  const status = getStatus(session, now);
  if (!(status.cents > 0)) return null;
  const moments = history(session, now);
  const last = moments.at(-1);
  const from = fromOf(session);
  const asOf = standInAsOf(session, now);
  return {
    id,
    title: savedTitle(session.config),
    pay: savedPay(session.config),
    cents: status.cents,
    currency: currencyOf(session.config),
    workedMs: status.workedMs,
    startedAt: moments[0]?.t ?? Math.floor(now),
    endedAt: status.running || !last ? Math.floor(now) : last.t,
    breakdown: {
      baseCents: status.baseCents,
      overtimeMs: status.overtimeMs ?? 0,
      extras: status.extrasCents > 0
        ? session.config.extras.filter((x) => x?.amountCents > 0).map((x) => ({ label: String(x.label ?? '').trim().slice(0, 30), cents: x.amountCents }))
        : [],
      feePaid: status.capCents != null && status.baseCents >= status.capCents,
    },
    ...(Number.isFinite(from?.start) && { origin: from.start }),
    ...(asOf != null && { asOf }),
  };
}

const extrasSum = (extras) => extras.reduce((sum, x) => sum + x.cents, 0);

// A stored breakdown is kept only if it's sound and adds up to the record's total
// (anything left over beyond base pay and extras is overtime).
function readBreakdown(b, cents) {
  if (!b || typeof b !== 'object') return null;
  const { baseCents, overtimeMs, extras, feePaid } = b;
  if (!Number.isSafeInteger(baseCents) || baseCents < 0) return null;
  if (!Number.isFinite(overtimeMs) || overtimeMs < 0) return null;
  if (typeof feePaid !== 'boolean') return null;
  if (!Array.isArray(extras) || !extras.every((x) => x && typeof x.label === 'string' && Number.isSafeInteger(x.cents) && x.cents > 0)) return null;
  const rest = cents - baseCents - extrasSum(extras);
  if (rest < 0 || (rest > 0 && !(overtimeMs > 0))) return null;
  return { baseCents, overtimeMs, extras: extras.map((x) => ({ label: x.label.slice(0, 30), cents: x.cents })), feePaid };
}

export const addHistory = (list, entry) => [entry, ...list].slice(0, HISTORY_MAX);
export const removeHistory = (list, id) => list.filter((e) => e.id !== id);

export function readHistory(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return []; }
  return historyFrom(data);
}

function historyFrom(data) {
  if (!Array.isArray(data)) return [];
  const seen = new Set();
  const list = [];
  for (const e of data) {
    const ok = e && typeof e.id === 'string' && e.id && !seen.has(e.id)
      && typeof e.title === 'string' && typeof e.pay === 'string'
      && Number.isSafeInteger(e.cents) && e.cents > 0
      && isMoment(e.startedAt) && isMoment(e.endedAt) && Number.isFinite(e.workedMs) && e.workedMs >= 0;
    if (!ok) continue;
    seen.add(e.id);
    const { id, cents, workedMs, startedAt, endedAt } = e;
    const breakdown = readBreakdown(e.breakdown, cents);
    const currency = KNOWN.has(e.currency) ? e.currency : null;
    list.push({
      id, title: e.title.slice(0, 100), pay: e.pay.slice(0, 100), cents, workedMs, startedAt, endedAt,
      ...(breakdown && { breakdown }), ...(currency && { currency }),
      ...(isMoment(e.asOf) && { asOf: e.asOf }), ...(isMoment(e.origin) && { origin: e.origin }),
    });
    if (list.length === HISTORY_MAX) break;
  }
  return list;
}

// Earned this week (from Monday 00:00), this month and this year, per currency (never
// adding dollars to euros): { week: { USD: 1000, EUR: 500 }, … }. A gig counts on the
// day it started.
export function historyTotals(list, now) {
  const d = new Date(now);
  const from = {
    week: new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime(),
    month: new Date(d.getFullYear(), d.getMonth(), 1).getTime(),
    year: new Date(d.getFullYear(), 0, 1).getTime(),
  };
  const total = (start) => {
    const sums = {};
    for (const e of list) if (e.startedAt >= start) sums[entryCurrency(e)] = (sums[entryCurrency(e)] ?? 0) + e.cents;
    return sums;
  };
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

// "Today, 9:00 AM · 1 hr 30 min" and "$90.00". A gig filed from a backup while it was
// still going says so.
export function historyRow(entry, now) {
  return {
    title: entry.title,
    sub: `${dayLabel(entry.startedAt, now)}, ${time12At(entry.startedAt)} · ${durationLong(entry.workedMs)}${Number.isFinite(entry.asOf) ? ' · as of backup' : ''}`,
    amount: formatMoney(entry.cents, entryCurrency(entry)),
  };
}

// ---------- receipts ----------
// A gig's receipt, from its history record: the words the app draws onto a picture
// in the Pay stub style. `live` is a gig still running (its total so far); a record
// filed from a backup while its gig was still going reads the same way, as of then.

// An unnamed gig's title is its pay summary ("$60 per hour", "$210 per service · 7:00 PM–10:00 PM"),
// already on the receipt.
const namedTitle = (entry) => (entry.title === entry.pay || entry.title.startsWith(`${entry.pay} · `) ? '' : entry.title);
const longDate = (ms) => { const d = new Date(ms); return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
const shortDate = (ms) => { const d = new Date(ms); return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; };

export function receipt(entry, now, live = false) {
  const cur = entryCurrency(entry);
  const asOf = live || Number.isFinite(entry.asOf);
  // A gig still going is "as of" now; a finished one ends at its last moment.
  const end = live ? Math.floor(now) : entry.endedAt;
  const sameDay = new Date(end).toDateString() === new Date(entry.startedAt).toDateString();
  const endTime = sameDay ? time12At(end) : `${shortDate(end)}, ${time12At(end)}`;
  const b = entry.breakdown;
  const money = [];
  if (b && (b.extras.length || b.overtimeMs > 0)) {
    money.push(['Base pay', formatMoney(b.baseCents, cur)]);
    if (b.overtimeMs > 0) {
      const label = b.overtimeMs >= 60000 ? `Overtime · ${durationLong(b.overtimeMs)}` : 'Overtime';
      money.push([label, formatMoney(entry.cents - b.baseCents - extrasSum(b.extras), cur)]);
    }
    for (const x of b.extras) money.push([x.label || 'Extra', formatMoney(x.cents, cur)]);
  }
  return {
    title: namedTitle(entry),
    date: longDate(entry.startedAt),
    rows: [['Pay', entry.pay], ['Started', time12At(entry.startedAt)], [asOf ? 'As of' : 'Finished', endTime], ['Worked', durationLong(entry.workedMs)]],
    money,
    totalLabel: asOf ? 'EARNED SO FAR' : 'TOTAL EARNED',
    total: formatMoney(entry.cents, cur),
    stamp: !asOf && b?.feePaid === true,
  };
}

// The same receipt as plain lines, read aloud in place of the picture.
export function receiptText(r) {
  return [
    'GIG METER', r.title, r.date,
    ...[...r.rows, ...r.money].map(([label, value]) => `${label}: ${value}`),
    `${r.totalLabel}: ${r.total}`,
    r.stamp ? 'PAID IN FULL' : '',
  ].filter(Boolean).join('\n');
}

// "Saturday wedding receipt 2026-11-04.png": the gig's name with anything a file name
// can't safely hold taken out.
export function receiptFileName(entry) {
  const cleaned = namedTitle(entry).replace(/[^\p{L}\p{M}\p{N} $'&,._-]/gu, '').replace(/\s+/g, ' ').replace(/^[.\s]+/, '').trim();
  const name = [...cleaned].slice(0, 40).join('').trim(); // whole letters, never half of one
  const d = new Date(entry.startedAt);
  return `${name || 'Gig'} receipt ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.png`;
}

// ---------- undo for Stop and Reset ----------
// Stop and Reset act on the first tap; for a while afterwards the Reset button reads
// "Undo". `undo` is { at, after, kind }: when it happened, the gig it left behind and
// 'stop' or 'reset'. If the gig has changed since (anything else was done), there's
// nothing to undo.

export const UNDO_MS = 10_000;
// A second tap this soon is the old "tap, Sure?, tap" habit, not a decision, so it's ignored.
export const UNDO_GUARD_MS = 1000;

export function undoState(undo, session, now) {
  if (!undo || undo.after !== session) return 'none';
  const since = now - undo.at;
  if (since < 0 || since >= UNDO_MS) return 'none';
  return since < UNDO_GUARD_MS ? 'guard' : 'ready';
}

export const resetLabel = (phase, undoing) => (undoing ? 'Undo' : phase === 'waiting' ? 'Cancel' : 'Reset');

// What a tap on the Reset button does. The label is redrawn a few times a second, so a
// button still showing "Undo" a moment after the offer ends undoes rather than resets;
// a button showing Undo never resets.
export function resetTap(undo, session, now, showingUndo) {
  const state = undoState(undo, session, now);
  if (state === 'guard') return 'ignore';
  if (state === 'ready') return 'undo';
  if (showingUndo) return undo?.after === session ? 'undo' : 'ignore';
  return 'reset';
}

// After a Stop the main button turns into New gig, so the habit's second tap is ignored
// there; after a Reset it's Start, which should work straight away.
export const primaryBlocked = (undo, session, now) => undo?.kind === 'stop' && undoState(undo, session, now) === 'guard';

// ---------- saving Setup: keep the gig or start fresh ----------
// Timing is how the gig starts and stops (by tap, or a schedule's date, times and breaks);
// price is what it pays (amount, kind of pay, and a fee's planned length by tap).

export function timingKey(config) {
  const s = config.schedule || {};
  const breaks = s.breaksOn === false ? [] : (s.breaks || []).map((b) => [b.start, Number(b.minutes)]);
  return JSON.stringify([config.mode, config.mode === 'scheduled' ? [s.date, s.start, s.end, breaks] : null]);
}

export function priceKey(config) {
  const fee = FORMATS[config.format]?.kind === 'flat';
  return JSON.stringify([config.format, config.amountCents, fee && config.mode !== 'scheduled' ? config.plannedMinutes : null, currencyOf(config)]);
}

// Saving Setup starts the meter over for a different gig: new timing, a schedule
// switched back on, or new pay on a gig that's finished or paused (that's setting up
// the next one: with the Pause button on, a gig rests at Paused after it ends). New
// pay on a gig under way (earning, in overtime, on a scheduled break, or not started)
// re-prices the whole gig and keeps it going. (The app also starts fresh on first run
// and from New gig.)
export function saveRestarts(session, config, now) {
  if (config.mode === 'scheduled' && !session.scheduleArmed) return true;
  if (timingKey(config) !== timingKey(session.config)) return true;
  if (priceKey(config) === priceKey(session.config)) return false;
  const status = getStatus(session, now);
  return gigFinished(status) || status.phase === 'paused';
}

// Saving keeps the gig, but its new pay would finish it on the spot (a fee whose
// planned length is already worked), so Save asks for a second tap.
export function saveEndsGig(session, config, now) {
  return !gigFinished(getStatus(session, now)) && gigFinished(getStatus({ ...session, config }, now));
}

// What saving does to the total of a gig it keeps, when it changes it.
export function repriceNote(session, config, now) {
  const before = getStatus(session, now);
  const after = getStatus({ ...session, config }, now);
  const was = formatMoney(before.cents, currencyOf(session.config));
  const becomes = formatMoney(after.cents, currencyOf(config));
  if (before.cents === after.cents && currencyOf(session.config) === currencyOf(config)) return '';
  if (gigFinished(before)) return `Updates this gig: ${was} becomes ${becomes}.`;
  const ends = gigFinished(after) ? `, which finishes it (${STATUS_TEXT[after.phase]})` : '';
  return `Updates this gig, no restart: ${was} so far becomes ${becomes}${ends}.`;
}

// ---------- Add to Home Screen hint ----------
// iPhones never offer to install a web app, so Setup explains how, but only in an
// iPhone or iPad browser (iPadOS calls itself a Mac; the touch screen gives it away),
// never in the Home Screen app itself, and never again once dismissed.
export function wantsInstallHint({ userAgent = '', maxTouchPoints = 0, standalone = false, dismissed = false }) {
  if (standalone || dismissed) return false;
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

// ---------- backup, restore and spreadsheet export ----------
// Everything lives only in this phone's browser. A backup is one file with the current
// gig, saved gigs and History. Restoring one adds what's missing and never counts a gig
// twice. A gig is the same gig when it started at the same moment (a gig brought back
// from a backup also goes by the start it had there). Of two copies, the one here stays,
// unless it's only a stand-in a restore left (its money known as of a backup, and not
// worked on here since) and the other copy is complete or known as of a later moment.
// Restoring the same file twice adds nothing the second time.

export const BACKUP_VERSION = 1;
const BACKUP_MAX_CHARS = 5_000_000; // far bigger than any real backup
const NOT_BACKUP = 'That file isn’t a Gig Meter backup.';
const fileDate = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

export const backupFileName = (now) => `Gig Meter backup ${fileDate(now)}.json`;
export const historyCsvFileName = (now) => `Gig Meter history ${fileDate(now)}.csv`;

const isText = (v, max) => typeof v === 'string' && v.length <= max;
const isPlain = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// A gig brought back onto the meter by a restore carries `from`: { at: the backup's
// moment, asOf: when its money was known on the old phone (null when it was complete
// or hadn't started), start: when it started there, cents: what it had then }.
const fromOf = (session) => (isPlain(session?.from) ? session.from : null);
const readFrom = (f) => (isPlain(f) && isMoment(f.at) && Number.isSafeInteger(f.cents) && f.cents >= 0
  && (f.asOf === null || isMoment(f.asOf)) && (f.start === null || isMoment(f.start))
  ? { at: f.at, asOf: f.asOf, start: f.start, cents: f.cents } : null);

// Until it's worked on here (a tap after the restore, or a different total), such a gig
// is only a stand-in for the old phone's copy: this returns when that copy's money was
// known, or null for any other gig.
function standInAsOf(session, now) {
  const from = fromOf(session);
  if (from?.asOf == null || !session.events.every((e) => e.t <= from.at)) return null;
  return getStatus(session, now).cents === from.cents ? from.asOf : null;
}

// The stored current gig, or null when it no longer makes a usable gig. Taps that make
// no sense are dropped.
export function readSession(data) {
  if (!data || !Array.isArray(data.events) || validateConfig(data.config)) return null;
  const events = data.events.filter((e) => Number.isFinite(e?.t) && ['resume', 'pause', 'stop'].includes(e.type));
  const from = readFrom(data.from);
  return { config: data.config, events, scheduleArmed: Boolean(data.scheduleArmed), ...(from && { from }) };
}

// The gig as a History record at `at`, known "as of" then if it was still going (a
// stand-in keeps the older moment its money was known).
function gigRecordAt(session, at) {
  const entry = historyEntry(session, at, `backup-${at}`);
  if (!entry) return null;
  return entry.asOf != null || gigFinished(getStatus(session, at)) ? entry : { ...entry, asOf: at };
}

// The file's contents. Its current gig also goes in as this phone reads it, the old
// phone's word on what it had earned (a phone that reads its times differently, in
// another time zone, goes by these numbers).
export function backupData({ session, saved, history: past }, now) {
  const at = Math.floor(now);
  return { app: 'gig-meter', version: BACKUP_VERSION, exportedAt: at, session: session ?? null, gigRecord: session ? gigRecordAt(session, at) : null, saved, history: past };
}

// A setup from a file must have the shape the app saves: text where it keeps text (no
// longer than Setup allows), lists of objects where it keeps lists, whole-cent amounts,
// and lengths the pay engine can count. Anything else is left out rather than trusted.
const isCents = (v) => Number.isSafeInteger(v) && v > 0;
const isLength = (v) => Number.isFinite(v) && Math.abs(v) <= 1e9; // minutes; more would overflow the engine
const isBreak = (b) => isPlain(b) && isText(b.start, 8) && isLength(Number(b.minutes));
const isExtra = (x) => isPlain(x) && (x.label === undefined || isText(x.label, 30)) && isCents(x.amountCents);
function soundConfig(c) {
  if (!isPlain(c) || (c.name !== undefined && !isText(c.name, 40)) || !isCents(c.amountCents)) return false;
  if (c.plannedMinutes !== undefined && !(isLength(c.plannedMinutes) && c.plannedMinutes >= 0)) return false;
  if (c.mode !== undefined && c.mode !== 'manual' && c.mode !== 'scheduled') return false;
  const s = c.schedule;
  if (s != null && !(isPlain(s) && [s.date, s.start, s.end].every((v) => v === undefined || isText(v, 10))
    && (s.breaksOn === undefined || typeof s.breaksOn === 'boolean')
    && (s.breaks === undefined || (Array.isArray(s.breaks) && s.breaks.every(isBreak))))) return false;
  if (c.extras !== undefined && !(Array.isArray(c.extras) && c.extras.every(isExtra))) return false;
  const ot = c.overtime;
  if (ot != null && !(isPlain(ot) && typeof ot.on === 'boolean' && Number.isSafeInteger(ot.amountCents) && ot.amountCents >= 0)) return false;
  return !validateConfig(c);
}

// The backup's current gig: a sound setup, and only taps up to the moment of the backup.
function sessionFrom(data, at) {
  if (!isPlain(data) || !soundConfig(data.config) || !Array.isArray(data.events) || data.events.length > 20_000) return null;
  const session = readSession(data);
  return session && { ...session, events: session.events.filter((e) => Number.isSafeInteger(e.t) && e.t >= 0 && e.t <= at) };
}

// A backup file's contents ({ exportedAt, session, gigRecord, saved, history,
// unreadable }), or { error }. Damaged or doubtful parts are left out and counted.
export function readBackup(text) {
  if (typeof text !== 'string' || text.length > BACKUP_MAX_CHARS) return { error: NOT_BACKUP };
  try {
    const data = JSON.parse(text);
    if (!isPlain(data) || data.app !== 'gig-meter' || !Number.isSafeInteger(data.version) || data.version < 1) return { error: NOT_BACKUP };
    if (data.version > BACKUP_VERSION) return { error: 'That backup is from a newer Gig Meter. Reopen the app to update it, then try again.' };
    const at = Math.floor(data.exportedAt);
    if (!Number.isSafeInteger(at) || !isMoment(at)) return { error: NOT_BACKUP };
    const session = sessionFrom(data.session, at);
    // The old phone's reading of its current gig: a record, null (nothing earned there), or
    // undefined when the file doesn't say (then this phone's own reading is used).
    const record = session && 'gigRecord' in data ? historyFrom([data.gigRecord])[0] ?? null : undefined;
    const saved = savedFrom(Array.isArray(data.saved) ? data.saved.filter((e) => isPlain(e) && soundConfig(e.config)) : []);
    const past = historyFrom(data.history);
    // How many gigs in the file were left out as damaged (a real backup has none).
    const unreadable = (data.session != null && !session ? 1 : 0)
      + (Array.isArray(data.saved) ? data.saved.length - saved.length : 0)
      + (Array.isArray(data.history) ? data.history.length - past.length : 0);
    return { exportedAt: at, session, gigRecord: record && record.id !== `backup-${at}` ? null : record, saved, history: past, unreadable };
  } catch {
    return { error: NOT_BACKUP };
  }
}

const withTap = (session, t, type) => ({ ...session, events: [...session.events, { t, type }] });

// The backup's current gig as it comes onto the meter, and the words for it. `origin`
// is the old phone's record of it (null when nothing was earned there). Time after the
// backup never counts: a gig running then is paused at that moment, and one on a
// schedule is stopped there (its schedule would otherwise start it again after a
// break). A schedule not started yet stays on, unless its start time has passed.
function gigFromBackup(session, at, now, origin) {
  const status = getStatus(session, at);
  const money = formatMoney(status.cents, currencyOf(session.config));
  const from = { at, asOf: origin?.asOf ?? null, start: origin?.startedAt ?? null, cents: status.cents };
  const back = (s, note) => ({ session: { ...s, from }, note });
  if (gigFinished(status)) return back(session, money);
  if (status.phase === 'idle') return back(session, 'not started');
  if (status.phase === 'waiting') {
    return status.schedule.startMs > now
      ? back(session, 'not started')
      : back({ ...session, scheduleArmed: false }, 'not started; its start time has passed, so its schedule is off');
  }
  if (session.scheduleArmed) return back(withTap(session, at, 'stop'), `${money}, stopped at the backup`);
  if (status.running) return back(withTap(session, at, 'pause'), `${money}, paused at the backup`);
  return back(session, `${money} so far`);
}

const sameSetup = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const startOf = (session, t) => history(session, t)[0]?.t ?? null;
const keysOf = (e) => [e.startedAt, e.origin].filter(Number.isFinite);
const sameGig = (a, b) => a.some((k) => b.includes(k));
// A copy here known as of `hereAsOf` (null: complete, or this phone's own) gives way to
// one that's complete (null) or known as of a later moment.
const givesWay = (hereAsOf, otherAsOf) => hereAsOf != null && (otherAsOf == null || otherAsOf > hereAsOf);
const blank = (session) => ({ config: session.config, events: [], scheduleArmed: false });

// Adds a saved gig unless it's here already: 'added', 'same', 'kept' (one with that name
// but other details is here, and stays) or 'full'.
function addSaved(saved, g) {
  const found = saved.find((e) => e.id === g.id) ?? matchSaved(saved, g.config);
  if (found) return sameSetup(found.config, g.config) ? 'same' : 'kept';
  if (saved.length >= SAVED_MAX) return 'full';
  saved.push(g);
  return 'added';
}

// Adds a backup to this phone's { session, saved, history } (`session` is null on a
// phone with nothing saved yet). Returns the new { session, saved, history } and a
// report of what it did. The backup's current gig comes onto the meter only on a phone
// with nothing saved yet (and only if this phone reads its times the same way), or to
// bring a stand-in there up to date; otherwise a started one goes into History as it
// was at the backup, and one not started into saved gigs.
export function mergeBackup(here, backup, now) {
  const report = { historyAdded: 0, historySkipped: 0, historyReplaced: 0, savedAdded: 0, savedSkipped: 0, savedKept: [], gig: 'none', gigNote: '', gigWhy: '', meterMoved: '' };

  const saved = [...here.saved];
  for (const g of [...backup.saved].sort((a, b) => b.savedAt - a.savedAt)) {
    const result = addSaved(saved, g);
    if (result === 'added') report.savedAdded += 1;
    else if (result === 'full') report.savedSkipped += 1;
    else if (result === 'kept') report.savedKept.push(savedTitle(g.config));
  }

  const mine = here.session;
  let session = mine;
  const past = [...here.history];
  let room = HISTORY_MAX - past.length;
  const add = (e) => {
    if (room <= 0) return false;
    past.push(e);
    room -= 1;
    return true;
  };
  // The phone's copies: the gig on the meter (once it has started) and History's.
  const mineStart = mine ? startOf(mine, now) : null;
  const meterKeys = mineStart != null ? [mineStart, fromOf(mine)?.start].filter(Number.isFinite) : [];
  const meterAsOf = mine ? standInAsOf(mine, now) : null;
  const findHere = (keys) => {
    if (session === mine && sameGig(keys, meterKeys)) return { meter: true, asOf: meterAsOf };
    const index = past.findIndex((h) => sameGig(keys, keysOf(h)));
    return index === -1 ? null : { index, asOf: past[index].asOf ?? null };
  };
  const moneyOf = (e) => `${formatMoney(e.cents, entryCurrency(e))}${e.asOf != null ? ' at the backup' : ''}`;
  // A stand-in on the meter gives way to a record: it goes into History, the meter starts fresh.
  const moveMeter = (e) => {
    if (!add(e)) return false;
    report.meterMoved = `${savedTitle(mine.config)} (${moneyOf(e)})`;
    session = blank(mine);
    return true;
  };

  const theirs = backup.session;
  if (theirs) {
    const at = backup.exportedAt;
    const local = gigRecordAt(theirs, at);
    const origin = backup.gigRecord === undefined ? local : backup.gigRecord; // the old phone's reading; null: nothing earned there
    const alike = (origin?.cents ?? 0) === (local?.cents ?? 0) && (origin?.startedAt ?? null) === (local?.startedAt ?? null);
    const found = origin && findHere(keysOf(origin));
    const take = (gig) => {
      const g = gigFromBackup(theirs, at, now, origin);
      session = g.session;
      Object.assign(report, { gig, gigNote: g.note });
    };
    if (fromOf(mine)?.at === at) report.gig = 'same'; // brought back from this very backup
    else if (found) {
      if (!givesWay(found.asOf, origin.asOf ?? null)) report.gig = 'same';
      else if (!found.meter) {
        past[found.index] = origin;
        report.historyReplaced += 1;
      } else if (alike) take('updated');
      else if (!moveMeter(origin)) report.historySkipped += 1;
    } else if (origin) {
      if (!mine && alike) take('taken');
      else if (add(origin)) Object.assign(report, { gig: 'filed', gigNote: moneyOf(origin), gigWhy: mine ? 'busy' : 'zone' });
      else report.historySkipped += 1;
    } else if (!mine) {
      if (alike) take('taken');
      else {
        // Nothing earned there, but this phone reads its times as started: its setup only.
        session = { config: theirs.config, events: [], scheduleArmed: false, from: { at, asOf: null, start: null, cents: 0 } };
        Object.assign(report, { gig: 'taken', gigNote: 'not started; its times read differently on this phone, so its schedule is off' });
      }
    } else if (sameSetup(mine.config, theirs.config)) report.gig = 'same';
    else {
      const result = addSaved(saved, { id: `backup-${at}`, config: theirs.config, savedAt: at });
      if (result === 'added') report.gig = 'saved';
      else if (result === 'full') report.gig = 'skipped';
      else if (result === 'kept') report.savedKept.push(savedTitle(theirs.config));
      else report.gig = 'same';
    }
  }

  // History from the backup, newest first while there's room.
  const ids = new Set(past.map((e) => e.id));
  for (const e of [...backup.history].sort((a, b) => b.startedAt - a.startedAt)) {
    if (ids.has(e.id)) continue;
    const found = findHere(keysOf(e));
    if (found) {
      if (!givesWay(found.asOf, e.asOf ?? null)) continue;
      if (found.meter) {
        if (!moveMeter(e)) report.historySkipped += 1;
      } else {
        past[found.index] = e;
        report.historyReplaced += 1;
      }
      ids.add(e.id);
      continue;
    }
    if (add(e)) {
      ids.add(e.id);
      report.historyAdded += 1;
    } else report.historySkipped += 1;
  }

  const changed = past.length !== here.history.length || report.historyReplaced > 0;
  return {
    session,
    saved: saved.sort((a, b) => b.savedAt - a.savedAt),
    history: changed ? past.sort((a, b) => b.startedAt - a.startedAt) : here.history,
    report,
  };
}

// Whether restoring would change anything on this phone.
export const restoreChanges = (r) => r.historyAdded > 0 || r.historyReplaced > 0 || r.savedAdded > 0 || Boolean(r.meterMoved) || ['taken', 'updated', 'filed', 'saved'].includes(r.gig);

const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listed = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

// What a restore will do (shown before asking), or did (`done`).
export function restoreText(report, backup, { done = false } = {}) {
  const will = (future, past) => (done ? past : future);
  const out = [];
  const adds = [];
  if (report.historyAdded) adds.push(`${count(report.historyAdded, 'gig')} to History`);
  if (report.savedAdded) adds.push(count(report.savedAdded, 'saved gig'));
  if (report.gig === 'taken') adds.push(`its current gig (${report.gigNote})`);
  if (adds.length) out.push(`${will('Adds', 'Added')} ${listed(adds)}.`);
  if (report.historyReplaced) out.push(`${will('Brings', 'Brought')} ${count(report.historyReplaced, 'gig')} in History up to date.`);
  if (report.gig === 'updated') out.push(`${will('Brings', 'Brought')} the gig on your meter up to date (${report.gigNote}).`);
  if (report.meterMoved) {
    out.push(done
      ? `That backup had a newer copy of the gig on your meter: ${report.meterMoved} went into History and the meter started fresh.`
      : `This backup has a newer copy of the gig on your meter: ${report.meterMoved} goes into History and the meter starts fresh.`);
  }
  const why = report.gigWhy === 'zone' ? 'since its times read differently on this phone' : 'since this phone has a gig of its own';
  if (report.gig === 'filed') out.push(`Its current gig (${report.gigNote}) ${will('goes', 'went')} into History, ${why}.`);
  if (report.gig === 'saved') out.push(`Its current gig (not started) ${will('goes', 'went')} into your saved gigs, since this phone has a gig of its own.`);
  if (report.gig === 'skipped') out.push(`Its current gig (not started) ${will('is', 'was')} left out: this phone has a gig of its own and saved gigs are full.`);
  const skipped = report.historySkipped;
  if (skipped) {
    out.push(report.historyAdded || report.gig === 'filed' || report.meterMoved
      ? `The ${skipped === 1 ? 'oldest gig' : `${skipped} oldest gigs`} ${will('won’t', 'didn’t')} fit (History keeps ${HISTORY_MAX}).`
      : `History is full (${HISTORY_MAX} gigs), so ${count(skipped, 'gig')} ${will('won’t', 'didn’t')} fit.`);
  }
  if (report.savedSkipped) out.push(`${count(report.savedSkipped, 'saved gig')} ${will('won’t', 'didn’t')} fit (you can keep ${SAVED_MAX}).`);
  const kept = report.savedKept;
  if (kept.length) out.push(`${listed(kept.map((t) => `“${t}”`))} ${kept.length === 1 ? 'is' : 'are'} already in saved gigs with other details; this phone’s ${kept.length === 1 ? 'stays' : 'stay'}.`);
  const bad = backup.unreadable ?? 0;
  if (bad) out.push(`${count(bad, 'gig')} in it couldn’t be read, so ${bad === 1 ? 'it’s' : 'they’re'} left out.`);
  if (!out.length) {
    const empty = !backup.session && !backup.saved.length && !backup.history.length;
    out.push(empty ? 'There’s nothing in it.' : 'Everything in it is already on this phone.');
  }
  return done ? out.join(' ') : [`Backup from ${longDate(backup.exportedAt)}, ${time12At(backup.exportedAt)}.`, ...out].join(' ');
}

// History as a spreadsheet (CSV), oldest first: dates and 24-hour times spreadsheets
// can read, plain amounts with a currency column, and base pay, extras and overtime
// where the record has them. A cell that starts like a formula is written as text.
const csvCell = (value) => {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const plainAmount = (cents) => `${Math.floor(cents / 100)}.${pad(cents % 100)}`;

export function historyCsv(list) {
  const head = ['Date', 'Start', 'End', 'Gig', 'Pay', 'Hours worked', 'Earned', 'Currency', 'Base pay', 'Extras', 'Overtime'];
  const rows = [...list].sort((a, b) => a.startedAt - b.startedAt).map((e) => {
    const b = e.breakdown;
    const extras = b ? extrasSum(b.extras) : 0;
    return [
      fileDate(e.startedAt), hm24(e.startedAt), hm24(e.endedAt), namedTitle(e), e.pay,
      (e.workedMs / 3_600_000).toFixed(2), plainAmount(e.cents), entryCurrency(e),
      b ? plainAmount(b.baseCents) : '', b ? plainAmount(extras) : '', b ? plainAmount(e.cents - b.baseCents - extras) : '',
    ];
  });
  return `﻿${[head, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
