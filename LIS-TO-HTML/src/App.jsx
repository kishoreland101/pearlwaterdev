import { useState, useRef, useCallback } from 'react'
import './App.css'

const DEFAULTS = {
  Heading_Text:     'LIS Text Report',
  ReportType:       'Both',
  PrintLogicFile:   'Y',
  Output_File_Name: 'LIS-Report-Output',
  headerUniversity: 'Universal University',
  headerSubtitle:   'LIS Report Generator',
  logoPath:         '',
}

function formatDate(d) {
  return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })
}
function formatTime(d) {
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export default function App() {
  const [form,     setForm]     = useState(DEFAULTS)
  const [file,     setFile]     = useState(null)      // File object
  const [dragOver, setDragOver] = useState(false)
  const [status,   setStatus]   = useState('idle')    // idle | running | done | error
  const [log,      setLog]      = useState([])
  const [result,   setResult]   = useState(null)
  const [showLog,  setShowLog]  = useState(false)
  const fileInputRef = useRef(null)
  const now = new Date()

  const set = (k, v) => setForm(prev => ({ ...prev, [k]: v }))

  // ── file selection ──────────────────────────────────────────────────────────
  const handleFile = (f) => {
    if (!f) return
    setFile(f)
    // Pre-fill output name from filename (strip extension)
    const base = f.name.replace(/\.[^.]+$/, '')
    set('Output_File_Name', base || 'LIS-Report-Output')
  }

  const onInputChange = (e) => handleFile(e.target.files?.[0])

  const onDrop = useCallback((e) => {
    e.preventDefault()
    setDragOver(false)
    handleFile(e.dataTransfer.files?.[0])
  }, [])

  const onDragOver = (e) => { e.preventDefault(); setDragOver(true)  }
  const onDragLeave = ()  => setDragOver(false)

  // ── pipeline ────────────────────────────────────────────────────────────────
  const runPipeline = async () => {
    if (!file) { alert('Please select a .lis (or .txt) text report file first.'); return }

    setStatus('running')
    setLog([])
    setResult(null)
    setShowLog(true)

    try {
      const body = new FormData()
      body.append('file',      file)
      body.append('formData',  JSON.stringify(form))

      const res  = await fetch('/api/run-lis', { method: 'POST', body })
      const data = await res.json()
      setLog(data.log || [])
      if (data.success) { setResult(data); setStatus('done') }
      else setStatus('error')
    } catch (err) {
      setLog(prev => [...prev, '❌ Network error: ' + err.message])
      setStatus('error')
    }
  }

  // ── download helpers ─────────────────────────────────────────────────────────
  const downloadCsv = () => {
    if (!result?.csvData) return
    const blob = new Blob([result.csvData], { type: 'text/csv;charset=utf-8;' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = (form.Output_File_Name || 'LIS-Report') + '.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  const logoSrc = form.logoPath.trim()

  return (
    <div className="app-wrapper">

      {/* ── HEADER ── */}
      <header className="gw-header">
        <div className="header-left">
          <div className="header-meta">
            <div className="meta-row"><span className="meta-label">USERID:</span><span className="meta-val">user</span></div>
            <div className="meta-row"><span className="meta-label">DATABASE:</span><span className="meta-val">LOCAL</span></div>
            <div className="meta-row"><span className="meta-label">Report Date:</span><span className="meta-val">{formatDate(now)}</span></div>
            <div className="meta-row"><span className="meta-label">Time:</span><span className="meta-val">{formatTime(now)}</span></div>
          </div>
        </div>

        <div className="header-center">
          <div className="header-university">{form.headerUniversity || 'Universal University'}</div>
          <div className="header-subtitle">{form.headerSubtitle || 'LIS Report Generator'}</div>
        </div>

        <div className="header-right">
          {logoSrc && (
            <img
              className="gw-logo-img" src={logoSrc} alt="Logo"
              onError={e => { e.target.style.display = 'none' }}
            />
          )}
          {!logoSrc && (
            <div className="gw-logo-fallback">
              {(form.headerUniversity || 'U').charAt(0).toUpperCase()}
            </div>
          )}
        </div>
      </header>

      {/* ── FORM CARD ── */}
      <main className="main-content">
        <div className="form-card">
          <h2 className="form-heading">LIS Text Report → Interactive Report</h2>
          <p className="form-subheading">
            Upload any Banner-style <code>.lis</code> or <code>.txt</code> fixed-width text report.
            The server parses headers and data columns automatically, then generates an interactive
            HTML report and CSV download. The report opens at{' '}
            <a href="http://localhost:3002/report" target="_blank" rel="noreferrer">
              localhost:3002/report
            </a>.
          </p>

          {/* ── FILE UPLOAD ── */}
          <div
            className={`upload-zone${dragOver ? ' drag-over' : ''}`}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".lis,.txt,.rpt,.out,.dat"
              onChange={onInputChange}
              onClick={e => e.stopPropagation()}
              style={{ display: 'none' }}
            />
            <div className="upload-icon">📄</div>
            <div className="upload-title">Drop your .lis report here, or click to browse</div>
            <div className="upload-sub">Supports .lis · .txt · .rpt · .out · .dat</div>
            {file && (
              <div className="upload-chosen">
                ✅ {file.name} ({(file.size / 1024).toFixed(1)} KB)
              </div>
            )}
          </div>

          {/* ── SETTINGS GRID ── */}
          <div className="two-col">

            <div className="field-block">
              <label className="field-label">Report Heading</label>
              <input className="field-input" type="text" value={form.Heading_Text}
                onChange={e => set('Heading_Text', e.target.value)} />
            </div>

            <div className="field-block">
              <label className="field-label">Output File Name</label>
              <input className="field-input" type="text" value={form.Output_File_Name}
                onChange={e => set('Output_File_Name', e.target.value)} />
              <div className="field-hint">Download filename (no extension needed)</div>
            </div>

            <div className="field-block">
              <label className="field-label">Report Type</label>
              <select className="field-select" value={form.ReportType}
                onChange={e => set('ReportType', e.target.value)}>
                <option value="Both">HTML and CSV Both</option>
                <option value="HTML">HTML Report Only</option>
                <option value="CSV">CSV File Only</option>
              </select>
            </div>

            <div className="field-block">
              <label className="field-label">Print Parameters / Logic Page?</label>
              <select className="field-select" value={form.PrintLogicFile}
                onChange={e => set('PrintLogicFile', e.target.value)}>
                <option value="Y">Yes</option>
                <option value="N">No</option>
              </select>
              <div className="field-hint">Generates a file-info summary page</div>
            </div>

            <div className="field-block">
              <label className="field-label">University / Organization Name</label>
              <input className="field-input" type="text" value={form.headerUniversity}
                onChange={e => set('headerUniversity', e.target.value)}
                placeholder="Universal University" />
              <div className="field-hint">Displayed in the page header above</div>
            </div>

            <div className="field-block">
              <label className="field-label">Header Subtitle</label>
              <input className="field-input" type="text" value={form.headerSubtitle}
                onChange={e => set('headerSubtitle', e.target.value)}
                placeholder="LIS Report Generator" />
            </div>

            <div className="field-block full">
              <label className="field-label">Logo File Path or URL</label>
              <input className="field-input" type="text" value={form.logoPath}
                onChange={e => set('logoPath', e.target.value)}
                placeholder="/WhiteHorseRisingSun.png  or  https://…" />
              <div className="field-hint">
                Full path or URL to your logo image. Place it in the project folder and use
                a relative path like <code>/logo.png</code>. Header updates live as you type.
              </div>
            </div>

          </div>{/* /two-col */}

          {/* ── SUBMIT ROW ── */}
          <div className="submit-row">
            <button
              className={`btn-run${status === 'running' ? ' running' : ''}`}
              onClick={runPipeline}
              disabled={status === 'running'}
            >
              {status === 'running' ? '⏳  Processing Report…' : '▶  Run Report'}
            </button>

            {status !== 'idle' && (
              <button className="btn btn-outline-blue" onClick={() => setShowLog(v => !v)}>
                {showLog ? 'Hide' : 'Show'} Pipeline Log ({log.length} steps)
              </button>
            )}
          </div>

          {/* ── LOG ── */}
          {showLog && log.length > 0 && (
            <div className="log-box">
              {log.map((line, i) => (
                <div key={i} className={
                  'log-line ' +
                  (line.startsWith('❌') || line.includes('ERROR') ? 'log-err' :
                   line.includes('✓')                              ? 'log-ok'  :
                   line.includes('⚠')                              ? 'log-warn' : '')
                }>{line}</div>
              ))}
            </div>
          )}

          {/* ── SUCCESS ── */}
          {status === 'done' && result && (
            <div className="result-panel">
              <div className="result-title">
                ✅ Report complete — <strong>{result.recordCount}</strong> data rows from{' '}
                <strong>{result.columnCount}</strong> columns
              </div>
              <div className="result-btns">
                {result.reportHtml && (
                  <a className="btn btn-blue result-btn"
                    href="http://localhost:3002/report" target="_blank" rel="noreferrer">
                    📊 Open HTML Report
                  </a>
                )}
                {result.csvData && (
                  <button className="btn btn-green result-btn" onClick={downloadCsv}>
                    ⬇ Download CSV
                  </button>
                )}
                {result.logicHtml && (
                  <a className="btn btn-purple result-btn"
                    href="http://localhost:3002/logic" target="_blank" rel="noreferrer">
                    🔧 View File Info Page
                  </a>
                )}
              </div>
              <div className="result-note">
                Report also available at{' '}
                <a href="http://localhost:3002/report" target="_blank" rel="noreferrer">
                  http://localhost:3002/report
                </a>
              </div>
            </div>
          )}

          {/* ── ERROR ── */}
          {status === 'error' && (
            <div className="error-panel">
              ❌ Processing failed. Review the pipeline log above for details.
            </div>
          )}

        </div>{/* /form-card */}
      </main>
    </div>
  )
}
