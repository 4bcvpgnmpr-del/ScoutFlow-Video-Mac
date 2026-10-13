const { app, BrowserWindow, ipcMain, protocol, net, shell, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

protocol.registerSchemesAsPrivileged([
  { scheme: 'scout', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
]);

let ffmpegPath = require('ffmpeg-static');
if (ffmpegPath) ffmpegPath = ffmpegPath.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);

const jobs = new Map(); // id -> {dir, proc}
let seq = 0, blocker = null;
const safe = (n) => path.basename(String(n));

ipcMain.handle('ff:start', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutflow-'));
  const id = 'j' + (++seq);
  jobs.set(id, { dir, proc: null });
  return id;
});
ipcMain.handle('ff:write', (_e, id, name, data) => { fs.writeFileSync(path.join(jobs.get(id).dir, safe(name)), Buffer.from(data)); });
ipcMain.handle('ff:append', (_e, id, name, data, first) => {
  const f = path.join(jobs.get(id).dir, safe(name));
  if (first) fs.writeFileSync(f, Buffer.from(data)); else fs.appendFileSync(f, Buffer.from(data));
});
ipcMain.handle('ff:pathOf', (_e, id, name) => path.join(jobs.get(id).dir, safe(name)));
ipcMain.handle('ff:read', (_e, id, name) => new Uint8Array(fs.readFileSync(path.join(jobs.get(id).dir, safe(name)))));
ipcMain.handle('ff:del', (_e, id, name) => { try { fs.unlinkSync(path.join(jobs.get(id).dir, safe(name))); } catch (_) {} });
ipcMain.handle('ff:kill', (_e, id) => { const j = jobs.get(id); if (j && j.proc) { try { j.proc.kill('SIGKILL'); } catch (_) {} } });
ipcMain.handle('ff:awake', (_e, on) => {
  if (on && blocker === null) blocker = powerSaveBlocker.start('prevent-display-sleep');
  if (!on && blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
});
ipcMain.handle('ff:exec', (e, id, args) => new Promise((resolve) => {
  const j = jobs.get(id);
  const proc = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', ...args], { cwd: j.dir });
  j.proc = proc;
  let buf = '', err = '';
  proc.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
      if (m) { try { e.sender.send('ff:progress', Number(m[1]) / 1e6); } catch (_) {} }
    }
  });
  proc.stderr.on('data', (d) => { err = (err + d.toString()).slice(-2000); });
  proc.on('error', (er) => { console.error('ffmpeg:', er); resolve(1); });
  proc.on('close', (code) => { j.proc = null; if (code) console.error('ffmpeg error', code, err); resolve(code === null ? 1 : code); });
}));

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 900, backgroundColor: '#0e0e10', title: 'ScoutFlow Video',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } } };
  });
  win.loadURL('scout://app/index.html');
}

app.whenReady().then(() => {
  protocol.handle('scout', (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.join(__dirname, 'app', path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
    return net.fetch(pathToFileURL(file).toString());
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { app.quit(); });
app.on('quit', () => { for (const j of jobs.values()) { try { if (j.proc) j.proc.kill('SIGKILL'); fs.rmSync(j.dir, { recursive: true, force: true }); } catch (_) {} } });
