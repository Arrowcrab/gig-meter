// Gig Meter pay engine. Pure functions, no DOM; every time is epoch milliseconds.
//
// Earnings are always recalculated from the clock: a session is its pay setup plus a
// list of manual Start/Pause taps, merged with the schedule's own start/break/end
// changes. Whatever happened most recently decides whether the meter is running.
// Nothing accumulates frame by frame, so a frozen or reopened page is never behind.

const MIN = 60_000;
const HOUR = 60 * MIN;

export const FORMATS = {
  hourly:  { label: 'Per hour',      kind: 'rate', unitMs: HOUR,           unit: 'hour' },
  service: { label: 'Per service',   kind: 'flat',                         unit: 'service' },
  day:     { label: 'Day rate',      kind: 'flat',                         unit: 'day' },
  flat:    { label: 'Flat fee',      kind: 'flat',                         unit: 'job' },
  minute:  { label: 'Per minute',    kind: 'rate', unitMs: MIN,            unit: 'minute' },
  weekly:  { label: 'Weekly salary', kind: 'rate', unitMs: 40 * HOUR,      unit: 'week', note: 'Assumes a 40-hour work week.' },
  yearly:  { label: 'Yearly salary', kind: 'rate', unitMs: 52 * 40 * HOUR, unit: 'year', note: 'Assumes 40-hour weeks, 52 weeks a year.' },
};

// "$1,250.50" → 125050. Parsed as text so 0.015 rounds to 2 cents, not 1.
export function parseMoney(text) {
  const cleaned = String(text ?? '').replace(/[$,\s]/g, '');
  const match = /^(\d*)(?:\.(\d*))?$/.exec(cleaned);
  if (!match || cleaned === '' || cleaned === '.') return null;
  const frac = ((match[2] || '') + '000').slice(0, 3);
  const cents = Number(match[1] || '0') * 100 + Number(frac.slice(0, 2)) + (Number(frac[2]) >= 5 ? 1 : 0);
  return Number.isSafeInteger(cents) ? cents : null;
}

// How many decimal places the meter can show: cents, or finer for faster-moving digits.
export const DECIMAL_CHOICES = [2, 3, 4, 5];
export const DEFAULT_DECIMALS = 4;

// units are whole 10^-decimals dollars: formatAmount(2187, 5) → "$0.02187".
export function formatAmount(units, decimals = 2) {
  const scale = 10 ** decimals;
  const dollars = Math.floor(units / scale).toLocaleString('en-US');
  return `$${dollars}.${String(units % scale).padStart(decimals, '0')}`;
}

export const formatMoney = (cents) => formatAmount(cents, 2);

// Earnings at the given precision, rounded down, so 2 places equals status.cents.
export function unitsEarned(status, decimals = 2) {
  const { amountCents, perMs } = status.payRate;
  if (!(perMs > 0)) return 0;
  const scale = 10n ** BigInt(decimals - 2);
  return Number((BigInt(amountCents) * scale * BigInt(status.workedMs)) / BigInt(perMs));
}

