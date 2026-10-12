/* =============================================
   Media Extractor Pro — offscreen.js
   Runs background download jobs (ZIP or individual files)
   in a hidden extension document, so the work keeps going
   after the popup is closed.

   The service worker creates this document, hands it a job,
   and does the actual chrome.downloads calls on its behalf
   (offscreen documents only get chrome.runtime).
   ============================================= */
'use strict';

const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico', 'tiff'];
const videoExts = ['mp4', 'webm', 'ogv', 'mov', 'm4v', '3gp', 'avi', 'flv', 'mkv'];
const audioExts = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus', 'wma', 'aiff'];
const allExts   = [...imageExts, ...videoExts, ...audioExts];

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
  'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/tiff': 'tiff',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv', 'video/quicktime': 'mov',
  'video/x-matroska': 'mkv', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav',
  'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
  'audio/flac': 'flac', 'audio/opus': 'opus'
};

let cancelRequested = false;
let running = false;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;

  if (msg.action === 'runJob') {
    if (running) { sendResponse({ ok: false, error: 'busy' }); return false; }
    running = true;
    cancelRequested = false;
    runJob(msg.job)
      .catch(err => report({ state: 'error', message: String(err?.message || err) }))
      .finally(() => { running = false; });
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === 'cancelJob') {
    cancelRequested = true;
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === 'revokeBlob') {
    try { URL.revokeObjectURL(msg.url); } catch {}
    return false;
  }
  return false;
});

// ── Messaging helpers ─────────────────────────
function report(patch) {
  return chrome.runtime.sendMessage({ action: 'jobProgress', patch }).catch(() => {});
}

