async function main() {
  const cdpUrl = 'http://127.0.0.1:9222';
  const targetResponse = await fetch(`${cdpUrl}/json/new?${encodeURIComponent('http://127.0.0.1:4011/videos/dogs')}`, { method: 'PUT' });
  if (!targetResponse.ok) {
    throw new Error(`Failed to create target: ${targetResponse.status}`);
  }
  const target = await targetResponse.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);

  let nextId = 1;
  const pending = new Map();
  const events = new Map();

  function on(eventName, handler) {
    if (!events.has(eventName)) {
      events.set(eventName, []);
    }
    events.get(eventName).push(handler);
  }

  function once(eventName, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for ${eventName}`));
      }, timeoutMs);
      on(eventName, (params) => {
        clearTimeout(timeout);
        resolve(params);
      });
    });
  }

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject, method });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  ws.addEventListener('message', (messageEvent) => {
    const payload = JSON.parse(messageEvent.data.toString());
    if (payload.id) {
      const pendingEntry = pending.get(payload.id);
      if (!pendingEntry) return;
      pending.delete(payload.id);
      if (payload.error) {
        pendingEntry.reject(new Error(payload.error.message || `CDP error for ${pendingEntry.method}`));
      } else {
        pendingEntry.resolve(payload.result);
      }
      return;
    }

    const handlers = events.get(payload.method) || [];
    handlers.forEach((handler) => {
      try {
        handler(payload.params || {});
      } catch (err) {
        // ignore handler errors
      }
    });
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.bringToFront');
  await once('Page.loadEventFired', 15000).catch(() => null);
  await send('Runtime.evaluate', {
    expression: `new Promise((resolve) => {
      if (document.readyState === 'complete') {
        setTimeout(resolve, 800);
        return;
      }
      window.addEventListener('load', () => setTimeout(resolve, 800), { once: true });
    })`,
    awaitPromise: true,
  });

  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    return result.result ? result.result.value : undefined;
  }

  const before = await evaluate(`(() => {
    const rect = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return { width: Math.round(box.width), height: Math.round(box.height), top: Math.round(box.top), left: Math.round(box.left) };
    };
    return {
      shell: rect('[data-video-player]'),
      player: rect('.video-detail-player'),
      stage: rect('.video-detail-player__stage'),
      video: rect('#video-detail'),
      controls: rect('.video-controls--detail'),
      fullscreenElement: !!document.fullscreenElement,
      shellClassFullscreen: document.querySelector('[data-video-player]')?.classList.contains('is-fullscreen') || false
    };
  })()`);

  await evaluate(`document.querySelector('.video-controls--detail .fullscreen')?.click()`);
  await send('Runtime.evaluate', {
    expression: `new Promise((resolve) => setTimeout(resolve, 1000))`,
    awaitPromise: true,
  });

  const afterFullscreen = await evaluate(`(() => {
    const rect = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return { width: Math.round(box.width), height: Math.round(box.height), top: Math.round(box.top), left: Math.round(box.left) };
    };
    return {
      shell: rect('[data-video-player]'),
      player: rect('.video-detail-player'),
      stage: rect('.video-detail-player__stage'),
      video: rect('#video-detail'),
      controls: rect('.video-controls--detail'),
      fullscreenElement: !!document.fullscreenElement,
      shellClassFullscreen: document.querySelector('[data-video-player]')?.classList.contains('is-fullscreen') || false,
      buttonLabel: document.querySelector('.video-controls--detail .fullscreen')?.textContent?.trim() || '',
      viewport: { width: window.innerWidth, height: window.innerHeight }
    };
  })()`);

  const audioSync = await evaluate(`(() => {
    const video = document.getElementById('video-detail');
    if (!video) {
      return { error: 'video missing' };
    }
    let pauseCalls = 0;
    let playCalls = 0;
    wavesurfer = {
      playing: true,
      isPlaying() { return this.playing; },
      pause() { this.playing = false; pauseCalls += 1; },
      play() { this.playing = true; playCalls += 1; return Promise.resolve(); }
    };
    currentTrackFilename = 'mock-track.mp3';
    queue = [{ filename: 'mock-track.mp3', title: 'Mock Track' }];
    currentTrackIndex = 0;
    isPlayerReady = true;
    footerMusicAutoPausedByVideo = false;

    video.dispatchEvent(new Event('play'));
    const afterPlay = {
      footerMusicAutoPausedByVideo,
      pauseCalls,
      playCalls,
      isWaveSurferPlaying: wavesurfer.isPlaying()
    };

    video.dispatchEvent(new Event('pause'));
    const afterManualPause = {
      footerMusicAutoPausedByVideo,
      pauseCalls,
      playCalls,
      isWaveSurferPlaying: wavesurfer.isPlaying()
    };

    wavesurfer.playing = true;
    footerMusicAutoPausedByVideo = false;
    video.dispatchEvent(new Event('play'));
    video.dispatchEvent(new Event('ended'));
    const afterEnded = {
      footerMusicAutoPausedByVideo,
      pauseCalls,
      playCalls,
      isWaveSurferPlaying: wavesurfer.isPlaying()
    };

    return { afterPlay, afterManualPause, afterEnded };
  })()`);

  await evaluate(`document.querySelector('.video-controls--detail .fullscreen')?.click()`);
  await send('Runtime.evaluate', {
    expression: `new Promise((resolve) => setTimeout(resolve, 500))`,
    awaitPromise: true,
  });

  const afterExit = await evaluate(`(() => ({
    fullscreenElement: !!document.fullscreenElement,
    shellClassFullscreen: document.querySelector('[data-video-player]')?.classList.contains('is-fullscreen') || false,
    buttonLabel: document.querySelector('.video-controls--detail .fullscreen')?.textContent?.trim() || ''
  }))()`);

  console.log(JSON.stringify({ before, afterFullscreen, afterExit, audioSync }, null, 2));
  ws.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
