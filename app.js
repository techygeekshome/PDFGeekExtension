// PDFGeek app page. Every tool runs here, inside this tab: files are read with the File API, edited with pdf-lib,
// drawn with PDF.js and encrypted with qpdf (WebAssembly). Results are saved with a normal browser download.
import * as pdfjsLib from './lib/pdf.min.mjs';
/* global PDFLib, makeZip */
const { PDFDocument, degrees } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kb = (n) => n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const baseName = (n) => (n || 'document').replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim() || 'document';
const pad = (n, w) => String(n).padStart(w, '0');

// ---------- settings (per viewer, on this computer) ----------
const prefs = { tool: 'merge', imgSize: 'a4', imgOrient: 'auto', imgMargin: '0', cropOut: 'crop', cropTurn: true };
const savePrefs = () => chrome.storage.local.set({ prefs }).catch(() => {});

// ---------- status cards ----------
let busyCount = 0;
function busy(text) {
  busyCount++; $('#busyText').textContent = text; $('#busy').hidden = false; $('#result').hidden = true; $('#error').hidden = true;
  $$('button.primary').forEach((b) => { b.dataset.wasDisabled = b.disabled ? '1' : ''; b.disabled = true; });
}
function idle() {
  busyCount = Math.max(0, busyCount - 1); if (busyCount) return;
  $('#busy').hidden = true;
  $$('button.primary').forEach((b) => { b.disabled = b.dataset.wasDisabled === '1'; });
  refreshButtons();
}
function showError(msg) {
  const e = $('#error'); e.textContent = msg; e.hidden = false; $('#result').hidden = true;
  e.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function clearStatus() { $('#error').hidden = true; $('#result').hidden = true; }

// ---------- saving ----------
const lastSaved = []; // for tests and the "Save again" buttons: [{name, size}]
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, hidden: true });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
  lastSaved.push({ name, size: blob.size });
}
const pdfBlob = (bytes) => new Blob([bytes], { type: 'application/pdf' });

function showResult(title, lines, files, ms) {
  const r = $('#result'); r.replaceChildren();
  r.append(h('h2', {}, title));
  for (const l of lines) r.append(h('div', {}, l));
  if (files.length > 1 && files.length <= 30) r.append(h('ul', {}, files.map((f) => h('li', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); download(f.blob, f.name); } }, f.name), h('span', { class: 'muted' }, '  ' + kb(f.blob.size))))));
  const main = files.main || files[0];
  const row = h('div', { class: 'row' });
  if (main) {
    row.append(h('button', { onclick: () => download(main.blob, main.name) }, 'Save again'));
    if (main.blob.type === 'application/pdf') row.append(h('button', { onclick: () => { const u = URL.createObjectURL(main.blob); window.open(u, '_blank'); setTimeout(() => URL.revokeObjectURL(u), 600000); } }, 'Open to check'));
  }
  if (ms != null) row.append(h('span', { class: 'muted small' }, `Done in ${(ms / 1000).toFixed(1)} s, on this computer.`));
  r.append(row);
  r.hidden = false; $('#error').hidden = true;
  r.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---------- qpdf worker ----------
let qw = null, qid = 0; const qwait = new Map();
function qpdf(op, bytes, password) {
  if (!qw) {
    qw = new Worker('qpdf-worker.js');
    qw.onmessage = (e) => { const p = qwait.get(e.data.id); if (p) { qwait.delete(e.data.id); p(e.data); } };
    qw.onerror = (e) => { for (const p of qwait.values()) p({ ok: false, log: e.message || 'qpdf failed to start' }); qwait.clear(); qw = null; };
  }
  const id = ++qid;
  const copy = bytes.slice();
  return new Promise((res) => { qwait.set(id, res); qw.postMessage({ id, op, bytes: copy, password }, [copy.buffer]); });
}

// ---------- reading PDFs ----------
const isPdf = (u8) => { const n = Math.min(u8.length, 1024); for (let i = 0; i < n - 4; i++) if (u8[i] === 0x25 && u8[i + 1] === 0x50 && u8[i + 2] === 0x44 && u8[i + 3] === 0x46 && u8[i + 4] === 0x2d) return true; return false; };

function askPassword(fileName, wrong) {
  const d = $('#pwDialog');
  $('#pwDlgFile').textContent = fileName;
  $('#pwDlgErr').textContent = wrong ? 'That password did not work. Try again.' : '';
  $('#pwDlgInput').value = '';
  return new Promise((res) => {
    d.onclose = () => res(d.returnValue === 'ok' ? $('#pwDlgInput').value : null);
    d.returnValue = '';
    d.showModal(); $('#pwDlgInput').focus();
  });
}

// Loads a PDF for editing. Files with a password are unlocked first (after asking for it).
// Returns { name, bytes, doc (pdf-lib), pages, wasLocked } or throws an Error with a plain message.
async function readPdf(file, { ask = true } = {}) {
  let bytes = file.data || new Uint8Array(await file.arrayBuffer()); // file.data: bytes we already have (not Blob.bytes)
  if (!isPdf(bytes)) throw new Error(`${file.name} is not a PDF file.`);
  let wasLocked = false, doc;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (/encrypt/i.test(String(e?.message || e))) {
      wasLocked = true;
      let r = await qpdf('decrypt', bytes, '');
      let wrong = false;
      while (!r.ok) {
        if (!r.badPw) throw new Error(`Could not open ${file.name}. ${r.log.split('\n')[0] || ''}`.trim());
        if (!ask) throw new Error(`${file.name} needs a password.`);
        const pw = await askPassword(file.name, wrong);
        if (pw == null) throw new Error(`${file.name} was skipped: it needs a password.`);
        r = await qpdf('decrypt', bytes, pw); wrong = true;
      }
      bytes = r.bytes;
      doc = await PDFDocument.load(bytes, { updateMetadata: false });
    } else {
      // Damaged file: let qpdf rebuild it, then try again.
      const r = await qpdf('repair', bytes);
      if (!r.ok) throw new Error(`Could not read ${file.name}. The file may be damaged.`);
      bytes = r.bytes;
      doc = await PDFDocument.load(bytes, { updateMetadata: false });
    }
  }
  return { name: file.name, bytes, doc, pages: doc.getPageCount(), wasLocked };
}

