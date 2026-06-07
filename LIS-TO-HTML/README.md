# LIS Report Generator

Converts any Banner-style fixed-width `.lis` (or `.txt`) text report into an
interactive HTML report + CSV download — with zero SQL or Ethos configuration.

## Quick Start

```bash
# 1 – install ALL dependencies (React + Express + Multer)
npm install

# 2 – Terminal A: start the Express API server (MUST be running first)
npm run server
#   → "✅  LIS Report Generator running on http://localhost:3002"

# 3 – Terminal B: start the Vite dev UI
npm run dev
#   → "➜  Local: http://localhost:5174"
```

Open **http://localhost:5174** in your browser.

> ⚠️  **Both terminals must be running at the same time.**
> The Vite UI proxies `/api/*` requests to the Express server on port 3002.
> If you see `ECONNREFUSED` it means the Express server is not running — go
> to Terminal A and check for errors (most likely `npm install` was not run).

## Production

```bash
npm run build         # builds React into dist/
npm start             # serves everything from :3002
```

Open **http://localhost:3002**.

## How It Works

1. **Upload** any `.lis`, `.txt`, `.rpt`, `.out` or `.dat` fixed-width text report.
2. The server parses page headers, detects column names from the header line,
   and extracts all data rows by character position.
3. An **interactive HTML report** is generated with:
   - Global search across all columns
   - Per-column dropdown filters
   - Sortable columns (click header)
   - Pagination (25 / 50 / 100 / 250 / All rows per page)
   - In-browser CSV download
   - Print support
4. A **CSV file** can be downloaded directly from the UI.
5. A **File Info page** shows column statistics (row counts, unique values, numeric totals).

## Features (matching Universal-SaaS-Query)

| Feature | Universal-SaaS-Query | LIS Report Generator |
|---|---|---|
| Report heading | ✓ | ✓ |
| Report type (HTML / CSV / Both) | ✓ | ✓ |
| Output file name | ✓ | ✓ |
| Print logic / parameters page | ✓ | ✓ |
| University name in header | ✓ | ✓ |
| Header subtitle | ✓ | ✓ |
| Logo file path | ✓ | ✓ |
| Interactive HTML report | ✓ | ✓ |
| CSV download | ✓ | ✓ |
| Column sort | ✓ | ✓ |
| Global search | ✓ | ✓ |
| Pagination | ✓ | ✓ |
| Column filters | — | ✓ |
| File/column statistics | — | ✓ |

## Supported File Formats

Any fixed-width text report that:
- Uses form-feed `\f` characters as page separators
- Has a column header line with 4+ UPPERCASE column names separated by 2+ spaces
- Has data rows that start with spaces followed by a 6-digit term code

Tested with Banner SFRHCNT (Unduplicated Headcount Report) and similar reports.
