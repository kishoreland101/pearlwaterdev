'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   LIS Report Generator – server.cjs  (universal parser v5)
   ─────────────────────────────────────────────────────────────────────────
   Correctly handles all Banner report formats:
   • SFRHCNT  – UPPERCASE col header + ---- dash sep, form-feed pages
   • TZRGADP  – REPORT/USER/DATABASE meta, ---- sep, wrapped rows
   • SZPALXI  – same + control-info + summary KV
   • SZPALX2  – same + blank-first-col continuation rows
   • PZPTTDE  – 4-line meta, ==== SECTION divider (long, after blank),
                centred section titles after divider, ---- col sep
   • SZRRCNT  – 3-line meta, ==== COLUMN sep (short groups, right after header),
                *** section titles, DATABASE inline subtitle
   ═══════════════════════════════════════════════════════════════════════════ */

['express','multer'].forEach(pkg => {
  try { require(pkg); } catch {
    console.error(`\n❌  Missing package: "${pkg}"\n   Run:  npm install\n`);
    process.exit(1);
  }
});

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');

const app    = express();
const PORT   = process.env.PORT || 3002;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100*1024*1024 } });

let latestReport    = null;
let latestLogic     = null;
let latestCsvReport = null;

/* ═══════════════════════════════════════════════════════════════════════════
   PRIMITIVE LINE CLASSIFIERS
   ═══════════════════════════════════════════════════════════════════════════ */
const escH = s =>
  String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
                 .replace(/>/g,'&gt;').replace(/"/g,'&quot;');

/* Only dashes and spaces, ≥2 dash-groups, ≥12 chars total */
function isDashSep(line) {
  if (line.length < 12) return false;
  if (!/^[ \-]+$/.test(line)) return false;
  const groups = line.match(/-{2,}/g) || [];
  /* Accept single-group total separators (e.g. "          --------------------")
     as long as the dash run is long enough (≥4) to not be a hyphenated word. */
  if (groups.length === 0) return false;
  if (groups.length >= 2) return true;
  return groups[0].length >= 4;
}

/* Only equals and spaces, ≥1 equals-group, ≥10 chars */
function isEqSep(line) {
  return line.length >= 10
    && /^[= ]+$/.test(line)
    && (line.match(/={2,}/g) || []).length >= 1;
}

/* Any separator (dash or equals) */
const isAnySep = line => isDashSep(line) || isEqSep(line);

/* "Long" equals: nearly all the width is = signs → section divider in PZPTTDE */
function isLongEqDivider(line) {
  const totalEq = (line.match(/={2,}/g) || []).reduce((s,r) => s + r.length, 0);
  return totalEq >= 60;
}

/* *** Title *** (SZRRCNT style) */
const isStarTitle = line => /^\s*\*{2,}.*\*{2,}\s*$/.test(line.trim());

/* Centred text: 10+ leading spaces, meaningful content, not a separator */
function isCentredTitle(line) {
  if (!/^\s{10,}\S/.test(line)) return false;
  if (isAnySep(line) || isStarTitle(line)) return false;
  /* Reject lines that look like multi-column headers:
     3+ spaces between content words = column-alignment spacing */
  if (/\S\s{3,}\S/.test(line.trim())) return false;
  return true;
}

/* Lines that belong to the Job-info / KV block (stop data collection) */
const isKvLine = line =>
  /^\s+Job (Home|Number)\s/i.test(line) ||
  /^\s+Library Used\s/i.test(line)       ||
  /^\s+Printer\s/i.test(line)            ||
  /^\s+Program Name\s/i.test(line)       ||
  /^\s+Software Version\s/i.test(line);

const isParamHeader = line => /^#\s+Parameter\s+Value/i.test(line);

/* Banner page-header meta lines */
const isMetaLine = line => /^(REPORT|USER|DATABASE)\s*:/i.test(line);

/* ═══════════════════════════════════════════════════════════════════════════
   PARSE META HEADER
   Returns all header fields including optional subtitle.
   ═══════════════════════════════════════════════════════════════════════════ */
function parseMeta(lines) {
  const m = {
    reportCode:'', orgName:'', reportTitle:'',
    user:'', database:'', date:'', time:'',
    subtitle:'', term:'', databaseExtra:'',
  };
  let seen = 0, foundDB = false;

  for (let i = 0; i < lines.length && seen < 20; i++) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    seen++;

    let match;

    /* REPORT  : CODE   org   PAGE : N */
    match = raw.match(/^REPORT\s*:\s*(\S+)\s{2,}(.*?)\s{3,}.*PAGE\s*:/i);
    if (match) { m.reportCode = match[1].trim(); m.orgName = match[2].trim(); continue; }

    /* USER    : ID   title   DATE : date */
    match = raw.match(/^USER\s*:\s*(\S+)\s{2,}(.*?)\s{3,}DATE\s*:\s*(.+)/i);
    if (match) { m.user = match[1].trim(); m.reportTitle = match[2].trim(); m.date = match[3].trim(); continue; }

    /* DATABASE: NAME  extra  TIME : time */
    match = raw.match(/^DATABASE\s*:\s*(\S+)\s*(.*?)\s*TIME\s*:\s*(.+)/i);
    if (match) {
      m.database      = match[1].trim();
      m.databaseExtra = match[2].trim();
      m.time          = match[3].trim();
      foundDB = true;
      continue;
    }

    /* 4th-line subtitle: ONLY the very next non-blank line after DATABASE.
       If centred → capture it. Then stop meta scanning either way. */
    if (foundDB && !m.subtitle) {
      if (isCentredTitle(raw) && !isAnySep(raw)) m.subtitle = raw.trim();
      break;
    }

    /* SFRHCNT date line */
    match = raw.match(/^(\d{2}-[A-Z]{3}-\d{4}\s+\d{1,2}:\d{2}:\d{2}\s+[AP]M)/i);
    if (match && !m.date) { m.date = match[1].trim(); continue; }

    /* SFRHCNT term+title line */
    match = raw.match(/^(\d{6})\s{3,}(.+?)\s{3,}(\S+)\s*$/);
    if (match && !m.term) {
      m.term = match[1].trim(); m.reportTitle = match[2].trim(); m.reportCode = match[3].trim();
    }
  }

  /* Use DATABASE inline text as subtitle if no explicit 4th line */
  if (!m.subtitle && m.databaseExtra) m.subtitle = m.databaseExtra;

  return m;
}

/* ═══════════════════════════════════════════════════════════════════════════
   COLUMN EXTRACTOR  (from separator + header line)
   ═══════════════════════════════════════════════════════════════════════════ */
