/* Database layer: Postgres connection, schema init, batch upsert, search. */
const { Pool } = require('pg');

/* Separate fields (not a URL) so passwords with special characters work. */
const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        user: process.env.DB_USER || 'shipmentsearch',
        password: process.env.DB_PASSWORD || 'changeme',
        database: process.env.DB_NAME || 'shipmentsearch',
      },
);

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE IF NOT EXISTS shipments (
  id BIGSERIAL PRIMARY KEY,
  tracking_number TEXT NOT NULL UNIQUE,
  customer_code TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL DEFAULT '',
  company_name TEXT NOT NULL DEFAULT '',
  address_line1 TEXT NOT NULL DEFAULT '',
  address_line2 TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  postal_code TEXT NOT NULL DEFAULT '',
  service_type TEXT NOT NULL DEFAULT '',
  packages INTEGER,
  weight_lbs DOUBLE PRECISION,
  payment_type TEXT NOT NULL DEFAULT '',
  customs_value DOUBLE PRECISION,
  customs_currency TEXT NOT NULL DEFAULT 'USD',
  duties_taxes TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  raw_reference TEXT NOT NULL DEFAULT '',
  invoice_number TEXT NOT NULL DEFAULT '',
  invoice_norm TEXT NOT NULL DEFAULT '',
  dept_notes TEXT NOT NULL DEFAULT '',
  report_start DATE,
  report_end DATE,
  source_file TEXT NOT NULL DEFAULT '',
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ship_tracking_trgm ON shipments USING gin (tracking_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_ship_customer_trgm ON shipments USING gin (customer_code gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_ship_company_trgm ON shipments USING gin (company_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_ship_contact_trgm ON shipments USING gin (contact_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_ship_invoice_trgm ON shipments USING gin (invoice_norm gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_ship_service ON shipments (service_type);
CREATE INDEX IF NOT EXISTS idx_ship_report_start ON shipments (report_start);
`;

async function init() {
  await pool.query(SCHEMA);
  await pool.query('ALTER TABLE shipments ADD COLUMN IF NOT EXISTS ship_date TIMESTAMP');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_ship_ship_date ON shipments (ship_date)');
}

const COLUMNS = [
  'tracking_number',
  'customer_code',
  'contact_name',
  'company_name',
  'address_line1',
  'address_line2',
  'city',
  'state',
  'country',
  'postal_code',
  'service_type',
  'packages',
  'weight_lbs',
  'payment_type',
  'customs_value',
  'customs_currency',
  'duties_taxes',
  'description',
  'raw_reference',
  'invoice_number',
  'invoice_norm',
  'dept_notes',
  'report_start',
  'report_end',
  'source_file',
];

/* Batch upsert by tracking_number. Returns { inserted, updated }. */
async function upsertShipments(rows) {
  if (!rows.length) return { inserted: 0, updated: 0 };
  const BATCH = 500;
  let inserted = 0;
  let updated = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const values = [];
    const placeholders = batch.map((r, bi) => {
      const start = bi * COLUMNS.length + 1;
      COLUMNS.forEach((c) => values.push(r[c] ?? null));
      return `(${COLUMNS.map((_, ci) => `$${start + ci}`).join(',')})`;
    });
    const updates = COLUMNS.filter((c) => c !== 'tracking_number')
      .map((c) => `${c} = EXCLUDED.${c}`)
      .join(',');
    const sql = `INSERT INTO shipments (${COLUMNS.join(',')}) VALUES ${placeholders.join(',')}
      ON CONFLICT (tracking_number) DO UPDATE SET ${updates}, imported_at = now()
      RETURNING (xmax = 0) AS was_inserted`;
    const res = await pool.query(sql, values);
    for (const row of res.rows) {
      if (row.was_inserted) inserted++;
      else updated++;
    }
  }
  return { inserted, updated };
}

/* Set ship_date from shipping-log rows. Matches by tracking_number;
   numbers not in the database are skipped. Returns { updated, notFound }. */
async function updateShipDates(rows) {
  let updated = 0;
  let notFound = 0;
  for (const r of rows) {
    const res = await pool.query(
      'UPDATE shipments SET ship_date = $2::timestamp WHERE tracking_number = $1',
      [r.tracking_number, r.ship_date],
    );
    if (res.rowCount > 0) updated++;
    else notFound++;
  }
  return { updated, notFound };
}

/* Normalize a user query for the digit/code fields. */
function normQuery(q) {
  return String(q || '')
    .trim()
    .toUpperCase()
    .replace(/^B\/C/, '')
    .replace(/[*#\s-]/g, '');
}

async function search({ q, service, period, page = 1, pageSize = 50 }) {
  const qn = normQuery(q);
  const qr = String(q || '').trim();
  const whereParts = [];
  const whereParams = [];
  if (qn) {
    whereParams.push(qn, qr);
    const a = whereParams.length - 1;
    const b = whereParams.length;
    whereParts.push(`(tracking_number ILIKE '%' || $${a} || '%'
      OR invoice_norm ILIKE '%' || $${a} || '%'
      OR customer_code ILIKE '%' || $${a} || '%'
      OR company_name ILIKE '%' || $${b} || '%'
      OR contact_name ILIKE '%' || $${b} || '%')`);
  }
  if (service) {
    whereParams.push(service);
    whereParts.push(`service_type = $${whereParams.length}`);
  }
  if (period) {
    whereParams.push(period);
    whereParts.push(`report_start = $${whereParams.length}`);
  }
  const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS total FROM shipments ${whereSql}`,
    whereParams,
  );
  const total = countRes.rows[0].total;
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeSize = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 50));
  const offset = (safePage - 1) * safeSize;
  // List query puts qn at $1 for the relevance ORDER BY; shift where params by 1.
  const listWhere = whereSql.replace(/\$(\d+)/g, (_m, n) => `$${parseInt(n, 10) + 1}`);
  const listParams = [qn, ...whereParams, safeSize, offset];
  const listRes = await pool.query(
    `SELECT id, tracking_number, customer_code, contact_name, company_name,
       city, state, country, service_type, packages, weight_lbs,
       customs_value, customs_currency, invoice_number, raw_reference,
       report_start, report_end,
       to_char(ship_date, 'YYYY-MM-DD HH24:MI') AS ship_date
     FROM shipments ${listWhere}
     ORDER BY
       CASE
         WHEN $1 <> '' AND tracking_number = $1 THEN 0
         WHEN $1 <> '' AND invoice_norm = $1 THEN 1
         WHEN $1 <> '' AND customer_code ILIKE $1 || '%' THEN 2
         ELSE 3
       END,
       imported_at DESC
     LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
    listParams,
  );
  return { total, page: safePage, pageSize: safeSize, rows: listRes.rows };
}

async function getById(id) {
  const res = await pool.query(
    `SELECT *, to_char(ship_date, 'YYYY-MM-DD HH24:MI') AS ship_date_fmt
     FROM shipments WHERE id = $1`,
    [id],
  );
  const row = res.rows[0] || null;
  if (row) {
    row.ship_date = row.ship_date_fmt;
    delete row.ship_date_fmt;
  }
  return row;
}

async function listPeriods() {
  const res = await pool.query(
    `SELECT report_start, report_end, COUNT(*)::int AS shipments,
       MIN(source_file) AS sample_file
     FROM shipments
     WHERE report_start IS NOT NULL
     GROUP BY report_start, report_end
     ORDER BY report_start DESC`,
  );
  return res.rows;
}

async function stats() {
  const res = await pool.query(
    'SELECT COUNT(*)::int AS shipments FROM shipments',
  );
  return res.rows[0];
}

module.exports = {
  pool,
  init,
  upsertShipments,
  updateShipDates,
  search,
  getById,
  listPeriods,
  stats,
  normQuery,
  COLUMNS,
};
