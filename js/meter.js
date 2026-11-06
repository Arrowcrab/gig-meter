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

// ---------- money ----------
// Every amount is whole cents (hundredths of the gig's currency). The currencies on
// offer all have cents. They're written the way the phone writes numbers (its region
// settings), always in Latin digits: "$1,234.56" on a US phone, "1.234,56 €" on a German
// one. The phone's own currency gets the short symbol; another country's dollar is
// labelled ("CA$" on a US phone, "US$" on a Canadian one), so they never look alike.
// The app sets the phone's style once at start; pure code and tests default to US style.

export const CURRENCIES = [
  { code: 'USD', name: 'US dollar' },
  { code: 'EUR', name: 'Euro' },
  { code: 'GBP', name: 'British pound' },
  { code: 'CAD', name: 'Canadian dollar' },
  { code: 'AUD', name: 'Australian dollar' },
  { code: 'BRL', name: 'Brazilian real' },
  { code: 'DKK', name: 'Danish krone' },
  { code: 'HKD', name: 'Hong Kong dollar' },
  { code: 'INR', name: 'Indian rupee' },
  { code: 'MXN', name: 'Mexican peso' },
  { code: 'NZD', name: 'New Zealand dollar' },
  { code: 'NOK', name: 'Norwegian krone' },
  { code: 'PLN', name: 'Polish złoty' },
  { code: 'SGD', name: 'Singapore dollar' },
  { code: 'ZAR', name: 'South African rand' },
  { code: 'SEK', name: 'Swedish krona' },
  { code: 'CHF', name: 'Swiss franc' },
];
export const DEFAULT_CURRENCY = 'USD';
const CODES = new Set(CURRENCIES.map((c) => c.code));
export const currencyOf = (config) => (CODES.has(config?.currency) ? config.currency : DEFAULT_CURRENCY);

let moneyLocale = 'en-US';
const styles = new Map();

// Use the phone's way of writing numbers (e.g. navigator.language); ignored if unusable.
export function setMoneyLocale(locale) {
  try {
    new Intl.NumberFormat(locale);
    moneyLocale = locale || 'en-US';
  } catch {
    moneyLocale = 'en-US';
  }
}

// How one currency is written in one style: what goes before and after the digits,
// the decimal mark, and the digit grouping (taken from the same formatter, so the
// digits themselves are never rounded through a decimal number).
function moneyStyle(currency, locale = moneyLocale) {
  const code = CODES.has(currency) ? currency : DEFAULT_CURRENCY;
  const key = `${locale}|${code}`;
  let style = styles.get(key);
  if (!style) {
    const options = { style: 'currency', currency: code, numberingSystem: 'latn' };
    let full;
    try {
      full = new Intl.NumberFormat(locale, options);
    } catch {
      full = new Intl.NumberFormat('en-US', options);
    }
    const parts = full.formatToParts(1234567.5);
    const first = parts.findIndex((p) => p.type === 'integer');
    let last = first;
    parts.forEach((p, i) => { if (['integer', 'group', 'decimal', 'fraction'].includes(p.type)) last = i; });
    const whole = new Intl.NumberFormat(full.resolvedOptions().locale, { ...options, minimumFractionDigits: 0, maximumFractionDigits: 0 });
    // Right-to-left languages add invisible direction marks; inside this left-to-right
    // page they only shift the number, so they're dropped.
    const clean = (text) => text.replace(/[\u200e\u200f\u061c]/g, '');
    style = {
      prefix: clean(parts.slice(0, first).map((p) => p.value).join('')),
      suffix: clean(parts.slice(last + 1).map((p) => p.value).join('')),
      decimal: parts.find((p) => p.type === 'decimal')?.value ?? '.',
      group: parts.find((p) => p.type === 'group')?.value ?? ',',
      symbol: clean(parts.find((p) => p.type === 'currency')?.value ?? '$'),
      digits: (n) => whole.formatToParts(n).filter((p) => p.type === 'integer' || p.type === 'group').map((p) => p.value).join(''),
    };
    styles.set(key, style);
  }
  return style;
}