function colsFromSep(sepLine, headerLine) {
  const groups = [];
  const re = /[=\-]{2,}/g;
  let m;
  while ((m = re.exec(sepLine)) !== null) {
    groups.push({ start: m.index, end: m.index + m[0].length });
  }
  return groups.map((g, i) => {
    const end  = i + 1 < groups.length ? groups[i + 1].start : 9999;
    const raw  = headerLine ? headerLine.substring(g.start, end) : '';
    const name = raw.trim().replace(/\s{2,}/g, ' ') || `COL${i + 1}`;
    return { name, start: g.start, end };
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   MAIN PARSER
   Strategy: two-pass.
     Pass 1 – identify section boundaries using a clean state machine.
     Pass 2 – parse each section's data blocks.
   ═══════════════════════════════════════════════════════════════════════════ */
function parseLisFile(text) {
  const log = [];

  /* Strip form-feeds to newlines */
  const lines = text.replace(/\f/g, '\n').split('\n');
  log.push(`Step 1: ${lines.length} lines`);

  const meta = parseMeta(lines);
  log.push(`Step 2: code="${meta.reportCode}" title="${meta.reportTitle}" sub="${meta.subtitle}" org="${meta.orgName}"`);

  /* ── PASS 1: build raw sections ── */
  /*
   * A raw section = { title, rawLines[] }
   * Section boundaries are detected by:
   *   (a) *** Title *** line
   *   (b) Long ==== divider (>=60 = chars) preceded by >=1 blank  → PZPTTDE style
   *       After a long divider the NEXT non-blank line is the section title
   *       (whether centred or not, as long as it's not itself a separator)
   *
   * A separator line (dash or short equals) that appears right after a
   * non-separator text line is a COLUMN SEPARATOR — it stays inside rawLines.
   *
   * The meta subtitle is used as the title for the very first section only.
   */

  const rawSections = [];
  let   curSec      = null;
  let   expectTitle = false;   // true right after a long-eq divider
  let   blanksBeforeCurrent = 0;

  const startSection = (title) => {
    if (curSec) rawSections.push(curSec);
    curSec = { title: title || '', rawLines: [] };
    expectTitle = false;
  };

  /* Track the last non-blank, non-sep, non-meta content line index
     so we can distinguish "sep right after header" vs "sep on its own" */
  let lastContentLineIdx = -1;  // index into `lines`
  let blanksSinceContent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    /* ── skip meta lines ── */
    if (isMetaLine(line)) continue;

    /* ── skip the 4th-line subtitle (already in meta.subtitle) ── */
    if (meta.subtitle && line.trim() === meta.subtitle) continue;

    /* ── blank ── */
    if (line.trim() === '') {
      blanksSinceContent++;
      continue;
    }

    /* ── stop at KV / parameter blocks ── */
    if (isKvLine(line) || isParamHeader(line)) {
      if (curSec) rawSections.push(curSec);
      curSec = null;
      break;
    }

    /* ── long equals divider → section boundary ── */
    if (isEqSep(line) && isLongEqDivider(line) && blanksSinceContent >= 1) {
      startSection('');   // placeholder; next content line will be the title
      expectTitle = true;
      blanksSinceContent = 0;
      continue;
    }

    /* ── star title → section boundary ── */
    if (isStarTitle(line)) {
      startSection(line.replace(/\*/g, '').trim());
      blanksSinceContent = 0;
      lastContentLineIdx = -1;
      continue;
    }

    /* ── after a long-eq divider, first non-blank is section title ── */
    if (expectTitle) {
      /* Update the title of the section we just started */
      curSec.title = line.trim();
      expectTitle  = false;
      blanksSinceContent = 0;
      lastContentLineIdx = -1;  // reset: title is NOT a data header
      continue;
    }

    /* ── ensure we have a current section ── */
    if (!curSec) {
      /* First section: use meta.subtitle as title if available */
      startSection(meta.subtitle || '');
    }

    /* ── accumulate line into current section ── */
    curSec.rawLines.push(line);
    blanksSinceContent = 0;
    lastContentLineIdx = i;
  }

  if (curSec) rawSections.push(curSec);   /* keep even empty sections (e.g. "EE with Warning") */

  log.push(`Step 3: ${rawSections.length} raw section(s): ${rawSections.map(s => `"${s.title||'(main)'}"`).join(', ')}`);

  /* ── PASS 2: parse each raw section into cols + rows ── */
  const sections = [];

  for (const rs of rawSections) {
    const parsed = parseRawSection(rs.rawLines);
    /* Always keep the section so its title appears as a tab, even when empty */
    sections.push({ title: rs.title, cols: parsed.cols, rows: parsed.rows, totals: parsed.totals });
  }

  log.push(`Step 4: ${sections.map(s => `"${s.title||'(main)'}":${s.rows.length}rows`).join(', ')}`);

  /* KV blocks and totals */
  const kvBlocks = extractKvBlocks(lines);
  const totals   = extractTotals(lines);
  if (kvBlocks.length) log.push(`Step 5: ${kvBlocks.length} KV block(s)`);

  return {
    log, meta, sections, kvBlocks, totals,
    columns:     sections[0]?.cols  || [],
    dataRows:    sections.flatMap(s => s.rows),
    reportCode:  meta.reportCode,
    reportTitle: meta.reportTitle,
    orgName:     meta.orgName,
    reportTerm:  meta.term,
    reportDate:  meta.date,
    reportTime:  meta.time,
    reportUser:  meta.user,
    reportDB:    meta.database,
    subtitle:    meta.subtitle,
  };
}

/* ─── parseRawSection: find the column header + sep, then extract rows ─── */
const STOP_DATA_RE = /^\s*(Job Home\s|Job Number\s|Library Used\s|Printer\s|Program Name\s|Software Version\s)/;

function parseRawSection(rawLines) {
  /* Find separator line (first line that is dash or equals sep) */
  let sepIdx  = -1;
  let headIdx = -1;

  for (let i = 0; i < rawLines.length; i++) {
    if (isAnySep(rawLines[i])) {
      sepIdx = i;
      /* Column header = last non-blank non-sep line before sepIdx */
      for (let j = i - 1; j >= 0; j--) {
        if (rawLines[j].trim() !== '' && !isAnySep(rawLines[j])) {
          headIdx = j;
          break;
        }
      }
      break;
    }
  }

  /* Fallback: SFRHCNT – UPPERCASE header, no explicit sep line */
  if (sepIdx === -1) {
    for (let i = 0; i < rawLines.length; i++) {
      const parts = rawLines[i].trim().split(/\s{2,}/);
      const uppers = parts.filter(p => /^[A-Z][A-Z\/]*$/.test(p.trim()));
      if (parts.length >= 4 && uppers.length >= 4) {
        return parseWithHeaderOnly(rawLines, i);
      }
    }
    return { cols: [], rows: [], totals: [] };
  }

  const cols = colsFromSep(rawLines[sepIdx], headIdx >= 0 ? rawLines[headIdx] : '');
  if (!cols.length) return { cols: [], rows: [], totals: [] };

  /* Extract data rows */
  const rows    = [];
  const totals  = [];
  let   pending = null;

  for (let i = sepIdx + 1; i < rawLines.length; i++) {
    const raw = rawLines[i];

    if (STOP_DATA_RE.test(raw)) break;

    /* Sub-separator or page-repeat separator → flush.
       Also drop the line immediately before a separator if it matches the
       original column-header line (page-repeat header text reprint). */
    if (isAnySep(raw)) {
      if (pending) { rows.push(pending); pending = null; }
      /* If the last row we just pushed looks like a repeated column header
         (matches headIdx content), pop it back out */
      if (rows.length > 0 && headIdx >= 0) {
        const origHead = rawLines[headIdx];
        const lastRow  = rows[rows.length - 1];
        /* Reconstruct what the header would look like if parsed as a data row */
        const headAsRow = cols.map(col => origHead.substring(col.start, Math.min(col.end, origHead.length)).trim());
        if (lastRow.every((v, ci) => v === headAsRow[ci])) {
          rows.pop();  /* remove the spurious repeated-header row */
        }
      }
      continue;
    }

    /* Total lines — parse using column positions so values align with table columns */
    if (/^\s*Total\b/i.test(raw)) {
      if (pending) { rows.push(pending); pending = null; }
      /* Build a structured total row: parse each column slot same way as data rows */
      const totalCells = cols.map(col => raw.substring(col.start, Math.min(col.end, raw.length)).trim());
      /* If col-0 slot is empty (number is only in later cols), fill label there */
      if (!totalCells[0]) totalCells[0] = (raw.match(/^\s*(Total\s*\S*)/i) || [])[1] || 'Total';
      totals.push({ label: raw.trim(), cells: totalCells });
      continue;
    }

    if (raw.trim() === '') {
      if (pending) { rows.push(pending); pending = null; }
      continue;
    }

    /* Continuation row: first column slice is blank */
    const firstSlice = raw.substring(cols[0].start, Math.min(cols[0].end, raw.length));
    if (firstSlice.trim() === '' && pending) {
      cols.forEach((col, ci) => {
        const slice = raw.substring(col.start, Math.min(col.end, raw.length)).trim();
        if (slice) pending[ci] = pending[ci] ? pending[ci] + ' ' + slice : slice;
      });
      continue;
    }

    if (pending) rows.push(pending);
    const row = cols.map(col => raw.substring(col.start, Math.min(col.end, raw.length)).trim());
    pending = row.some(v => v !== '') ? row : null;
  }
  if (pending) rows.push(pending);

  return { cols, rows, totals };
}

/* SFRHCNT fallback: build cols from UPPERCASE header line using token positions */
function parseWithHeaderOnly(rawLines, headerIdx) {
  const headerLine = rawLines[headerIdx];
  const cols = [];
  const re   = /(\S+(?:\s\S+)*)/g;
  let m;
  const tokens = [];
  let   pos = 0;
  for (const part of headerLine.split(/(\s{2,})/)) {
    if (part.trim()) tokens.push({ name: part.trim(), start: pos });
    pos += part.length;
  }
  for (let i = 0; i < tokens.length; i++) {
    tokens[i].end = i + 1 < tokens.length ? tokens[i + 1].start : 9999;
    cols.push(tokens[i]);
  }

  const rows   = [];
  const totals = [];
  let   pending = null;

  for (let i = headerIdx + 1; i < rawLines.length; i++) {
    const raw = rawLines[i];
    if (STOP_DATA_RE.test(raw)) break;
    if (isAnySep(raw)) { if (pending) { rows.push(pending); pending = null; } continue; }
    if (/^\s*Total\b/i.test(raw)) {
      if (pending) { rows.push(pending); pending = null; }
      const totalCells = cols.map(col => raw.substring(col.start, Math.min(col.end, raw.length)).trim());
      if (!totalCells[0]) totalCells[0] = (raw.match(/^\s*(Total\s*\S*)/i) || [])[1] || 'Total';
      totals.push({ label: raw.trim(), cells: totalCells });
      continue;
    }
    if (raw.trim() === '') { if (pending) { rows.push(pending); pending = null; } continue; }

    const firstSlice = raw.substring(cols[0].start, Math.min(cols[0].end, raw.length));
    if (firstSlice.trim() === '' && pending) {
      cols.forEach((col, ci) => {
        const slice = raw.substring(col.start, Math.min(col.end, raw.length)).trim();
        if (slice) pending[ci] = pending[ci] ? pending[ci] + ' ' + slice : slice;
      });
      continue;
    }

    if (pending) rows.push(pending);
    const row = cols.map(col => raw.substring(col.start, Math.min(col.end, raw.length)).trim());
    pending = row.some(v => v !== '') ? row : null;
  }
  if (pending) rows.push(pending);

  return { cols, rows, totals };
}

/* ═══════════════════════════════════════════════════════════════════════════
   KV + TOTALS EXTRACTORS
   ═══════════════════════════════════════════════════════════════════════════ */
function extractKvBlocks(lines) {
  const blocks = [];
  let cur = null;

  for (const line of lines) {
    if (/REPORT CONTROL INFORMATION/i.test(line)) {
      if (cur) blocks.push(cur);
      cur = { title: 'Report Control Information', rows: [] };
      continue;
    }
    if (isParamHeader(line)) {
      if (cur) blocks.push(cur);
      cur = { title: 'Parameters', rows: [] };
      continue;
    }
    if (/^\s+Job Home\s/i.test(line) && !cur) {
      cur = { title: 'Job Information', rows: [] };
    }
    if (!cur) continue;
    if (/^[-=\s]{5,}$/.test(line)) continue;
    if (isMetaLine(line)) continue;

    /* "  01  label   value" */
    let m = line.match(/^\s*(\d{1,2})\s{1,5}(.+?)\s{3,}(.+?)\s*$/);
    if (m) { cur.rows.push({ key: `${m[1]}. ${m[2].trim()}`, value: m[3].trim() }); continue; }

    /* "     label (≥5 spaces) value" */
    m = line.match(/^\s{3,}(.{4,}?)\s{5,}(.+?)\s*$/);
    if (m && !isMetaLine(m[1])) cur.rows.push({ key: m[1].trim(), value: m[2].trim() });
  }
  if (cur) blocks.push(cur);
  return blocks.filter(b => b.rows.length > 0);
}

function extractTotals(lines) {
  const totals = [];
  for (const line of lines) {
    const m = line.match(/^(Total\s+.+?):\s*(\S+)/i);
    if (m) totals.push({ key: m[1].trim(), value: m[2].trim() });
  }
  return totals;
}

/* ═══════════════════════════════════════════════════════════════════════════
   BUILD CSV
   ═══════════════════════════════════════════════════════════════════════════ */
function buildCsv(parsed) {
  const { sections } = parsed;
  const esc = v => { const s = String(v ?? ''); return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g,'""')}"` : s; };
  if (!sections.length) return '';
  if (sections.length === 1) {
    const { cols, rows } = sections[0];
    return [cols.map(c => esc(c.name)).join(','), ...rows.map(r => r.map(esc).join(','))].join('\r\n');
  }
  /* Multi-section: union columns + Section prefix */
  const allNames = [], seen = new Set();
  sections.forEach(s => s.cols.forEach(c => { if (!seen.has(c.name)) { seen.add(c.name); allNames.push(c.name); } }));
  const lines = [['Section', ...allNames].map(esc).join(',')];
  sections.forEach(s => {
    const idx = {};
    s.cols.forEach((c, i) => { idx[c.name] = i; });
    s.rows.forEach(row => {
      lines.push([esc(s.title), ...allNames.map(n => esc(idx[n] !== undefined ? row[idx[n]] ?? '' : ''))].join(','));
    });
  });
  return lines.join('\r\n');
}

/* ═══════════════════════════════════════════════════════════════════════════
   BUILD INTERACTIVE HTML REPORT
   ═══════════════════════════════════════════════════════════════════════════ */
function buildReportHtml(parsed, form) {
  const { meta, sections, kvBlocks, totals } = parsed;

  const heading  = form.Heading_Text     || meta.reportTitle || meta.reportCode || 'Report';
  const univName = form.headerUniversity || meta.orgName     || 'Universal University';
  const subtitle = meta.subtitle || '';
  const logoPath = form.logoPath || '';
  const outName  = form.Output_File_Name || 'report';
  const now      = new Date();
  const fmtDate  = now.toLocaleDateString('en-US');
  const fmtTime  = now.toLocaleTimeString('en-US');

  const logoHtml = logoPath
    ? `<img src="${escH(logoPath)}" alt="Logo" class="gw-logo-img" onerror="this.style.display='none'">`
    : `<div class="gw-logo-fallback">${escH(univName.charAt(0).toUpperCase())}</div>`;

  const metaParts = [
    meta.reportCode && `Report: ${meta.reportCode}`,
    meta.user       && `User: ${meta.user}`,
    meta.database   && `DB: ${meta.database}`,
    meta.term       && `Term: ${meta.term}`,
    meta.date       && `Date: ${meta.date}`,
    meta.time       && `Time: ${meta.time}`,
    `Generated: ${fmtDate} ${fmtTime}`,
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');

  /* ── section HTML blocks ── */
  const secBlocks = sections.map((sec, si) => {
    const { title, cols, rows, totals: secTotals } = sec;
    /* Empty section (no columns) — render a placeholder tab panel */
    if (!cols.length) return `
<div class="section-block" id="sec${si}">
  ${title ? `<div class="sec-title">${escH(title)}</div>` : ''}
  <div class="empty-section">No records found for this section.</div>
</div>`;

    const thCells = cols.map((c) =>
      `<th onclick="sortTable(${si}, this.cellIndex)">` +
        `<div class="thWrap">` +
          `<span class="headerText" data-original="${escH(c.name)}" title="Double-click to rename" onclick="event.stopPropagation();" ondblclick="startHeaderEdit(this,event)">${escH(c.name)}</span>` +
          `<span class="hMini hMoveLeft"  title="Move column left"  onclick="hColAct(this,event,'left')">&#8592;</span>` +
          `<span class="hMini hMoveRight" title="Move column right" onclick="hColAct(this,event,'right')">&#8594;</span>` +
          `<span class="hMini hSort"      title="Sort this column"  onclick="hColAct(this,event,'sort')">&#8597;</span>` +
          `<span class="hMini hInsert"    title="Insert new column before this column" onclick="hColAct(this,event,'insert')">&#65291;</span>` +
          `<span class="hMini hDelete"    title="Remove this column" onclick="hColAct(this,event,'delete')">&times;</span>` +
        `</div>` +
      `</th>`
    ).join('');

    const filterSelects = cols.map((col, ci) => {
      const unique = [...new Set(rows.map(r => r[ci] ?? ''))].sort();
      const opts   = unique.map(v => `<option value="${escH(v)}">${escH(v) || '(blank)'}</option>`).join('');
      return `<label class="flt-label">${escH(col.name)}<select class="col-filter" data-sec="${si}" data-col="${ci}" onchange="applyFilters(${si})"><option value="">All</option>${opts}</select></label>`;
    }).join('');

    const trRows = rows.map(row =>
      `<tr>${row.map((v, ci) => `<td data-col="${ci}">${escH(v)}</td>`).join('')}</tr>`
    ).join('\n');

    /* Render each Total line as a proper tfoot row aligned to its columns */
    const tfootRows = (secTotals && secTotals.length)
      ? secTotals.map(t => {
          /* t may be a structured { label, cells[] } object or legacy plain string */
          if (t && typeof t === 'object' && Array.isArray(t.cells)) {
            return `<tr class="total-row">${t.cells.map((v, ci) =>
              `<td data-col="${ci}">${escH(v)}</td>`
            ).join('')}</tr>`;
          }
          /* Legacy plain string: just show label in first col */
          return `<tr class="total-row"><td colspan="${cols.length}">${escH(String(t))}</td></tr>`;
        }).join('\n')
      : '';
    const totalsRow = '';  /* no longer used — totals are in tfoot */

    return `
<div class="section-block" id="sec${si}">
  ${title ? `<div class="sec-title">${escH(title)}</div>` : ''}
  <div class="tb">
    <input type="text" id="gs${si}" placeholder="🔍  Search all columns…" oninput="applyFilters(${si})">
    <button class="btn btn-green" onclick="exportCsv(${si})">⬇ CSV</button>
    <button class="btn btn-ol"    onclick="toggleFilters(${si})">⚙ Column Filters</button>
    <span class="badge" id="rc${si}">${rows.length} rows</span>
    <label style="font-size:12px;color:var(--muted);">Per page:
      <select id="ps${si}" onchange="setPs(${si})" style="margin-left:4px;">
        <option>25</option><option>50</option><option>100</option>
        <option>250</option><option value="0">All</option>
      </select>
    </label>
    <button class="btn btn-ol" onclick="window.print()">🖨 Print</button>
  </div>
  <div class="flt-row" id="flt${si}" style="display:none;">${filterSelects}</div>
  <div class="tw">
    <table class="rt-tbl" id="tbl${si}">
      <thead><tr id="hr${si}">${thCells}</tr></thead>
      <tbody id="tb${si}">${trRows}</tbody>
      ${tfootRows ? `<tfoot id="tft${si}">${tfootRows}</tfoot>` : ''}
    </table>
  </div>
  <div class="pgr">
    <button onclick="cp(${si},-1)" id="pb${si}">◀ Prev</button>
    <span class="pi" id="pi${si}"></span>
    <button onclick="cp(${si},1)"  id="nb${si}">Next ▶</button>
  </div>
</div>`;
  }).join('');

  /* ── tabs (show when >1 section, including empty ones) ── */
  const sectionsWithData = sections.filter(s => s.cols.length > 0);
  const tabNav = sections.length > 1
    ? `<div class="tab-nav">${sections.map((s, i) => {
        const label = s.title || `Section ${i + 1}`;
        const isFirst = (i === 0);
        return `<button class="tab-btn${isFirst ? ' active' : ''}" onclick="showTab(${i})">${escH(label)}<span class="tab-ct">${s.rows.length}</span></button>`;
      }).join('')}</div>`
    : '';

  /* ── KV + totals ── */
  const kvHtml = kvBlocks.map(b => `
    <div class="kv-block">
      <div class="kv-title">${escH(b.title)}</div>
      <table class="kv-table"><tbody>
        ${b.rows.map(r => `<tr><td class="kv-key">${escH(r.key)}</td><td class="kv-val">${escH(r.value)}</td></tr>`).join('')}
      </tbody></table>
    </div>`).join('');

  const totalsHtml = totals.length ? `
    <div class="kv-block">
      <div class="kv-title">Totals</div>
      <table class="kv-table"><tbody>
        ${totals.map(t => `<tr><td class="kv-key">${escH(t.key)}</td><td class="kv-val">${escH(t.value)}</td></tr>`).join('')}
      </tbody></table>
    </div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escH(heading)}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@3.9.1/dist/chart.min.js"></script>
<link href="https://fonts.googleapis.com/css2?family=Merriweather:wght@700&family=Source+Sans+3:wght@400;600;700&display=swap" rel="stylesheet">
<style>
:root{
  --blue:#003A5D;--gold:#FFBE00;--lb:#0054A4;--bg:#f4f6f8;
  --white:#fff;--border:#d1d9e0;--text:#1a2733;--muted:#5a6a7a;
  --alt:#eef2f7;--chdr:#1a4f7a;--green:#27ae60;
  --shadow:0 4px 12px rgba(0,0,0,.15);--r:4px;
  --fd:'Merriweather',Georgia,serif;--fb:'Source Sans 3','Segoe UI',sans-serif;
}
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:var(--fb);background:var(--bg);color:var(--text);font-size:13px;}
/* header */
.hdr{background:#2e78b0;color:#fff;display:flex;align-items:stretch;min-height:82px;box-shadow:var(--shadow);}
.hl{padding:10px 16px;border-right:1px solid rgba(255,255,255,.15);display:flex;align-items:center;min-width:185px;}
.hm{display:flex;flex-direction:column;gap:3px;}
.mr{display:flex;gap:6px;font-size:11px;}
.ml{color:rgba(255,255,255,.6);font-weight:600;white-space:nowrap;}
.mv{color:var(--gold);}
.hc{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:12px 20px;text-align:center;gap:3px;}
.h-org{font-family:var(--fd);font-size:18px;font-weight:700;line-height:1.2;}
.h-title{font-size:13px;color:rgba(255,255,255,.9);font-weight:600;}
.h-sub{font-size:11px;color:rgba(255,255,255,.7);letter-spacing:.03em;}
.hrr{display:flex;align-items:center;justify-content:flex-end;padding:10px 16px;border-left:1px solid rgba(255,255,255,.15);min-width:80px;}
.gw-logo-img{max-height:60px;max-width:120px;object-fit:contain;filter:drop-shadow(0 1px 3px rgba(0,0,0,.25));}
.gw-logo-fallback{font-family:var(--fd);font-size:28px;font-weight:700;color:var(--gold);}
/* page */
.pw{padding:18px 20px;}
.page-meta{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;font-size:11px;color:var(--muted);margin-bottom:14px;line-height:1.7;}
.meta-text{flex:1;min-width:220px;}
.page-actions{display:flex;gap:10px;align-items:center;}
.page-actions .btn{font-size:12px;}
/* tabs */
.tab-nav{display:flex;flex-wrap:wrap;gap:0 2px;border-bottom:2px solid var(--lb);}
.tab-btn{padding:8px 16px;font-size:12px;font-weight:700;font-family:var(--fb);background:var(--white);
  border:1.5px solid var(--border);border-bottom:none;cursor:pointer;color:var(--muted);
  transition:all .15s;border-radius:4px 4px 0 0;display:flex;align-items:center;gap:6px;}
.tab-btn:hover{background:var(--alt);color:var(--lb);}
.tab-btn.active{background:var(--lb);color:#fff;border-color:var(--lb);}
.tab-ct{font-size:10px;background:rgba(0,0,0,.15);border-radius:10px;padding:1px 6px;font-weight:700;}
.tab-btn:not(.active) .tab-ct{background:#dde4ed;color:var(--muted);}
.section-block{display:none;padding-top:14px;}
.section-block.visible{display:block;}
/* section */
.sec-title{font-family:var(--fd);font-size:15px;color:var(--blue);margin-bottom:10px;
  padding-bottom:6px;border-bottom:1px solid var(--border);}
.sec-totals{font-size:12px;color:var(--muted);margin-top:6px;padding:6px 10px;
  background:var(--alt);border-radius:var(--r);}
/* toolbar */
.tb{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px;
  background:var(--white);border:1px solid var(--border);border-radius:var(--r);
  padding:9px 14px;box-shadow:var(--shadow);}
.tb input[type=text]{padding:5px 9px;border:1.5px solid var(--border);border-radius:var(--r);
  font-size:12px;font-family:var(--fb);outline:none;min-width:200px;}
.tb input:focus{border-color:var(--lb);}
.btn{display:inline-flex;align-items:center;gap:4px;padding:5px 12px;border-radius:var(--r);
  font-size:12px;font-weight:600;border:1.5px solid transparent;cursor:pointer;
  font-family:var(--fb);transition:all .15s;text-decoration:none;}
.btn-green{background:var(--green);color:#fff;border-color:#219a52;}
.btn-green:hover{background:#219a52;}
.btn-ol{background:transparent;color:var(--lb);border-color:var(--lb);}
.btn-ol:hover{background:rgba(0,84,164,.08);}
.btn-gray{background:#ccc;color:#333;border-color:#999;}
.btn-gray:hover{background:#bbb;}
.btn-graph{background:#0054a4;color:#fff;border-color:#003a7a;}
.btn-graph:hover{background:#003a7a;}
/* Modal styles */
.graph-modal{
  position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);
  z-index:1000;display:flex;align-items:center;justify-content:center;
}
.graph-modal-content{
  background:var(--white);border:1px solid var(--border);border-radius:var(--r);
  box-shadow:0 8px 24px rgba(0,0,0,0.3);max-width:400px;width:90%;
}
.graph-modal-header{
  display:flex;justify-content:space-between;align-items:center;
  padding:16px 20px;border-bottom:1px solid var(--border);
}
.graph-modal-header h3{font-family:var(--fd);font-size:14px;color:var(--blue);margin:0;}
.graph-close-btn{background:none;border:none;font-size:20px;cursor:pointer;color:var(--muted);} 
.graph-close-btn:hover{color:var(--blue);} 
.graph-modal-body{padding:20px;} 
.graph-form-group{margin-bottom:16px;} 
.graph-form-group label{display:block;font-size:12px;font-weight:700;color:var(--text);
  margin-bottom:6px;text-transform:uppercase;letter-spacing:.02em;} 
.graph-select{width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:var(--r);
  font-size:12px;font-family:var(--fb);background:#fff;outline:none;} 
.graph-select:focus{border-color:var(--lb);box-shadow:0 0 0 3px rgba(0,84,164,.1);} 
.graph-form-buttons{display:flex;gap:8px;justify-content:flex-end;margin-top:20px;} 
.graph-form-buttons .btn{margin:0;} 
.graph-container{display:none;} 
@media print{.graph-modal,.graph-container{display:none!important;}}
.badge{font-size:11px;color:var(--muted);padding:4px 8px;background:#eef2f7;border-radius:var(--r);}
/* filter row */
.flt-row{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;}
.flt-label{font-size:10px;color:var(--muted);font-weight:700;text-transform:uppercase;
  letter-spacing:.04em;display:flex;flex-direction:column;gap:2px;}
.col-filter{padding:3px 5px;border:1px solid var(--border);border-radius:var(--r);
  font-size:11px;font-family:var(--fb);background:#fff;outline:none;max-width:150px;}
.col-filter:focus{border-color:var(--lb);}
/* table */
.tw{overflow-x:auto;border-radius:var(--r);box-shadow:var(--shadow);
  border:1px solid var(--border);margin-bottom:8px;}
table.rt-tbl{width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap;}
table.rt-tbl thead tr{background:var(--chdr);color:#fff;}
table.rt-tbl thead th{padding:8px 12px;text-align:left;font-size:11px;font-weight:700;
  letter-spacing:.04em;text-transform:uppercase;cursor:pointer;user-select:none;position:sticky;top:0;}
table.rt-tbl thead th:hover{background:#163d61;}
table.rt-tbl thead th.sa::after{content:' ▲';}
table.rt-tbl thead th.sd::after{content:' ▼';}
table.rt-tbl tbody tr:nth-child(even){background:var(--alt);}
table.rt-tbl tbody tr:hover{background:#dce8f4;}
table.rt-tbl tbody td{padding:5px 12px;border-bottom:1px solid var(--border);}
.hidden{display:none!important;}
/* empty section placeholder */
.empty-section{padding:28px 18px;color:var(--muted);font-style:italic;font-size:13px;background:var(--white);border:1px solid var(--border);border-radius:var(--r);margin-top:10px;}
/* totals footer row */
table.rt-tbl tfoot tr.total-row td{padding:6px 12px;font-weight:700;color:var(--text);border-top:2px solid var(--chdr);background:var(--alt);}
/* column-header inline controls */
table.rt-tbl thead th .thWrap{display:flex;align-items:center;justify-content:flex-start;gap:4px;width:100%;}
table.rt-tbl thead th .headerText{display:inline-block;padding:2px 6px;border-radius:3px;cursor:text;outline:none;color:#fff;flex:0 1 auto;min-width:24px;}
table.rt-tbl thead th .headerText.editing{background:#fff7cc;color:#000;}
.hMini{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;font-size:11px;font-weight:700;cursor:pointer;background:#fff;color:#0b2d4d;border:1px solid rgba(0,0,0,.18);user-select:none;text-transform:none;letter-spacing:0;line-height:1;}
.hMini:hover{filter:brightness(.95);}
.hDelete{background:#fff0f0;color:#a32020;}
.hInsert{background:#ecfdf5;color:#047857;}
.hMoveLeft,.hMoveRight{background:#eef6ff;color:#0f5cc0;}
.hSort{background:#fff8e1;color:#7a5c00;}
/* pager */
.pgr{display:flex;align-items:center;gap:8px;margin-bottom:16px;justify-content:flex-end;flex-wrap:wrap;}
.pgr button{padding:4px 10px;border:1.5px solid var(--border);border-radius:var(--r);
  font-size:12px;font-family:var(--fb);background:#fff;cursor:pointer;}
.pgr button:hover:not(:disabled){border-color:var(--lb);color:var(--lb);}
.pgr button:disabled{opacity:.45;cursor:not-allowed;}
.pi{font-size:12px;color:var(--muted);}
/* KV blocks */
.kv-section{margin-top:22px;display:flex;flex-wrap:wrap;gap:16px;}
.kv-block{background:var(--white);border:1px solid var(--border);border-radius:var(--r);
  box-shadow:var(--shadow);padding:14px 18px;min-width:280px;max-width:680px;flex:1;}
.kv-title{font-family:var(--fd);font-size:13px;font-weight:700;color:var(--blue);
  margin-bottom:8px;border-bottom:1px solid var(--border);padding-bottom:5px;}
.kv-table{width:100%;border-collapse:collapse;font-size:12px;}
.kv-table tr:nth-child(even){background:var(--alt);}
.kv-key{padding:4px 10px 4px 0;color:var(--muted);font-weight:600;white-space:nowrap;width:230px;vertical-align:top;}
.kv-val{padding:4px 0;color:var(--text);}
@media print{
  .tb,.pgr,.flt-row,.tab-nav{display:none!important;}
  .section-block{display:block!important;}
  thead th{background:var(--chdr)!important;-webkit-print-color-adjust:exact;}
}
</style>
</head>
<body>
<header class="hdr">
  <div class="hl">
    <div class="hm">
      ${meta.reportCode ? `<div class="mr"><span class="ml">REPORT:</span><span class="mv">${escH(meta.reportCode)}</span></div>` : ''}
      ${meta.user       ? `<div class="mr"><span class="ml">USER:</span><span class="mv">${escH(meta.user)}</span></div>`       : ''}
      ${meta.database   ? `<div class="mr"><span class="ml">DB:</span><span class="mv">${escH(meta.database)}</span></div>`     : ''}
      ${meta.term       ? `<div class="mr"><span class="ml">TERM:</span><span class="mv">${escH(meta.term)}</span></div>`       : ''}
      ${meta.date       ? `<div class="mr"><span class="ml">DATE:</span><span class="mv">${escH(meta.date)}</span></div>`       : ''}
      ${meta.time       ? `<div class="mr"><span class="ml">TIME:</span><span class="mv">${escH(meta.time)}</span></div>`       : ''}
    </div>
  </div>
  <div class="hc">
    <div class="h-org">${escH(univName)}</div>
    <div class="h-title">${escH(heading)}</div>
    ${subtitle ? `<div class="h-sub">${escH(subtitle)}</div>` : ''}
  </div>
  <div class="hrr">
    <button class="btn btn-graph" onclick="openGraphModal(getActiveSection())">📊 Create a Graph</button>
    <button class="btn btn-gray" onclick="clearPage()">Clear</button>
    ${logoHtml}
  </div>
</header>

<div class="pw">
  <div class="page-meta">
    <div class="meta-text">${metaParts}</div>
  </div>
  ${tabNav}
  ${secBlocks}
  <div id="graph-modal" class="graph-modal" style="display:none;">
    <div class="graph-modal-content">
      <div class="graph-modal-header">
        <h3>Create a Graph</h3>
        <button class="graph-close-btn" onclick="closeGraphModal()">✕</button>
      </div>
      <div class="graph-modal-body">
        <div class="graph-form-group">
          <label>Graph Type:</label>
          <select id="gt" class="graph-select">
            <option value="pie">Pie Chart</option>
            <option value="bar">Bar Chart</option>
            <option value="line">Line Chart</option>
          </select>
        </div>
        <div class="graph-form-group">
          <label>Label Column (X-axis / Labels):</label>
          <select id="gc1" class="graph-select"></select>
        </div>
        <div class="graph-form-group">
          <label>Value Column (Y-axis / Values):</label>
          <select id="gc2" class="graph-select"></select>
        </div>
        <div class="graph-form-buttons">
          <button class="btn btn-green" onclick="generateGraph()">Submit</button>
          <button class="btn btn-gray" onclick="closeGraphModal()">Cancel</button>
        </div>
      </div>
    </div>
  </div>
  <div class="graph-container" id="graph-container" style="display:none; margin-top: 20px; padding: 15px; background: white; border: 1px solid var(--border); border-radius: var(--r);">
    <canvas id="graph-chart" style="max-height: 400px;"></canvas>
  </div>
  ${(kvBlocks.length || totals.length) ? `<div class="kv-section">${totalsHtml}${kvHtml}</div>` : ''}
</div>

<script>
var NSEC=${sections.length};
var state=[];
var sectionCols=${JSON.stringify(sections.map(s => s.cols.map(c => c.name)))};
var chartInstances = {};  /* Store Chart.js instances */
for(var _i=0;_i<NSEC;_i++) state.push({allR:[],filt:[],ps:25,pg:1,sc:-1,sa:true});

function init(){
  for(var i=0;i<NSEC;i++){
    var tb=document.getElementById('tb'+i);
    state[i].allR=tb?Array.from(tb.querySelectorAll('tr')):[];
    state[i].filt=state[i].allR.slice();
  }
  if(${sections.length}>1){
    document.querySelectorAll('.section-block').forEach(function(b){b.classList.remove('visible');});
    /* show first section block */
    var first=document.querySelector('.section-block');
    if(first) first.classList.add('visible');
  } else {
    document.querySelectorAll('.section-block').forEach(function(b){b.classList.add('visible');});
  }
  for(var j=0;j<NSEC;j++) render(j);
}
function showTab(si){
  document.querySelectorAll('.section-block').forEach(function(b){b.classList.remove('visible');});
  document.querySelectorAll('.tab-btn').forEach(function(b){b.classList.remove('active');});
  var sb=document.getElementById('sec'+si); if(sb) sb.classList.add('visible');
  var tabs=document.querySelectorAll('.tab-btn'); if(tabs[si]) tabs[si].classList.add('active');
}
function toggleFilters(si){
  var r=document.getElementById('flt'+si);
  if(r) r.style.display=(r.style.display==='none'?'flex':'none');
}
function applyFilters(si){
  var s=(document.getElementById('gs'+si)||{value:''}).value.toLowerCase();
  var cf=Array.from(document.querySelectorAll('.col-filter[data-sec="'+si+'"]')).map(function(x){return x.value.toLowerCase();});
  state[si].filt=state[si].allR.filter(function(tr){
    var cells=Array.from(tr.cells);
    if(s&&!cells.some(function(td){return td.textContent.toLowerCase().includes(s);})) return false;
    for(var i=0;i<cf.length;i++){if(cf[i]&&cells[i]&&cells[i].textContent.trim().toLowerCase()!==cf[i]) return false;}
    return true;
  });
  state[si].pg=1; render(si);
}
function sortTable(si,ci){
  var ths=document.querySelectorAll('#hr'+si+' th');
  var st=state[si];
  if(st.sc===ci){st.sa=!st.sa;}else{st.sc=ci;st.sa=true;}
  ths.forEach(function(th,i){th.classList.remove('sa','sd');if(i===ci)th.classList.add(st.sa?'sa':'sd');});
  st.filt.sort(function(a,b){
    var av=(a.cells[ci]||{}).textContent||'',bv=(b.cells[ci]||{}).textContent||'';
    var an=parseFloat(av.replace(/[,$%]/g,'')),bn=parseFloat(bv.replace(/[,$%]/g,''));
    var cmp=(!isNaN(an)&&!isNaN(bn))?an-bn:av.localeCompare(bv);
    return st.sa?cmp:-cmp;
  });
  render(si);
}
function setPs(si){state[si].ps=parseInt(document.getElementById('ps'+si).value)||0;state[si].pg=1;render(si);}
function cp(si,d){var st=state[si];var tot=Math.ceil(st.filt.length/(st.ps||st.filt.length))||1;st.pg=Math.max(1,Math.min(st.pg+d,tot));render(si);}
function render(si){
  if(!state[si]||!state[si].allR.length) return;  /* empty section – nothing to render */
  var st=state[si],p=st.ps||st.filt.length,tot=Math.ceil(st.filt.length/p)||1;
  st.pg=Math.min(st.pg,tot);
  var s=(st.pg-1)*p,e=s+p;
  st.allR.forEach(function(r){r.classList.add('hidden');});
  var tb=document.getElementById('tb'+si);
  st.filt.forEach(function(r,i){if(i>=s&&i<e){r.classList.remove('hidden');if(tb)tb.appendChild(r);}});
  var rc=document.getElementById('rc'+si); if(rc) rc.textContent=st.filt.length+' / '+st.allR.length+' rows';
  var pi=document.getElementById('pi'+si); if(pi) pi.textContent='Page '+st.pg+' of '+tot;
  var pb=document.getElementById('pb'+si),nb=document.getElementById('nb'+si);
  if(pb) pb.disabled=(st.pg===1); if(nb) nb.disabled=(st.pg===tot);
}
function exportCsv(si){
  var hdrs=Array.from(document.querySelectorAll('#hr'+si+' th')).map(function(th){var s=th.querySelector('.headerText');return (s?s.textContent:th.textContent).trim();});
  var esc=function(v){var s=String(v||'');return(s.includes(',')||s.includes('"'))?'"'+s.replace(/"/g,'""')+'"':s;};
  var lines=[hdrs.map(esc).join(',')];
  state[si].filt.forEach(function(tr){lines.push(Array.from(tr.cells).map(function(td){return esc(td.textContent.trim());}).join(','));});
  var blob=new Blob([lines.join('\\r\\n')],{type:'text/csv;charset=utf-8;'});
  var url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download='${escH(outName)}'+(si>0?'_s'+(si+1):'')+'.csv';a.click();URL.revokeObjectURL(url);
}

/* ─── column header actions: move left/right, insert, delete, rename ─── */
function hColAct(span,event,action){
  if(event){event.preventDefault();event.stopPropagation();}
  var th=span.closest('th'); if(!th) return;
  var tr=th.parentNode;
  var si=tr.id?parseInt(tr.id.replace(/[^0-9]/g,''),10):0;
  if(isNaN(si)) si=0;
  var idx=Array.prototype.indexOf.call(tr.children,th);
  if(action==='left')        moveCol(si,idx,idx-1);
  else if(action==='right')  moveCol(si,idx,idx+1);
  else if(action==='sort')   sortTable(si,idx);
  else if(action==='insert') insertColAt(si,idx);
  else if(action==='delete') deleteColAt(si,idx);
}
function moveCol(si,from,to){
  var tbl=document.getElementById('tbl'+si); if(!tbl) return;
  var headerRow=document.getElementById('hr'+si); if(!headerRow) return;
  var n=headerRow.children.length;
  if(from<0||to<0||from>=n||to>=n||from===to) return;
  /* move th */
  var movingTh=headerRow.children[from];
  var refTh=headerRow.children[to];
  if(to<from) headerRow.insertBefore(movingTh,refTh);
  else        headerRow.insertBefore(movingTh,refTh.nextSibling);
  /* move cells in every body and tfoot row of this section */
  var rows=tbl.querySelectorAll('tbody tr, tfoot tr');
  rows.forEach(function(r){
    if(r.children.length<=Math.max(from,to)) return;
    var moving=r.children[from];
    var ref=r.children[to];
    if(to<from) r.insertBefore(moving,ref);
    else        r.insertBefore(moving,ref.nextSibling);
  });
  /* update sectionCols cache */
  if(sectionCols[si]){
    var arr=sectionCols[si], item=arr.splice(from,1)[0];
    arr.splice(to,0,item);
  }
  rebindHeader(si);
  refreshFilters(si);
}
function insertColAt(si,index){
  var headerRow=document.getElementById('hr'+si); if(!headerRow) return;
  var name=prompt('New column name:','New Column');
  if(name===null) return;
  name=String(name||'New Column').trim()||'New Column';
  /* Build a new TH with the same controls */
  var th=document.createElement('th');
  th.setAttribute('onclick','sortTable('+si+', this.cellIndex)');
  th.innerHTML='<div class="thWrap">'+
    '<span class="headerText" data-original="'+esc(name)+'" title="Double-click to rename" onclick="event.stopPropagation();" ondblclick="startHeaderEdit(this,event)">'+esc(name)+'</span>'+
    '<span class="hMini hMoveLeft"  title="Move column left"  onclick="hColAct(this,event,\\'left\\')">&#8592;</span>'+
    '<span class="hMini hMoveRight" title="Move column right" onclick="hColAct(this,event,\\'right\\')">&#8594;</span>'+
    '<span class="hMini hSort"      title="Sort this column"  onclick="hColAct(this,event,\\'sort\\')">&#8597;</span>'+
    '<span class="hMini hInsert"    title="Insert new column before this column" onclick="hColAct(this,event,\\'insert\\')">&#65291;</span>'+
    '<span class="hMini hDelete"    title="Remove this column" onclick="hColAct(this,event,\\'delete\\')">&times;</span>'+
    '</div>';
  if(index>=headerRow.children.length) headerRow.appendChild(th);
  else headerRow.insertBefore(th,headerRow.children[index]);
  /* insert empty editable td in every body/tfoot row */
  var tbl=document.getElementById('tbl'+si);
  var rows=tbl.querySelectorAll('tbody tr, tfoot tr');
  rows.forEach(function(r){
    var td=document.createElement('td');
    td.setAttribute('contenteditable','true');
    td.setAttribute('data-col',index);
    td.innerHTML='';
    if(index>=r.children.length) r.appendChild(td);
    else r.insertBefore(td,r.children[index]);
  });
  if(sectionCols[si]) sectionCols[si].splice(index,0,name);
  rebindHeader(si);
  refreshFilters(si);
}
function deleteColAt(si,index){
  var headerRow=document.getElementById('hr'+si); if(!headerRow) return;
  if(headerRow.children.length<=1){alert('At least one column must remain.');return;}
  var name=(headerRow.children[index].querySelector('.headerText')||{}).textContent||('Column '+(index+1));
  if(!confirm('Remove column "'+name.trim()+'" ?')) return;
  headerRow.removeChild(headerRow.children[index]);
  var tbl=document.getElementById('tbl'+si);
  var rows=tbl.querySelectorAll('tbody tr, tfoot tr');
  rows.forEach(function(r){if(r.children[index]) r.removeChild(r.children[index]);});
  if(sectionCols[si]) sectionCols[si].splice(index,1);
  /* reset sort marker on this section */
  state[si].sc=-1; state[si].sa=true;
  rebindHeader(si);
  refreshFilters(si);
}
function rebindHeader(si){
  /* Re-attach onclick on TH (for sort) so it picks up new cellIndex.
     The mini-buttons compute index from current DOM each time via hColAct. */
  var headerRow=document.getElementById('hr'+si); if(!headerRow) return;
  Array.prototype.forEach.call(headerRow.children,function(th){
    th.onclick=function(){ sortTable(si, this.cellIndex); };
  });
}
function refreshFilters(si){
  /* Rebuild column-filter dropdowns from the current column set + body rows */
  var fltRow=document.getElementById('flt'+si); if(!fltRow) return;
  var headerRow=document.getElementById('hr'+si); if(!headerRow) return;
  var headers=Array.prototype.map.call(headerRow.children,function(th){var s=th.querySelector('.headerText');return (s?s.textContent:th.textContent).trim();});
  var allRows=state[si].allR||[];
  fltRow.innerHTML='';
  headers.forEach(function(name,ci){
    var unique={}, opts='<option value="">All</option>';
    allRows.forEach(function(r){var c=r.cells[ci];var v=c?c.textContent.trim():'';if(!(v in unique)){unique[v]=true;opts+='<option value="'+escAttr(v)+'">'+(v?escAttr(v):'(blank)')+'</option>';}});
    var lab=document.createElement('label');
    lab.className='flt-label';
    lab.innerHTML=escAttr(name)+'<select class="col-filter" data-sec="'+si+'" data-col="'+ci+'" onchange="applyFilters('+si+')">'+opts+'</select>';
    fltRow.appendChild(lab);
  });
  applyFilters(si);
}
function esc(v){return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
function escAttr(v){return esc(v);}

/* ─── inline header rename via double-click ─── */
function startHeaderEdit(span,event){
  if(event){event.preventDefault();event.stopPropagation();}
  if(!span) return;
  span.contentEditable='true';
  span.classList.add('editing');
  span.focus();
  try{var rng=document.createRange();rng.selectNodeContents(span);rng.collapse(false);
    var sel=window.getSelection();sel.removeAllRanges();sel.addRange(rng);}catch(e){}
  span.onblur=function(){finishHeaderEdit(span);};
  span.onkeydown=function(e){
    if(e.key==='Enter'){e.preventDefault();span.blur();}
    else if(e.key==='Escape'){e.preventDefault();span.textContent=span.getAttribute('data-original')||span.textContent;span.contentEditable='false';span.classList.remove('editing');span.blur();}
  };
}
function finishHeaderEdit(span){
  if(!span||span.contentEditable!=='true') return;
  var v=String(span.innerText||span.textContent||'').replace(/\\s+/g,' ').trim();
  if(v==='') v=span.getAttribute('data-original')||'Field';
  span.textContent=v;
  span.setAttribute('data-original',v);
  span.contentEditable='false';
  span.classList.remove('editing');
  /* Update sectionCols cache to keep graph dropdowns in sync */
  var th=span.closest('th'); if(!th) return;
  var tr=th.parentNode;
  var si=tr.id?parseInt(tr.id.replace(/[^0-9]/g,''),10):0;
  var idx=Array.prototype.indexOf.call(tr.children,th);
  if(sectionCols[si]) sectionCols[si][idx]=v;
}

function clearPage(){
  window.location.reload();
}

function getActiveSection(){
  var buttons=document.querySelectorAll('.tab-btn');
  if(!buttons.length) return 0;
  for(var i=0;i<buttons.length;i++){
    if(buttons[i].classList.contains('active')) return i;
  }
  return 0;
}

/* Graph functions */
function populateGraphSelectors(si){
  var labelsSelect=document.getElementById('gc1');
  var valuesSelect=document.getElementById('gc2');
  if(!labelsSelect||!valuesSelect||!sectionCols[si]) return;
  labelsSelect.innerHTML = '<option value="">Select a column...</option>' + sectionCols[si].map(function(name, idx){
    return '<option value="'+idx+'">'+name+'</option>';
  }).join('');
  valuesSelect.innerHTML = labelsSelect.innerHTML;
}

function openGraphModal(si){
  if(typeof si !== 'number' || si < 0) si = getActiveSection();
  populateGraphSelectors(si);
  var modal=document.getElementById('graph-modal');
  if(modal) modal.style.display='flex';
}
function closeGraphModal(){
  var modal=document.getElementById('graph-modal');
  if(modal) modal.style.display='none';
}
function generateGraph(si){
  if(typeof si !== 'number' || si < 0) si = getActiveSection();
  var graphType=document.getElementById('gt').value;
  var labelColIdx=parseInt(document.getElementById('gc1').value);
  var valueColIdx=parseInt(document.getElementById('gc2').value);
  if(isNaN(labelColIdx)||isNaN(valueColIdx)){
    alert('Please select both columns');
    return;
  }
  var hdrs=Array.from(document.querySelectorAll('#hr'+si+' th')).map(function(th){return th.textContent.trim();});
  var labels=[];
  var data=[];
  state[si].allR.forEach(function(tr){
    var cells=Array.from(tr.cells);
    if(cells[labelColIdx]&&cells[valueColIdx]){
      var label=cells[labelColIdx].textContent.trim();
      var val=cells[valueColIdx].textContent.trim();
      var numVal=parseFloat(val.replace(/[,$%]/g,''));
      if(!isNaN(numVal)){
        labels.push(label);
        data.push(numVal);
      }
    }
  });
  if(labels.length===0){
    alert('No valid data found for selected columns');
    return;
  }
  var container=document.getElementById('graph-container');
  var canvas=document.getElementById('graph-chart');
  if(container) container.style.display='block';
  if(chartInstances[si]){
    chartInstances[si].destroy();
  }
  var chartConfig={
    type:graphType,
    data:{
      labels:labels,
      datasets:[{
        label:hdrs[valueColIdx],
        data:data,
        backgroundColor:[
          'rgba(54, 162, 235, 0.7)','rgba(255, 99, 132, 0.7)','rgba(75, 192, 192, 0.7)',
          'rgba(255, 206, 86, 0.7)','rgba(153, 102, 255, 0.7)','rgba(255, 159, 64, 0.7)',
          'rgba(199, 199, 199, 0.7)','rgba(83, 102, 255, 0.7)','rgba(255, 99, 255, 0.7)'
        ],
        borderColor:[
          'rgba(54, 162, 235, 1)','rgba(255, 99, 132, 1)','rgba(75, 192, 192, 1)',
          'rgba(255, 206, 86, 1)','rgba(153, 102, 255, 1)','rgba(255, 159, 64, 1)',
          'rgba(199, 199, 199, 1)','rgba(83, 102, 255, 1)','rgba(255, 99, 255, 1)'
        ],
        borderWidth:1
      }]
    },
    options:{
      responsive:true,
      maintainAspectRatio:true,
      plugins:{
        legend:{position:'top'},
        title:{display:true,text:'Chart: '+hdrs[labelColIdx]+' vs '+hdrs[valueColIdx]}
      },
      scales:(graphType==='pie'?{}:{
        y:{beginAtZero:true}
      })
    }
  };
  chartInstances[si]=new Chart(canvas.getContext('2d'),chartConfig);
  closeGraphModal();
}

init();
</script>
</body>
</html>`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   BUILD FILE-INFO / LOGIC PAGE
   ═══════════════════════════════════════════════════════════════════════════ */
function buildLogicHtml(parsed, form, filename, fileSize) {
  const { meta, sections, kvBlocks, totals } = parsed;
  const univName = form.headerUniversity || meta.orgName || 'Universal University';
  const now = new Date();

  const secRows = sections.map(s =>
    `<tr><td>${escH(s.title||'(main)')}</td><td>${s.cols.length}</td><td>${s.rows.length}</td></tr>`
  ).join('');

  const colStats = sections.map(sec => {
    if (!sec.cols.length) return '';
    const rows = sec.cols.map((col, ci) => {
      const vals = sec.rows.map(r => r[ci] ?? '').filter(v => v !== '');
      const uniq = new Set(vals).size;
      const nums = vals.map(v => parseFloat(String(v).replace(/[,$%]/g,''))).filter(n => !isNaN(n));
      const tot  = nums.length ? nums.reduce((a,b)=>a+b,0).toLocaleString(undefined,{maximumFractionDigits:2}) : '—';
      return `<tr><td>${escH(col.name)}</td><td>${vals.length}</td><td>${uniq}</td><td>${tot}</td></tr>`;
    }).join('');
    return `<div class="card"><h2>Column Stats – ${escH(sec.title||'Main')}</h2>
      <table><thead><tr><th>Column</th><th>Non-blank</th><th>Unique</th><th>Numeric Total</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }).join('');

  const kvHtml = kvBlocks.map(b => `<div class="card"><h2>${escH(b.title)}</h2>
    <table><thead><tr><th>Parameter</th><th>Value</th></tr></thead>
    <tbody>${b.rows.map(r=>`<tr><td>${escH(r.key)}</td><td>${escH(r.value)}</td></tr>`).join('')}</tbody>
    </table></div>`).join('');

  const totHtml = totals.length ? `<div class="card"><h2>Totals</h2>
    <table><thead><tr><th>Description</th><th>Count</th></tr></thead>
    <tbody>${totals.map(t=>`<tr><td>${escH(t.key)}</td><td>${escH(t.value)}</td></tr>`).join('')}</tbody>
    </table></div>` : '';

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><title>File Info – ${escH(meta.reportCode||filename)}</title>
<link href="https://fonts.googleapis.com/css2?family=Merriweather:wght@700&family=Source+Sans+3:wght@400;600;700&display=swap" rel="stylesheet">
<style>
:root{--blue:#003A5D;--bg:#f4f6f8;--white:#fff;--border:#d1d9e0;--text:#1a2733;
  --muted:#5a6a7a;--shadow:0 4px 12px rgba(0,0,0,.15);--r:4px;
  --fd:'Merriweather',Georgia,serif;--fb:'Source Sans 3','Segoe UI',sans-serif;}
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:var(--fb);background:var(--bg);color:var(--text);font-size:13px;padding:24px;}
h1{font-family:var(--fd);font-size:18px;color:var(--blue);margin-bottom:16px;}
.card{background:var(--white);border:1px solid var(--border);border-radius:var(--r);
  box-shadow:var(--shadow);padding:18px 22px;margin-bottom:18px;max-width:840px;}
.card h2{font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;
  letter-spacing:.04em;margin-bottom:10px;}
.ig{display:grid;grid-template-columns:220px 1fr;gap:5px 10px;font-size:12px;}
.ik{font-weight:700;color:var(--muted);} .iv{color:var(--text);}
table{width:100%;border-collapse:collapse;font-size:12px;}
thead tr{background:#1a4f7a;color:#fff;}
thead th{padding:7px 11px;text-align:left;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;}
tbody tr:nth-child(even){background:#eef2f7;}
tbody td{padding:5px 11px;border-bottom:1px solid var(--border);}
</style></head><body>
<h1>📋 File Info / Parameters Page</h1>
<div class="card"><h2>Source File Details</h2><div class="ig">
  <span class="ik">File Name:</span>      <span class="iv">${escH(filename)}</span>
  <span class="ik">File Size:</span>       <span class="iv">${(fileSize/1024).toFixed(1)} KB</span>
  <span class="ik">Report Code:</span>     <span class="iv">${escH(meta.reportCode)}</span>
  <span class="ik">Report Title:</span>    <span class="iv">${escH(meta.reportTitle)}</span>
  <span class="ik">Subtitle:</span>        <span class="iv">${escH(meta.subtitle)}</span>
  <span class="ik">Organization:</span>    <span class="iv">${escH(meta.orgName||univName)}</span>
  <span class="ik">User:</span>            <span class="iv">${escH(meta.user)}</span>
  <span class="ik">Database:</span>        <span class="iv">${escH(meta.database)}</span>
  <span class="ik">Date:</span>            <span class="iv">${escH(meta.date)}</span>
  <span class="ik">Time:</span>            <span class="iv">${escH(meta.time)}</span>
  <span class="ik">Sections:</span>        <span class="iv">${sections.length}</span>
  <span class="ik">Total Rows:</span>      <span class="iv">${sections.reduce((a,s)=>a+s.rows.length,0)}</span>
  <span class="ik">Generated:</span>       <span class="iv">${now.toLocaleString()}</span>
</div></div>
${sections.length>1?`<div class="card"><h2>Sections</h2>
  <table><thead><tr><th>Section Title</th><th>Columns</th><th>Rows</th></tr></thead>
  <tbody>${secRows}</tbody></table></div>`:''}
${colStats}${totHtml}${kvHtml}
</body></html>`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   CSV SUPPORT – parser + HTML builder
   ─────────────────────────────────────────────────────────────────────────
   parseCsvText       : RFC-4180 parser → { headers, rows, totalRows, totalCols }
   buildCsvPassthrough: re-serialises parsed CSV back to a clean CSV string
   buildCsvReportHtml : self-contained interactive HTML matching LIS report style
   ═══════════════════════════════════════════════════════════════════════════ */

/* Re-serialise parsed CSV so the front-end download button still works */
function buildCsvPassthrough(csvParsed) {
  const esc = v => {
    const s = String(v ?? '');
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [csvParsed.headers.map(esc).join(',')];
  csvParsed.rows.forEach(r => lines.push(r.map(esc).join(',')));
  return lines.join('\r\n');
}

function parseCsvText(text) {
  /* Normalise line endings; strip UTF-8 BOM if present */
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rawLines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  /* RFC-4180 single-line field parser */
  function parseLine(line) {
    const fields = [];
    let i = 0;
    while (i <= line.length) {
      if (i === line.length) { fields.push(''); break; }
      if (line[i] === '"') {
        let field = ''; i++;
        while (i < line.length) {
          if (line[i] === '"') {
            if (line[i+1] === '"') { field += '"'; i += 2; }
            else { i++; break; }
          } else { field += line[i++]; }
        }
        fields.push(field);
        if (line[i] === ',') i++;
      } else {
        const end = line.indexOf(',', i);
        if (end === -1) { fields.push(line.slice(i)); break; }
        fields.push(line.slice(i, end));
        i = end + 1;
      }
    }
    return fields;
  }

  const nonEmpty = rawLines.filter(l => l.trim() !== '');
  if (!nonEmpty.length) return { headers:[], rows:[], totalRows:0, totalCols:0 };

  const headers = parseLine(nonEmpty[0]);
  const rows = nonEmpty.slice(1).map(l => {
    const cells = parseLine(l);
    while (cells.length < headers.length) cells.push('');
    return cells.slice(0, headers.length);
  });

  return { headers, rows, totalRows: rows.length, totalCols: headers.length };
}

const CSV_EMPTY = new Set(['','nan','none','null','n/a','na','#n/a']);
const isCsvEmpty = v => CSV_EMPTY.has(String(v??'').trim().toLowerCase());

function buildCsvReportHtml(csvParsed, form, filename, fileSize) {
  const { headers, rows, totalRows, totalCols } = csvParsed;

  const heading  = form.Heading_Text     || filename.replace(/\.[^.]+$/,'') + ' Report';
  const univName = form.headerUniversity || 'Universal University';
  const logoPath = form.logoPath         || '';
  const outName  = filename.replace(/\.[^.]+$/,'');
  const now      = new Date();
  const fmtDate  = now.toLocaleDateString('en-US');
  const fmtTime  = now.toLocaleTimeString('en-US');

  const logoHtml = logoPath
    ? `<img src="${escH(logoPath)}" alt="Logo" class="gw-logo-img" onerror="this.style.display='none'">`
    : `<div class="gw-logo-fallback">${escH(univName.charAt(0).toUpperCase())}</div>`;

  const thCells = headers.map((h, ci) => {
    const name = h.trim() || `COL${ci+1}`;
    return `<th onclick="sortTbl(this.cellIndex)">` +
        `<div class="thWrap">` +
          `<span class="headerText" data-original="${escH(name)}" title="Double-click to rename" onclick="event.stopPropagation();" ondblclick="startHeaderEdit(this,event)">${escH(name)}</span>` +
          `<span class="hMini hMoveLeft"  title="Move column left"  onclick="hColAct(this,event,'left')">&#8592;</span>` +
          `<span class="hMini hMoveRight" title="Move column right" onclick="hColAct(this,event,'right')">&#8594;</span>` +
          `<span class="hMini hSort"      title="Sort this column"  onclick="hColAct(this,event,'sort')">&#8597;</span>` +
          `<span class="hMini hInsert"    title="Insert new column before this column" onclick="hColAct(this,event,'insert')">&#65291;</span>` +
          `<span class="hMini hDelete"    title="Remove this column" onclick="hColAct(this,event,'delete')">&times;</span>` +
        `</div>` +
      `</th>`;
  }).join('');

  const filterSelects = headers.map((col,ci) => {
    const unique = [...new Set(rows.map(r => r[ci]??''))].sort();
    const opts   = unique.map(v =>
      `<option value="${escH(v)}">${isCsvEmpty(v)?'(blank)':escH(v)}</option>`).join('');
    return `<label class="flt-label">${escH(col.trim()||`COL${ci+1}`)}<select class="col-filter" data-col="${ci}" onchange="applyF()"><option value="">All</option>${opts}</select></label>`;
  }).join('');

  const trRows = rows.map(row =>
    `<tr>${row.map((v,ci) => {
      const empty = isCsvEmpty(v);
      return `<td data-col="${ci}"${empty?' class="ec"':''}>${empty ? '&mdash;' : escH(v)}</td>`;
    }).join('')}</tr>`).join('\n');

  /* Column names JSON for the graph selector — injected into the page JS */
  const colNamesJson = JSON.stringify(headers.map((h,i) => h.trim() || `COL${i+1}`));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escH(heading)}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@3.9.1/dist/chart.min.js"><\/script>
<link href="https://fonts.googleapis.com/css2?family=Merriweather:wght@700&family=Source+Sans+3:wght@400;600;700&display=swap" rel="stylesheet">
<style>
:root{--blue:#003A5D;--gold:#FFBE00;--lb:#0054A4;--bg:#f4f6f8;--white:#fff;--border:#d1d9e0;
  --text:#1a2733;--muted:#5a6a7a;--alt:#eef2f7;--chdr:#1a4f7a;--green:#27ae60;
  --shadow:0 4px 12px rgba(0,0,0,.15);--r:4px;
  --fd:'Merriweather',Georgia,serif;--fb:'Source Sans 3','Segoe UI',sans-serif;}
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:var(--fb);background:var(--bg);color:var(--text);font-size:13px;}
/* ── header ── */
.hdr{background:#2e78b0;color:#fff;display:flex;align-items:stretch;min-height:82px;box-shadow:var(--shadow);}
.hl{padding:10px 16px;border-right:1px solid rgba(255,255,255,.15);display:flex;align-items:center;min-width:185px;}
.hc{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:12px 20px;text-align:center;gap:3px;}
.h-org{font-family:var(--fd);font-size:18px;font-weight:700;line-height:1.2;}
.h-title{font-size:13px;color:rgba(255,255,255,.9);font-weight:600;}
.h-sub{font-size:11px;color:rgba(255,255,255,.7);letter-spacing:.03em;}
.hrr{display:flex;align-items:center;gap:8px;justify-content:flex-end;padding:10px 16px;border-left:1px solid rgba(255,255,255,.15);min-width:80px;}
.gw-logo-img{max-height:60px;max-width:120px;object-fit:contain;filter:drop-shadow(0 1px 3px rgba(0,0,0,.25));}
.gw-logo-fallback{font-family:var(--fd);font-size:28px;font-weight:700;color:var(--gold);}
/* ── stats bar ── */
.stats-bar{display:flex;gap:14px;flex-wrap:wrap;padding:16px 20px 0;}
.sc{background:var(--white);border-radius:var(--r);padding:12px 20px;box-shadow:0 2px 8px rgba(0,0,0,.07);border-left:4px solid #0d8fa8;min-width:130px;}
.sl{font-size:.68rem;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);margin-bottom:3px;}
.sv{font-size:1.3rem;font-weight:700;color:var(--blue);}
/* ── page wrapper ── */
.pw{padding:16px 20px;}
.page-meta{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;font-size:11px;color:var(--muted);margin-bottom:14px;line-height:1.7;}
/* ── buttons ── */
.btn{display:inline-flex;align-items:center;gap:4px;padding:5px 12px;border-radius:var(--r);font-size:12px;font-weight:600;border:1.5px solid transparent;cursor:pointer;font-family:var(--fb);transition:all .15s;}
.btn-green{background:var(--green);color:#fff;border-color:#219a52;} .btn-green:hover{background:#219a52;}
.btn-ol{background:transparent;color:var(--lb);border-color:var(--lb);} .btn-ol:hover{background:rgba(0,84,164,.08);}
.btn-gray{background:#ccc;color:#333;border-color:#999;} .btn-gray:hover{background:#bbb;}
.btn-graph{background:#0054a4;color:#fff;border-color:#003a7a;} .btn-graph:hover{background:#003a7a;}
/* ── toolbar ── */
.tb{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px;background:var(--white);border:1px solid var(--border);border-radius:var(--r);padding:9px 14px;box-shadow:var(--shadow);}
.tb input[type=text]{padding:5px 9px;border:1.5px solid var(--border);border-radius:var(--r);font-size:12px;font-family:var(--fb);outline:none;min-width:200px;}
.tb input:focus{border-color:var(--lb);}
.badge{font-size:11px;color:var(--muted);padding:4px 8px;background:#eef2f7;border-radius:var(--r);}
/* ── filter row ── */
.flt-row{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;}
.flt-label{font-size:10px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.04em;display:flex;flex-direction:column;gap:2px;}
.col-filter{padding:3px 5px;border:1px solid var(--border);border-radius:var(--r);font-size:11px;font-family:var(--fb);background:#fff;outline:none;max-width:150px;}
.col-filter:focus{border-color:var(--lb);}
/* ── table ── */
.tw{overflow-x:auto;border-radius:var(--r);box-shadow:var(--shadow);border:1px solid var(--border);margin-bottom:8px;}
table.rt-tbl{width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap;}
table.rt-tbl thead tr{background:var(--chdr);color:#fff;}
table.rt-tbl thead th{padding:8px 12px;text-align:left;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;cursor:pointer;user-select:none;position:sticky;top:0;}
table.rt-tbl thead th:hover{background:#163d61;}
table.rt-tbl thead th.sa::after{content:' \u25b2';}
table.rt-tbl thead th.sd::after{content:' \u25bc';}
table.rt-tbl tbody tr:nth-child(even){background:var(--alt);}
table.rt-tbl tbody tr:hover{background:#dce8f4;}
table.rt-tbl tbody td{padding:5px 12px;border-bottom:1px solid var(--border);}
td.ec{color:#b0bec5;font-style:italic;}
.hidden{display:none!important;}
/* column-header inline controls */
table.rt-tbl thead th .thWrap{display:flex;align-items:center;justify-content:flex-start;gap:4px;width:100%;}
table.rt-tbl thead th .headerText{display:inline-block;padding:2px 6px;border-radius:3px;cursor:text;outline:none;color:#fff;flex:0 1 auto;min-width:24px;}
table.rt-tbl thead th .headerText.editing{background:#fff7cc;color:#000;}
.hMini{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;font-size:11px;font-weight:700;cursor:pointer;background:#fff;color:#0b2d4d;border:1px solid rgba(0,0,0,.18);user-select:none;text-transform:none;letter-spacing:0;line-height:1;}
.hMini:hover{filter:brightness(.95);}
.hDelete{background:#fff0f0;color:#a32020;}
.hInsert{background:#ecfdf5;color:#047857;}
.hMoveLeft,.hMoveRight{background:#eef6ff;color:#0f5cc0;}
.hSort{background:#fff8e1;color:#7a5c00;}
/* ── pager ── */
.pgr{display:flex;align-items:center;gap:8px;margin-bottom:16px;justify-content:flex-end;flex-wrap:wrap;}
.pgr button{padding:4px 10px;border:1.5px solid var(--border);border-radius:var(--r);font-size:12px;font-family:var(--fb);background:#fff;cursor:pointer;}
.pgr button:hover:not(:disabled){border-color:var(--lb);color:var(--lb);}
.pgr button:disabled{opacity:.45;cursor:not-allowed;}
.pi{font-size:12px;color:var(--muted);}
/* ── graph modal (identical to LIS report) ── */
.graph-modal{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:1000;display:flex;align-items:center;justify-content:center;}
.graph-modal-content{background:var(--white);border:1px solid var(--border);border-radius:var(--r);box-shadow:0 8px 24px rgba(0,0,0,0.3);max-width:400px;width:90%;}
.graph-modal-header{display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--border);}
.graph-modal-header h3{font-family:var(--fd);font-size:14px;color:var(--blue);margin:0;}
.graph-close-btn{background:none;border:none;font-size:20px;cursor:pointer;color:var(--muted);}
.graph-close-btn:hover{color:var(--blue);}
.graph-modal-body{padding:20px;}
.graph-form-group{margin-bottom:16px;}
.graph-form-group label{display:block;font-size:12px;font-weight:700;color:var(--text);margin-bottom:6px;text-transform:uppercase;letter-spacing:.02em;}
.graph-select{width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:var(--r);font-size:12px;font-family:var(--fb);background:#fff;outline:none;}
.graph-select:focus{border-color:var(--lb);box-shadow:0 0 0 3px rgba(0,84,164,.1);}
.graph-form-buttons{display:flex;gap:8px;justify-content:flex-end;margin-top:20px;}
.graph-form-buttons .btn{margin:0;}
/* ── graph canvas container ── */
.graph-container{display:none;margin-top:20px;padding:15px;background:var(--white);border:1px solid var(--border);border-radius:var(--r);box-shadow:var(--shadow);}
/* ── footer ── */
.page-footer{text-align:center;padding:18px;font-size:11px;color:var(--muted);}
@media print{.tb,.pgr,.flt-row,.graph-modal,.graph-container{display:none!important;} .tw{overflow:visible!important;}}
</style>
</head>
<body>

<!-- ═══ HEADER ═══ -->
<header class="hdr">
  <div class="hl">${logoHtml}</div>
  <div class="hc">
    <div class="h-org">${escH(univName)}</div>
    <div class="h-title">${escH(heading)}</div>
    <div class="h-sub">Source: ${escH(filename)} &nbsp;&middot;&nbsp; Generated: ${fmtDate} ${fmtTime}</div>
  </div>
  <div class="hrr">
    <button class="btn btn-graph" onclick="openGraphModal()">&#128202; Create a Graph</button>
    <button class="btn btn-gray"  onclick="clearPage()">Clear</button>
    ${logoPath ? '' : ''}
  </div>
</header>

<!-- ═══ STATS BAR ═══ -->
<div class="stats-bar">
  <div class="sc"><div class="sl">Total Rows</div><div class="sv">${totalRows}</div></div>
  <div class="sc"><div class="sl">Columns</div><div class="sv">${totalCols}</div></div>
  <div class="sc"><div class="sl">Source File</div><div class="sv" style="font-size:.78rem;padding-top:3px;">${escH(filename)}</div></div>
  <div class="sc"><div class="sl">File Size</div><div class="sv" style="font-size:.78rem;padding-top:3px;">${(fileSize/1024).toFixed(1)} KB</div></div>
</div>

<!-- ═══ MAIN CONTENT ═══ -->
<div class="pw">
  <div class="page-meta">
    <span>CSV data report &nbsp;&middot;&nbsp; ${totalRows} records &nbsp;&middot;&nbsp; ${totalCols} columns</span>
    <button class="btn btn-ol" onclick="window.print()">&#128424; Print</button>
  </div>

  <!-- toolbar -->
  <div class="tb">
    <input type="text" id="gs" placeholder="&#128269;  Search all columns&hellip;" oninput="applyF()">
    <button class="btn btn-green" onclick="expCsv()">&#11015; Export CSV</button>
    <button class="btn btn-ol"    onclick="togF()">&#9881; Column Filters</button>
    <span class="badge" id="rc">${totalRows} rows</span>
    <label style="font-size:12px;color:var(--muted);">Per page:
      <select id="ps" onchange="setPs()" style="margin-left:4px;">
        <option>25</option><option>50</option><option>100</option><option>250</option><option value="0">All</option>
      </select>
    </label>
  </div>

  <!-- column filters -->
  <div class="flt-row" id="flt" style="display:none;">${filterSelects}</div>

  <!-- data table -->
  <div class="tw">
    <table class="rt-tbl" id="tbl">
      <thead><tr id="hr">${thCells}</tr></thead>
      <tbody id="tb">${trRows}</tbody>
    </table>
  </div>

  <!-- pager -->
  <div class="pgr">
    <button onclick="cp(-1)" id="pb">&#9664; Prev</button>
    <span class="pi" id="pi"></span>
    <button onclick="cp(1)"  id="nb">Next &#9654;</button>
  </div>

  <!-- ── Graph modal ── -->
  <div id="graph-modal" class="graph-modal" style="display:none;">
    <div class="graph-modal-content">
      <div class="graph-modal-header">
        <h3>Create a Graph</h3>
        <button class="graph-close-btn" onclick="closeGraphModal()">&#x2715;</button>
      </div>
      <div class="graph-modal-body">
        <div class="graph-form-group">
          <label>Graph Type:</label>
          <select id="gt" class="graph-select">
            <option value="pie">Pie Chart</option>
            <option value="bar">Bar Chart</option>
            <option value="line">Line Chart</option>
          </select>
        </div>
        <div class="graph-form-group">
          <label>Label Column (X-axis / Labels):</label>
          <select id="gc1" class="graph-select"></select>
        </div>
        <div class="graph-form-group">
          <label>Value Column (Y-axis / Values):</label>
          <select id="gc2" class="graph-select"></select>
        </div>
        <div class="graph-form-buttons">
          <button class="btn btn-green" onclick="generateGraph()">Submit</button>
          <button class="btn btn-gray"  onclick="closeGraphModal()">Cancel</button>
        </div>
      </div>
    </div>
  </div>

  <!-- ── Graph canvas ── -->
  <div class="graph-container" id="graph-container">
    <canvas id="graph-chart" style="max-height:400px;"></canvas>
  </div>

</div><!-- /.pw -->

<footer class="page-footer">Generated by LIS Report Generator &nbsp;&middot;&nbsp; ${fmtDate} ${fmtTime}</footer>

<script>
/* ── column names for graph selectors ── */
var colNames = ${colNamesJson};
var chartInstance = null;

/* ── table state ── */
var all = Array.from(document.querySelectorAll('#tb tr'));
var fil = all.slice(), ps = 25, pg = 1, sc = -1, sa = true;

/* ── pagination ── */
function rp(){
  var tot=fil.length, pz=ps===0?tot:ps, pages=pz?Math.ceil(tot/pz):1;
  if(pg>pages) pg=Math.max(1,pages);
  var s=ps===0?0:(pg-1)*pz, e=ps===0?tot:Math.min(s+pz,tot);
  all.forEach(function(r){r.classList.add('hidden');});
  fil.slice(s,e).forEach(function(r){r.classList.remove('hidden');});
  document.getElementById('rc').textContent=tot+' row'+(tot!==1?'s':'');
  document.getElementById('pi').textContent=pages>1?'Page '+pg+' of '+pages:'';
  document.getElementById('pb').disabled=pg<=1;
  document.getElementById('nb').disabled=pg>=pages||tot===0;
}
function cp(d){pg+=d;rp();}
function setPs(){var v=document.getElementById('ps').value;ps=v==='0'?0:parseInt(v,10);pg=1;rp();}

/* ── filter ── */
function applyF(){
  var q=document.getElementById('gs').value.toLowerCase();
  var cf={};
  document.querySelectorAll('.col-filter').forEach(function(s){if(s.value!=='')cf[parseInt(s.dataset.col,10)]=s.value.toLowerCase();});
  fil=all.filter(function(r){
    if(q&&!r.textContent.toLowerCase().includes(q)) return false;
    for(var ci in cf){
      var cell=r.cells[ci]; if(!cell) return false;
      var tv=cell.textContent.trim().toLowerCase();
      var rv=(tv==='\u2014'||tv==='-')?'':tv;
      if(rv!==cf[ci]) return false;
    }
    return true;
  });
  pg=1; rp();
}
function togF(){var e=document.getElementById('flt');e.style.display=e.style.display==='none'?'flex':'none';}

/* ── sort ── */
function sortTbl(ci){
  var ths=document.querySelectorAll('#tbl thead th');
  if(sc===ci){sa=!sa;}else{sc=ci;sa=true;}
  ths.forEach(function(t){t.classList.remove('sa','sd');});
  ths[ci].classList.add(sa?'sa':'sd');
  all.sort(function(a,b){
    var av=a.cells[ci]?a.cells[ci].textContent.trim():'';
    var bv=b.cells[ci]?b.cells[ci].textContent.trim():'';
    if(av==='\u2014') av=''; if(bv==='\u2014') bv='';
    var an=parseFloat(av.replace(/[^0-9.+-]/g,'')), bn=parseFloat(bv.replace(/[^0-9.+-]/g,''));
    if(!isNaN(an)&&!isNaN(bn)) return sa?an-bn:bn-an;
    return sa?av.localeCompare(bv):bv.localeCompare(av);
  });
  var tb=document.getElementById('tb');
  all.forEach(function(r){tb.appendChild(r);});
  applyF();
}

/* ── export CSV ── */
function expCsv(){
  var hdrs=Array.from(document.querySelectorAll('#tbl thead th')).map(function(t){var s=t.querySelector('.headerText');return (s?s.textContent:t.textContent).replace(/ [\u25b2\u25bc]$/,'').trim();});
  var data=fil.map(function(r){return Array.from(r.cells).map(function(td){var v=td.textContent.trim();if(v==='\u2014')v='';return(v.includes(',')||v.includes('"'))?'"'+v.replace(/"/g,'""')+'"':v;});});
  var csv=[hdrs.join(',')].concat(data.map(function(r){return r.join(',');})).join('\\r\\n');
  var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  a.download='${escH(outName)}_export.csv'; a.click();
}

/* ─── column header actions: move left/right, sort, insert, delete, rename ─── */
function hColAct(span,event,action){
  if(event){event.preventDefault();event.stopPropagation();}
  var th=span.closest('th'); if(!th) return;
  var tr=th.parentNode;
  var idx=Array.prototype.indexOf.call(tr.children,th);
  if(action==='left')        moveCol(idx,idx-1);
  else if(action==='right')  moveCol(idx,idx+1);
  else if(action==='sort')   sortTbl(idx);
  else if(action==='insert') insertColAt(idx);
  else if(action==='delete') deleteColAt(idx);
}
function moveCol(from,to){
  var headerRow=document.getElementById('hr'); if(!headerRow) return;
  var n=headerRow.children.length;
  if(from<0||to<0||from>=n||to>=n||from===to) return;
  var movingTh=headerRow.children[from], refTh=headerRow.children[to];
  if(to<from) headerRow.insertBefore(movingTh,refTh);
  else        headerRow.insertBefore(movingTh,refTh.nextSibling);
  var rows=document.querySelectorAll('#tbl tbody tr');
  rows.forEach(function(r){
    if(r.children.length<=Math.max(from,to)) return;
    var moving=r.children[from], ref=r.children[to];
    if(to<from) r.insertBefore(moving,ref);
    else        r.insertBefore(moving,ref.nextSibling);
  });
  var item=colNames.splice(from,1)[0]; colNames.splice(to,0,item);
  rebindHeader();
  refreshFilters();
}
function insertColAt(index){
  var headerRow=document.getElementById('hr'); if(!headerRow) return;
  var name=prompt('New column name:','New Column');
  if(name===null) return;
  name=String(name||'New Column').trim()||'New Column';
  var th=document.createElement('th');
  th.setAttribute('onclick','sortTbl(this.cellIndex)');
  th.innerHTML='<div class="thWrap">'+
    '<span class="headerText" data-original="'+escAttr(name)+'" title="Double-click to rename" onclick="event.stopPropagation();" ondblclick="startHeaderEdit(this,event)">'+escAttr(name)+'</span>'+
    '<span class="hMini hMoveLeft"  title="Move column left"  onclick="hColAct(this,event,\\'left\\')">&#8592;</span>'+
    '<span class="hMini hMoveRight" title="Move column right" onclick="hColAct(this,event,\\'right\\')">&#8594;</span>'+
    '<span class="hMini hSort"      title="Sort this column"  onclick="hColAct(this,event,\\'sort\\')">&#8597;</span>'+
    '<span class="hMini hInsert"    title="Insert new column before this column" onclick="hColAct(this,event,\\'insert\\')">&#65291;</span>'+
    '<span class="hMini hDelete"    title="Remove this column" onclick="hColAct(this,event,\\'delete\\')">&times;</span>'+
    '</div>';
  if(index>=headerRow.children.length) headerRow.appendChild(th);
  else headerRow.insertBefore(th,headerRow.children[index]);
  var rows=document.querySelectorAll('#tbl tbody tr');
  rows.forEach(function(r){
    var td=document.createElement('td');
    td.setAttribute('contenteditable','true');
    td.setAttribute('data-col',index);
    td.innerHTML='&mdash;';
    td.className='ec';
    if(index>=r.children.length) r.appendChild(td);
    else r.insertBefore(td,r.children[index]);
  });
  colNames.splice(index,0,name);
  rebindHeader();
  refreshFilters();
}
function deleteColAt(index){
  var headerRow=document.getElementById('hr'); if(!headerRow) return;
  if(headerRow.children.length<=1){alert('At least one column must remain.');return;}
  var name=(headerRow.children[index].querySelector('.headerText')||{}).textContent||('Column '+(index+1));
  if(!confirm('Remove column "'+String(name).trim()+'" ?')) return;
  headerRow.removeChild(headerRow.children[index]);
  var rows=document.querySelectorAll('#tbl tbody tr');
  rows.forEach(function(r){if(r.children[index]) r.removeChild(r.children[index]);});
  colNames.splice(index,1);
  sc=-1; sa=true;
  rebindHeader();
  refreshFilters();
}
function rebindHeader(){
  var headerRow=document.getElementById('hr'); if(!headerRow) return;
  Array.prototype.forEach.call(headerRow.children,function(th){
    th.onclick=function(){ sortTbl(this.cellIndex); };
  });
}
function refreshFilters(){
  var fltRow=document.getElementById('flt'); if(!fltRow) return;
  var headerRow=document.getElementById('hr'); if(!headerRow) return;
  var headers=Array.prototype.map.call(headerRow.children,function(th){var s=th.querySelector('.headerText');return (s?s.textContent:th.textContent).trim();});
  fltRow.innerHTML='';
  headers.forEach(function(name,ci){
    var seen={}, opts='<option value="">All</option>';
    all.forEach(function(r){
      var c=r.cells[ci]; var v=c?c.textContent.trim():''; if(v==='\u2014') v='';
      if(!(v in seen)){seen[v]=true;opts+='<option value="'+escAttr(v)+'">'+(v?escAttr(v):'(blank)')+'</option>';}
    });
    var lab=document.createElement('label');
    lab.className='flt-label';
    lab.innerHTML=escAttr(name)+'<select class="col-filter" data-col="'+ci+'" onchange="applyF()">'+opts+'</select>';
    fltRow.appendChild(lab);
  });
  applyF();
}
function escAttr(v){return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}

/* ─── inline header rename via double-click ─── */
function startHeaderEdit(span,event){
  if(event){event.preventDefault();event.stopPropagation();}
  if(!span) return;
  span.contentEditable='true';
  span.classList.add('editing');
  span.focus();
  try{var rng=document.createRange();rng.selectNodeContents(span);rng.collapse(false);
    var sel=window.getSelection();sel.removeAllRanges();sel.addRange(rng);}catch(e){}
  span.onblur=function(){finishHeaderEdit(span);};
  span.onkeydown=function(e){
    if(e.key==='Enter'){e.preventDefault();span.blur();}
    else if(e.key==='Escape'){e.preventDefault();span.textContent=span.getAttribute('data-original')||span.textContent;span.contentEditable='false';span.classList.remove('editing');span.blur();}
  };
}
function finishHeaderEdit(span){
  if(!span||span.contentEditable!=='true') return;
  var v=String(span.innerText||span.textContent||'').replace(/\\s+/g,' ').trim();
  if(v==='') v=span.getAttribute('data-original')||'Field';
  span.textContent=v;
  span.setAttribute('data-original',v);
  span.contentEditable='false';
  span.classList.remove('editing');
  var th=span.closest('th'); if(!th) return;
  var tr=th.parentNode;
  var idx=Array.prototype.indexOf.call(tr.children,th);
  colNames[idx]=v;
}

/* ── clear (reload) ── */
function clearPage(){ window.location.reload(); }

/* ── graph modal ── */
function openGraphModal(){
  var labSel=document.getElementById('gc1');
  var valSel=document.getElementById('gc2');
  var opts='<option value="">Select a column\u2026</option>'+colNames.map(function(n,i){return '<option value="'+i+'">'+n+'</option>';}).join('');
  labSel.innerHTML=opts;
  valSel.innerHTML=opts;
  document.getElementById('graph-modal').style.display='flex';
}
function closeGraphModal(){
  document.getElementById('graph-modal').style.display='none';
}

/* ── generate graph (uses ALL rows, not just current page) ── */
function generateGraph(){
  var graphType = document.getElementById('gt').value;
  var labelColIdx = parseInt(document.getElementById('gc1').value);
  var valueColIdx = parseInt(document.getElementById('gc2').value);
  if(isNaN(labelColIdx)||isNaN(valueColIdx)){
    alert('Please select both a Label column and a Value column.');
    return;
  }
  var labels=[], data=[];
  all.forEach(function(tr){
    var lCell=tr.cells[labelColIdx], vCell=tr.cells[valueColIdx];
    if(!lCell||!vCell) return;
    var label=lCell.textContent.trim();
    var raw  =vCell.textContent.trim();
    if(raw==='\u2014') raw='';
    var num=parseFloat(raw.replace(/[,$%]/g,''));
    if(!isNaN(num)){ labels.push(label); data.push(num); }
  });
  if(!labels.length){
    alert('No numeric values found in the selected Value column. Please choose a column that contains numbers.');
    return;
  }
  var container=document.getElementById('graph-container');
  var canvas   =document.getElementById('graph-chart');
  container.style.display='block';
  if(chartInstance){ chartInstance.destroy(); chartInstance=null; }
  var BG=[
    'rgba(54,162,235,0.7)','rgba(255,99,132,0.7)','rgba(75,192,192,0.7)',
    'rgba(255,206,86,0.7)','rgba(153,102,255,0.7)','rgba(255,159,64,0.7)',
    'rgba(199,199,199,0.7)','rgba(83,102,255,0.7)','rgba(255,99,255,0.7)'
  ];
  var BD=[
    'rgba(54,162,235,1)','rgba(255,99,132,1)','rgba(75,192,192,1)',
    'rgba(255,206,86,1)','rgba(153,102,255,1)','rgba(255,159,64,1)',
    'rgba(199,199,199,1)','rgba(83,102,255,1)','rgba(255,99,255,1)'
  ];
  /* Cycle colours if there are more rows than palette entries */
  var bgArr  = labels.map(function(_,i){return BG[i%BG.length];});
  var bdArr  = labels.map(function(_,i){return BD[i%BD.length];});
  chartInstance=new Chart(canvas.getContext('2d'),{
    type:graphType,
    data:{
      labels:labels,
      datasets:[{
        label:colNames[valueColIdx],
        data:data,
        backgroundColor:bgArr,
        borderColor:bdArr,
        borderWidth:1
      }]
    },
    options:{
      responsive:true,
      maintainAspectRatio:true,
      plugins:{
        legend:{position:'top'},
        title:{display:true,text:'Chart: '+colNames[labelColIdx]+' vs '+colNames[valueColIdx]}
      },
      scales:(graphType==='pie'?{}:{y:{beginAtZero:true}})
    }
  });
  closeGraphModal();
}

rp();
</script>
</body>
</html>`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   EXPRESS ROUTES
   ═══════════════════════════════════════════════════════════════════════════ */
app.use(express.json());
app.use(express.static(path.join(__dirname,'dist')));
app.use(express.static(__dirname));

app.post('/api/run-lis', upload.single('file'), (req, res) => {
  const log = [];
  try {
    if (!req.file) return res.json({ success:false, log:['❌ No file received'] });

    const filename   = req.file.originalname;
    const fileSize   = req.file.size;
    const form       = JSON.parse(req.body.formData || '{}');
    const reportType = form.ReportType     || 'Both';
    const printLogic = form.PrintLogicFile || 'Y';

    log.push(`Step 1: Reading "${filename}" (${(fileSize/1024).toFixed(1)} KB)…`);

    /* ── CSV branch: detect by extension or by sniffing the first line ── */
    const lname = filename.toLowerCase();
    let text = req.file.buffer.toString('utf-8');
    const isCsv = lname.endsWith('.csv')
      || (!lname.endsWith('.lis') && !lname.endsWith('.txt')
          && /^[^\n]{1,500}\n/.test(text)
          && (() => { const fl = text.replace(/^\uFEFF/,'').split('\n')[0]; return (fl.match(/,/g)||[]).length >= 2; })());

    if (isCsv) {
      log.push('Detected CSV file – switching to CSV pipeline…');
      const csvParsed = parseCsvText(text);

      if (!csvParsed.headers.length) {
        log.push('❌ CSV file appears to be empty or has no header row.');
        return res.json({ success:false, log });
      }

      log.push(`Step 2: Parsed ${csvParsed.totalRows} data rows × ${csvParsed.totalCols} columns.`);
      log.push(`        Headers: ${csvParsed.headers.slice(0,8).map(h=>`"${h}"`).join(', ')}${csvParsed.totalCols>8?` … (+${csvParsed.totalCols-8} more)`:''}`);

      let reportHtml=null, logicHtml=null;

      if (reportType==='Both'||reportType==='HTML') {
        log.push('Building CSV HTML report…');
        reportHtml = buildCsvReportHtml(csvParsed, form, filename, fileSize);
        latestReport    = reportHtml;
        latestCsvReport = reportHtml;
        log.push('✓ CSV HTML report ready');
      }
      if (printLogic==='Y') {
        /* Lightweight info page for CSV files */
        const now = new Date();
        logicHtml = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>File Info – ${escH(filename)}</title>
<link href="https://fonts.googleapis.com/css2?family=Merriweather:wght@700&family=Source+Sans+3:wght@400;600;700&display=swap" rel="stylesheet">
<style>:root{--blue:#003A5D;--bg:#f4f6f8;--white:#fff;--border:#d1d9e0;--text:#1a2733;--muted:#5a6a7a;--shadow:0 4px 12px rgba(0,0,0,.15);--r:4px;--fd:'Merriweather',Georgia,serif;--fb:'Source Sans 3','Segoe UI',sans-serif;}
*{margin:0;padding:0;box-sizing:border-box;}body{font-family:var(--fb);background:var(--bg);color:var(--text);font-size:13px;padding:24px;}
h1{font-family:var(--fd);font-size:18px;color:var(--blue);margin-bottom:16px;}
.card{background:var(--white);border:1px solid var(--border);border-radius:var(--r);box-shadow:var(--shadow);padding:18px 22px;margin-bottom:18px;max-width:840px;}
.card h2{font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:10px;}
.ig{display:grid;grid-template-columns:220px 1fr;gap:5px 10px;font-size:12px;}
.ik{font-weight:700;color:var(--muted);}.iv{color:var(--text);}
table{width:100%;border-collapse:collapse;font-size:12px;}thead tr{background:#1a4f7a;color:#fff;}
thead th{padding:7px 11px;text-align:left;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;}
tbody tr:nth-child(even){background:#eef2f7;}tbody td{padding:5px 11px;border-bottom:1px solid var(--border);}</style></head><body>
<h1>&#128203; File Info – CSV Report</h1>
<div class="card"><h2>Source File Details</h2><div class="ig">
  <span class="ik">File Name:</span><span class="iv">${escH(filename)}</span>
  <span class="ik">File Size:</span><span class="iv">${(fileSize/1024).toFixed(1)} KB</span>
  <span class="ik">File Type:</span><span class="iv">CSV (Comma-Separated Values)</span>
  <span class="ik">Total Data Rows:</span><span class="iv">${csvParsed.totalRows}</span>
  <span class="ik">Total Columns:</span><span class="iv">${csvParsed.totalCols}</span>
  <span class="ik">Generated:</span><span class="iv">${now.toLocaleString()}</span>
</div></div>
<div class="card"><h2>Column Headers (${csvParsed.totalCols})</h2>
<table><thead><tr><th>#</th><th>Column Name</th><th>Non-Blank Values</th><th>Unique Values</th></tr></thead><tbody>
${csvParsed.headers.map((h,ci)=>{
  const vals=csvParsed.rows.map(r=>r[ci]??'').filter(v=>!isCsvEmpty(v));
  const uniq=new Set(vals).size;
  return `<tr><td>${ci+1}</td><td>${escH(h)}</td><td>${vals.length}</td><td>${uniq}</td></tr>`;
}).join('')}
</tbody></table></div>
</body></html>`;
        latestLogic = logicHtml;
        log.push('✓ CSV file info page ready');
      }

      log.push('✓ Pipeline complete');
      return res.json({
        success:true, log,
        csvData: reportType==='Both'||reportType==='CSV' ? buildCsvPassthrough(csvParsed) : null,
        reportHtml: !!reportHtml, logicHtml: !!logicHtml,
        recordCount: csvParsed.totalRows,
        columnCount: csvParsed.totalCols,
      });
    }
    /* ── end CSV branch — fall through to LIS parser ── */

    const parsed = parseLisFile(text);
    log.push(...parsed.log);

    if (!parsed.sections.length) {
      log.push('❌ Could not detect any data sections with column headers.');
      return res.json({ success:false, log });
    }

    let csvData=null, reportHtml=null, logicHtml=null;

    if (reportType==='Both'||reportType==='CSV') {
      log.push('Building CSV…');
      csvData = buildCsv(parsed);
      log.push(`✓ CSV built (${parsed.dataRows.length} rows)`);
    }
    if (reportType==='Both'||reportType==='HTML') {
      log.push('Building interactive HTML report…');
      reportHtml = buildReportHtml(parsed, form);
      latestReport = reportHtml;
      log.push('✓ HTML report ready');
    }
    if (printLogic==='Y') {
      log.push('Building file info page…');
      logicHtml = buildLogicHtml(parsed, form, filename, fileSize);
      latestLogic = logicHtml;
      log.push('✓ File info page ready');
    }

    log.push('✓ Pipeline complete');
    return res.json({
      success:true, log, csvData,
      reportHtml:!!reportHtml, logicHtml:!!logicHtml,
      recordCount: parsed.dataRows.length,
      columnCount: parsed.columns.length,
    });
  } catch (err) {
    log.push(`❌ Server error: ${err.message}`);
    console.error(err.stack);
    return res.json({ success:false, log });
  }
});

app.get('/report', (_req,res) => {
  if (!latestReport) return res.send('<h2>No report generated yet.</h2>');
  res.send(latestReport);
});
app.get('/logic', (_req,res) => {
  if (!latestLogic) return res.send('<h2>No file info page generated yet.</h2>');
  res.send(latestLogic);
});
app.get('*', (_req,res) => {
  const dist = path.join(__dirname,'dist','index.html');
  if (fs.existsSync(dist)) res.sendFile(dist);
  else res.send('<h2>Run <code>npm run build</code> then <code>npm start</code>.</h2>');
});

app.listen(PORT, () => {
  console.log(`\n✅  LIS Report Generator v5 on http://localhost:${PORT}`);
  console.log(`   React UI   : http://localhost:5174  (npm run dev)`);
  console.log(`   HTML Report: http://localhost:${PORT}/report`);
  console.log(`   File Info  : http://localhost:${PORT}/logic\n`);
});
