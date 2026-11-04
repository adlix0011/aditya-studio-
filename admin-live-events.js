(function () {
  'use strict';

  // Keep browser code outside server.js's HTML template: template escaping
  // previously turned /https:\/\// into invalid JavaScript before it arrived.
  function bindEventEditor(options) {
    const button = document.getElementById(options.button);
    const status = document.getElementById(options.status);
    if (!button || !status || button.dataset.liveEventBound) return;
    button.dataset.liveEventBound = 'true';
    const input = id => document.getElementById(id);
    const debug = input(options.debug);
    let busy = false;
    let messages = [];

    function show(message, failed) {
      status.textContent = message;
      status.style.color = failed ? '#fca5a5' : '#a5f3fc';
      messages.push(message);
      if (debug) {
        debug.hidden = false;
        debug.style.display = 'block';
        debug.textContent = messages.join('\n');
      }
    }

    async function request(url, body) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await fetch(url, {
          method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
          signal: controller.signal,
          headers: body ? { 'Content-Type': 'application/json' } : {},
          body: body ? JSON.stringify(body) : undefined
        });
        if (response.status === 401 || response.status === 403 || response.redirected) {
          throw new Error('Admin session verify karein; save nahi hua (HTTP ' + response.status + ').');
        }
        let result;
        try { result = await response.json(); }
        catch (_) { throw new Error('Server response invalid (HTTP ' + response.status + ').'); }
        if (!response.ok || !result.ok) {
          throw new Error((result.message || result.error || 'Save failed') + ' (HTTP ' + response.status + ').');
        }
        return result;
      } catch (error) {
        if (error.name === 'AbortError') {
          throw new Error('Server ne 30 seconds mein jawab nahi diya. Dobara add karne se pehle saved events check karein.');
        }
        throw error;
      } finally { clearTimeout(timer); }
    }

    function thumbnail(file) {
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const image = new Image();
        const finish = (error, value) => {
          clearTimeout(timer);
          image.onload = image.onerror = null;
          URL.revokeObjectURL(url);
          if (error) reject(error); else resolve(value);
        };
        const timer = setTimeout(() => finish(new Error('Thumbnail process timeout. JPG/PNG photo try karein.')), 20000);
        image.onerror = () => finish(new Error('Thumbnail read nahi hua. JPG/PNG/WebP photo choose karein.'));
        image.onload = () => {
          try {
            const scale = Math.min(1, 1400 / Math.max(image.naturalWidth, image.naturalHeight));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
            const context = canvas.getContext('2d');
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            finish(null, canvas.toDataURL('image/jpeg', 0.84));
          } catch (_) { finish(new Error('Thumbnail process nahi hua. Chhoti photo try karein.')); }
        };
        image.src = url;
      });
    }

    button.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      button.disabled = true;
      messages = [];
      try {
        show('1/3 Click received — details check ho rahe hain…');
        const file = input(options.file).files[0];
        const driveUrl = input(options.link).value.trim();
        const password = input(options.password).value;
        const title = options.title ? (input(options.title).value.trim() || 'Live Event') : 'Live Event';
        let drive;
        try { drive = new URL(driveUrl); } catch (_) { /* validated below */ }
        if (!drive || drive.protocol !== 'https:' || !['drive.google.com', 'docs.google.com'].includes(drive.hostname) || drive.username || drive.password) {
          throw new Error('Google Drive ka poora https link paste karein.');
        }
        if ((options.add || password) && (password.length < 4 || password.length > 80)) {
          throw new Error('Password 4 se 80 characters ka rakhein.');
        }
        if (options.add && !file) throw new Error('Pehle thumbnail choose karein.');
        if (file && (!file.type.startsWith('image/') || file.size > 12 * 1024 * 1024)) {
          throw new Error('12 MB se chhoti image thumbnail choose karein.');
        }
        show('2/3 Thumbnail process ho raha hai…');
        const image = file ? await thumbnail(file) : (await request('/api/home-gallery-samples')).liveEvent.thumbnail;
        if (!image) throw new Error('Pehle thumbnail choose karein.');
        show('3/3 Thumbnail, link aur password save ho rahe hain…');
        await request(options.endpoint, { title, thumbnail: image, driveUrl, password });
        show('Saved successfully — Home page par Live Event available hai.');
        status.style.color = '#86efac';
        input(options.file).value = '';
        input(options.password).value = '';
        const saved = input(options.preview);
        if (saved) {
          if (!options.add) saved.textContent = '';
          const item = document.createElement('div');
          const img = document.createElement('img');
          img.src = image;
          img.alt = title + ' thumbnail';
          img.style.cssText = 'width:112px;height:64px;object-fit:cover;border-radius:9px;vertical-align:middle;margin:8px';
          item.append(img, document.createTextNode('✓ ' + title + ' saved'));
          saved.appendChild(item);
        }
      } catch (error) {
        show('FAILED: ' + (error.message || 'Network error; connection check karein.'), true);
      } finally {
        busy = false;
        button.disabled = false;
      }
    });
    status.textContent = options.add ? 'Ready to add' : 'Ready to save';
    button.disabled = false;
  }

  bindEventEditor({ add: true, button: 'liveEventAddBtn', status: 'liveEventAddSt', debug: 'liveEventAddDebug',
    file: 'liveEventNewFile', title: 'liveEventNewTitle', link: 'liveEventNewDriveUrl', password: 'liveEventNewPassword',
    endpoint: '/admin/live-events-add', preview: 'liveEventAddedPreviews' });
  bindEventEditor({ add: false, button: 'liveEventSaveBtn', status: 'liveEventSt', debug: 'liveEventSaveDebug',
    file: 'liveEventFile', link: 'liveEventDriveUrl', password: 'liveEventPassword',
    endpoint: '/admin/live-event-save', preview: 'liveEventSavedPreview' });
})();