export const currencySymbol = (currency, locale = moneyLocale) => moneyStyle(currency, locale).symbol;
// The decimal mark the phone uses ("." or ","), for showing amounts in Setup's boxes.
export const decimalMark = (locale = moneyLocale) => moneyStyle(DEFAULT_CURRENCY, locale).decimal;

// units are whole 10^-decimals of the currency: formatAmount(2187, 5) → "$0.02187".
export function formatAmount(units, decimals = 2, currency = DEFAULT_CURRENCY, locale = moneyLocale) {
  const scale = 10 ** decimals;
  const style = moneyStyle(currency, locale);
  const fraction = String(units % scale).padStart(decimals, '0');
  return `${style.prefix}${style.digits(Math.floor(units / scale))}${style.decimal}${fraction}${style.suffix}`;
}

export const formatMoney = (cents, currency = DEFAULT_CURRENCY, locale = moneyLocale) => formatAmount(cents, 2, currency, locale);

// "$210" when whole, "$210.50" otherwise.
export function formatPrice(cents, currency = DEFAULT_CURRENCY, locale = moneyLocale) {
  if (cents % 100) return formatMoney(cents, currency, locale);
  const style = moneyStyle(currency, locale);
  return `${style.prefix}${style.digits(cents / 100)}${style.suffix}`;
}

