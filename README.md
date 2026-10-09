# Shipment Search

Standalone website to store FedEx shipment report `.txt` files and quickly
search them by **tracking number**, **customer** (code or company name), or
**invoice number**.

## How it works

- Whenever a new report arrives (end of day, every few days, weekly, ...),
  upload the FedEx Shipment Report `.txt` file(s) on the Import card. The
  server parses the two-column report format, strips page headers/footers,
  stitches records split across page breaks, and upserts by tracking number
  — re-importing never duplicates. Each file is stored with its actual
  report date range, whatever length the period covers.
- Rows with reference `B/Ctest` are skipped. The `B/C` prefix is trimmed from
  references and stored as the invoice number (search works with or without it).
- Search is a single box with trigram indexes (pg_trgm), fast across millions
  of rows, with service-type and report-period filters and pagination.

## Run on the office PC

```bash
cd shipment-search
# set a real DB password first:
export DB_PASSWORD=your-strong-password
docker compose up -d --build
```

Open `http://<pc-name>:3002`. Data lives in the `pgdata` volume.

Environment overrides: `APP_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`.

## API

- `POST /api/import` — multipart `files` (.txt shipment reports, up to 200 files)
- `POST /api/import-log` — multipart `files` (.txt Shipping Log files); fills in
  each shipment's ship date + time by tracking number, skips unknown numbers
- `GET /api/search?q=&service=&period=&page=&pageSize=`
- `GET /api/shipments/:id`
- `GET /api/periods`, `GET /api/stats`, `GET /api/health`

## Tests

```bash
npm test   # parser unit tests (no DB needed)
```
