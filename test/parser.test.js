const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseReport, parseShipLog, isShipLog, normInvoice } = require('../src/parser');

const SAMPLE = path.join('/home/hatch/workspace/user/files/FexEx_Report.txt');
const SHIP_LOG = path.join('/home/hatch/workspace/user/files/Ship_log.txt');

test('parses the sample report: 101 tracking numbers minus 3 B/Ctest = 98 records', () => {
  const r = parseReport(fs.readFileSync(SAMPLE, 'utf8'), 'FexEx_Report.txt');
  assert.equal(r.records.length, 98);
  assert.equal(r.reportStart, '2026-10-07');
  assert.equal(r.reportEnd, '2026-10-08');
});

test('first record fields', () => {
  const r = parseReport(fs.readFileSync(SAMPLE, 'utf8'), 'x');
  const rec = r.records[0];
  assert.equal(rec.tracking_number, '520173574363'); // '*' stripped
  assert.equal(rec.customer_code, 'S0124295');
  assert.equal(rec.contact_name, '');
  assert.equal(rec.company_name, 'Setpoint Systems Corporation');
  assert.equal(rec.city, 'LITTLETON');
  assert.equal(rec.state, 'CO');
  assert.equal(rec.country, 'United States');
  assert.equal(rec.postal_code, '80120');
  assert.equal(rec.service_type, 'FedEx International Economy');
  assert.equal(rec.packages, 1);
  assert.equal(rec.weight_lbs, 1);
  assert.equal(rec.customs_value, 140.98);
  assert.equal(rec.invoice_number, '9199189759');
  assert.equal(rec.raw_reference, 'B/C9199189759');
});

test('contact name captured when present', () => {
  const r = parseReport(fs.readFileSync(SAMPLE, 'utf8'), 'x');
  const rec = r.records.find((x) => x.tracking_number === '520173574146');
  assert.equal(rec.contact_name, 'Joe Flores');
  assert.equal(rec.company_name, 'Lonestar Electric Industrial Supply');
});

test('UK address parses', () => {
  const r = parseReport(fs.readFileSync(SAMPLE, 'utf8'), 'x');
  const rec = r.records.find((x) => x.country === 'United Kingdom');
  assert.ok(rec);
  assert.equal(rec.postal_code, 'DE119FX');
  assert.equal(rec.duties_taxes, 'Recipient');
});

test('grand totals footer is not parsed as a record', () => {
  const r = parseReport(fs.readFileSync(SAMPLE, 'utf8'), 'x');
  assert.ok(!r.records.some((x) => x.description.includes('GRAND')));
  assert.ok(r.records.every((x) => x.tracking_number));
});

test('B/Ctest rows are skipped', () => {
  const r = parseReport(fs.readFileSync(SAMPLE, 'utf8'), 'x');
  assert.ok(!r.records.some((x) => /test/i.test(x.raw_reference)));
});

test('normInvoice', () => {
  assert.equal(normInvoice('9199189759'), '9199189759');
  assert.equal(normInvoice('RMA #75771'), 'RMA75771');
  assert.equal(normInvoice('test'), 'TEST');
});

test('record split across a page break still parses', () => {
  // A0123414's 4th package spans pages 1-2 in the sample; it must be complete.
  const r = parseReport(fs.readFileSync(SAMPLE, 'utf8'), 'x');
  const rec = r.records.find((x) => x.tracking_number === '520173574102');
  assert.ok(rec);
  assert.equal(rec.company_name, 'ALBIREO ENERGY');
  assert.equal(rec.city, 'CHELMSFORD');
  assert.equal(rec.invoice_number, '9199189691');
});

test('isShipLog detects the shipping log, rejects the shipment report', () => {
  assert.ok(isShipLog(fs.readFileSync(SHIP_LOG, 'utf8')));
  assert.ok(!isShipLog(fs.readFileSync(SAMPLE, 'utf8')));
});

test('parseShipLog: 320 data rows from the 8-page sample', () => {
  const rows = parseShipLog(fs.readFileSync(SHIP_LOG, 'utf8'));
  assert.equal(rows.length, 320);
  assert.ok(rows.every((r) => /^\d{12}$/.test(r.tracking_number)));
  assert.ok(rows.every((r) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(r.ship_date)));
});

test('parseShipLog: first and last rows', () => {
  const rows = parseShipLog(fs.readFileSync(SHIP_LOG, 'utf8'));
  assert.equal(rows[0].tracking_number, '520173572279');
  assert.equal(rows[0].ship_date, '2026-10-01 06:52');
  const last = rows[rows.length - 1];
  assert.equal(last.tracking_number, '520173572496');
  assert.equal(last.ship_date, '2026-10-01 11:46');
});

test('parseShipLog: skips headers, subtotals, wrapped references, blanks', () => {
  const rows = parseShipLog(fs.readFileSync(SHIP_LOG, 'utf8'));
  const nums = new Set(rows.map((r) => r.tracking_number));
  assert.ok(![...nums].some((t) => /tot|page/i.test(t)));
  // no duplicate tracking numbers in this sample
  assert.equal(nums.size, rows.length);
});

test('parseShipLog: row with wrapped B/C reference still parses', () => {
  const rows = parseShipLog(fs.readFileSync(SHIP_LOG, 'utf8'));
  const r = rows.find((x) => x.tracking_number === '520173572522');
  assert.ok(r);
  assert.equal(r.ship_date, '2026-10-01 13:00');
});
