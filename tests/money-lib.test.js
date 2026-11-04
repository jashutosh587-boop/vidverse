import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { feeOf, splitTip, allocate, parseAmount, toDecimal } from '../src/lib/money.js';
import { csvText, csvMoney, csvLine } from '../src/lib/csv.js';
import { parsePayoutDetails } from '../src/lib/payout-details.js';

describe('fees', () => {
  test('fee plus net always equals the amount, for every amount and fee tried', () => {
    for (const bps of [0, 1, 250, 1000, 1234, 3333, 5000, 10_000]) {
      for (let amount = 0; amount <= 3000; amount++) {
        const { fee, net } = splitTip(amount, bps);
        assert.equal(fee + net, amount, `${amount} at ${bps} bps`);
        assert.ok(fee >= 0 && net >= 0);
      }
    }
    for (const amount of [5_000_000, 123_456_789, Number.MAX_SAFE_INTEGER - 1]) {
      const { fee, net } = splitTip(amount, 1000);
      assert.equal(fee + net, amount);
    }
  });

  test('halves round up, to the nearest paisa', () => {
    assert.equal(feeOf(5, 1000), 1); // 0.5 paisa -> 1
    assert.equal(feeOf(4, 1000), 0); // 0.4 -> 0
    assert.equal(feeOf(15, 1000), 2); // 1.5 -> 2
    assert.equal(feeOf(10_000, 1000), 1000);
  });

  test('refuses nonsense instead of guessing', () => {
    for (const bad of [-1, 1.5, NaN, '100', null, undefined, Infinity]) assert.throws(() => feeOf(bad, 1000), RangeError);
    for (const bad of [-1, 10_001, 0.5, NaN]) assert.throws(() => feeOf(100, bad), RangeError);
  });
});

describe('allocate', () => {
  const total = (m) => [...m.values()].reduce((a, b) => a + b, 0);

  test('the parts add up to the pool exactly, whatever the weights', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let round = 0; round < 300; round++) {
      const n = 1 + Math.floor(rnd() * 12);
      const entries = Array.from({ length: n }, (_, i) => ({ key: `u${i}`, weight: Math.floor(rnd() * 1e9) }));
      const pool = Math.floor(rnd() * 5_000_000);
      const out = allocate(pool, entries);
      const anyWeight = entries.some((e) => e.weight > 0);
      assert.equal(total(out), anyWeight ? pool : 0, `round ${round}`);
    }
  });

  test('each share is within one paisa of the exact proportion', () => {
    const entries = [{ key: 'a', weight: 600_000 }, { key: 'b', weight: 300_000 }, { key: 'c', weight: 100_000 }];
    const out = allocate(1001, entries);
    assert.equal(total(out), 1001);
    for (const e of entries) assert.ok(Math.abs(out.get(e.key) - (1001 * e.weight) / 1_000_000) < 1);
  });

  test('the result does not depend on the order of the input', () => {
    const entries = Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, weight: 7 }));
    const a = allocate(100, entries);
    const b = allocate(100, [...entries].reverse());
    assert.deepEqual([...a].sort(), [...b].sort());
  });

  test('zero weights get nothing, an empty pool or no entries gives an empty result, bad input is refused', () => {
    assert.deepEqual([...allocate(100, [{ key: 'a', weight: 0 }, { key: 'b', weight: 5 }])], [['b', 100]]);
    assert.equal(allocate(0, [{ key: 'a', weight: 1 }]).size, 0);
    assert.equal(allocate(100, []).size, 0);
    assert.equal(allocate(100, [{ key: 'a', weight: 0 }]).size, 0);
    assert.throws(() => allocate(-1, []), RangeError);
    assert.throws(() => allocate(1.5, []), RangeError);
  });

  test('large weights do not lose precision', () => {
    const out = allocate(1_000_001, [{ key: 'a', weight: 2 ** 40 }, { key: 'b', weight: 2 ** 40 }, { key: 'c', weight: 2 ** 40 }]);
    assert.equal(total(out), 1_000_001);
    assert.ok([...out.values()].every((x) => x === 333_333 || x === 333_334 || x === 333_335));
  });
});

