import qrcode from 'qrcode-generator';
import { escapeHtml, raw } from './html.js';

/**
 * A QR code as inline SVG: one path, no style attributes, so it works under a strict Content-Security-Policy.
 * The colours are fixed (black on white) on purpose: scanners need the contrast whatever theme the page uses.
 * The markup is built here from numbers and a fixed template, which is why this file is allowed to call raw().
 */
export function qrSvg(text, { label = 'QR code', quiet = 4 } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text));
  qr.make();
  const n = qr.getModuleCount();
  const size = n + quiet * 2;
  let d = '';
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (!qr.isDark(y, x)) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < n && qr.isDark(y, x + run)) run++;
      d += `M${x + quiet} ${y + quiet}h${run}v1h-${run}z`;
      x += run;
    }
  }
  return raw(
    `<svg class="qr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="${escapeHtml(label)}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`,
  );
}
