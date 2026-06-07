'use strict'

const express = require('express')
const path = require('path')
const fs = require('fs')

const app = express()
const PORT = process.env.PORT || 3003

let latestReportHtml = ''
let latestCsv = ''
let latestLogicHtml = ''
let latestSummary = { rowCount: 0, colCount: 0, reportType: 'None' }

app.use(express.json({ limit: '5mb' }))
app.use(express.urlencoded({ extended: true }))
app.use(express.static(path.join(__dirname, 'dist')))

function safeString(value) {
  if (value === undefined || value === null) return ''
  return String(value)
}

function parseJsonOrText(text) {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function normalizeBearer(value) {
  if (!value) return ''
  const trimmed = String(value).trim()
  return /^Bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`
}

async function attemptSaasRequest(url, headers, log, label) {
  log.push(`Attempt ${label}: ${url}`)
  const response = await fetch(url, {
    method: 'GET',
    headers,
    redirect: 'follow',
  })
  const text = await response.text()
  const snippet = safeString(text).replace(/\s+/g, ' ').slice(0, 220)
  log.push(`  → ${response.status} ${response.statusText} | ${snippet}`)
  if (response.ok) {
    return { success: true, body: parseJsonOrText(text) }
  }
  return { success: false, status: response.status, statusText: response.statusText, body: text }
}

async function fetchAuth(apiKey, log) {
  log.push('Step 1: Requesting token from Ellucian auth endpoint')
  const url = 'https://integrate.elluciancloud.com/auth'
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({}),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Auth failed ${response.status}: ${safeString(text).slice(0, 180)}`)
  }

  const raw = await response.text()
  const payload = parseJsonOrText(raw)
  log.push(`  auth response: ${safeString(raw).replace(/\s+/g, ' ').slice(0, 220)}`)

  let token = ''
  if (typeof payload === 'string') {
    token = payload.trim()
  } else if (payload && typeof payload === 'object') {
    token = payload.token || payload.access_token || payload.authToken || payload.payload || ''
    if (!token && payload.payload && typeof payload.payload === 'string') {
      token = payload.payload
    }
    if (!token && payload.message && /bearer/i.test(payload.message)) {
      token = payload.message
    }
  }

  if (!token) {
    throw new Error('Auth succeeded but did not return a usable token. Response: ' + JSON.stringify(payload))
  }

  log.push('✓ Token retrieved successfully')
  return token
}

async function fetchSaasData(apiKey, token, resource, limit, log) {
  log.push(`Step 2: Fetching SaaS payload from resource "${resource}"`)
  const encodedResource = encodeURIComponent(resource)
  const requestLimit = encodeURIComponent(limit || 25)

  const attempts = [
    {
      label: 'api-bearer-token',
      url: `https://integrate.elluciancloud.com/api/${encodedResource}?limit=${requestLimit}`,
      headers: {
        Accept: 'application/json',
        Authorization: normalizeBearer(token),
        'X-GW-APIKEY': apiKey,
      },
    },
    {
      label: 'api-bearer-apikey',
      url: `https://integrate.elluciancloud.com/api/${encodedResource}?limit=${requestLimit}`,
      headers: {
        Accept: 'application/json',
        Authorization: normalizeBearer(apiKey),
        'X-GW-APIKEY': apiKey,
      },
    },
    {
      label: 'proxy-query-resource-bearer-token',
      url: `https://integrate.elluciancloud.com/proxy?resource=${encodedResource}&limit=${requestLimit}`,
      headers: {
        Accept: 'application/json',
        Authorization: normalizeBearer(token),
        'X-GW-APIKEY': apiKey,
      },
    },
    {
      label: 'proxy-query-resource-bearer-apikey',
      url: `https://integrate.elluciancloud.com/proxy?resource=${encodedResource}&limit=${requestLimit}`,
      headers: {
        Accept: 'application/json',
        Authorization: normalizeBearer(apiKey),
        'X-GW-APIKEY': apiKey,
      },
    },
    {
      label: 'proxy-path-bearer-token',
      url: `https://integrate.elluciancloud.com/proxy/${encodedResource}?limit=${requestLimit}`,
      headers: {
        Accept: 'application/json',
        Authorization: normalizeBearer(token),
        'X-GW-APIKEY': apiKey,
      },
    },
    {
      label: 'proxy-path-bearer-apikey',
      url: `https://integrate.elluciancloud.com/proxy/${encodedResource}?limit=${requestLimit}`,
      headers: {
        Accept: 'application/json',
        Authorization: normalizeBearer(apiKey),
        'X-GW-APIKEY': apiKey,
      },
    },
  ]

  const failures = []
  for (const attempt of attempts) {
    const result = await attemptSaasRequest(attempt.url, attempt.headers, log, attempt.label)
    if (result.success) {
      log.push(`✓ Successful SaaS request on attempt: ${attempt.label}`)
      return result.body
    }
    failures.push({ label: attempt.label, status: result.status, body: result.body })
    if (result.status === 400 || result.status === 401) {
      log.push(`  ⚠ Attempt ${attempt.label} failed with ${result.status}. Trying next option...`)
    }
  }

  const summary = failures.map((f) => `[${f.label}] ${f.status} ${safeString(f.body).slice(0, 140)}`).join(' | ')
  throw new Error(`All SaaS request attempts failed. ${summary}`)
}