describe('amounts typed by people', () => {
  test('rupees become paise', () => {
    const cases = [['250', 25_000], ['250.5', 25_050], ['250.50', 25_050], ['1,250.00', 125_000], ['0.99', 99], ['  99  ', 9900], ['0', 0], ['100000000', 10_000_000_000]];
    for (const [input, want] of cases) assert.equal(parseAmount(input), want, input);
  });

  test('anything else is null', () => {
    for (const bad of ['', ' ', 'abc', '-5', '+5', '1e3', '12.345', '.50', '5.', '1 000', '₹100', '١٢٣', null, undefined, '1234567890']) assert.equal(parseAmount(bad), null, String(bad));
  });

  test('toDecimal writes exact two-place numbers', () => {
    assert.equal(toDecimal(0), '0.00');
    assert.equal(toDecimal(5), '0.05');
    assert.equal(toDecimal(99), '0.99');
    assert.equal(toDecimal(123_456), '1234.56');
    assert.equal(toDecimal(-90), '-0.90');
    assert.equal(toDecimal(-12_345), '-123.45');
    for (const bad of [1.5, NaN, Infinity, 2 ** 60]) assert.throws(() => toDecimal(bad), RangeError);
  });
});

describe('CSV cells', () => {
  test('text that a spreadsheet would run as a formula is shown as plain text', () => {
    for (const evil of ['=1+1', '+1', '-1', '@SUM(A1)', '=HYPERLINK("http://example.org")', '\t=1', '\r=1']) {
      const cell = csvText(evil);
      assert.ok(cell.startsWith("'") || cell.startsWith('"\''), `${JSON.stringify(evil)} -> ${JSON.stringify(cell)}`);
    }
  });

  test('commas, quotes and newlines are quoted the standard way', () => {
    assert.equal(csvText('a,b'), '"a,b"');
    assert.equal(csvText('say "hi"'), '"say ""hi"""');
    assert.equal(csvText('two\nlines'), '"two\nlines"');
    assert.equal(csvText(null), '');
    assert.equal(csvText(undefined), '');
    assert.equal(csvText('plain'), 'plain');
  });

  test('amounts are written as numbers and are never prefixed', () => {
    assert.equal(csvMoney(-9000), '-90.00');
    assert.equal(csvMoney(9000), '90.00');
    assert.equal(csvLine(['a', 'b']), 'a,b\r\n');
  });
});

describe('payout details', () => {
  test('a UPI address is checked, lowercased and shown back only in part', () => {
    const r = parsePayoutDetails({ method: 'upi', upi: ' Asha.Rao@OkBank ' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.details, { upi: 'asha.rao@okbank' });
    assert.equal(r.hint, 'as••••@okbank');
    assert.ok(!r.hint.includes('rao'));
  });

  test('bad UPI addresses are refused with a message', () => {
    for (const upi of ['', 'nobank', 'a@b', 'x y@bank', 'name@', '@bank', 'name@bank@bank', '<script>@bank']) {
      const r = parsePayoutDetails({ method: 'upi', upi });
      assert.equal(r.ok, false, upi);
      assert.ok(r.errors.upi);
    }
  });

  test('a bank account needs a holder, 9 to 18 digits and a real-looking IFSC', () => {
    const ok = parsePayoutDetails({ method: 'bank', holder: 'Asha K. Rao', account: '1234 5678 9012', ifsc: 'hdfc0001234' });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.details, { holder: 'Asha K. Rao', account: '123456789012', ifsc: 'HDFC0001234' });
    assert.equal(ok.hint, '••••9012 · HDFC0001234');
    const bad = parsePayoutDetails({ method: 'bank', holder: '1', account: '12ab', ifsc: 'HDFC1001234' });
    assert.equal(bad.ok, false);
    assert.deepEqual(Object.keys(bad.errors).sort(), ['account', 'holder', 'ifsc']);
  });

  test('an unknown or missing method is refused', () => {
    for (const method of [undefined, '', 'paypal', 'UPI', null]) assert.equal(parsePayoutDetails({ method, upi: 'asha@okbank' }).ok, false);
    assert.equal(parsePayoutDetails(null).ok, false);
  });
});