// ---------- thumbnails (PDF.js) ----------
async function pdfjsDoc(bytes) {
  return pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false, disableAutoFetch: true, enableXfa: false }).promise;
}
async function renderPage(jsDoc, n, box) {
  const page = await jsDoc.getPage(n);
  const v1 = page.getViewport({ scale: 1 });
  const scale = Math.min(box / v1.width, box / v1.height) * (window.devicePixelRatio || 1);
  const vp = page.getViewport({ scale });
  const c = h('canvas', { width: Math.ceil(vp.width), height: Math.ceil(vp.height) });
  c.style.width = Math.round(vp.width / (window.devicePixelRatio || 1)) + 'px';
  c.style.height = Math.round(vp.height / (window.devicePixelRatio || 1)) + 'px';
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  page.cleanup();
  return c;
}
async function firstThumb(bytes, holder) {
  try { const d = await pdfjsDoc(bytes); holder.replaceChildren(await renderPage(d, 1, 60)); d.destroy(); } catch { holder.textContent = 'PDF'; }
}

// ---------- drop zones ----------
const handlers = {};
function wireDrops() {
  for (const z of $$('.drop')) {
    const input = $('input', z);
    const take = (files) => { const f = [...files]; if (f.length) handlers[z.dataset.for](z.dataset.multi ? f : [f[0]]); };
    input.addEventListener('change', () => { take(input.files); input.value = ''; });
    z.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); z.classList.add('over'); } });
    z.addEventListener('dragleave', () => z.classList.remove('over'));
    z.addEventListener('drop', (e) => { e.preventDefault(); z.classList.remove('over'); take(e.dataTransfer.files); });
  }
  // Stop a file dropped next to the drop zone from replacing this tab.
  window.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (e.defaultPrevented) return; e.preventDefault();
    const z = $(`#t-${prefs.tool} .drop`); if (z && e.dataTransfer.files.length) handlers[z.dataset.for](z.dataset.multi ? [...e.dataTransfer.files] : [e.dataTransfer.files[0]]);
  });
}

// Drag to reorder inside a list. getArr returns the array that mirrors the list items, redraw rebuilds the list.
function sortable(container, itemSel, getArr, redraw, horizontal = false) {
  let from = -1;
  container.addEventListener('dragstart', (e) => {
    const it = e.target.closest(itemSel); if (!it) return;
    from = [...container.children].indexOf(it); it.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(from));
  });
  container.addEventListener('dragend', () => { from = -1; $$('.dragging, .drop-before, .drop-after', container).forEach((x) => x.classList.remove('dragging', 'drop-before', 'drop-after')); });
  const target = (e) => {
    const it = e.target.closest(itemSel); if (!it) return null;
    const r = it.getBoundingClientRect();
    const after = horizontal ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
    return { it, idx: [...container.children].indexOf(it), after };
  };
  container.addEventListener('dragover', (e) => {
    if (from < 0) return; e.preventDefault(); e.stopPropagation();
    $$('.drop-before, .drop-after', container).forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    const t = target(e); if (t) t.it.classList.add(t.after ? 'drop-after' : 'drop-before');
  });
  container.addEventListener('drop', (e) => {
    if (from < 0) return; e.preventDefault(); e.stopPropagation();
    const t = target(e); if (!t) return;
    let to = t.idx + (t.after ? 1 : 0); if (to > from) to--;
    moveItem(getArr(), from, to); from = -1; redraw();
  });
}
function moveItem(arr, from, to) { if (to < 0 || to >= arr.length || from === to) return false; const [x] = arr.splice(from, 1); arr.splice(to, 0, x); return true; }

// ---------- MERGE ----------
const merge = { items: [] };
handlers.merge = async (files) => {
  clearStatus();
  for (const f of files) {
    if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') { showError(`${f.name} is not a PDF, so it was left out.`); continue; }
    busy(`Reading ${f.name}...`);
    try { const p = await readPdf(f); merge.items.push(p); drawMerge(); }
    catch (e) { showError(e.message); }
    finally { idle(); }
  }
};
function drawMerge() {
  const ol = $('#mergeList'); ol.replaceChildren();
  merge.items.forEach((it, i) => {
    if (!it.thumbEl) { it.thumbEl = h('div', { class: 'thumb' }); firstThumb(it.bytes, it.thumbEl); }
    const th = it.thumbEl;
    ol.append(h('li', { draggable: 'true', 'data-i': i },
      h('span', { class: 'grip', title: 'Drag to move' }, '⠿'), h('span', { class: 'num' }, i + 1), th,
      h('div', { class: 'fname' }, h('b', {}, it.name), h('span', {}, `${plural(it.pages, 'page')}, ${kb(it.bytes.length)}${it.wasLocked ? ', password removed for merging' : ''}`)),
      h('button', { class: 'icon', title: 'Move up', 'aria-label': 'Move up', disabled: i === 0, onclick: () => { moveItem(merge.items, i, i - 1); drawMerge(); } }, '↑'),
      h('button', { class: 'icon', title: 'Move down', 'aria-label': 'Move down', disabled: i === merge.items.length - 1, onclick: () => { moveItem(merge.items, i, i + 1); drawMerge(); } }, '↓'),
      h('button', { class: 'icon', title: 'Remove', 'aria-label': 'Remove', onclick: () => { merge.items.splice(i, 1); drawMerge(); } }, '✕')));
  });
  refreshButtons();
}
async function doMerge() {
  if (merge.items.length < 2) return;
  const t0 = performance.now(); busy('Merging...');
  try {
    const out = await PDFDocument.create();
    for (const it of merge.items) {
      const pages = await out.copyPages(it.doc, it.doc.getPageIndices());
      pages.forEach((p) => out.addPage(p));
      await sleep(0);
    }
    out.setProducer('PDFGeek'); out.setCreator('PDFGeek');
    const bytes = await out.save();
    const name = `${baseName(merge.items[0].name)}-merged.pdf`;
    const f = { name, blob: pdfBlob(bytes) };
    download(f.blob, f.name);
    const total = out.getPageCount();
    showResult(`Saved ${name}`, [`${plural(merge.items.length, 'file')} merged into one PDF with ${plural(total, 'page')} (${kb(bytes.length)}).`], [f], performance.now() - t0);
  } catch (e) { showError('Merging failed: ' + (e.message || e)); }
  finally { idle(); }
}

