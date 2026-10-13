const { app, BrowserWindow, ipcMain, protocol, net, shell, powerSaveBlocker, dialog, Menu } = require('electron');
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

const REMOTE = process.env.SCOUT_URL || 'https://4bcvpgnmpr-del.github.io/Editor-de-video/index.html';
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
ipcMain.handle('save:choose', async () => {
  const r = await dialog.showOpenDialog({ title: 'Carpeta donde guardar los vídeos', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled || !r.filePaths[0] ? '' : r.filePaths[0];
});
ipcMain.handle('ff:move', (_e, id, name, dir, dest) => {
  const src = path.join(jobs.get(id).dir, safe(name));
  const base = safe(dest).replace(/\.mp4$/i, '');
  let out = path.join(dir, base + '.mp4'), k = 2;
  while (fs.existsSync(out)) out = path.join(dir, base + ' (' + (k++) + ').mp4');
  fs.copyFileSync(src, out);
  try { fs.unlinkSync(src); } catch (_) {}
  return out;
});
ipcMain.handle('save:show', (_e, p) => { shell.showItemInFolder(p); });
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

let mainWin = null;
function send(action) { if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus(); mainWin.webContents.send('menu', action); } }
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const it = (id, label, accelerator, extra) => Object.assign({ id, label, accelerator, click: () => send(id) }, extra || {});
  const tpl = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'Archivo', submenu: [
      it('open', 'Abrir vídeo…', 'CmdOrCtrl+O'),
      it('saveProject', 'Guardar proyecto', 'CmdOrCtrl+S'),
      it('loadProject', 'Cargar proyecto…', 'CmdOrCtrl+Shift+O'),
      { type: 'separator' },
      it('production', 'Mesa de producción y exportar vídeo', 'CmdOrCtrl+Shift+P'),
      it('csv', 'Exportar CSV'),
      { type: 'separator' },
      it('backupExport', 'Exportar copia de seguridad…'),
      it('backupImport', 'Importar copia de seguridad…'),
      { type: 'separator' },
      it('settings', 'Ajustes…', 'CmdOrCtrl+,'),
      { type: 'separator' },
      { role: 'close', label: 'Cerrar ventana' }
    ] },
    { label: 'Edición', submenu: [
      it('undo', 'Deshacer', 'CmdOrCtrl+Z', { registerAccelerator: false }),
      it('redo', 'Rehacer', 'CmdOrCtrl+Shift+Z', { registerAccelerator: false }),
      { type: 'separator' },
      { role: 'cut', label: 'Cortar' }, { role: 'copy', label: 'Copiar' }, { role: 'paste', label: 'Pegar' }, { role: 'selectAll', label: 'Seleccionar todo' }
    ] },
    { label: 'Ver', submenu: [
      it('buttons', 'Mostrar u ocultar la botonera'),
      it('layout', 'Paneles y diseño'),
      { type: 'separator' },
      { role: 'resetZoom', label: 'Tamaño normal' }, { role: 'zoomIn', label: 'Ampliar' }, { role: 'zoomOut', label: 'Reducir' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: 'Pantalla completa' }
    ] },
    { role: 'windowMenu', label: 'Ventana' },
    { label: 'Ayuda', submenu: [ it('help', 'Tutorial') ] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 900, backgroundColor: '#0e0e10', title: 'ScoutFlow Video',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  mainWin = win;
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } } };
  });
  win.loadURL('scout://app/index.html');
}

app.whenReady().then(() => {
  protocol.handle('scout', async (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    if (rel === 'index.html') {
      // Siempre intenta bajar la última versión publicada; si no hay internet usa la última copia guardada o la incluida en la app
      const cache = path.join(app.getPath('userData'), 'index-web.html');
      const hdr = { 'content-type': 'text/html; charset=utf-8' };
      try {
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), 5000);
        const r = await fetch(REMOTE + (REMOTE.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store', signal: ctl.signal });
        clearTimeout(to);
        const txt = await r.text();
        if (r.ok && txt.length > 100000 && /<html/i.test(txt)) {
          try { fs.writeFileSync(cache, txt); } catch (_) {}
          return new Response(txt, { headers: hdr });
        }
      } catch (_) {}
      try { if (fs.existsSync(cache)) return new Response(fs.readFileSync(cache, 'utf8'), { headers: hdr }); } catch (_) {}
    }
    const file = path.join(__dirname, 'app', path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
    return net.fetch(pathToFileURL(file).toString());
  });
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { app.quit(); });
app.on('quit', () => { for (const j of jobs.values()) { try { if (j.proc) j.proc.kill('SIGKILL'); fs.rmSync(j.dir, { recursive: true, force: true }); } catch (_) {} } });
