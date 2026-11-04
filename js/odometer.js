// Rolling-digit money display. Each digit is a vertical strip of 0–9 twice over;
// it slides to its new value, and 9→0 rolls forward into the second set and then
// snaps back to the first without animating, like a real odometer wheel.

const CELLS = '01234567890123456789';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

function createRoller() {
  const node = el('span', 'od-digit');
  const strip = el('span', 'od-strip');
  for (const ch of CELLS) strip.append(el('span', 'od-cell', ch));
  node.append(strip);
  let cell = 0;

  const place = (c, animate) => {
    cell = c;
    strip.style.transition = animate ? '' : 'none';
    strip.style.transform = `translateY(${-c * 5}%)`; // each cell is 1/20 of the strip
    if (!animate) {
      void strip.offsetHeight; // apply the jump before transitions come back on
      strip.style.transition = '';
    }
  };

  strip.addEventListener('transitionend', () => {
    if (cell >= 10) place(cell - 10, false);
  });

  return {
    node,
    to(digit, animate) {
      if (!animate) return place(digit, false);
      if (cell >= 10) place(cell - 10, false); // a wrap was interrupted; settle it first
      if (digit !== cell) place(digit > cell ? digit : digit + 10, true);
    },
  };
}

export function createOdometer(root) {
  const dollarsEl = el('span', 'od-dollars');
  const centsEl = el('span', 'od-cents');
  const dollarRollers = []; // index 0 is the ones place
  const centRollers = [createRoller(), createRoller()];
  centsEl.append(centRollers[0].node, centRollers[1].node);
  root.replaceChildren(el('span', 'od-sign', '$'), dollarsEl, el('span', 'od-dot', '.'), centsEl);

  // Returns true when a new whole dollar was just earned.
  function set(cents, animate) {
    const dollars = Math.floor(cents / 100);
    const digits = String(dollars).split('').reverse();

    if (digits.length !== dollarRollers.length) {
      while (dollarRollers.length < digits.length) dollarRollers.push(createRoller());
      dollarRollers.length = digits.length;
      const parts = [];
      for (let i = dollarRollers.length - 1; i >= 0; i--) {
        parts.push(dollarRollers[i].node);
        if (i > 0 && i % 3 === 0) parts.push(el('span', 'od-comma', ','));
      }
      dollarsEl.replaceChildren(...parts);
    }

    digits.forEach((d, i) => dollarRollers[i].to(Number(d), animate));
    centRollers[0].to(Math.floor((cents % 100) / 10), animate);
    centRollers[1].to(cents % 10, animate);

    const newDollar = animate && set.lastDollars != null && dollars > set.lastDollars;
    set.lastDollars = dollars;
    return newDollar;
  }

  return { set };
}
