#!/usr/bin/env node
/**
 * A back-of-envelope cost model for running the site: how much video you deliver, what that costs, and how
 * much advertising has to pay per 1,000 views just to break even.
 *
 *     npm run economics                                  # the defaults below
 *     npm run economics -- --views 250000 --egress 0.6   # change any input
 *     npm run economics -- --adsense-rpm 45 --tips 20000 # compare with an income guess of your own
 *     npm run economics -- --json
 *
 * Every default is a PLACEHOLDER, not a quote and not a forecast. Replace prices with your provider's real
 * price list, and the AdSense figure with the "RPM" shown in your own AdSense reports once you have some.
 * The cost of delivering video is usually the number that decides whether a video site can pay for itself.
 */
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

export const DEFAULTS = Object.freeze({
  views: 100_000, // video views per month
  minutes: 4, // average minutes watched per view
  bitrate: 1.5, // average Mbps actually streamed (a 480p-720p mix)
  egress: 1, // rupees per GB delivered to viewers
  storedGb: 100, // GB of video kept on disk, all sizes included
  storage: 2, // rupees per GB per month
  server: 2500, // rupees per month for the server and database
  tips: 0, // total tips sent by viewers in the month, in rupees
  feeBps: 1000, // the platform fee on tips (PLATFORM_FEE_BPS), in basis points
  gatewayBps: 250, // what the payment provider keeps, in basis points: check your plan
  adsenseRpm: null, // rupees AdSense pays per 1,000 views: leave empty to see the break-even figure instead
});

const GB_PER_MBPS_HOUR = 3600 / 8 / 1000; // 1 Mbps for an hour = 0.45 GB

const round2 = (n) => Math.round(n * 100) / 100;

export function model(input = {}) {
  const i = { ...DEFAULTS, ...input };
  for (const [key, value] of Object.entries(i)) {
    if (value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${key} must be a number that is zero or more`);
  }
  if (i.views <= 0) throw new Error('views must be more than zero');
  if (i.feeBps > 10_000 || i.gatewayBps > 10_000) throw new Error('fee percentages cannot be above 100%');

  const thousands = i.views / 1000;
  const hours = (i.views * i.minutes) / 60;
  const gb = hours * i.bitrate * GB_PER_MBPS_HOUR;
  const cost = { egress: gb * i.egress, storage: i.storedGb * i.storage, server: i.server };
  const totalCost = cost.egress + cost.storage + cost.server;
  const tipsKept = (i.tips * (i.feeBps - i.gatewayBps)) / 10_000; // what the site keeps of tips after the provider's cut (can be negative)
  const adsNeeded = Math.max(0, totalCost - tipsKept);
  const out = {
    inputs: i,
    hoursWatched: round2(hours),
    gbDelivered: round2(gb),
    cost: { egress: round2(cost.egress), storage: round2(cost.storage), server: round2(cost.server), total: round2(totalCost) },
    costPer1000Views: round2(totalCost / thousands),
    tipsKept: round2(tipsKept),
    breakEvenRpm: round2(adsNeeded / thousands),
    result: null,
  };
  if (i.adsenseRpm !== null) {
    const adRevenue = thousands * i.adsenseRpm;
    out.result = { adRevenue: round2(adRevenue), profit: round2(adRevenue + tipsKept - totalCost) };
  }
  return out;
}

const inr = (n) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export function report(m) {
  const { inputs: i } = m;
  const lines = [
    'COST MODEL: placeholders in, arithmetic out. Not a forecast.',
    '',
    `Views per month            ${i.views.toLocaleString('en-IN')}   (${i.minutes} min watched each, ${i.bitrate} Mbps streamed)`,
    `Hours watched              ${m.hoursWatched.toLocaleString('en-IN')}`,
    `Video delivered            ${m.gbDelivered.toLocaleString('en-IN')} GB`,
    '',
    `Delivery   ${inr(m.cost.egress).padStart(14)}   at ${inr(i.egress)} per GB`,
    `Storage    ${inr(m.cost.storage).padStart(14)}   ${i.storedGb} GB at ${inr(i.storage)} per GB-month`,
    `Server     ${inr(m.cost.server).padStart(14)}`,
    `Total      ${inr(m.cost.total).padStart(14)}   = ${inr(m.costPer1000Views)} per 1,000 views`,
    '',
  ];
  if (i.tips > 0) lines.push(`Tips: ${inr(i.tips)} sent; the site keeps ${inr(m.tipsKept)} after the provider's cut (fee ${i.feeBps / 100}% minus ${i.gatewayBps / 100}%).`, '');
  lines.push(`Advertising must pay at least ${inr(m.breakEvenRpm)} per 1,000 views to cover these costs.`);
  if (m.result) {
    lines.push(`With ${inr(i.adsenseRpm)} per 1,000 views: ad income ${inr(m.result.adRevenue)}, ${m.result.profit >= 0 ? 'left over' : 'short by'} ${inr(Math.abs(m.result.profit))} this month.`);
  } else {
    lines.push('Compare that with the RPM in your AdSense reports (pass it as --adsense-rpm). Do not use anyone else’s number: it depends on your audience, topics and country.');
  }
  lines.push(
    '',
    'What moves it most: delivery price per GB (object storage with free delivery, or a cheap CDN), the bitrate you stream,',
    'and how long people watch. AdSense earnings cannot be shared with creators without Google’s written permission.',
  );
  return lines.join('\n');
}

const FLAGS = {
  views: 'views', minutes: 'minutes', bitrate: 'bitrate', egress: 'egress', 'stored-gb': 'storedGb', storage: 'storage',
  server: 'server', tips: 'tips', 'fee-bps': 'feeBps', 'gateway-bps': 'gatewayBps', 'adsense-rpm': 'adsenseRpm',
};

function main() {
  const { values } = parseArgs({ options: { ...Object.fromEntries(Object.keys(FLAGS).map((k) => [k, { type: 'string' }])), json: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log(`Usage: npm run economics -- [--${Object.keys(FLAGS).join(' N] [--')} N] [--json]\nDefaults: ${JSON.stringify(DEFAULTS)}`);
    return;
  }
  const input = {};
  for (const [flag, key] of Object.entries(FLAGS)) {
    if (values[flag] === undefined) continue;
    const n = Number(values[flag]);
    if (values[flag].trim() === '' || !Number.isFinite(n)) throw new Error(`--${flag} must be a number`);
    input[key] = n;
  }
  const m = model(input);
  console.log(values.json ? JSON.stringify(m, null, 2) : report(m));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
