/* Parser for FedEx Shipment Report .txt exports.
 *
 * Layout: paginated plain text, two fixed columns. The right column starts at
 * character index 66 and carries labeled fields (Tracking #:, Packages:, ...);
 * the left column carries the matching detail (customer code, contact, company,
 * address, city/state, country/postal, description). Records may span page
 * breaks; page headers/footers are stripped first.
 */
const COL = 66;

const KNOWN_LABELS = [
  'Tracking #:',
  'Packages:',
  'Total Weight:',
  'PaymentType:',
  'Carriage Value:',
  'Customs Value:',
  'Duties and Taxes:',
  'Reference:',
  'Dept./Notes:',
];

function splitCityState(s) {
  const parts = s.split(/\s{2,}/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const state = parts.pop();
    return { city: parts.join(' '), state };
  }
  return { city: s.trim(), state: '' };
}

function splitCountryPostal(s) {
  const parts = s.split(/\s{2,}/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const postal = parts.pop();
    return { country: parts.join(' '), postal_code: postal };
  }
  return { country: s.trim(), postal_code: '' };
}

function buildRecord(pairs) {
  const rec = {
    tracking_number: '',
    customer_code: '',
    contact_name: '',
    company_name: '',
    address_line1: '',
    address_line2: '',
    city: '',
    state: '',
    country: '',
    postal_code: '',
    service_type: '',
    packages: null,
    weight_lbs: null,
    payment_type: '',
    customs_value: null,
    customs_currency: 'USD',
    duties_taxes: '',
    description: '',
    raw_reference: '',
    invoice_number: '',
    dept_notes: '',
  };
  const descParts = [];
  let serviceSet = false;

  pairs.forEach(({ left, right }) => {
    if (/^Tracking #:/.test(right)) {
      rec.tracking_number = right
        .replace(/^Tracking #:\s*/, '')
        .replace(/^[*\s]+/, '')
        .trim();
      rec.customer_code = left;
      return;
    }
    if (/^Packages:/.test(right)) {
      rec.packages = parseInt(right.replace(/^Packages:\s*/, ''), 10) || null;
      rec.company_name = left;
      return;
    }
    if (/^Total Weight:/.test(right)) {
      rec.weight_lbs = parseFloat(right.replace(/^Total Weight:\s*/, '')) || null;
      rec.address_line1 = left;
      return;
    }
    if (/^PaymentType:/.test(right)) {
      rec.payment_type = right.replace(/^PaymentType:\s*/, '').trim();
      rec.address_line2 = left;
      return;
    }
    if (/^Carriage Value:/.test(right)) {
      const { city, state } = splitCityState(left);
      rec.city = city;
      rec.state = state;
      return;
    }
    if (/^Customs Value:/.test(right)) {
      const m = right.match(/^Customs Value:\s*([\d.]+)\s*([A-Z]{3})?/);
      if (m) {
        rec.customs_value = parseFloat(m[1]);
        if (m[2]) rec.customs_currency = m[2];
      }
      const { country, postal_code } = splitCountryPostal(left);
      rec.country = country;
      rec.postal_code = postal_code;
      return;
    }
    if (/^Duties and Taxes:/.test(right)) {
      rec.duties_taxes = right.replace(/^Duties and Taxes:\s*/, '').trim();
      const dm = left.match(/^Description \(\d+\)\s*:\s*(.*)$/);
      descParts.push((dm ? dm[1] : left).trim());
      return;
    }
    if (/^Reference:/.test(right)) {
      rec.raw_reference = right.replace(/^Reference:\s*/, '').trim();
      rec.invoice_number = rec.raw_reference.replace(/^b\/c/i, '').trim();
      if (left) descParts.push(left);
      return;
    }
    if (/^Dept\.\/Notes:/.test(right)) {
      rec.dept_notes = right.replace(/^Dept\.\/Notes:\s*/, '').trim();
      if (left) descParts.push(left);
      return;
    }
    // Unlabeled right cell: the service-type row (always right after Tracking).
    if (!serviceSet) {
      rec.service_type = right.replace(/®/g, '').trim();
      rec.contact_name = left;
      serviceSet = true;
      return;
    }
    if (left) descParts.push(left);
  });

  rec.description = joinDescParts(descParts);
  return rec;
}

/* Join description fragments. The report wraps mid-word ("sy"+"tems"), so a
   fragment ending in a short lowercase piece followed by a lowercase fragment
   is glued without a space; everything else joins with a space. */
function joinDescParts(parts) {
  let out = '';
  for (const p of parts) {
    if (!p) continue;
    if (!out) {
      out = p;
      continue;
    }
    const prevWord = out.split(/\s+/).pop() || '';
    if (/^[a-z]{1,3}$/.test(prevWord) && /^[a-z]/.test(p)) out += p;
    else out += ' ' + p;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/* Normalized invoice number for search: uppercased, punctuation stripped. */
function normInvoice(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function isTestRecord(rec) {
  return normInvoice(rec.invoice_number) === 'TEST';
}

function parseReport(text, filename) {
  const lines = String(text).split('\n');
  const records = [];
  let current = null;
  let reportStart = null;
  let reportEnd = null;
  let afterHeader = 0;

  function pushCurrent() {
    if (current && current.length) {
      const rec = buildRecord(current);
      if (rec.tracking_number && !isTestRecord(rec)) records.push(rec);
    }
    current = null;
  }

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');

    const hm = line.match(
      /^(\d{2})\/(\d{2})\/(\d{4}) - (\d{2})\/(\d{2})\/(\d{4})\s+Shipment Report/,
    );
    if (hm) {
      if (!reportStart) {
        reportStart = `${hm[3]}-${hm[1]}-${hm[2]}`;
        reportEnd = `${hm[6]}-${hm[4]}-${hm[5]}`;
      }
      afterHeader = 2; // blank line + bare account-number line follow
      continue;
    }
    if (afterHeader > 0) {
      afterHeader--;
      // Only skip what looks like the account block; anything else is content.
      if (!line.trim() || /^\d{8,}$/.test(line.trim())) continue;
    }
    if (!line.trim()) continue;

    const left = line.slice(0, COL).trim();
    const right = line.slice(COL).trim();
    if (!left && !right) continue;

    // Report summary footer: nothing after this is shipment data.
    if (/^(GRAND TOTALS|SUBTOTALS|TOTALS)\b/.test(left)) break;

    if (/^Tracking #:/.test(right)) pushCurrent(), (current = []);
    if (!current) continue; // stray lines before the first record
    current.push({ left, right });
  }
  pushCurrent();

  return {
    filename: filename || '',
    reportStart,
    reportEnd,
    records,
  };
}

/* Parser for FedEx Shipping Log .txt exports.
 *
 * Layout: paginated plain text, one row per package:
 *   MM/DD/YYYY HH:MM <12-digit tracking#> OutBnd <service> ...
 * Page headers ("Shipping Log", "Page N"), the column header line
 * ("Date  Time  Tracking# ..."), "Tot Pkg:" subtotal lines, blank lines and
 * wrapped B/C reference lines are skipped — only the leading date/time and
 * tracking number of each row are read. Returns
 * [{ tracking_number, ship_date: 'YYYY-MM-DD HH:MM' }, ...].
 */
const SHIP_LOG_ROW = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})\s+\*?(\d{12})\b/;

function isShipLog(text) {
  return /Shipping Log/.test(text);
}

function parseShipLog(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(SHIP_LOG_ROW);
    if (!m) continue;
    const [, mm, dd, yyyy, hh, mi, tracking] = m;
    rows.push({
      tracking_number: tracking,
      ship_date: `${yyyy}-${mm}-${dd} ${hh}:${mi}`,
    });
  }
  return rows;
}

module.exports = { parseReport, buildRecord, normInvoice, isTestRecord, parseShipLog, isShipLog, COL };
