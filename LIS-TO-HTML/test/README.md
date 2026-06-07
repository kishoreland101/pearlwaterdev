# Ellucian SaaS Report Generator (test)

This test project is built with the same React + Vite + Express technology used by the LIS Report Generator. It asks for an Ellucian Ethos API key first, requests a token, then pulls SaaS table data and generates:

- interactive HTML report at `http://localhost:3003/report`
- CSV download directly from the browser
- summary graph built from returned data
- logic/parameter page at `http://localhost:3003/logic`

## Run locally

1. Open `test` folder in terminal:

```bash
cd c:\LIS-Report-Generator\test
npm install
```

2. Start the Express API server:

```bash
npm run server
```

3. Start the Vite UI:

```bash
npm run dev
```

4. Open the Vite app at `http://localhost:5175`

> Make sure the server is running on port `3003` first.

## Notes

- The app retrieves the token from `https://integrate.elluciancloud.com/auth`.
- It then calls the SaaS resource `x-gw-get-saas-table-data` with the requested limit.
- The generated report page includes a chart, table, and metadata summary.
- If `PrintParameters` is set to `Y`, the logic page is created as well.