// ---------- SPLIT ----------
const split = { src: null };
handlers.split = async ([f]) => {
  clearStatus(); busy(`Reading ${f.name}...`);
  try { split.src = await readPdf(f); drawHead('#splitHead', split.src); $('#splitBody').hidden = false; $('#ranges').placeholder = `For example 1-3, 5, 8-${split.src.pages}`; }
  catch (e) { showError(e.message); }
  finally { idle(); }
};
function drawHead(sel, it, extra = '') {
  const th = h('div', { class: 'thumb' }); firstThumb(it.bytes, th);
  $(sel).replaceChildren(th, h('div', { class: 'fname' }, h('b', {}, it.name), h('span', {}, `${plural(it.pages, 'page')}, ${kb(it.bytes.length)}${it.wasLocked ? ', password removed for this job' : ''}${extra}`)));
}
// "1-3, 5, 8-" -> [[0,1,2],[4],[7..n-1]] (0-based). Throws a plain message when something is wrong.
function parseRanges(text, n) {
  const parts = text.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('Type the pages you want, for example 1-3, 5.');
  return parts.map((p) => {
    const m = p.match(/^(\d*)\s*(?:-|–|to)\s*(\d*)$/i) || p.match(/^(\d+)$/);
    if (!m) throw new Error(`"${p}" is not a page or range. Use numbers like 4 or 2-6.`);
    let a, b;
    if (m.length === 2) { a = b = +m[1]; } else { a = m[1] === '' ? 1 : +m[1]; b = m[2] === '' ? n : +m[2]; }
    if (a < 1 || b < 1 || a > n || b > n) throw new Error(`"${p}" is outside this PDF, which has ${plural(n, 'page')}.`);
    const out = []; if (a <= b) for (let i = a; i <= b; i++) out.push(i - 1); else for (let i = a; i >= b; i--) out.push(i - 1);
    return out;
  });
}
const rangeLabel = (idx) => { const a = idx[0] + 1, b = idx[idx.length - 1] + 1; return a === b ? `page-${a}` : `pages-${a}-${b}`; };
async function doSplit() {
  const src = split.src; if (!src) return;
  $('#splitErr').textContent = '';
  const mode = $('input[name=splitMode]:checked').value;
  let groups;
  try {
    if (mode === 'each') groups = src.doc.getPageIndices().map((i) => [i]);
    else if (mode === 'every') { const k = Math.max(1, parseInt($('#everyN').value, 10) || 1); groups = []; for (let i = 0; i < src.pages; i += k) groups.push(src.doc.getPageIndices().slice(i, i + k)); }
    else { groups = parseRanges($('#ranges').value, src.pages); if ($('#oneFile').checked) groups = [groups.flat()]; }
  } catch (e) { $('#splitErr').textContent = e.message; return; }
  const t0 = performance.now(); busy('Splitting...');
  try {
    const base = baseName(src.name); const files = [];
    const w = String(src.pages).length;
    for (let g = 0; g < groups.length; g++) {
      const idx = groups[g];
      const out = await PDFDocument.create();
      (await out.copyPages(src.doc, idx)).forEach((p) => out.addPage(p));
      out.setProducer('PDFGeek');
      let label;
      if (mode === 'each') label = `page-${pad(idx[0] + 1, w)}`;
      else if (mode === 'ranges' && $('#oneFile').checked) label = 'selected-pages';
      else label = rangeLabel(idx);
      files.push({ name: `${base}-${label}.pdf`, blob: pdfBlob(await out.save()), pages: idx.length });
      if (g % 10 === 9) { $('#busyText').textContent = `Splitting... ${g + 1} of ${groups.length}`; await sleep(0); }
    }
    // the same name twice (for example "1-2, 1-2") gets a number
    const seen = {}; for (const f of files) { if (seen[f.name]) f.name = f.name.replace(/\.pdf$/, `-${++seen[f.name]}.pdf`); else seen[f.name] = 1; }
    if (files.length === 1) {
      download(files[0].blob, files[0].name);
      showResult(`Saved ${files[0].name}`, [`${plural(files[0].pages, 'page')} taken from ${src.name}.`], files, performance.now() - t0);
    } else {
      $('#busyText').textContent = 'Packing the files into one ZIP...';
      const zip = await makeZip(files.map((f) => ({ name: f.name, blob: f.blob })));
      const z = { name: `${base}-split.zip`, blob: zip };
      download(z.blob, z.name);
      const all = files.slice(); all.main = z;
      showResult(`Saved ${z.name}`, [`${plural(files.length, 'PDF')} in one ZIP file. You can also save any of them on its own:`], all, performance.now() - t0);
    }
  } catch (e) { showError('Splitting failed: ' + (e.message || e)); }
  finally { idle(); }
}

// ---------- ORGANISE ----------
const org = { src: null, js: null, pages: [], io: null };
handlers.organize = async ([f]) => {
  clearStatus(); busy(`Reading ${f.name}...`);
  try {
    if (org.js) org.js.destroy();
    org.src = await readPdf(f);
    org.js = await pdfjsDoc(org.src.bytes);
    org.pages = org.src.doc.getPages().map((p, i) => ({ i, rot: 0, base: p.getRotation().angle || 0, del: false, el: null }));
    drawHead('#orgHead', org.src); $('#orgBody').hidden = false; drawOrg();
  } catch (e) { showError(e.message); }
  finally { idle(); }
};
function pageCard(p) {
  const paper = h('div', { class: 'paper' }, h('span', { class: 'muted small' }, String(p.i + 1)));
  const lbl = h('div', { class: 'lbl' });
  const card = h('div', { class: 'pg', draggable: 'true', 'data-page': p.i + 1 },
    h('div', { class: 'frame' }, paper), lbl,
    h('div', { class: 'btns' },
      h('button', { class: 'icon', title: 'Rotate left', 'aria-label': 'Rotate left', 'data-act': 'left', onclick: () => { p.rot = (p.rot + 270) % 360; updCard(p); } }, '↺'),
      h('button', { class: 'icon', title: 'Rotate right', 'aria-label': 'Rotate right', 'data-act': 'right', onclick: () => { p.rot = (p.rot + 90) % 360; updCard(p); } }, '↻'),
      h('button', { class: 'icon', title: 'Remove or keep this page', 'aria-label': 'Remove page', 'data-act': 'del', onclick: () => { p.del = !p.del; updCard(p); } }, '✕')));
  p.el = card; p.paper = paper; p.lbl = lbl; updCard(p);
  card._page = p;
  return card;
}
function updCard(p) {
  p.paper.style.transform = `rotate(${p.rot}deg)`;
  p.el.classList.toggle('deleted', p.del); p.el.classList.toggle('rotated', !!p.rot);
  p.lbl.textContent = `Page ${p.i + 1}${p.rot ? `, turned ${p.rot === 270 ? 'left' : p.rot === 90 ? 'right' : 'upside down'}` : ''}`;
  $('[data-act=del]', p.el).setAttribute('aria-label', p.del ? 'Keep page' : 'Remove page');
  const kept = org.pages.filter((x) => !x.del).length;
  $('#orgCount').textContent = `${plural(kept, 'page')} kept of ${org.pages.length}`;
  refreshButtons();
}
function drawOrg() {
  const g = $('#orgGrid'); g.replaceChildren();
  if (org.io) org.io.disconnect();
  // Thumbnails are drawn as they scroll into view, so big files open quickly.
  org.io = new IntersectionObserver((ents) => {
    for (const e of ents) {
      if (!e.isIntersecting) continue;
      const p = e.target._page; org.io.unobserve(e.target);
      if (p.canvas) { p.paper.replaceChildren(p.canvas); continue; }
      renderPage(org.js, p.i + 1, 120).then((c) => { p.canvas = c; p.paper.replaceChildren(c); }).catch(() => {});
    }
  }, { rootMargin: '400px' });
  for (const p of org.pages) { const c = pageCard(p); g.append(c); if (p.canvas) p.paper.replaceChildren(p.canvas); else org.io.observe(c); }
}
async function doOrganize() {
  const src = org.src; if (!src) return;
  const keep = org.pages.filter((p) => !p.del);
  if (!keep.length) { showError('Every page is marked for removal. Keep at least one page.'); return; }
  const t0 = performance.now(); busy('Saving...');
  try {
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src.doc, keep.map((p) => p.i));
    copied.forEach((pg, k) => { const p = keep[k]; if (p.rot) pg.setRotation(degrees((p.base + p.rot) % 360)); out.addPage(pg); });
    out.setProducer('PDFGeek');
    const bytes = await out.save();
    const name = `${baseName(src.name)}-edited.pdf`; const f = { name, blob: pdfBlob(bytes) };
    download(f.blob, f.name);
    const rotated = keep.filter((p) => p.rot).length, removed = org.pages.length - keep.length;
    const moved = keep.some((p, k) => k > 0 && p.i < keep[k - 1].i);
    const what = [moved && 'pages reordered', rotated && `${plural(rotated, 'page')} rotated`, removed && `${plural(removed, 'page')} removed`].filter(Boolean).join(', ') || 'no changes';
    showResult(`Saved ${name}`, [`${plural(keep.length, 'page')} (${what}), ${kb(bytes.length)}.`], [f], performance.now() - t0);
  } catch (e) { showError('Saving failed: ' + (e.message || e)); }
  finally { idle(); }
}

