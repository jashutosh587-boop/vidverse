import { z } from 'zod';
import { cleanText, checkbox } from './validate.js';

export const CATEGORIES = [
  ['entertainment', 'Entertainment'],
  ['education', 'Education'],
  ['music', 'Music'],
  ['gaming', 'Gaming'],
  ['tech', 'Science and technology'],
  ['comedy', 'Comedy'],
  ['news', 'News and commentary'],
  ['sports', 'Sports'],
  ['travel', 'Travel'],
  ['food', 'Food'],
  ['film', 'Film and animation'],
  ['howto', 'How-to and style'],
  ['blogs', 'People and blogs'],
  ['other', 'Other'],
];
export const CATEGORY_IDS = CATEGORIES.map(([id]) => id);
export const categoryLabel = (id) => CATEGORIES.find(([k]) => k === id)?.[1] ?? 'Other';

const TAG_RE = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} _-]{0,29}$/u;

/** "Cooking, #Pasta ,pasta" -> ['cooking', 'pasta']. At most 10 tags; ones that do not fit the rules are dropped. */
export function parseTags(input) {
  const seen = new Set();
  const out = [];
  for (const part of String(input ?? '').split(/[,\n]/)) {
    const tag = part.normalize('NFC').replace(/^#+/, '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!tag || !TAG_RE.test(tag) || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length === 10) break;
  }
  return out;
}

export const videoMetaSchema = z.object({
  title: cleanText({ min: 1, max: 100, label: 'Title' }),
  description: cleanText({ min: 0, max: 5000, multiline: true, label: 'Description' }).optional().default(''),
  tags: z.string().max(1000).optional().default('').transform(parseTags),
  category: z.enum(CATEGORY_IDS, { error: 'Choose a category.' }).default('other'),
  visibility: z.enum(['public', 'unlisted', 'private'], { error: 'Choose who can watch.' }).default('private'),
  comments_enabled: checkbox.default(true),
  has_paid_promotion: checkbox.default(false),
});
