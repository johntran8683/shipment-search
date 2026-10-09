/* Shipment Search — standalone website.
 * Upload FedEx shipment report .txt files, store them in Postgres,
 * and search by tracking number, customer, or invoice number. */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');

const db = require('./db');
const { parseReport, parseShipLog, isShipLog, normInvoice } = require('./parser');

const app = express();
const PORT = process.env.PORT || 3002;

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 500 * 1024 * 1024, files: 200 },
  fileFilter: (_req, file, cb) => {
    if (/\.txt$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Only .txt report files are accepted.'));
  },
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/stats', async (_req, res) => {
  try {
    res.json(await db.stats());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/periods', async (_req, res) => {
  try {
    res.json(await db.listPeriods());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Import one or more report .txt files. Deduplicates by tracking number,
   skips B/Ctest rows (handled by the parser). */
app.post('/api/import', upload.array('files', 200), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'No files uploaded.' });
  const summary = { files: [], totalRecords: 0, inserted: 0, updated: 0 };
  try {
    for (const f of files) {
      const text = fs.readFileSync(f.path, 'utf8');
      const parsed = parseReport(text, f.originalname);
      const rows = parsed.records.map((r) => ({
        ...r,
        invoice_norm: normInvoice(r.invoice_number),
        report_start: parsed.reportStart,
        report_end: parsed.reportEnd,
        source_file: f.originalname,
      }));
      const { inserted, updated } = await db.upsertShipments(rows);
      summary.files.push({
        name: f.originalname,
        records: rows.length,
        inserted,
        updated,
        reportStart: parsed.reportStart,
        reportEnd: parsed.reportEnd,
      });
      summary.totalRecords += rows.length;
      summary.inserted += inserted;
      summary.updated += updated;
      fs.unlink(f.path, () => {});
    }
    res.json(summary);
  } catch (e) {
    for (const f of files) fs.unlink(f.path, () => {});
    res.status(500).json({ error: e.message });
  }
});

/* Import one or more Shipping Log .txt files. Updates ship_date on the
   shipments whose tracking numbers match; numbers not in the database
   are skipped and reported. */
app.post('/api/import-log', upload.array('files', 200), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'No files uploaded.' });
  const summary = { files: [], totalRows: 0, updated: 0, notFound: 0 };
  try {
    for (const f of files) {
      const text = fs.readFileSync(f.path, 'utf8');
      fs.unlink(f.path, () => {});
      if (!isShipLog(text)) {
        summary.files.push({ name: f.originalname, error: 'Not a Shipping Log file — skipped.' });
        continue;
      }
      const rows = parseShipLog(text);
      const { updated, notFound } = await db.updateShipDates(rows);
      summary.files.push({ name: f.originalname, rows: rows.length, updated, notFound });
      summary.totalRows += rows.length;
      summary.updated += updated;
      summary.notFound += notFound;
    }
    res.json(summary);
  } catch (e) {
    for (const f of files) fs.unlink(f.path, () => {});
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const result = await db.search({
      q: req.query.q || '',
      service: req.query.service || '',
      period: req.query.period || '',
      page: req.query.page || 1,
      pageSize: req.query.pageSize || 50,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/shipments/:id', async (req, res) => {
  try {
    const row = await db.getById(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found.' });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function main() {
  // Wait for Postgres to be ready (compose healthcheck usually covers this,
  // but a short retry loop makes `docker compose up` reliable on its own).
  for (let i = 0; i < 30; i++) {
    try {
      await db.init();
      break;
    } catch (e) {
      if (i === 29) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  app.listen(PORT, () => console.log(`Shipment Search on :${PORT}`));
}

main().catch((e) => {
  console.error('Startup failed:', e.message);
  process.exit(1);
});