// ---------- CROP ----------
// Boxes are kept as fractions (0 to 1) of the page as it is shown (after its /Rotate), so the same box fits
// pages of different sizes. They are turned into PDF points only when saving.
const crop = { src: null, js: null, n: 0, all: true, shared: null, boxes: [], canvas: null, vp: null, scale: 1 };
const WHOLE = () => ({ x0: 0, y0: 0, x1: 1, y1: 1 });
const PAPER = { '4x6': [288, 432], a6: [297.64, 419.53], a4: [595.28, 841.89] };
const PRESETS = { top: [0, 0, 1, .5], bottom: [0, .5, 1, 1], left: [0, 0, .5, 1], right: [.5, 0, 1, 1],
  tl: [0, 0, .5, .5], tr: [.5, 0, 1, .5], bl: [0, .5, .5, 1], br: [.5, .5, 1, 1] };
handlers.crop = async ([f]) => {
  clearStatus(); busy(`Reading ${f.name}...`);
  try {
    if (crop.js) crop.js.destroy();
    crop.src = await readPdf(f);
    crop.js = await pdfjsDoc(crop.src.bytes);
    crop.n = 0; crop.shared = WHOLE(); crop.boxes = new Array(crop.src.pages).fill(null);
    drawHead('#cropHead', crop.src); $('#cropBody').hidden = false;
    await drawCropPage();
  } catch (e) { showError(e.message); }
  finally { idle(); }
};
const cropBoxOf = (i) => crop.all ? crop.shared : crop.boxes[i];
function setCropBox(b) {
  const c = (v) => Math.min(1, Math.max(0, v));
  const n = { x0: c(Math.min(b.x0, b.x1)), y0: c(Math.min(b.y0, b.y1)), x1: c(Math.max(b.x0, b.x1)), y1: c(Math.max(b.y0, b.y1)) };
  if (crop.all) crop.shared = n; else crop.boxes[crop.n] = n;
  showCropBox();
}
async function drawCropPage() {
  const page = await crop.js.getPage(crop.n + 1);
  const v1 = page.getViewport({ scale: 1 });
  const maxW = Math.max(280, Math.min(760, $('#t-crop .cropmain').clientWidth || 640)), maxH = 640;
  const s = Math.min(maxW / v1.width, maxH / v1.height); const dpr = window.devicePixelRatio || 1;
  const vp = page.getViewport({ scale: s * dpr });
  const c = h('canvas', { width: Math.ceil(vp.width), height: Math.ceil(vp.height) });
  c.style.width = Math.round(v1.width * s) + 'px'; c.style.height = Math.round(v1.height * s) + 'px';
  await page.render({ canvasContext: c.getContext('2d', { willReadFrequently: true }), viewport: vp }).promise;
  page.cleanup();
  crop.canvas = c; crop.vp = v1; crop.scale = s;
  const st = $('#cropStage'); $$('canvas', st).forEach((x) => x.remove()); st.prepend(c);
  $('#cropPageNo').textContent = `Page ${crop.n + 1} of ${crop.src.pages}`;
  $('#cropPrev').disabled = crop.n === 0; $('#cropNext').disabled = crop.n >= crop.src.pages - 1;
  showCropBox();
}
function showCropBox() {
  if (!crop.canvas) return;
  const b = cropBoxOf(crop.n), el = $('#cropBox');
  const W = parseFloat(crop.canvas.style.width), H = parseFloat(crop.canvas.style.height);
  el.hidden = !b;
  if (b) Object.assign(el.style, { left: b.x0 * W + 'px', top: b.y0 * H + 'px', width: (b.x1 - b.x0) * W + 'px', height: (b.y1 - b.y0) * H + 'px' });
  const shown = b || WHOLE();
  const wp = (shown.x1 - shown.x0) * crop.vp.width, hp = (shown.y1 - shown.y0) * crop.vp.height;
  $('#cropSize').textContent = `${b ? 'Crop' : 'Not cropped'}: ${Math.round(wp / MM)} x ${Math.round(hp / MM)} mm (${(wp / 72).toFixed(1)} x ${(hp / 72).toFixed(1)} in)`;
  refreshButtons();
}
function wireCropStage() {
  const st = $('#cropStage'); let drag = null;
  const pos = (e) => { const r = crop.canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; };
  st.addEventListener('pointerdown', (e) => {
    if (!crop.canvas || e.button !== 0) return;
    e.preventDefault(); st.setPointerCapture(e.pointerId);
    const p = pos(e), b = cropBoxOf(crop.n); const hd = e.target.dataset?.h;
    if (hd && b) drag = { mode: 'h', h: hd, b: { ...b } };
    else if (b && e.target.closest('#cropBox')) drag = { mode: 'move', p, b: { ...b } };
    else { drag = { mode: 'draw', p }; setCropBox({ x0: p.x, y0: p.y, x1: p.x, y1: p.y }); }
  });
  st.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = pos(e); const c = (v) => Math.min(1, Math.max(0, v));
    if (drag.mode === 'draw') setCropBox({ x0: drag.p.x, y0: drag.p.y, x1: c(p.x), y1: c(p.y) });
    else if (drag.mode === 'move') {
      const b = drag.b, w = b.x1 - b.x0, hh = b.y1 - b.y0;
      const x0 = Math.min(1 - w, Math.max(0, b.x0 + p.x - drag.p.x)), y0 = Math.min(1 - hh, Math.max(0, b.y0 + p.y - drag.p.y));
      setCropBox({ x0, y0, x1: x0 + w, y1: y0 + hh });
    } else {
      const b = { ...drag.b };
      if (drag.h.includes('w')) b.x0 = c(p.x); if (drag.h.includes('e')) b.x1 = c(p.x);
      if (drag.h.includes('n')) b.y0 = c(p.y); if (drag.h.includes('s')) b.y1 = c(p.y);
      setCropBox(b);
    }
  });
  const end = () => {
    if (!drag) return; drag = null;
    const b = cropBoxOf(crop.n);
    // a click without a drag (or a tiny box) means the whole page again
    if (b && ((b.x1 - b.x0) * crop.vp.width < 14 || (b.y1 - b.y0) * crop.vp.height < 14)) setCropBox(WHOLE());
  };
  st.addEventListener('pointerup', end); st.addEventListener('pointercancel', end);
}
// Shrinks the box to the printed area inside it (anything that is not near white), with a small margin.
function trimCrop() {
  const b = cropBoxOf(crop.n) || WHOLE(); const c = crop.canvas; const W = c.width, H = c.height;
  const X0 = Math.floor(b.x0 * W), Y0 = Math.floor(b.y0 * H), X1 = Math.ceil(b.x1 * W), Y1 = Math.ceil(b.y1 * H);
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(X0, Y0, Math.max(1, X1 - X0), Math.max(1, Y1 - Y0));
  const w = d.width; let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < d.height; y++) for (let x = 0; x < w; x++) {
    const k = (y * w + x) * 4;
    if (d.data[k + 3] > 40 && (d.data[k] < 225 || d.data[k + 1] < 225 || d.data[k + 2] < 225)) {
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) { showError('There is nothing printed inside the box to trim to.'); return; }
  clearStatus();
  const padX = 3 * MM / crop.vp.width, padY = 3 * MM / crop.vp.height; // 3 mm
  setCropBox({ x0: (X0 + minX) / W - padX, y0: (Y0 + minY) / H - padY, x1: (X0 + maxX + 1) / W + padX, y1: (Y0 + maxY + 1) / H + padY });
}
async function doCrop() {
  const src = crop.src; if (!src) return;
  const outMode = $('#cropOut').value, turn = $('#cropTurn').checked, only = !crop.all && $('#cropOnly').checked;
  const idx = src.doc.getPageIndices().filter((i) => !only || crop.boxes[i]);
  if (!idx.length) { showError('No page has a crop yet. Draw a box on a page first.'); return; }
  const t0 = performance.now(); busy('Cropping...');
  try {
    const out = await PDFDocument.create();
    for (const i of idx) {
      const f = cropBoxOf(i) || WHOLE();
      const jp = await crop.js.getPage(i + 1); const vp = jp.getViewport({ scale: 1 });
      const [ax, ay] = vp.convertToPdfPoint(f.x0 * vp.width, f.y0 * vp.height);
      const [bx, by] = vp.convertToPdfPoint(f.x1 * vp.width, f.y1 * vp.height);
      const L = Math.min(ax, bx), R = Math.max(ax, bx), B = Math.min(ay, by), T = Math.max(ay, by);
      if (outMode === 'crop') {
        // Lossless: the page keeps all its text and drawings, only the visible area changes.
        const [pg] = await out.copyPages(src.doc, [i]);
        for (const set of ['setMediaBox', 'setCropBox', 'setTrimBox', 'setBleedBox', 'setArtBox']) pg[set](L, B, R - L, T - B);
        out.addPage(pg);
      } else {
        const [PW0, PH0] = PAPER[outMode];
        const r0 = (((src.doc.getPage(i).getRotation().angle || 0) % 360) + 360) % 360;
        const w0 = R - L, h0 = T - B;
        const shownW = r0 % 180 ? h0 : w0, shownH = r0 % 180 ? w0 : h0;
        // When it has to turn: a sideways page goes back to how it was drawn, otherwise it turns a quarter clockwise.
        const needTurn = turn && (shownW > shownH) !== (PW0 > PH0) && Math.abs(shownW - shownH) > 1;
        const extra = !needTurn ? 0 : r0 % 180 ? 360 - r0 : 90;
        const tot = (r0 + extra) % 360;
        const fw = tot % 180 ? h0 : w0, fh = tot % 180 ? w0 : h0;
        const s = Math.min(PW0 / fw, PH0 / fh);
        const W = w0 * s, H = h0 * s, tx = (PW0 - fw * s) / 2, ty = (PH0 - fh * s) / 2;
        const emb = await out.embedPage(src.doc.getPage(i), { left: L, bottom: B, right: R, top: T });
        const page = out.addPage([PW0, PH0]);
        const at = { 0: [tx, ty, 0], 90: [tx, ty + W, -90], 180: [tx + W, ty + H, 180], 270: [tx + H, ty, 90] }[tot];
        page.drawPage(emb, { x: at[0], y: at[1], width: W, height: H, rotate: degrees(at[2]) });
      }
      await sleep(0);
    }
    out.setProducer('PDFGeek'); out.setCreator('PDFGeek');
    const bytes = await out.save();
    const name = `${baseName(src.name)}-cropped.pdf`; const fl = { name, blob: pdfBlob(bytes) };
    download(fl.blob, fl.name);
    const what = { crop: 'at the cropped size', '4x6': 'on 4 x 6 inch label pages', a6: 'on A6 pages', a4: 'on A4 pages' }[outMode];
    showResult(`Saved ${name}`, [`${plural(idx.length, 'page')} cropped and saved ${what} (${kb(bytes.length)}).`,
      'Text and lines stay sharp: nothing is turned into a picture.'], [fl], performance.now() - t0);
  } catch (e) { showError('Cropping failed: ' + (e.message || e)); }
  finally { idle(); }
}
function wireCrop() {
  wireCropStage();
  $$('#t-crop [data-preset]').forEach((b) => b.addEventListener('click', () => { const [x0, y0, x1, y1] = PRESETS[b.dataset.preset]; setCropBox({ x0, y0, x1, y1 }); }));
  $('#cropTrim').addEventListener('click', () => crop.canvas && trimCrop());
  $('#cropReset').addEventListener('click', () => crop.canvas && setCropBox(WHOLE()));
  $('#cropPrev').addEventListener('click', () => { if (crop.n > 0) { crop.n--; drawCropPage(); } });
  $('#cropNext').addEventListener('click', () => { if (crop.src && crop.n < crop.src.pages - 1) { crop.n++; drawCropPage(); } });
  $('#cropAll').addEventListener('change', (e) => {
    crop.all = e.target.checked;
    if (crop.all) crop.shared = crop.boxes[crop.n] || crop.shared || WHOLE();
    else { crop.boxes = crop.boxes.map(() => null); crop.boxes[crop.n] = { ...crop.shared }; }
    cropToggles(); showCropBox();
  });
  $('#cropOut').addEventListener('change', cropToggles);
  $('#cropGo').addEventListener('click', doCrop);
  cropToggles();
}
function cropToggles() { $('#cropTurnBox').hidden = $('#cropOut').value === 'crop'; $('#cropOnlyBox').hidden = crop.all; }