// 1:02:03 once past an hour, otherwise 02:03.
export function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${m}:${s}` : `${m}:${s}`;
}

const parseDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? [+m[1], +m[2], +m[3]] : null;
};

const parseTime = (s) => {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s || '');
  return m && +m[1] < 24 && +m[2] < 60 ? [+m[1], +m[2]] : null;
};

const localMs = ([y, mo, d], [h, mi], addDays = 0) => new Date(y, mo - 1, d + addDays, h, mi).getTime();

// Turns the user's date/times into real moments. An end (or break) earlier on the
// clock than the start is taken to be after midnight.
export function buildSchedule(schedule) {
  if (!schedule) return { error: 'Add a schedule.' };
  const date = parseDate(schedule.date);
  if (!date) return { error: 'Pick a date for the session.' };
  const start = parseTime(schedule.start);
  const end = parseTime(schedule.end);
  if (!start) return { error: 'Pick a start time.' };
  if (!end) return { error: 'Pick an end time.' };

  const startMs = localMs(date, start);
  let endMs = localMs(date, end);
  if (endMs === startMs) return { error: 'The end time has to be different from the start time.' };
  if (endMs < startMs) endMs = localMs(date, end, 1);

  const breaks = [];
  for (const [i, b] of (schedule.breaks || []).entries()) {
    const time = parseTime(b.start);
    if (!time) return { error: `Break ${i + 1} needs a start time.` };
    const minutes = Number(b.minutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return { error: `Break ${i + 1} needs a length.` };
    let breakStart = localMs(date, time);
    if (breakStart < startMs) breakStart = localMs(date, time, 1);
    const breakEnd = breakStart + Math.round(minutes * MIN);
    if (breakEnd > endMs) return { error: `Break ${i + 1} runs outside the session.` };
    breaks.push({ startMs: breakStart, endMs: breakEnd });
  }
  breaks.sort((a, b) => a.startMs - b.startMs);
  for (let i = 1; i < breaks.length; i++) {
    if (breaks[i].startMs < breaks[i - 1].endMs) return { error: 'Two breaks overlap.' };
  }

  const breakMs = breaks.reduce((sum, b) => sum + (b.endMs - b.startMs), 0);
  return { startMs, endMs, breaks, workingMs: endMs - startMs - breakMs };
}

// Returns a message for the first problem, or null when the setup is usable.
export function validateConfig(config) {
  const format = FORMATS[config?.format];
  if (!format) return 'Pick a pay format.';
  if (!Number.isSafeInteger(config.amountCents) || config.amountCents <= 0) return 'Enter an amount above $0.';
  if (config.mode === 'scheduled') {
    const built = buildSchedule(config.schedule);
    if (built.error) return built.error;
    if (format.kind === 'flat' && built.workingMs <= 0) return 'The breaks take up the whole session.';
  } else if (format.kind === 'flat' && !(config.plannedMinutes > 0)) {
    return 'Enter how long the job runs.';
  }
  return null;
}

export function newSession(config) {
  return { config, events: [], scheduleArmed: config.mode === 'scheduled' };
}

// Flat fees are spread over working time only, so the meter lands on the full fee
// exactly when the planned work is done, and stops there.
function payRate(config, built) {
  const format = FORMATS[config.format];
  if (format.kind === 'rate') return { amountCents: config.amountCents, perMs: format.unitMs, capMs: null };
  const plannedMs = built ? built.workingMs : Math.round((config.plannedMinutes || 0) * MIN);
  return { amountCents: config.amountCents, perMs: plannedMs, capMs: plannedMs };
}

function scheduleEvents(built) {
  const events = [{ t: built.startMs, run: true, kind: 'start' }];
  for (const b of built.breaks) {
    events.push({ t: b.startMs, run: false, kind: 'break' }, { t: b.endMs, run: true, kind: 'breakEnd' });
  }
  events.push({ t: built.endMs, run: false, kind: 'end' });
  return events;
}

function runState(events, now) {
  let running = false;
  let since = 0;
  let worked = 0;
  for (const e of events) {
    if (e.t > now) break;
    if (running) worked += e.t - since;
    running = e.run;
    since = e.t;
  }
  if (running) worked += now - since;
  return { running, worked };
}

// Everything getStatus and history share: the usable schedule, the pay rate, and the
// merged list of scheduled changes and manual taps.
function prepare(session) {
  const { config } = session;
  const built = config.mode === 'scheduled' ? buildSchedule(config.schedule) : null;
  const schedule = built && !built.error ? built : null;
  const armed = Boolean(session.scheduleArmed && schedule);
  const rate = payRate(config, schedule);
  // On a tie, the manual tap comes second (sort is stable), so the user's tap wins.
  const manual = session.events.map((e) => ({ t: e.t, run: e.type === 'resume', kind: 'manual' }));
  const timeline = [...(armed ? scheduleEvents(schedule) : []), ...manual].sort((a, b) => a.t - b.t);
  return { schedule, armed, rate, timeline };
}

// What has happened so far, oldest first: every scheduled change or tap that actually
// started or stopped the meter, then the moment a flat fee was paid in full (after
// which nothing else matters). Kinds: start, resume, pause, break, back, end, paid.
export function history(session, nowInput) {
  const now = Math.floor(nowInput);
  const { rate, timeline } = prepare(session);
  const capped = rate.capMs != null && rate.capMs > 0;
  const entries = [];
  let running = false;
  let started = false;
  let since = 0;
  let worked = 0;

  const paidBy = (t) => running && capped && worked + (t - since) >= rate.capMs;
  for (const e of timeline) {
    if (e.t > now) break;
    if (paidBy(e.t)) {
      entries.push({ t: since + (rate.capMs - worked), kind: 'paid' });
      return entries;
    }
    if (running) worked += e.t - since;
    if (e.run !== running) {
      let kind;
      if (e.kind === 'manual' || e.kind === 'start') kind = e.run ? (started ? 'resume' : 'start') : 'pause';
      else kind = { break: 'break', breakEnd: 'back', end: 'end' }[e.kind];
      entries.push({ t: e.t, kind });
      if (e.run) started = true;
    }
    running = e.run;
    since = e.t;
  }
  if (paidBy(now)) entries.push({ t: since + (rate.capMs - worked), kind: 'paid' });
  return entries;
}

export function getStatus(session, nowInput) {
  const now = Math.floor(nowInput);
  const { schedule, armed, rate, timeline } = prepare(session);
  const state = runState(timeline, now);

  const workedMs = rate.capMs == null ? state.worked : Math.min(state.worked, rate.capMs);
  const earning = { amountCents: rate.amountCents, perMs: rate.perMs };
  const cents = unitsEarned({ payRate: earning, workedMs }, 2);
  const paid = rate.capMs != null && rate.capMs > 0 && workedMs >= rate.capMs;

  let phase;
  if (paid) phase = 'paid';
  else if (state.running) phase = 'running';
  else if (armed) {
    if (now < schedule.startMs && !session.events.some((e) => e.t <= now)) phase = 'waiting';
    else if (now >= schedule.endMs) phase = 'over';
    else if (schedule.breaks.some((b) => now >= b.startMs && now < b.endMs)) phase = 'break';
    else phase = 'paused';
  } else phase = session.events.length ? 'paused' : 'idle';

  // The next scheduled change that will actually start or stop the meter. A scheduled
  // start is skipped if the user already started early, a break end if they never stopped.
  const next = armed && !paid ? scheduleEvents(schedule).find((e) => e.t > now && e.run !== state.running) : null;

  return {
    phase,
    running: state.running && !paid,
    cents,
    workedMs,
    capCents: rate.capMs == null ? null : rate.amountCents,
    plannedMs: rate.capMs,
    progress: rate.capMs ? workedMs / rate.capMs : null,
    next: next ? { t: next.t, kind: next.kind } : null,
    centsPerHour: rate.perMs > 0 ? (rate.amountCents * HOUR) / rate.perMs : 0,
    payRate: earning,
    schedule: armed ? schedule : null,
  };
}

// The big button: pauses if running, otherwise starts or resumes.
export function toggle(session, now) {
  const { running } = getStatus(session, now);
  return { ...session, events: [...session.events, { t: Math.floor(now), type: running ? 'pause' : 'resume' }] };
}

// Back to $0.00. The schedule is switched off too, or it would refill the meter;
// saving the setup again turns it back on.
export function reset(session) {
  return { ...session, events: [], scheduleArmed: false };
}
