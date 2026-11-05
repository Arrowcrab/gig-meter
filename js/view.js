// Screen text for every look. Pure: given a session, its status and the time, it
// returns the strings and numbers the four looks show, so they all agree.

import { formatAmount, formatMoney, formatClock, unitsEarned, history } from './meter.js';

// The looks the app can wear. `fonts` is the Google Fonts family list each needs
// (loaded only when that look is on); `color` is its top-of-screen color.
export const THEMES = {
  quiet: { label: 'Quiet', fonts: null, color: '#F2F2F7' },
  fare: { label: 'Fare meter', fonts: 'family=Barlow+Condensed:wght@500;600;700&family=Share+Tech+Mono', color: '#1B1A18' },
  stub: { label: 'Pay stub', fonts: 'family=IBM+Plex+Mono:wght@400;500;600;700', color: '#2B2A27' },
  poster: { label: 'Poster', fonts: 'family=Archivo:wdth,wght@62..125,400..900', color: '#FF6B1A' },
};
export const DEFAULT_THEME = 'quiet';
export const themeOf = (config) => (Object.hasOwn(THEMES, config?.theme ?? '') ? config.theme : DEFAULT_THEME);

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