// ---------- IMAGES TO PDF ----------
const imgs = { items: [] };
const MM = 72 / 25.4;
const SIZES = { a4: [595.28, 841.89], letter: [612, 792] };
handlers.images = async (files) => {
  clearStatus();
  for (const f of files) {
    if (!/^image\/(jpeg|png|webp)$/.test(f.type) && !/\.(jpe?g|png|webp)$/i.test(f.name)) { showError(`${f.name} is not a JPG, PNG or WebP picture, so it was left out.`); continue; }
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const bmp = await createImageBitmap(new Blob([bytes], { type: f.type || 'image/*' })); // turned the right way (photo orientation tag)
      const it = { name: f.name, type: sniffImage(bytes), bytes, w: bmp.width, h: bmp.height, orient: jpegOrientation(bytes) };
      bmp.close();
      imgs.items.push(it);
    } catch { showError(`${f.name} could not be read as a picture.`); }
  }
  drawImgs();
};
function sniffImage(b) {
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'webp';
  return 'other';
}
// EXIF orientation of a JPEG (1 = upright). Phones often save photos sideways with this tag set.
function jpegOrientation(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let i = 2;
  while (i + 4 < b.length) {
    if (b[i] !== 0xff) return 1;
    const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
    if (m === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) {
      const t = i + 10; const le = b[t] === 0x49;
      const u16 = (o) => le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1];
      const u32 = (o) => le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
      const ifd = t + u32(t + 4); const n = u16(ifd);
      for (let k = 0; k < n; k++) { const e = ifd + 2 + k * 12; if (u16(e) === 0x0112) return u16(e + 8) || 1; }
      return 1;
    }
    if (m === 0xda) return 1;
    i += 2 + len;
  }
  return 1;
}
function drawImgs() {
  const ol = $('#imgList'); ol.replaceChildren();
  imgs.items.forEach((it, i) => {
    if (!it.url) it.url = URL.createObjectURL(new Blob([it.bytes]));
    ol.append(h('li', { draggable: 'true' },
      h('span', { class: 'grip', title: 'Drag to move' }, '⠿'), h('span', { class: 'num' }, i + 1),
      h('div', { class: 'thumb' }, h('img', { src: it.url, alt: '' })),
      h('div', { class: 'fname' }, h('b', {}, it.name), h('span', {}, `${it.w} x ${it.h} px, ${it.type.toUpperCase()}, ${kb(it.bytes.length)}`)),
      h('button', { class: 'icon', title: 'Move up', 'aria-label': 'Move up', disabled: i === 0, onclick: () => { moveItem(imgs.items, i, i - 1); drawImgs(); } }, '↑'),
      h('button', { class: 'icon', title: 'Move down', 'aria-label': 'Move down', disabled: i === imgs.items.length - 1, onclick: () => { moveItem(imgs.items, i, i + 1); drawImgs(); } }, '↓'),
      h('button', { class: 'icon', title: 'Remove', 'aria-label': 'Remove', onclick: () => { URL.revokeObjectURL(it.url); imgs.items.splice(i, 1); drawImgs(); } }, '✕')));
  });
  refreshButtons();
}
async function canvasBytes(it, type) {
  const bmp = await createImageBitmap(new Blob([it.bytes]));
  const c = new OffscreenCanvas(bmp.width, bmp.height); const ctx = c.getContext('2d');
  if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
  ctx.drawImage(bmp, 0, 0); bmp.close();
  return new Uint8Array(await (await c.convertToBlob({ type, quality: 0.92 })).arrayBuffer());
}
async function hasAlpha(it) {
  const bmp = await createImageBitmap(new Blob([it.bytes]));
  const w = Math.min(bmp.width, 512), hh = Math.min(bmp.height, 512);
  const c = new OffscreenCanvas(w, hh); const ctx = c.getContext('2d'); ctx.drawImage(bmp, 0, 0, w, hh); bmp.close();
  const d = ctx.getImageData(0, 0, w, hh).data; for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true; return false;
}
async function doImages() {
  if (!imgs.items.length) return;
  const t0 = performance.now(); busy('Making the PDF...');
  try {
    const out = await PDFDocument.create();
    const size = $('#imgSize').value, orient = $('#imgOrient').value, margin = (+$('#imgMargin').value) * MM;
    for (const it of imgs.items) {
      let img;
      if (it.type === 'jpg' && it.orient === 1) img = await out.embedJpg(it.bytes);          // original JPEG data, no quality loss
      else if (it.type === 'png') img = await out.embedPng(it.bytes);
      else if (it.type === 'jpg') img = await out.embedJpg(await canvasBytes(it, 'image/jpeg')); // turned upright first
      else img = (await hasAlpha(it)) ? await out.embedPng(await canvasBytes(it, 'image/png')) : await out.embedJpg(await canvasBytes(it, 'image/jpeg'));
      const iw = it.w, ih = it.h; // upright size in pixels
      let pw, ph;
      if (size === 'fit') { pw = iw * 0.75 + 2 * margin; ph = ih * 0.75 + 2 * margin; } // 96 pixels per inch
      else {
        [pw, ph] = SIZES[size];
        const land = orient === 'landscape' || (orient === 'auto' && iw > ih);
        if (land) [pw, ph] = [ph, pw];
      }
      const page = out.addPage([pw, ph]);
      const bw = pw - 2 * margin, bh = ph - 2 * margin;
      const s = size === 'fit' ? 0.75 : Math.min(bw / iw, bh / ih);
      const dw = iw * s, dh = ih * s;
      page.drawImage(img, { x: (pw - dw) / 2, y: (ph - dh) / 2, width: dw, height: dh });
      await sleep(0);
    }
    out.setProducer('PDFGeek'); out.setCreator('PDFGeek');
    const bytes = await out.save();
    const first = baseName(imgs.items[0].name);
    const name = imgs.items.length === 1 ? `${first}.pdf` : `${first}-and-${imgs.items.length - 1}-more.pdf`;
    const f = { name, blob: pdfBlob(bytes) }; download(f.blob, f.name);
    showResult(`Saved ${name}`, [`${plural(imgs.items.length, 'picture')}, one per page, ${kb(bytes.length)}.`], [f], performance.now() - t0);
  } catch (e) { showError('Making the PDF failed: ' + (e.message || e)); }
  finally { idle(); }
}

