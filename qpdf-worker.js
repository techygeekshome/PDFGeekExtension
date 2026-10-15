// Runs qpdf (compiled to WebAssembly, bundled in lib/) in a worker so the page stays responsive.
// Used for AES-256 encryption, removing a password and lossless shrinking. Files stay in memory.
/* global Module */
importScripts('lib/qpdf.js');
const WASM = new URL('lib/qpdf.wasm', self.location).href;
// This qpdf build writes its messages with console.log and console.error (it has no print hooks), so catch them here.
let current = null;
for (const k of ['log', 'error']) { const orig = console[k].bind(console); console[k] = (...a) => { if (current) current.push(a.join(' ')); else orig(...a); }; }

// A fresh qpdf instance for every job: qpdf exits after each run, like the command line tool.
async function run(args, input) {
  const log = [];
  current = log;
  const q = await Module({ noInitialRun: true, locateFile: () => WASM });
  q.FS.writeFile('/in.pdf', input);
  let code;
  try { code = q.callMain(args); } catch (e) { code = typeof e?.status === 'number' ? e.status : 1; log.push(String(e?.message || e)); }
  let out = null;
  try { out = q.FS.readFile('/out.pdf'); } catch { /* no output */ }
  current = null;
  return { code, log, out };
}

self.onmessage = async (e) => {
  const { id, op, bytes, password } = e.data;
  try {
    let r;
    if (op === 'encrypt') {
      // The owner password is set to the same password: an empty owner password would let anyone open the file.
      r = await run(['/in.pdf', '--encrypt', '--user-password=' + password, '--owner-password=' + password, '--bits=256', '--', '/out.pdf'], bytes);
    } else if (op === 'decrypt') {
      r = await run(['--password=' + (password || ''), '--decrypt', '/in.pdf', '/out.pdf'], bytes);
    } else if (op === 'shrink') {
      r = await run(['/in.pdf', '--object-streams=generate', '--compress-streams=y', '--recompress-flate', '--compression-level=9', '/out.pdf'], bytes);
    } else if (op === 'repair') {
      r = await run(['/in.pdf', '/out.pdf'], bytes);
    } else if (op === 'status') {
      // qpdf --requires-password: 0 needs a password, 2 not encrypted, 3 encrypted but opens without one
      r = await run(['--requires-password', '/in.pdf'], bytes);
    } else throw new Error('unknown job ' + op);
    const text = r.log.join('\n');
    const badPw = /invalid password/i.test(text);
    // This build reports "invalid password" (exit 2) instead of exit 0 when a file needs a password.
    if (op === 'status' && badPw) r.code = 0;
    // qpdf exit codes: 0 fine, 3 fine with warnings, 2 error
    const ok = op === 'status' ? true : (r.code === 0 || r.code === 3) && !!r.out;
    const msg = { id, ok, code: r.code, badPw, log: text.slice(0, 2000) };
    if (ok && r.out) { msg.bytes = r.out; self.postMessage(msg, [r.out.buffer]); } else self.postMessage(msg);
  } catch (err) {
    current = null;
    self.postMessage({ id, ok: false, code: -1, log: String(err?.message || err) });
  }
};
