import { useState } from 'react'
import './App.css'

const DEFAULT_FORM = {
  apiName: 'x-gw-get-saas-table-data',
  SQLstatement:
    "SELECT DISTINCT\n      TO_CHAR(r.rcrtmp1_pidm,'9999999') AS pidm,\n      ro.rotiden_stat_ind AS iden_stat,\n      r.rcrtmp1_last_name AS LastName,\n      r.rcrtmp1_first_name AS FirstName,\n      r.rcrtmp1_addr AS Address,\n      r.rcrtmp1_city AS City\n FROM rcrtmp1 r\n  JOIN rotiden ro\n    ON ro.rotiden_aidy_code = r.rcrtmp1_aidy_code\n   AND ro.rotiden_pidm = r.rcrtmp1_pidm\n  JOIN rcrtmp4 r4\n    ON r4.rcrtmp4_aidy_code = r.rcrtmp1_aidy_code\n   AND r4.rcrtmp4_pidm      = r.rcrtmp1_pidm\n   AND r4.rcrtmp4_infc_code = r.rcrtmp1_infc_code\n   AND r4.rcrtmp4_seq_no    = r.rcrtmp1_seq_no\n  LEFT JOIN rcrtmp5 r5\n    ON r5.rcrtmp5_aidy_code = r.rcrtmp1_aidy_code\n   AND r5.rcrtmp5_pidm      = r.rcrtmp1_pidm\n   AND r5.rcrtmp5_infc_code = r.rcrtmp1_infc_code\n   AND r5.rcrtmp5_seq_no    = r.rcrtmp1_seq_no\n WHERE r.rcrtmp1_aidy_code = '2324'\n   AND r.rcrtmp1_infc_code IN ('EDE','CSS')",
  Number_of_Records: 25,
  Output_File_Name: 'SaaS-Table-Query-Data',
  ReportType: 'Both',
  Heading_Text: 'Universal SaaS Query Report',
  PrintParameters: 'N',
  ethosApiKey: '',
  headerUniversity: 'Universal University',
  headerSubtitle: 'Ellucian SaaS Report Generator',
  logoPath: ''
}