// ---------- PROTECT ----------
const prot = { src: null };
handlers.protect = async ([f]) => {
  clearStatus(); busy(`Reading ${f.name}...`);
  try {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (!isPdf(bytes)) throw new Error(`${f.name} is not a PDF file.`);
    const st = await qpdf('status', bytes);
    let src = { name: f.name, bytes, pages: null, wasLocked: false };
    if (st.code === 0 || st.code === 3) src = await readPdf({ name: f.name, data: bytes }); // remove the old lock first (asks for the password if needed)
    else { try { src.pages = (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount(); } catch { src.pages = '?'; } }
    prot.src = src;
    drawHead('#protHead', src, src.wasLocked ? '. It already had a password: the new one replaces it' : '');
    $('#protBody').hidden = false; $('#pw1').focus();
  } catch (e) { showError(e.message); }
  finally { idle(); }
};
async function doProtect() {
  const src = prot.src; if (!src) return;
  const a = $('#pw1').value, b = $('#pw2').value; $('#protErr').textContent = '';
  if (!a) { $('#protErr').textContent = 'Type a password.'; return; }
  if (a !== b) { $('#protErr').textContent = 'The two passwords are not the same.'; return; }
  if (a.length > 127) { $('#protErr').textContent = 'That password is too long. PDFs allow up to 127 characters.'; return; }
  const t0 = performance.now(); busy('Encrypting with AES-256...');
  try {
    const r = await qpdf('encrypt', src.bytes, a);
    if (!r.ok) throw new Error(r.log.split('\n')[0] || 'qpdf could not encrypt this file');
    const name = `${baseName(src.name)}-protected.pdf`; const f = { name, blob: pdfBlob(r.bytes) };
    download(f.blob, f.name);
    $('#pw1').value = ''; $('#pw2').value = '';
    showResult(`Saved ${name}`, ['Locked with AES-256. It will ask for your password when it opens.', a.length < 8 ? 'Tip: that password is short. Longer passwords are much harder to guess.' : ''].filter(Boolean), [f], performance.now() - t0);
  } catch (e) { showError('Adding the password failed: ' + (e.message || e)); }
  finally { idle(); }
}

// ---------- UNLOCK ----------
const unl = { src: null };
handlers.unlock = async ([f]) => {
  clearStatus(); busy(`Reading ${f.name}...`);
  try {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (!isPdf(bytes)) throw new Error(`${f.name} is not a PDF file.`);
    const st = await qpdf('status', bytes);
    unl.src = { name: f.name, bytes, status: st.code };
    $('#unlHead').replaceChildren(h('div', { class: 'thumb' }, 'PDF'), h('div', { class: 'fname' }, h('b', {}, f.name),
      h('span', {}, `${kb(bytes.length)}, ${st.code === 0 ? 'needs a password to open' : st.code === 3 ? 'opens without a password but has editing limits' : 'has no password'}`)));
    $('#unlBody').hidden = false; $('#unlPwBox').hidden = st.code !== 0; $('#unlErr').textContent = '';
    $('#unlGo').disabled = st.code === 2;
    if (st.code === 2) $('#unlErr').textContent = 'This PDF has no password, so there is nothing to remove.';
    else if (st.code === 0) $('#unlPw').focus();
  } catch (e) { showError(e.message); }
  finally { idle(); }
};
async function doUnlock() {
  const src = unl.src; if (!src) return;
  $('#unlErr').textContent = '';
  const pw = src.status === 0 ? $('#unlPw').value : '';
  if (src.status === 0 && !pw) { $('#unlErr').textContent = 'Type the password for this PDF.'; return; }
  const t0 = performance.now(); busy('Removing the password...');
  try {
    const r = await qpdf('decrypt', src.bytes, pw);
    if (!r.ok) { if (r.badPw) { $('#unlErr').textContent = 'That password is not right. Check it and try again.'; return; } throw new Error(r.log.split('\n')[0]); }
    const name = `${baseName(src.name)}-unlocked.pdf`; const f = { name, blob: pdfBlob(r.bytes) };
    download(f.blob, f.name); $('#unlPw').value = '';
    showResult(`Saved ${name}`, ['This copy opens without a password. Your original file has not changed.'], [f], performance.now() - t0);
  } catch (e) { showError('Removing the password failed: ' + (e.message || e)); }
  finally { idle(); }
}

// ---------- SHRINK ----------
const shr = { src: null };
handlers.shrink = async ([f]) => {
  clearStatus(); busy(`Reading ${f.name}...`);
  try { shr.src = await readPdf(f); drawHead('#shrHead', shr.src); $('#shrBody').hidden = false; }
  catch (e) { showError(e.message); }
  finally { idle(); }
};
async function doShrink() {
  const src = shr.src; if (!src) return;
  const t0 = performance.now(); busy('Repacking...');
  try {
    const r = await qpdf('shrink', src.bytes);
    if (!r.ok) throw new Error(r.log.split('\n')[0]);
    const before = src.bytes.length, after = r.bytes.length;
    if (after >= before * 0.98) {
      showResult('Already packed tightly', [`Repacking only saved ${kb(Math.max(0, before - after))}, so nothing was saved. PDFGeek only makes lossless savings: it will not lower the quality of pictures in your file.`], [], performance.now() - t0);
      return;
    }
    const name = `${baseName(src.name)}-smaller.pdf`; const f = { name, blob: pdfBlob(r.bytes) };
    download(f.blob, f.name);
    showResult(`Saved ${name}`, [`${kb(before)} down to ${kb(after)} (${Math.round((1 - after / before) * 100)}% smaller). Text and pictures are exactly the same.`,
      src.wasLocked ? 'Note: the original had a password. This copy does not. Use Add a password to lock it again.' : ''].filter(Boolean), [f], performance.now() - t0);
  } catch (e) { showError('Shrinking failed: ' + (e.message || e)); }
  finally { idle(); }
}

// ---------- open a PDF from a right-clicked link ----------
async function fetchSrc(src) {
  const u = new URL(src); const origin = `${u.protocol}//${u.hostname}/*`;
  $('#fetchUrl').textContent = u.href; $('#fetchHost').textContent = u.hostname; $('#fetchCard').hidden = false;
  const go = async () => {
    busy('Downloading the PDF...');
    try {
      const res = await fetch(u.href, { credentials: 'include' });
      if (!res.ok) throw new Error(`The site answered ${res.status}.`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!isPdf(bytes)) throw new Error('That link did not give a PDF file.');
      let name = decodeURIComponent(u.pathname.split('/').pop() || 'document.pdf');
      const cd = res.headers.get('content-disposition'); const m = cd && cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
      if (m) { try { name = decodeURIComponent(m[1]); } catch { name = m[1]; } }
      if (!/\.pdf$/i.test(name)) name += '.pdf';
      $('#fetchCard').hidden = true;
      history.replaceState(null, '', location.pathname);
      idle();
      const f = { name, data: bytes, arrayBuffer: async () => bytes.buffer };
      // A linked PDF always opens in Organise pages, where every page can be seen.
      showTool('organize');
      await handlers.organize([f]);
    } catch (e) { idle(); showError(`Could not open that PDF. ${e.message || e} You can save it from the page and drop it here instead.`); }
  };
  $('#fetchNo').onclick = () => { $('#fetchCard').hidden = true; history.replaceState(null, '', location.pathname); };
  let have = false;
  try { have = await chrome.permissions.contains({ origins: [origin] }); } catch { /* ignore */ }
  if (have) { $('#fetchNote').textContent = 'Downloading it now. It is only read, never sent anywhere.'; return go(); }
  $('#fetchGo').onclick = async () => {
    let ok = false;
    try { ok = await chrome.permissions.request({ origins: [origin] }); } catch { /* ignore */ }
    if (ok) go(); else showError(`PDFGeek was not allowed to read ${u.hostname}. Save the PDF from the page and drop it here instead.`);
  };
}

// ---------- tools and buttons ----------
function showTool(t) {
  prefs.tool = t; savePrefs();
  $$('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  $$('.tool').forEach((s) => { s.hidden = s.id !== 't-' + t; });
  clearStatus();
}
function refreshButtons() {
  if (busyCount) return;
  $('#mergeGo').disabled = merge.items.length < 2;
  $('#mergeGo').textContent = merge.items.length >= 2 ? `Merge ${merge.items.length} PDFs` : 'Merge PDFs';
  $('#mergeClear').hidden = !merge.items.length;
  $('#imgGo').disabled = !imgs.items.length; $('#imgClear').hidden = !imgs.items.length;
  $('#imgGo').textContent = imgs.items.length ? `Make PDF from ${plural(imgs.items.length, 'picture')}` : 'Make PDF';
  if (org.pages.length) $('#orgGo').disabled = !org.pages.some((p) => !p.del);
  if (unl.src) $('#unlGo').disabled = unl.src.status === 2;
  if (crop.src) $('#cropGo').disabled = !crop.all && $('#cropOnly').checked && !crop.boxes.some(Boolean);
}

async function init() {
  try { Object.assign(prefs, (await chrome.storage.local.get('prefs')).prefs || {}); } catch { /* defaults */ }
  $('#cropTurn').checked = prefs.cropTurn !== false;
  $('#cropTurn').addEventListener('change', (e) => { prefs.cropTurn = e.target.checked; savePrefs(); });
  wireCrop();
  for (const k of ['imgSize', 'imgOrient', 'imgMargin', 'cropOut']) { const s = $('#' + k); s.value = prefs[k]; s.addEventListener('change', () => { prefs[k] = s.value; savePrefs(); }); }
  $$('#nav button').forEach((b) => b.addEventListener('click', () => showTool(b.dataset.tool)));
  wireDrops();
  sortable($('#mergeList'), 'li', () => merge.items, drawMerge);
  sortable($('#imgList'), 'li', () => imgs.items, drawImgs);
  sortable($('#orgGrid'), '.pg', () => org.pages, drawOrg, true);
  $('#mergeGo').addEventListener('click', doMerge);
  $('#mergeClear').addEventListener('click', () => { merge.items = []; drawMerge(); clearStatus(); });
  $('#splitGo').addEventListener('click', doSplit);
  $('#ranges').addEventListener('focus', () => { $('input[name=splitMode][value=ranges]').checked = true; });
  $('#everyN').addEventListener('focus', () => { $('input[name=splitMode][value=every]').checked = true; });
  $('#orgGo').addEventListener('click', doOrganize);
  $('#orgRotAll').addEventListener('click', () => org.pages.forEach((p) => { p.rot = (p.rot + 90) % 360; updCard(p); }));
  $('#orgReverse').addEventListener('click', () => { org.pages.reverse(); drawOrg(); });
  $('#orgReset').addEventListener('click', () => { org.pages.sort((a, b) => a.i - b.i).forEach((p) => { p.rot = 0; p.del = false; }); drawOrg(); });
  $('#imgGo').addEventListener('click', doImages);
  $('#imgClear').addEventListener('click', () => { imgs.items.forEach((i) => URL.revokeObjectURL(i.url)); imgs.items = []; drawImgs(); clearStatus(); });
  $('#protGo').addEventListener('click', doProtect);
  $('#pwShow').addEventListener('change', (e) => { $('#pw1').type = $('#pw2').type = e.target.checked ? 'text' : 'password'; });
  $('#pw2').addEventListener('keydown', (e) => { if (e.key === 'Enter') doProtect(); });
  $('#unlGo').addEventListener('click', doUnlock);
  $('#unlPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doUnlock(); });
  $('#shrGo').addEventListener('click', doShrink);
  const q = new URLSearchParams(location.search);
  showTool(q.get('tool') || prefs.tool);
  refreshButtons();
  if (q.get('src')) fetchSrc(q.get('src'));
  document.documentElement.dataset.ready = '1';
}
// for the automated tests
globalThis.pdfgeek = { pdfjs: pdfjsLib, merge, split, org, crop, setCropBox, trimCrop, imgs, prot, unl, shr, lastSaved, parseRanges, handlers, showTool };
init();