// "$1,250.50" → 125050, "12,50" → 1250. Parsed as text so 0.015 rounds to 2 cents,
// not 1. Either "." or "," can be the decimal mark: with both, the last one is; a lone
// one before exactly three digits is a thousands mark only where the phone groups
// digits that way ("1,250" in the US, "1.250" in Germany) and the number doesn't start
// with 0. Thousands groups (also spaces and apostrophes) must be three digits (Indian
// two-digit groups before the last three are fine). Currency symbols and words are
// ignored; a minus, a ¢ or anything else means it isn't an amount.
export function parseMoney(text, locale = moneyLocale) {
  // An Arabic or Persian keypad types its own digits and marks: read them as 0–9, "." and ",".
  const raw = String(text ?? '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/٫/g, '.')
    .replace(/٬/g, ',');
  if (/[¢-]/.test(raw)) return null;
  const t = raw.replace(/\p{Sc}/gu, ' ').trim().replace(/^(?:CHF|kr|zł|R)\s*/i, '').replace(/\s*(?:CHF|kr|zł)$/i, '').trim();
  const s = t.replace(/[\s\u00a0\u202f'’]+/g, '_');
  if (!/^[\d.,_]+$/.test(s)) return null;
  const dots = s.split('.').length - 1;
  const commas = s.split(',').length - 1;
  let mark = null;
  if (dots && commas) mark = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
  else if (dots + commas === 1) {
    const only = dots ? '.' : ',';
    const i = s.indexOf(only);
    const thousands = only === moneyStyle(DEFAULT_CURRENCY, locale).group && /^\d{3}$/.test(s.slice(i + 1)) && /^[1-9]/.test(s.slice(0, i));
    mark = thousands ? null : only;
  }
  const at = mark ? s.lastIndexOf(mark) : s.length;
  const whole = s.slice(0, at);
  const frac = mark ? s.slice(at + 1) : '';
  if (!/^\d*$/.test(frac)) return null;
  const grouped = /[.,_]/.test(whole);
  if (grouped && !/^\d{1,3}(?:[.,_]\d{3})+$/.test(whole) && !/^\d{1,2}(?:[,_]\d{2})*[,_]\d{3}$/.test(whole)) return null;
  const digits = whole.replace(/[.,_]/g, '');
  if (digits === '' && frac === '') return null;
  const f = (frac + '000').slice(0, 3);
  const cents = Number(digits || '0') * 100 + Number(f.slice(0, 2)) + (Number(f[2]) >= 5 ? 1 : 0);
  return Number.isSafeInteger(cents) ? cents : null;
}

// A new install starts with the currency of the phone's region, if it's on the list.
const EURO = new Set('AT BE BG CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK AD MC SM VA ME XK'.split(' '));
const REGION_CURRENCY = { US: 'USD', CA: 'CAD', AU: 'AUD', NZ: 'NZD', SG: 'SGD', HK: 'HKD', MX: 'MXN', BR: 'BRL', GB: 'GBP', CH: 'CHF', LI: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', IN: 'INR', ZA: 'ZAR' };
export function currencyForRegion(locale) {
  try {
    const region = new Intl.Locale(locale).maximize().region;
    return EURO.has(region) ? 'EUR' : (REGION_CURRENCY[region] ?? DEFAULT_CURRENCY);
  } catch {
    return DEFAULT_CURRENCY;
  }
}

// How many decimal places the meter can show: cents, or finer for faster-moving digits.
export const DECIMAL_CHOICES = [2, 3, 4, 5];
export const DEFAULT_DECIMALS = 4;

// Earnings at the given precision, rounded down, so 2 places equals status.cents.
// The parts (the pay rate's time, then any overtime) are added as exact fractions
// before rounding, and extras are whole cents, so every precision agrees and none
// ever runs ahead of what was actually earned.
export function unitsEarned(status, decimals = 2) {
  const scale = 10n ** BigInt(decimals - 2);
  const parts = status.parts ?? [{ ...status.payRate, workedMs: status.workedMs }];
  let num = 0n;
  let den = 1n;
  for (const { amountCents, perMs, workedMs } of parts) {
    if (!(perMs > 0) || !(workedMs > 0)) continue;
    const p = BigInt(perMs);
    num = num * p + BigInt(amountCents) * BigInt(workedMs) * scale * den;
    den *= p;
  }
  return Number(num / den) + (status.extrasCents ?? 0) * Number(scale);
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

  // Breaks count only when unpaid breaks are switched on. Gigs saved before that switch
  // existed have no breaksOn at all and keep the breaks they had.
  const listed = schedule.breaksOn === false ? [] : schedule.breaks || [];
  const breaks = [];
  for (const [i, b] of listed.entries()) {
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
  if (!Number.isSafeInteger(config.amountCents) || config.amountCents <= 0) return 'Enter an amount above 0.';
  if (config.mode === 'scheduled') {
    const built = buildSchedule(config.schedule);
    if (built.error) return built.error;
    if (format.kind === 'flat' && built.workingMs <= 0) return 'The breaks take up the whole session.';
  } else if (format.kind === 'flat' && !(config.plannedMinutes > 0)) {
    return 'Enter how long the job runs.';
  }
  const extras = Array.isArray(config.extras) ? config.extras : [];
  for (const [i, x] of extras.entries()) {
    if (!Number.isSafeInteger(x?.amountCents) || x.amountCents <= 0) return x?.label ? `Add an amount for ${x.label}.` : `Extra ${i + 1} needs an amount.`;
  }
  if (config.overtime?.on && !(Number.isSafeInteger(config.overtime.amountCents) && config.overtime.amountCents > 0)) {
    return 'Enter an overtime rate above 0.';
  }
  return null;
}

// Add-ons like parking or cartage: whole cents, counted once the gig has started.
const extrasTotal = (config) => (Array.isArray(config.extras) ? config.extras : [])
  .reduce((sum, x) => sum + (Number.isSafeInteger(x?.amountCents) && x.amountCents > 0 ? x.amountCents : 0), 0);

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

// With overtime on, the scheduled end doesn't stop the meter (run: null leaves it as
// it was); it marks where overtime begins.
function scheduleEvents(built, overtimeOn = false) {
  const events = [{ t: built.startMs, run: true, kind: 'start' }];
  for (const b of built.breaks) {
    events.push({ t: b.startMs, run: false, kind: 'break' }, { t: b.endMs, run: true, kind: 'breakEnd' });
  }
  events.push(overtimeOn ? { t: built.endMs, run: null, kind: 'overtime' } : { t: built.endMs, run: false, kind: 'end' });
  return events;
}

function runState(events, now) {
  let running = false;
  let ran = false;
  let since = 0;
  let worked = 0;
  for (const e of events) {
    if (e.t > now) break;
    if (running) worked += e.t - since;
    running = e.run ?? running;
    ran ||= running;
    since = e.t;
  }
  if (running) worked += now - since;
  return { running, worked, ran };
}

// Everything getStatus and history share: the usable schedule, the pay rate, and the
// merged list of scheduled changes and manual taps.
function prepare(session) {
  const { config } = session;
  const built = config.mode === 'scheduled' ? buildSchedule(config.schedule) : null;
  const schedule = built && !built.error ? built : null;
  const armed = Boolean(session.scheduleArmed && schedule);
  const rate = payRate(config, schedule);
  // Overtime needs a planned end: the full fee, or an hourly schedule's end.
  const ot = config.overtime;
  const overtime = ot?.on && ot.amountCents > 0 && (rate.capMs > 0 || armed)
    ? { centsPerHour: ot.amountCents, atMs: rate.capMs > 0 ? null : schedule.endMs }
    : null;
  // On a tie, the manual tap comes second (sort is stable), so the user's tap wins.
  const manual = session.events.map((e) => ({ t: e.t, run: e.type === 'resume', kind: e.type === 'stop' ? 'stop' : 'manual' }));
  let timeline = [...(armed ? scheduleEvents(schedule, Boolean(overtime)) : []), ...manual].sort((a, b) => a.t - b.t);
  // Stop is final: nothing after it, scheduled or tapped, counts.
  const stopIndex = timeline.findIndex((e) => e.kind === 'stop');
  const stopAt = stopIndex === -1 ? null : timeline[stopIndex].t;
  if (stopIndex !== -1) timeline = timeline.slice(0, stopIndex + 1);
  return { schedule, armed, rate, timeline, stopAt, overtime };
}

// What has happened so far, oldest first: every scheduled change or tap that actually
// started or stopped the meter, then the moment a flat fee was paid in full (after
// which nothing else matters). Kinds: start, resume, pause, break, back, end, stop, paid.
// With overtime on, the moment the fee is earned (or an hourly schedule ends) is an
// "overtime" entry instead, and the gig carries on until Stop.
export function history(session, nowInput) {
  const now = Math.floor(nowInput);
  const { rate, timeline, overtime } = prepare(session);
  const capped = rate.capMs != null && rate.capMs > 0;
  const entries = [];
  let running = false;
  let started = false;
  let feeDone = false;
  let overtimePending = false; // an hourly schedule ended while paused: overtime starts on resume
  let since = 0;
  let worked = 0;

  // The fee is earned during the running stretch that ends at t.
  const paidBy = (t) => running && capped && !feeDone && worked + (t - since) >= rate.capMs;
  const feeEarned = () => {
    entries.push({ t: since + (rate.capMs - worked), kind: overtime ? 'overtime' : 'paid' });
    feeDone = true;
  };
  for (const e of timeline) {
    if (e.t > now) break;
    if (paidBy(e.t)) {
      feeEarned();
      if (!overtime) return entries;
    }
    if (running) worked += e.t - since;
    if (e.kind === 'stop') {
      entries.push({ t: e.t, kind: 'stop' });
      return entries;
    }
    if (e.run === null) {
      // The end of an hourly schedule with overtime on: the meter carries on.
      if (overtime?.atMs != null) {
        if (running) entries.push({ t: e.t, kind: 'overtime' });
        else overtimePending = true;
      }
    } else if (e.run !== running) {
      let kind;
      if (e.kind === 'manual' || e.kind === 'start') kind = e.run ? (started ? 'resume' : 'start') : 'pause';
      else kind = { break: 'break', breakEnd: 'back', end: 'end' }[e.kind];
      entries.push({ t: e.t, kind });
      if (e.run) started = true;
      if (e.run && overtimePending) {
        entries.push({ t: e.t, kind: 'overtime' });
        overtimePending = false;
      }
      running = e.run;
    }
    since = e.t;
  }
  if (paidBy(now)) feeEarned();
  return entries;
}

// When a running fee-based gig will have earned its fee, if nothing is tapped: walk
// the schedule's remaining stops and starts (breaks) from now.
function feeEarnedAt(ahead, now, left) {
  let t = now;
  let run = true;
  for (const e of ahead) {
    if (run && t + left <= e.t) return t + left;
    if (run) left -= e.t - t;
    t = e.t;
    run = e.run ?? run;
  }
  return run ? t + left : null;
}

export function getStatus(session, nowInput) {
  const now = Math.floor(nowInput);
  const { schedule, armed, rate, timeline, stopAt, overtime } = prepare(session);
  const state = runState(timeline, now);
  const stopped = stopAt != null && now >= stopAt;
  const capped = rate.capMs != null && rate.capMs > 0;

  // Worked time at the pay rate, and (with overtime on) past the planned end.
  let baseMs = capped ? Math.min(state.worked, rate.capMs) : state.worked;
  let overtimeMs = 0;
  if (overtime) {
    if (capped) overtimeMs = state.worked - baseMs;
    else {
      baseMs = runState(timeline, Math.min(now, overtime.atMs)).worked;
      overtimeMs = state.worked - baseMs;
    }
  }
  const earning = { amountCents: rate.amountCents, perMs: rate.perMs };
  const overtimeRate = overtime ? { amountCents: overtime.centsPerHour, perMs: HOUR } : null;
  const baseCents = unitsEarned({ parts: [{ ...earning, workedMs: baseMs }] }, 2);
  const overtimeCents = overtime ? unitsEarned({ parts: [{ ...overtimeRate, workedMs: overtimeMs }] }, 2) : 0;
  const extrasCents = state.ran ? extrasTotal(session.config) : 0;
  const parts = [{ ...earning, workedMs: baseMs }, ...(overtime ? [{ ...overtimeRate, workedMs: overtimeMs }] : [])];
  const cents = unitsEarned({ parts, extrasCents }, 2);
  const feeDone = capped && baseMs >= rate.capMs;
  const paid = feeDone && !overtime;
  // Past the planned end with overtime on: the fee is earned, or an hourly schedule is over.
  const pastEnd = Boolean(overtime) && (capped ? feeDone : now >= overtime.atMs);
  const running = state.running && !paid;

  const inBreak = armed && schedule.breaks.some((b) => now >= b.startMs && now < b.endMs);

  let phase;
  if (overtime && stopped) phase = feeDone ? 'paid' : 'over';
  else if (pastEnd) phase = running ? 'overtime' : inBreak ? 'break' : 'paused';
  else if (paid) phase = 'paid';
  else if (state.running) phase = 'running';
  else if (stopped) phase = 'over';
  else if (armed) {
    if (now < schedule.startMs && !session.events.some((e) => e.t <= now)) phase = 'waiting';
    else if (now >= schedule.endMs && !overtime) phase = 'over';
    else if (schedule.breaks.some((b) => now >= b.startMs && now < b.endMs)) phase = 'break';
    else phase = 'paused';
  } else phase = session.events.length ? 'paused' : 'idle';

  // The next scheduled change that will actually start or stop the meter (or begin
  // overtime). A scheduled start is skipped if the user already started early, a break
  // end if they never stopped.
  let next = null;
  if (armed && !paid && !stopped) {
    const ahead = scheduleEvents(schedule, Boolean(overtime)).filter((e) => e.t > now);
    next = ahead.find((e) => e.run !== null && e.run !== state.running) ?? null;
    // Overtime begins at an hourly schedule's end, or when the fee will be earned (counting
    // the breaks still to come). Only shown while the meter is running toward it.
    if (overtime && !pastEnd && state.running) {
      const at = capped ? feeEarnedAt(ahead, now, rate.capMs - baseMs) : overtime.atMs;
      if (at != null && (!next || at < next.t)) next = { t: at, kind: 'overtime' };
    }
  }
  const current = pastEnd ? overtimeRate : earning;

  return {
    phase,
    running,
    cents,
    baseCents,
    extrasCents,
    overtimeCents,
    overtimeMs,
    workedMs: overtime ? state.worked : baseMs,
    capCents: rate.capMs == null ? null : rate.amountCents,
    plannedMs: rate.capMs,
    progress: rate.capMs ? baseMs / rate.capMs : null,
    next: next ? { t: next.t, kind: next.kind } : null,
    centsPerHour: current.perMs > 0 ? (current.amountCents * HOUR) / current.perMs : 0,
    payRate: current,
    parts,
    schedule: armed ? schedule : null,
    stopped,
  };
}

// Ends the gig for good, keeping the total. Used when the Pause button is switched off.
export function stop(session, now) {
  return { ...session, events: [...session.events, { t: Math.floor(now), type: 'stop' }] };
}

// ---------- Fixing start and stop times ("I forgot to tap Start") ----------

const atClock = (time, near) => {
  const hm = parseTime(time);
  if (!hm) return null;
  const d = new Date(near);
  d.setHours(hm[0], hm[1], 0, 0);
  return d;
};
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// Correcting a time means the moment with that clock time nearest the one being
// corrected, so 11:50 PM next to 12:10 AM is the evening before.
export function nearestAt(time, near) {
  const d = atClock(time, near);
  if (!d) return null;
  if (d.getTime() - near > 12 * HOUR) d.setDate(d.getDate() - 1);
  else if (near - d.getTime() > 12 * HOUR) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// The most recent moment at or before `now` with that clock time ("started at 7:00").
export function latestAt(time, now) {
  const d = atClock(time, now);
  if (!d) return null;
  if (d.getTime() > now) d.setDate(d.getDate() - 1);
  return d.getTime();
}

// The taps that can be corrected: the Start that began the gig, and the Stop that ended
// it (or, with the Pause button on, the latest Pause).
export function editableTimes(session) {
  const events = session.events;
  const start = events[0]?.type === 'resume' ? events[0] : null;
  let endIndex = events.findIndex((e) => e.type === 'stop');
  if (endIndex === -1 && events.at(-1)?.type === 'pause') endIndex = events.length - 1;
  return { start, end: endIndex === -1 ? null : events[endIndex], endIndex };
}

const tapWord = (type) => ({ stop: 'stop', pause: 'pause', resume: 'resume' })[type] ?? 'change';

// Already working: start the meter from a past time today (or last night).
export function startAt(session, time, now) {
  const t = latestAt(time, now);
  if (t == null) return { error: 'Pick the time you started.' };
  if (now - t > 12 * HOUR) return { error: 'That’s more than 12 hours ago. Check the time.' };
  return { session: { ...session, events: [{ t, type: 'resume' }] } };
}

export function setStartTime(session, time, now) {
  const { start } = editableTimes(session);
  if (!start) return { error: 'This gig’s start can’t be changed here.' };
  const t = nearestAt(time, start.t);
  if (t == null) return { error: 'Pick the time you started.' };
  if (t > now) return { error: 'The start can’t be in the future.' };
  const next = session.events[1];
  if (next && t > next.t) return { error: `The start can’t be after the ${tapWord(next.type)} at ${clock(next.t)}.` };
  return { session: { ...session, events: [{ ...start, t }, ...session.events.slice(1)] } };
}

export function setEndTime(session, time, now) {
  const { end, endIndex } = editableTimes(session);
  if (!end) return { error: 'This gig hasn’t been stopped.' };
  const word = tapWord(end.type);
  const t = nearestAt(time, end.t);
  if (t == null) return { error: `Pick the time of the ${word}.` };
  if (t > now) return { error: `The ${word} can’t be in the future.` };
  const prev = session.events[endIndex - 1];
  if (prev && t < prev.t) {
    const what = endIndex - 1 === 0 && prev.type === 'resume' ? 'start' : tapWord(prev.type);
    return { error: `The ${word} can’t be before the ${what} at ${clock(prev.t)}.` };
  }
  // A scheduled gig that started on its own has no Start tap; its start is the schedule's.
  const begun = history({ ...session, events: session.events.slice(0, endIndex) }, now)[0];
  if (!prev && begun && t < begun.t) return { error: `The ${word} can’t be before the gig started at ${clock(begun.t)}.` };
  // Anything tapped after a Stop never counted, so it goes.
  return { session: { ...session, events: [...session.events.slice(0, endIndex), { ...end, t }] } };
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
