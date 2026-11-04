import { z } from 'zod';

/** Runs a zod schema over form input and returns { data } or { errors: { field: message } } (first message per field). */
export function parseInput(schema, input) {
  const result = schema.safeParse(input ?? {});
  if (result.success) return { data: result.data, errors: null };
  const errors = {};
  for (const issue of result.error.issues) {
    const key = issue.path[0] ?? '_';
    if (!(key in errors)) errors[key] = issue.message;
  }
  return { data: null, errors };
}

/** A checkbox: present means true. */
export const checkbox = z.preprocess((v) => v === '1' || v === 'on' || v === 'true' || v === true, z.boolean());

// Bidirectional-text control characters can reorder what a reader sees ("trojan source" style tricks), so they are removed.
// Zero-width joiners are kept: Indian-language names and emoji need them.
const BIDI = [
  [0x200e, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
]
  .map(([a, b]) => `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`)
  .join('');
const STRIP_SINGLE_LINE = new RegExp(`[\\u0000-\\u001f\\u007f${BIDI}]`, 'g');
const STRIP_MULTI_LINE = new RegExp(`[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f${BIDI}]`, 'g');

/** Text from a form: trimmed, control characters removed, newlines kept only when allowed. */
export function cleanText({ min = 0, max, multiline = false, label = 'This field' }) {
  return z
    .string({ error: `${label} is required.` })
    .transform((s) => {
      const stripped = s.normalize('NFC').replace(multiline ? STRIP_MULTI_LINE : STRIP_SINGLE_LINE, '');
      return (multiline ? stripped.replace(/\r\n?/g, '\n') : stripped.replace(/\s+/g, ' ')).trim();
    })
    .pipe(
      z
        .string()
        .min(min, min === 1 ? `${label} is required.` : `${label} must be at least ${min} characters.`)
        .max(max, `${label} must be at most ${max} characters.`),
    );
}

export const emailSchema = z
  .string({ error: 'Enter your email address.' })
  .trim()
  .toLowerCase()
  .max(254, 'That email address is too long.')
  .regex(/^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/, 'Enter a valid email address.');

export const RESERVED_HANDLES = new Set(
  'admin administrator root system support help security staff moderator mod official team vidverse null undefined api www mail ftp studio settings legal login logout signup watch results trending history library subscriptions about contact privacy terms billing payments abuse postmaster webmaster'.split(' '),
);

export const handleSchema = z
  .string({ error: 'Choose a handle.' })
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_.-]{2,29}$/, 'Use 3 to 30 letters, numbers, dots, dashes or underscores, starting with a letter or number.')
  .refine((h) => !RESERVED_HANDLES.has(h), 'That handle is reserved.')
  .refine((h) => !/^(deleted-)/.test(h), 'That handle is reserved.');