function flattenValue(value) {
  if (value == null) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function normalizeRows(payload) {
  if (payload == null) return []
  if (Array.isArray(payload)) {
    return payload.map((item) => normalizeObject(item))
  }
  if (typeof payload === 'object') {
    const snapshot = payload.data || payload.payload || payload.items || payload.rows || payload.results || payload.result || payload
    if (Array.isArray(snapshot)) return snapshot.map(normalizeObject)
    if (typeof snapshot === 'object' && !Array.isArray(snapshot)) return [normalizeObject(snapshot)]
  }
  if (typeof payload === 'string') {
    const parsed = parseJsonOrText(payload)
    if (parsed !== payload) return normalizeRows(parsed)
  }
  return []
}

function normalizeObject(record) {
  if (record == null) return {}
  if (Array.isArray(record)) {
    return record.reduce((acc, value, idx) => {
      acc[`Column${idx + 1}`] = flattenValue(value)
      return acc
    }, {})
  }
  if (typeof record === 'object') {
    const result = {}
    Object.keys(record).forEach((key) => {
      result[key] = flattenValue(record[key])
    })
    return result
  }
  return { value: String(record) }
}

function buildCsv(rows) {
  if (!rows || !rows.length) return ''
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))))
  const escape = (value) => {
    const text = safeString(value)
    if (text.includes(',') || text.includes('"') || text.includes('\n')) {
      return `"${text.replace(/"/g, '""')}"`
    }
    return text
  }
  const header = columns.map(escape).join(',')
  const lineRows = rows.map((row) => columns.map((col) => escape(row[col])).join(','))
  return [header, ...lineRows].join('\r\n')
}