function App() {
  const [form, setForm] = useState(DEFAULT_FORM)
  const [status, setStatus] = useState('idle')
  const [log, setLog] = useState([])
  const [result, setResult] = useState(null)
  const [showLog, setShowLog] = useState(true)

  const setField = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))

  const runReport = async () => {
    if (!form.ethosApiKey.trim()) {
      alert('Enter your Ellucian Ethos API key to generate the token and run the report.')
      return
    }

    setStatus('running')
    setLog([])
    setResult(null)

    try {
      const res = await fetch('/api/run-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      setLog(data.log || [])
      if (!res.ok || !data.success) {
        setStatus('error')
        return
      }
      setResult(data)
      setStatus('done')
    } catch (err) {
      setLog((prev) => [...prev, `❌ Network error: ${err.message}`])
      setStatus('error')
    }
  }

  const downloadCsv = () => {
    if (!result?.csvData) return
    const blob = new Blob([result.csvData], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${form.Output_File_Name || 'SaaS-Report'}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <div className="brand-title">Ellucian SaaS Report Generator</div>
          <div className="brand-subtitle">Request token, fetch SaaS table data, and generate HTML + CSV reports.</div>
        </div>
        <div className="header-meta">
          <div>Report page: <a href="http://localhost:3003/report" target="_blank" rel="noreferrer">http://localhost:3003/report</a></div>
          <div>Logic page: <a href="http://localhost:3003/logic" target="_blank" rel="noreferrer">http://localhost:3003/logic</a></div>
        </div>
      </header>

      <main className="content">
        <section className="form-panel">
          <h2>Step 1: Provide Ellucian credentials and report parameters</h2>

          <div className="field-grid">
            <label>
              Ellucian Ethos API Key
              <input
                type="password"
                value={form.ethosApiKey}
                onChange={(e) => setField('ethosApiKey', e.target.value)}
                placeholder="Bearer API key here"
              />
            </label>
            <label>
              API Resource
              <input
                type="text"
                value={form.apiName}
                onChange={(e) => setField('apiName', e.target.value)}
              />
            </label>
            <label>
              Record limit
              <input
                type="number"
                min="1"
                value={form.Number_of_Records}
                onChange={(e) => setField('Number_of_Records', Number(e.target.value) || 1)}
              />
            </label>
            <label>
              Output file name
              <input
                type="text"
                value={form.Output_File_Name}
                onChange={(e) => setField('Output_File_Name', e.target.value)}
              />
            </label>
            <label>
              Report type
              <select
                value={form.ReportType}
                onChange={(e) => setField('ReportType', e.target.value)}
              >
                <option value="Both">HTML and CSV</option>
                <option value="HTML">HTML only</option>
                <option value="CSV">CSV only</option>
              </select>
            </label>
            <label>
              Include parameters page
              <select
                value={form.PrintParameters}
                onChange={(e) => setField('PrintParameters', e.target.value)}
              >
                <option value="N">No</option>
                <option value="Y">Yes</option>
              </select>
            </label>
          </div>

          <div className="field-grid">
            <label>
              Report heading
              <input
                type="text"
                value={form.Heading_Text}
                onChange={(e) => setField('Heading_Text', e.target.value)}
              />
            </label>
            <label>
              University / Organization
              <input
                type="text"
                value={form.headerUniversity}
                onChange={(e) => setField('headerUniversity', e.target.value)}
              />
            </label>
            <label>
              Subtitle
              <input
                type="text"
                value={form.headerSubtitle}
                onChange={(e) => setField('headerSubtitle', e.target.value)}
              />
            </label>
            <label>
              Logo URL
              <input
                type="text"
                value={form.logoPath}
                onChange={(e) => setField('logoPath', e.target.value)}
                placeholder="https://... or /logo.png"
              />
            </label>
          </div>

          <div className="field-full">
            <label>
              SQL statement (recorded for report logic)
              <textarea
                rows="8"
                value={form.SQLstatement}
                onChange={(e) => setField('SQLstatement', e.target.value)}
              />
            </label>
          </div>

          <div className="actions-row">
            <button className="btn btn-primary" onClick={runReport} disabled={status === 'running'}>
              {status === 'running' ? 'Generating report…' : 'Run SaaS Report'}
            </button>
            {result?.csvData && form.ReportType !== 'HTML' && (
              <button className="btn btn-secondary" onClick={downloadCsv}>
                Download CSV
              </button>
            )}
          </div>
        </section>

        {status !== 'idle' && (
          <section className="log-panel">
            <div className="log-header">
              <h3>Pipeline log</h3>
              <button className="btn btn-sm" onClick={() => setShowLog((v) => !v)}>
                {showLog ? 'Hide' : 'Show'} log
              </button>
            </div>
            {showLog && (
              <div className="log-box">
                {log.length === 0 ? (
                  <div className="log-line">Waiting for backend response…</div>
                ) : (
                  log.map((line, index) => (
                    <div key={index} className={`log-line ${line.startsWith('❌') ? 'error' : ''}`}>
                      {line}
                    </div>
                  ))
                )}
              </div>
            )}
          </section>
        )}

        {status === 'done' && result && (
          <section className="result-panel">
            <h3>Report ready</h3>
            <p>
              {result.rowCount} rows · {result.colCount} columns · {result.reportType}
            </p>
            <div className="result-actions">
              {form.ReportType !== 'CSV' && (
                <a className="btn btn-green" href="http://localhost:3003/report" target="_blank" rel="noreferrer">
                  Open HTML report
                </a>
              )}
              {form.ReportType !== 'HTML' && (
                <button className="btn btn-blue" onClick={downloadCsv}>
                  Download CSV file
                </button>
              )}
              {form.PrintParameters === 'Y' && (
                <a className="btn btn-purple" href="http://localhost:3003/logic" target="_blank" rel="noreferrer">
                  View logic / parameter page
                </a>
              )}
            </div>
          </section>
        )}

      </main>
    </div>
  )
}

export default App