function requestDownload(url, filename, saveAs = false, isBlob = false) {
  return chrome.runtime.sendMessage({ action: 'jobDownload', url, filename, saveAs, isBlob })
    .catch(() => null);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Job runner ────────────────────────────────
async function runJob(job) {
  const { mode, items, options = {} } = job;
  const total = items.length;
  let done = 0, failed = 0;

  await report({ state: 'running', phase: mode === 'zip' ? 'Fetching' : 'Downloading', total, done, failed });

  if (mode === 'zip') {
    const zip = new JSZip();
    const usedNames = new Set();
    let added = 0;

    for (let i = 0; i < items.length; i++) {
      if (cancelRequested) break;
      const item = items[i];
      try {
        const url = await resolvePinterestVideo(item.url);
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        const ctype = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        // A login wall or error page comes back as HTML — don't zip that as "media"
        if (ctype.startsWith('text/html')) throw new Error('Got an HTML page instead of media (logged out?)');

        let blob = await resp.blob();
        let name = deriveFilename(url, resp.headers.get('content-disposition'), ctype, item.kind);

        if (options.convertWebp && /\.(webp|avif)$/i.test(name)) {
          try {
            blob = await convertImageBlob(blob, 'image/jpeg', 0.95);
            name = name.replace(/\.(webp|avif)$/i, '.jpg');
          } catch {}
        }

        if (options.renamePattern) name = applyRename(options.renamePattern, i + 1, name);
        zip.file(uniqueName(name, usedNames), blob);
        added++;
      } catch (err) {
        failed++;
        console.warn('[MEP] zip fetch failed:', item.url, err);
      }
      done = i + 1;
      await report({ done, failed });
    }

    if (cancelRequested) {
      await report({ state: 'cancelled', message: `Cancelled after ${done} of ${total}` });
      return;
    }
    if (added === 0) {
      await report({ state: 'error', message: 'None of the files could be fetched' });
      return;
    }

    await report({ phase: 'Compressing', percentOverride: 0 });
    const zipBlob = await zip.generateAsync(
      { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
      meta => { throttledReport({ percentOverride: Math.round(meta.percent) }); }
    );

    const blobUrl = URL.createObjectURL(zipBlob);
    const zipName = `${sanitize(options.subfolder || 'media-extractor-pro')}.zip`;
    await report({ phase: 'Saving' });
    const res = await requestDownload(blobUrl, zipName, !!options.saveAs, true);
    if (!res || !res.ok) {
      URL.revokeObjectURL(blobUrl);
      await report({ state: 'error', message: 'Could not start the ZIP download' + (res?.error ? `: ${res.error}` : '') });
      return;
    }
    await report({
      state: 'done',
      message: `Zipped ${added} file${added !== 1 ? 's' : ''}` + (failed ? ` (${failed} failed)` : '') + ` → ${zipName}`
    });
    return;
  }

  // mode === 'files' — individual downloads
  const folder = sanitize(options.subfolder || 'media-extractor-pro');
  for (let i = 0; i < items.length; i++) {
    if (cancelRequested) break;
    const item = items[i];
    try {
      let name = deriveFilename(item.url, null, '', item.kind);
      const needsConvert = options.convertWebp && /\.(webp|avif)$/i.test(name);

      if (needsConvert) {
        const resp = await fetch(item.url, { credentials: 'include' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const jpg = await convertImageBlob(await resp.blob(), 'image/jpeg', 0.95);
        name = name.replace(/\.(webp|avif)$/i, '.jpg');
        if (options.renamePattern) name = applyRename(options.renamePattern, i + 1, name);
        const blobUrl = URL.createObjectURL(jpg);
        const res = await requestDownload(blobUrl, `${folder}/${name}`, false, true);
        if (!res?.ok) { URL.revokeObjectURL(blobUrl); throw new Error(res?.error || 'download failed'); }
      } else {
        if (options.renamePattern) name = applyRename(options.renamePattern, i + 1, name);
        // Let the browser fetch it natively (keeps cookies, handles big videos)
        const res = await requestDownload(item.url, `${folder}/${name}`, false, false);
        if (!res?.ok) throw new Error(res?.error || 'download failed');
      }
    } catch (err) {
      failed++;
      console.warn('[MEP] download failed:', item.url, err);
    }
    done = i + 1;
    await report({ done, failed });
    if (i < items.length - 1) await sleep(250);
  }

  if (cancelRequested) {
    await report({ state: 'cancelled', message: `Cancelled after ${done} of ${total}` });
  } else {
    await report({
      state: failed === total ? 'error' : 'done',
      message: `Downloaded ${total - failed} file${total - failed !== 1 ? 's' : ''}` + (failed ? ` (${failed} failed)` : '')
    });
  }
}

let lastThrottle = 0;
function throttledReport(patch) {
  const now = Date.now();
  if (now - lastThrottle < 400) return;
  lastThrottle = now;
  report(patch);
}

// ── Filenames ─────────────────────────────────
function sanitize(name) {
  return String(name).replace(/[<>:"\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').trim() || 'file';
}

function deriveFilename(url, contentDisposition, ctype, kind) {
  let name = '';

  // 1. Server-provided filename
  if (contentDisposition) {
    const star = contentDisposition.match(/filename\*\s*=\s*[^']*''([^;]+)/i);
    const plain = contentDisposition.match(/filename\s*=\s*"?([^";]+)"?/i);
    try { name = star ? decodeURIComponent(star[1]) : (plain ? plain[1] : ''); } catch { name = plain ? plain[1] : ''; }
  }

  let path = '';
  try { path = new URL(url).pathname; } catch { path = url.split('?')[0]; }

  // 2. XenForo-style attachment URL: /attachments/some-name-jpg.123456/
  if (!name) {
    const xf = path.match(/\/attachments\/([^/]+)-([a-z0-9]{2,5})\.(\d+)\/?$/i);
    if (xf) name = `${xf[1]}_${xf[3]}.${xf[2].toLowerCase()}`;
  }

  // 3. Last path segment
  if (!name) {
    const seg = decodeSafe(path.split('/').filter(Boolean).pop() || '');
    name = seg;
  }

  name = sanitize(name.split('/').pop());

  // Make sure there's a sensible extension
  const extMatch = name.match(/\.([a-z0-9]{2,5})$/i);
  const hasKnownExt = extMatch && allExts.includes(extMatch[1].toLowerCase());
  if (!hasKnownExt) {
    let ext = MIME_EXT[ctype] || '';
    if (!ext) ext = kind === 'videos' ? 'mp4' : kind === 'audios' ? 'mp3' : 'jpg';
    name = name.replace(/\.(cmfv|cmfa|bin|unknown)$/i, '');
    if (!name || name === 'file') name = `file_${Date.now()}`;
    name = `${name}.${ext}`;
  }
  return name;
}

function decodeSafe(s) { try { return decodeURIComponent(s); } catch { return s; } }

function uniqueName(name, used) {
  if (!used.has(name.toLowerCase())) { used.add(name.toLowerCase()); return name; }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let n = 2;
  while (used.has(`${base} (${n})${ext}`.toLowerCase())) n++;
  const out = `${base} (${n})${ext}`;
  used.add(out.toLowerCase());
  return out;
}

function applyRename(pattern, index, currentName) {
  const ext = (currentName.match(/\.[a-z0-9]{2,5}$/i) || ['.bin'])[0];
  const base = pattern.includes('[index]') ? pattern.replace(/\[index\]/g, String(index)) : `${pattern}-${index}`;
  return sanitize(base) + ext;
}

// ── Pinterest video resolution ────────────────
async function resolvePinterestVideo(url) {
  if (!url || !url.includes('pinimg.com/videos')) return url;
  const m = url.match(/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{32})/i);
  if (!m) return url;
  const [, p1, p2, p3, hash] = m;
  const iht = url.includes('/iht/');
  const candidates = iht ? [
    `https://v1.pinimg.com/videos/iht/expMp4/${p1}/${p2}/${p3}/${hash}_720w.mp4`,
    `https://v1.pinimg.com/videos/mc/720p/${p1}/${p2}/${p3}/${hash}.mp4`,
    `https://v1.pinimg.com/videos/mc/expMp4/${p1}/${p2}/${p3}/${hash}_t1.mp4`
  ] : [
    `https://v1.pinimg.com/videos/mc/720p/${p1}/${p2}/${p3}/${hash}.mp4`,
    `https://v1.pinimg.com/videos/iht/expMp4/${p1}/${p2}/${p3}/${hash}_720w.mp4`,
    `https://v1.pinimg.com/videos/mc/expMp4/${p1}/${p2}/${p3}/${hash}_t1.mp4`
  ];
  for (const c of candidates) {
    try {
      const r = await fetch(c, { method: 'HEAD' });
      const t = r.headers.get('content-type') || '';
      if (r.ok && !t.includes('xml')) return c;
    } catch {}
  }
  return url;
}

// ── Canvas format converter ───────────────────
function convertImageBlob(blob, targetFormat = 'image/jpeg', quality = 0.95) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext('2d');
      if (targetFormat === 'image/jpeg') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Canvas conversion failed'))), targetFormat, quality);
    };
    img.onerror = err => { URL.revokeObjectURL(url); reject(err); };
    img.src = url;
  });
}