function buildReportHtml(rows, form) {
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))))
  const heading = safeString(form.Heading_Text || 'SaaS Report')
  const orgName = safeString(form.headerUniversity || 'Universal SaaS')
  const subtitle = safeString(form.headerSubtitle || '')
  const logoPath = safeString(form.logoPath || '')
  const now = new Date().toLocaleString('en-US')

  const headerHtml = logoPath
    ? `<img src="${safeString(logoPath)}" alt="Logo" class="logo-image" onerror="this.style.display='none'" />`
    : `<div class="logo-fallback">${orgName.charAt(0).toUpperCase()}</div>`

  const tableHeader = columns.map((col, idx) => `<th data-col="${idx}" class="sortable">${safeString(col)}</th>`).join('')
  const tableBody = rows.map((row) => `<tr class="data-row">${columns.map((col, idx) => `<td data-col="${idx}">${safeString(row[col])}</td>`).join('')}</tr>`).join('')

  const dataJson = JSON.stringify({ rows, columns })

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${heading}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@3.9.1/dist/chart.min.js"></script>
<style>
:root{--blue:#0f3d72;--light-blue:#1b6cc8;--bg:#eef3f8;--card:#fff;--border:#d8dde3;--text:#1a2733;--muted:#586475;--yellow-row:#ffffcc;--shadow:0 18px 45px rgba(15,35,55,.08)}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text)}
.page-shell{max-width:1400px;margin:0 auto;padding:24px}
.page-header{display:flex;gap:18px;align-items:stretch;padding:24px;background:var(--card);border:1px solid var(--border);border-radius:18px;box-shadow:var(--shadow);margin-bottom:24px}
.page-title{flex:1;display:flex;flex-direction:column;justify-content:center}
.page-title h1{margin:0 0 4px;font-size:28px;color:var(--blue)}
.page-title p{margin:4px 0;color:var(--muted);font-size:13px}
.page-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:0 0 0 18px;border-left:1px solid var(--border)}
.btn{padding:10px 16px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text);cursor:pointer;font-weight:600;font-size:13px;transition:all .15s}
.btn:hover{background:var(--light-blue);color:#fff;border-color:var(--light-blue)}
.btn-primary{background:var(--blue);color:#fff;border-color:var(--blue)}
.btn-primary:hover{background:#0a2a5e}
.logo-image{max-height:80px;max-width:180px;object-fit:contain}
.logo-fallback{width:80px;height:80px;border-radius:16px;background:var(--blue);color:#fff;display:grid;place-items:center;font-size:36px;font-weight:800}
.meta-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
.meta-card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px;font-size:13px}
.meta-card strong{display:block;color:var(--blue);margin-bottom:6px;font-size:14px}
.section{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:22px;margin-top:22px}
.section h2{margin:0 0 14px;font-size:18px;color:var(--blue)}
.section-toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;align-items:center}
.search-box{flex:1;min-width:240px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;font-size:13px}
.table-wrapper{overflow:auto;max-height:600px;border-radius:10px;border:1px solid var(--border);box-shadow:0 4px 12px rgba(0,0,0,.06)}
table{width:100%;border-collapse:collapse;font-size:13px}
thead{background:linear-gradient(180deg,#f9fbfd 0%,#f4f7fb 100%);position:sticky;top:0;z-index:10}
th{padding:12px;border:1px solid var(--border);color:var(--blue);font-weight:700;text-align:left;cursor:pointer;user-select:none}
th:hover{background:#eef2f7}
th.sortable:after{content:' ↕';opacity:.5}
th.sorted-asc:after{content:' ▲';opacity:1;color:var(--light-blue)}
th.sorted-desc:after{content:' ▼';opacity:1;color:var(--light-blue)}
td{padding:10px 12px;border-bottom:1px solid #e8eef5;text-align:left}
tbody tr{transition:background .1s}
tbody tr:hover{background:#f9fbfd}
tbody tr.active{background:var(--yellow-row);font-weight:600}
.graph-modal{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.4);z-index:1000;align-items:center;justify-content:center}
.graph-modal.open{display:flex}
.graph-modal-content{background:var(--card);border-radius:18px;padding:24px;max-width:500px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,.3)}
.graph-modal-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}
.graph-modal-header h3{margin:0;font-size:18px;color:var(--blue)}
.graph-modal-close{background:none;border:none;font-size:24px;cursor:pointer;color:var(--muted)}
.form-group{display:grid;gap:6px;margin-bottom:14px}
.form-group label{font-size:13px;font-weight:700;color:var(--text);text-transform:uppercase;letter-spacing:.02em}
.form-group select{padding:10px;border:1px solid var(--border);border-radius:8px;font-size:13px;background:var(--card)}
.graph-actions{display:flex;gap:10px;margin-top:20px;justify-content:flex-end}
.chart-section{display:none;margin-top:22px}
.chart-section.active{display:block}
#reportChart{max-height:400px}
@media(max-width:900px){.page-header{flex-direction:column}.page-actions{padding:12px 0 0;border:none}.section-toolbar{flex-direction:column}.search-box{min-width:100%}}
</style>
</head>
<body>
<div class="page-shell">
  <div class="page-header">
    <div class="page-title">
      <h1>${heading}</h1>
      <p>${orgName}${subtitle ? ' — ' + subtitle : ''}</p>
      <p style="margin-top:6px;font-size:12px;color:var(--muted)">Generated: ${now}</p>
    </div>
    ${headerHtml}
    <div class="page-actions">
      <button class="btn btn-primary" onclick="openGraphModal()">📊 Create Graph</button>
      <button class="btn" onclick="exportCsv()">⬇ CSV</button>
      <button class="btn" onclick="window.print()">🖨 Print</button>
    </div>
  </div>

  <div class="meta-grid">
    <div class="meta-card"><strong>Total Rows</strong><span id="row-count">${rows.length}</span></div>
    <div class="meta-card"><strong>Columns</strong><span>${columns.length}</span></div>
    <div class="meta-card"><strong>Report Type</strong><span>${safeString(form.ReportType)}</span></div>
    <div class="meta-card"><strong>Record Limit</strong><span>${safeString(form.Number_of_Records)}</span></div>
  </div>

  <div class="section">
    <h2>Data Records</h2>
    <div class="section-toolbar">
      <input type="text" class="search-box" id="search-input" placeholder="🔍 Search records...">
      <button class="btn" onclick="resetSearch()">Clear</button>
    </div>
    <div class="table-wrapper">
      <table id="data-table">
        <thead><tr>${tableHeader}</tr></thead>
        <tbody id="table-body">${tableBody}</tbody>
      </table>
    </div>
  </div>

  <div class="chart-section" id="chart-section">
    <div class="section">
      <h2 id="chart-title">Chart</h2>
      <canvas id="reportChart"></canvas>
    </div>
  </div>
</div>

<div class="graph-modal" id="graph-modal">
  <div class="graph-modal-content">
    <div class="graph-modal-header">
      <h3>Create Graph</h3>
      <button class="graph-modal-close" onclick="closeGraphModal()">✕</button>
    </div>
    <div class="form-group">
      <label>Chart Type</label>
      <select id="chart-type-select">
        <option value="bar">Bar Chart</option>
        <option value="pie">Pie Chart</option>
      </select>
    </div>
    <div class="form-group">
      <label>Label Field</label>
      <select id="label-field-select">${columns.map(col => '<option>' + safeString(col) + '</option>').join('')}</select>
    </div>
    <div class="form-group">
      <label>Value Field</label>
      <select id="value-field-select">${columns.map(col => '<option>' + safeString(col) + '</option>').join('')}</select>
    </div>
    <div class="graph-actions">
      <button class="btn" onclick="closeGraphModal()">Cancel</button>
      <button class="btn btn-primary" onclick="createGraph()">Create</button>
    </div>
  </div>
</div>

<script>
const reportData = ${dataJson};
let currentChart = null;
let sortState = {};

function qs(sel) { return document.querySelector(sel); }
function qsa(sel) { return Array.from(document.querySelectorAll(sel)); }
function getCellText(td) { return (td.innerText || td.textContent || '').trim(); }

function filterTable() {
  const query = (qs('#search-input').value || '').toLowerCase();
  const rows = qsa('#table-body tr');
  let visible = 0;
  rows.forEach(row => {
    const text = (row.innerText || row.textContent || '').toLowerCase();
    if (query === '' || text.includes(query)) {
      row.style.display = '';
      visible++;
    } else {
      row.style.display = 'none';
    }
  });
  qs('#row-count').textContent = visible;
}

function resetSearch() {
  qs('#search-input').value = '';
  filterTable();
}

qs('#search-input').addEventListener('input', filterTable);
qsa('th.sortable').forEach((th, idx) => {
  th.addEventListener('click', () => sortTable(idx));
});

function sortTable(colIdx) {
  const rows = qsa('#table-body tr');
  const isAsc = sortState[colIdx] !== true;
  sortState = {};
  sortState[colIdx] = isAsc;
  qsa('th.sortable').forEach(th => th.classList.remove('sorted-asc', 'sorted-desc'));
  qs(\`th[data-col="\${colIdx}"]\`).classList.add(isAsc ? 'sorted-asc' : 'sorted-desc');
  
  rows.sort((a, b) => {
    const aVal = getCellText(a.children[colIdx]);
    const bVal = getCellText(b.children[colIdx]);
    const aNum = parseFloat(aVal);
    const bNum = parseFloat(bVal);
    if (!isNaN(aNum) && !isNaN(bNum)) {
      return isAsc ? aNum - bNum : bNum - aNum;
    }
    return isAsc ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
  });
  
  const tbody = qs('#table-body');
  rows.forEach(row => tbody.appendChild(row));
}

qsa('#table-body tr').forEach(row => {
  row.addEventListener('click', () => {
    qsa('#table-body tr').forEach(r => r.classList.remove('active'));
    row.classList.add('active');
  });
});

function openGraphModal() {
  qs('#graph-modal').classList.add('open');
}

function closeGraphModal() {
  qs('#graph-modal').classList.remove('open');
}

function createGraph() {
  const type = qs('#chart-type-select').value;
  const labelField = qs('#label-field-select').value;
  const valueField = qs('#value-field-select').value;
  
  const labelIdx = reportData.columns.indexOf(labelField);
  const valueIdx = reportData.columns.indexOf(valueField);
  
  if (labelIdx < 0 || valueIdx < 0) { alert('Invalid field selection'); return; }
  
  const groups = {};
  reportData.rows.forEach(row => {
    const label = String(row[labelField] || 'Blank').trim();
    const val = parseFloat(String(row[valueField] || '0').replace(/[^0-9.-]/g, '')) || 1;
    groups[label] = (groups[label] || 0) + val;
  });
  
  const labels = Object.keys(groups);
  const values = Object.values(groups);
  
  closeGraphModal();
  
  if (currentChart) currentChart.destroy();
  const ctx = qs('#reportChart').getContext('2d');
  currentChart = new Chart(ctx, {
    type: type,
    data: {
      labels: labels,
      datasets: [{
        label: \`\${labelField} by \${valueField}\`,
        data: values,
        backgroundColor: type === 'pie' ? ['#2563eb','#dc2626','#16a34a','#9333ea','#f97316','#0891b2','#ca8a04','#db2777'] : '#2563eb',
        borderColor: '#fff',
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { position: type === 'pie' ? 'bottom' : 'top' } },
      scales: type === 'pie' ? {} : { y: { beginAtZero: true } }
    }
  });
  
  qs('#chart-title').textContent = (type === 'pie' ? 'Pie Chart' : 'Bar Chart') + ': ' + labelField + ' by ' + valueField;
  qs('#chart-section').classList.add('active');
}

function exportCsv() {
  const rows = qsa('#table-body tr:not([style*="display: none"])');
  const headers = qsa('th');
  let csv = Array.from(headers).map(h => '"' + (h.innerText || h.textContent || '').replace(/"/g, '""') + '"').join(',') + '\\n';
  rows.forEach(row => {
    csv += Array.from(row.children).map(td => '"' + (td.innerText || '').replace(/"/g, '""') + '"').join(',') + '\\n';
  });
  
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'SaaS-Report.csv';
  link.click();
  URL.revokeObjectURL(url);
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeGraphModal();
});
qs('#graph-modal').addEventListener('click', (e) => {
  if (e.target.id === 'graph-modal') closeGraphModal();
});
</script>
</body>
</html>`
}

function buildLogicHtml(form, authLog) {
  const heading = safeString(form.Heading_Text || 'Report Logic')
  const rows = Object.entries(form).map(
    ([key, value]) => `<tr><td>${safeString(key)}</td><td><code>${safeString(value)}</code></td></tr>`
  ).join('')
  const logLines = authLog.map((line) => `<li>${safeString(line)}</li>`).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${heading}</title>
<style>
body{margin:0;font-family:system-ui, sans-serif;background:#f5f7fb;color:#102a43;}
.container{max-width:980px;margin:0 auto;padding:28px}
h1{font-size:28px;color:#0f3d72}
table{width:100%;border-collapse:collapse;margin-top:18px}
th,td{padding:12px 14px;border:1px solid #d9e2ec;text-align:left}
th{background:#f0f4f8;color:#243b53}
code{background:#f0f4f8;padding:2px 6px;border-radius:4px;color:#1d4ed8}
.card{background:#fff;border:1px solid #d9e2ec;border-radius:14px;padding:18px;box-shadow:0 18px 40px rgba(15,35,55,.06);margin-top:20px}
</style>
</head>
<body>
<div class="container">
  <h1>${heading}</h1>
  <div class="card">
    <h2>Request parameters</h2>
    <table><thead><tr><th>Field</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table>
  </div>
  <div class="card">
    <h2>Pipeline log</h2>
    <ul>${logLines}</ul>
  </div>
</div>
</body>
</html>`
}

app.post('/api/run-report', async (req, res) => {
  const form = req.body || {}
  const log = []

  try {
    if (!form.ethosApiKey || !form.ethosApiKey.trim()) {
      return res.status(400).json({ success: false, log: ['❌ Ethos API key is required'] })
    }

    const token = await fetchAuth(form.ethosApiKey.trim(), log)
    const payload = await fetchSaasData(form.ethosApiKey.trim(), token, form.apiName || 'x-gw-get-saas-table-data', form.Number_of_Records || 25, log)
    log.push(`✓ Received SaaS payload (${Array.isArray(payload) ? `${payload.length} items` : typeof payload})`)

    const rows = normalizeRows(payload)
    const csvData = buildCsv(rows)
    const reportHtml = buildReportHtml(rows, form)
    const logicHtml = form.PrintParameters === 'Y' ? buildLogicHtml(form, log) : ''

    latestReportHtml = reportHtml
    latestCsv = csvData
    latestLogicHtml = logicHtml
    latestSummary = {
      rowCount: rows.length,
      colCount: rows.length ? Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).length : 0,
      reportType: form.ReportType || 'Both',
    }

    res.json({
      success: true,
      rowCount: latestSummary.rowCount,
      colCount: latestSummary.colCount,
      reportType: latestSummary.reportType,
      reportUrl: '/report',
      logicUrl: form.PrintParameters === 'Y' ? '/logic' : '',
      csvAvailable: !!csvData,
      csvData: csvData,
      log,
    })
  } catch (err) {
    log.push(`❌ ${err.message}`)
    res.status(500).json({ success: false, log })
  }
})

app.get('/report', (req, res) => {
  if (!latestReportHtml) {
    return res.send(`<html><body><h1>No report generated</h1><p>Run the app and submit a request first.</p></body></html>`)
  }
  res.send(latestReportHtml)
})

app.get('/logic', (req, res) => {
  if (!latestLogicHtml) {
    return res.send(`<html><body><h1>No logic page generated</h1><p>Enable PrintParameters = Y and run a report.</p></body></html>`)
  }
  res.send(latestLogicHtml)
})

app.get('/download-csv', (req, res) => {
  if (!latestCsv) {
    return res.status(404).send('No CSV available yet')
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${safeString(req.query.name || 'saas-report')}.csv"`)
  res.send(latestCsv)
})

app.use((req, res) => {
  res.status(404).send('Not found')
})

app.listen(PORT, () => {
  console.log(`✅ Ellucian SaaS Report Generator running on http://localhost:${PORT}`)
})
