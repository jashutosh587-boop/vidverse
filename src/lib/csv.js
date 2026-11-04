import { toDecimal } from './money.js';

// Spreadsheet programs run a cell as a formula when it starts with one of these characters. Names and notes come from
// people, so a text cell that starts with one gets a leading apostrophe and is shown as plain text instead.
const FORMULA_START = /^[=+\-@\t\r]/;

/** A text value as one CSV cell. */
export function csvText(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** An amount in minor units as one CSV cell ("-90.00"). Written directly: it is a number, never a formula. */
export const csvMoney = (minor) => toDecimal(minor);

export const csvLine = (cells) => `${cells.join(',')}\r\n`;
