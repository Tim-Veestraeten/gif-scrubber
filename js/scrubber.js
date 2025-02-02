window.addEventListener('load', () => {

  const manifest = chrome.runtime.getManifest();
  document.title = `${manifest.name} ${manifest.version}`;

  function clamp(num, min, max) {
    return Math.min(Math.max(num, min), max);
  }

  function preference(item) {
    return localStorage[item] === 'true';
  }

  // Progress Bars
  // =============

  const barSettings = {
    color: '#fff',
    strokeWidth: 20,
    trailWidth: 1,
    text: {
      autoStyleContainer: false
    },
    from: { color: '#fff', width: 20 },
    to: { color: '#fff', width: 20 },
    step (state, circle) {
      circle.path.setAttribute('stroke', state.color);
      circle.path.setAttribute('stroke-width', state.width);
      const value = Math.round(circle.value() * 100);
      circle.setText(value === 0 ? '' : `${value}%`);
    }
  };
  const $downloadBar = document.getElementById('download-progress-bar');
  const $renderBar = document.getElementById('render-progress-bar');
  const downloadBar = new ProgressBar.Circle($downloadBar, barSettings);
  const renderBar = new ProgressBar.Circle($renderBar, barSettings);

  // DOM Cache
  // =========

  const dom = {
    errorMessage: document.getElementById('error-message'),
    explodedFrames: document.getElementById('exploded-frames'),
    filler: document.getElementById('scrubber-bar-filler'),
    pausePlayIcon: document.getElementById('play-pause-icon'),
    speedList: document.getElementById('speed-list'),
    speeds: document.querySelectorAll('#speed-list td'),
    bar: document.getElementById('scrubber-bar'),
    image: document.getElementById('image-holder'),
    line: document.getElementById('scrubber-bar-line'),
    spacer: document.getElementById('bubble-spacer'),
    zipIcon: document.querySelectorAll('#zip .fa'),
  };

  const canvas = {
    display: document.getElementById('canvas-display'),
    render: document.getElementById('canvas-render'),
  };

  const context = {
    display: canvas.display.getContext('2d'),
    render: canvas.render.getContext('2d'),
  };

  dom.explodeView = [dom.explodedFrames, dom.spacer, dom.speedList];
  dom.explodeViewToggles = document.querySelectorAll('#bomb, #exploded-frames .close');
  dom.player = [dom.bar, dom.speedList, canvas.display, dom.spacer, document.getElementById('toolbar')];
  dom.loadingScreen = [canvas.render, document.getElementById('messages'), document.body];

  // Validate URL
  // ============

  let downloadReady;
  let state = {};
  let url = '';
  const urlString = decodeURIComponent(window.location.hash.substring(1));
  const urlList = JSON.parse(urlString).map(function (url) {

    // Imgur support
    if (url.includes('imgur')) {
      if (url.endsWith('gifv')) url = url.slice(0, -1);
      else if (url.endsWith('mp4')) url = url.slice(0, -3) + 'gif';
      else if (url.endsWith('webm')) url = url.slice(0, -4) + 'gif';
      if (!url.endsWith('.gif')) url += '.gif';
    }

    // Gfycat support
    if (url.includes('gfycat') && !url.includes('giant.gfycat')) {
      URLparts = url.split('/');
      let code = URLparts[URLparts.length - 1].split('.')[0];
      if (code.endsWith('-mobile')) code = code.slice(0, -7);
      url = `https://giant.gfycat.com/${code}.gif`;
    }

    return url;
  });

  function confirmGIF(url) {
    return new Promise(function(ignore, use) {
      if (url === 'undefined') return ignore('undefined');
      const h = new XMLHttpRequest();
      h.open('GET', url);
      h.setRequestHeader('Range', 'bytes=0-5');
      h.onload = () => {
        const validHeaders = ['GIF87a', 'GIF89a'];
        if (validHeaders.includes(h.responseText.substr(0, 6))) use(url);
        else ignore('bad header');
      };
      h.onerror = () => ignore('error loading');
      h.send(null);
    });
  }

  // Download GIF
  // ============

  Promise.all(urlList.map(confirmGIF)).then(reason => {
    showError('Not a valid GIF file.');
    console.log('Could not load GIF from URL because: ',reason);
  }, validURL => {
    console.log('downloading...',validURL);
    console.time('download');
    const h = new XMLHttpRequest();
    h.responseType = 'arraybuffer';
    h.onload = request => downloadReady = handleGIF(request.target.response);
    h.onprogress = e => e.lengthComputable && downloadBar.set(e.loaded / e.total);
    h.onerror = showError.bind(null, validURL);
    h.open('GET', validURL, true);
    h.send();
    url = validURL;
  });

  // Initialize player
  // =================

  function init() {

    // Clean up any previous scrubbing
    if (Object.entries(state).length > 0) {
      document.getElementById('exploding-message').style.display = 'none';
      for (const img of document.querySelectorAll('#exploded-frames > img')) img.remove();
      context.display.clearRect(0, 0, state.width, state.height);
    }

    // Default state
    window.state = state = {
      barWidth: null,
      currentFrame: 0,
      debug: {
        showRawFrames: false,
      },
      hasTransparency: false,
      keyFrameRate: 15, // Performance: Pre-render every n frames
      frame() { return this.frames[this.currentFrame] },
      frameDelay() { return this.frame().delayTime / Math.abs(this.speed) },
      frames: [],
      playing: false,
      playTimeoutId: null,
      scrubbing: false,
      speed: 1,
      zipGen: new JSZip(),
    };
  }

  function showError(msg) {
    dom.errorMessage.html(`<span class="error">${msg}</span>`);
  }

  function handleGIF(buffer) {
    console.timeEnd('download');
    console.time('parse');
    const bytes = new Uint8Array(buffer);
    init();

    // Image dimensions
    const dimensions = new Uint16Array(buffer, 6, 2);
    [state.width, state.height] = dimensions;
    canvas.render.width = canvas.display.width = state.width;
    canvas.render.height = canvas.display.height = state.height;
    dom.bar.style.width = dom.line.style.width =
      state.barWidth = Math.max(state.width, 450);
    const content = document.getElementById('content');
    content.style.width = state.barWidth;
    content.style.height = state.height;

    // Adjust window size
    if (!preference('open-tabs')) {
      chrome.windows.getCurrent((win) => {
        chrome.windows.update(win.id, {
          width: Math.max(state.width + 180, 640),
          height: clamp(state.height + 300, 410, 850),
        });
      });
    }

    // Record global color table
    let pos = 13 + colorTableSize(bytes[10]);
    const gct = bytes.subarray(13, pos);

    state.frames = parseFrames(buffer, pos, gct, state.keyFrameRate);
    console.timeEnd('parse');

    return renderKeyFrames()
      .then(showControls)
      .then(renderIntermediateFrames)
      .then(explodeFrames)
      .catch(err => console.error('Rendering GIF failed!', err));
  }

  const chainPromises = [(x, y) => x.then(y), Promise.resolve()];

  function renderKeyFrames() {
    console.time('render-keyframes');
    return state.frames
      .map(frame => () => {
        return createImageBitmap(frame.blob)
          .then(bitmap => { frame.drawable = bitmap; return frame })
          .then(renderAndSave);
      })
      .reduce(...chainPromises);
  }

  function renderIntermediateFrames() {
    console.time('background-render');
    return state.frames
      .map(frame => () => renderAndSave(frame))
      .reduce(...chainPromises);
  }

  function explodeFrames() {
    console.timeEnd('background-render');
    state.frames.map(x => dom.explodedFrames.append(x.canvas));
    document.getElementById('exploding-message').style.display = 'none';
  }

  // Keyboard and mouse controls
  // ===========================

  function showControls() {
    console.timeEnd('render-keyframes');
    console.time('background-render');
    for (const playerEl of dom.player) playerEl.classList.add('displayed');
    for (const loadingEl of dom.loadingScreen) loadingEl.classList.remove('displayed');
    showFrame(state.currentFrame);
    togglePlaying(preference('auto-play'));
    canvas.display.classList.add(localStorage['background-color']);

    const urlInput = document.getElementById('url');
    for (const eventType of ['mousedown', 'mouseup', 'mousemove']) {
      urlInput.addEventListener(eventType, e => e.stopPropagation());
    }
    urlInput.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.keyCode === 13) {
        const url = encodeURIComponent(e.currentTarget.value);
        location.href = location.href.replace(location.hash,'') + '#' + JSON.stringify([url]);
        location.reload();
      }
    });

    document.getElementById('bubble-spacer').addEventListener('mousedown', e => {
       state.scrubbing = true;
        state.scrubStart = e.pageX;
    })
    document.addEventListener('mouseup', () => state.scrubbing = false )
    document.addEventListener('mousemove', e => {
      if (Math.abs(e.pageX - state.scrubStart) < 2) return;
      state.clicking = false;
      if (state.scrubbing || preference('mouse-scrub')) updateScrub(e);
    });

    dom.bar.addEventListener('mousedown', updateScrub);
    dom.image.addEventListener('mousedown', e => { state.clicking = true })
    dom.image.addEventListener('mouseup', e => {
      if (state.clicking) togglePlaying(!state.playing);
      state.clicking = false;
    })

    document.body.addEventListener('keydown', e => {
      switch (e.keyCode) {
        case 8: // Backspace
        case 27: // Escape
        case 69: return toggleExplodeView(); // E
        case 32: return togglePlaying(!state.playing); // Space
        case 37: return advanceFrame(-1); // Left Arrow
        case 39: return advanceFrame(1); // Right Arrow
        case 79: return options(); // O
      }
    });

    if (state.debug.showRawFrames) throw 'abort rendering frames';
  }

  // GIF parsing
  // ===========

  function colorTableSize(packedHeader) {
    const tableFlag = packedHeader.bits(0, 1);
    if (tableFlag !== 1) return 0;
    const size = packedHeader.bits(5, 3);
    return 3 * Math.pow(2, size + 1);
  }

  function parseFrames(buffer, pos, gct, keyFrameRate) {
    const bytes = new Uint8Array(buffer);
    const trailer = new Uint8Array([0x3B]);
    const frames = [];
    let gce = {
      disposalMethod: 0,
      transparent: 0,
      delayTime: 10,
    };
    let packed;

    // Rendering 87a GIFs didn't work right for some reason.
    // Forcing the 89a header made them work.
    const headerBytes = 'GIF89a'.split('').map(x => x.charCodeAt(0), []);
    const nextBytes = bytes.subarray(6, 13);
    const header = new Uint8Array(13);
    header.set(headerBytes);
    header.set(nextBytes, 6);

    while (pos < bytes.length) {
      switch (bytes[pos]) {
        case 0x21:
          switch (bytes[pos+1]) {
            case 0xF9: // Graphics control extension...
              packed = bytes[pos+3];
              gce = {
                pos: pos,
                disposalMethod: packed.bits(3, 3),
                transparent: packed.bits(7, 1),
                delayTime: bytes[pos+4],
                tci: bytes[pos+6],
              };
              pos += 8;
              break;
            case 0xFE: pos -= 12; // Comment extension fallthrough...
            case 0xFF: pos -= 1; // Application extension fallthrough...
            case 0x01: pos += 15; // Plain Text extension fallthrough...
            default: // Skip data sub-blocks
              while (bytes[pos] !== 0x00) pos += bytes[pos] + 1;
              pos++;
          }
          break;
        case 0x2C: { // `New image frame at ${pos}`
          const [x, y, w, h] = new Uint16Array(buffer.slice(pos + 1, pos + 9));
          const frame = {
            disposalMethod: gce.disposalMethod,
            delayTime: gce.delayTime < 2 ? 100 : gce.delayTime * 10,
            isKeyFrame: frames.length % keyFrameRate === 0 && !!frames.length,
            isRendered: false,
            number: frames.length + 1,
            transparent: gce.transparent,
            pos: {x, y},
            size: {w, h},
          };

          // We try to detect transparency in first frame after drawing...
          // But we assume transparency if using method 2 since the background
          // could show through
          if (frame.disposalMethod === 2) {
            state.hasTransparency = true;
          }

          // Skip local color table
          const imageStart = pos;
          pos += colorTableSize(bytes[pos+9]) + 11;

          // Skip data blocks
          while (bytes[pos] !== 0x00) pos += bytes[pos] + 1;
          let imageBlocks = bytes.subarray(imageStart, ++pos);

          // Use a Graphics Control Extension
          if (typeof gce.pos !== 'undefined') {
            imageBlocks = bytes.subarray(gce.pos, gce.pos + 4) // Begin ext
              .concat(new Uint8Array([0x00,0x00])) // Zero out the delay time
              .concat(bytes.subarray(gce.pos + 6, gce.pos + 8)) // End ext
              .concat(imageBlocks);
          }

          const data = header.concat(gct).concat(imageBlocks).concat(trailer);
          frame.blob = new Blob([data], {type: 'image/gif'});
          frames.push(frame);
          break;
        }
        case 0x3B: // End of file
          return frames;
        default:
          return showError('Error: Could not decode GIF');
      }
    }
  }

  // Drawing to canvas
  // =================

  function renderAndSave(frame) {
    renderFrame(frame, context.render)
    if (frame.isRendered || !frame.isKeyFrame)  {
      frame.isKeyFrame = true;
      return Promise.resolve();
    }
    return new Promise(function(resolve, reject) {
      frame.putable = context.render.getImageData(0, 0, state.width, state.height)
      frame.blob = null;
      frame.drawable = null;
      frame.isRendered = true
      const c = frame.canvas = document.createElement('canvas');
      [c.width, c.height] = [state.width, state.height];
      c.getContext('2d').putImageData(frame.putable, 0, 0);
      renderBar.set(frame.number / state.frames.length);
      setTimeout(resolve, 0);
    });
  }

  function renderFrame(frame, ctx) {
    const [{x, y}, {w, h}, method] = [frame.pos, frame.size, frame.disposalMethod];
    const full = [0, 0, state.width, state.height];
    const prevFrame = state.frames[frame.number - 2];

    if (!prevFrame) {
      ctx.clearRect(...full); // First frame, wipe the canvas clean
    } else {
      // Disposal method 0 or 1: draw image only
      // Disposal method 2: draw image then erase portion just drawn
      // Disposal method 3: draw image then revert to previous frame
      const [{x, y}, {w, h}, method] = [prevFrame.pos, prevFrame.size, prevFrame.disposalMethod];
      if (method === 2) ctx.clearRect(x, y, w, h);
      if (method === 3) ctx.putImageData(prevFrame.backup, 0, 0);
    }

    frame.backup = method === 3 ? ctx.getImageData(...full) : null;
    drawFrame(frame, ctx);

    // Check first frame for transparency
    if (!prevFrame && !state.hasTransparency && !state.firstFrameChecked) {
      state.firstFrameChecked = true;
      const data = ctx.getImageData(0, 0, state.width, state.height).data;
      for (let i = 0, l = data.length; i < l; i += 4) {
        if(data[i + 3] === 0) { // Check alpha of each pixel in frame 0
          state.hasTransparency = true;
          break;
        }
      }
    }
  }

  function drawFrame(frame, ctx) {
    if (frame.drawable) ctx.drawImage(frame.drawable, 0, 0, state.width, state.height);
    else ctx.putImageData(frame.putable, 0, 0);
  }

  function showFrame(frameNumber) {
    const lastFrame = state.frames.length - 1;
    frameNumber = clamp(frameNumber, 0, lastFrame);
    const frame = state.frames[state.currentFrame = frameNumber];
    let fillX = ((frameNumber / lastFrame) * state.barWidth) - 2;
    dom.filler.style.left = Math.max(0, fillX);

    // Draw current frame only if it's already rendered
    if (frame.isRendered || state.debug.showRawFrames) {
      if (state.hasTransparency) {
        context.display.clearRect(0, 0, state.width, state.height);
      }
      return drawFrame(frame, context.display);
    }

    // Rendering not complete. Draw all frames since latest key frame as well
    const first = Math.max(0, frameNumber - (frameNumber % state.keyFrameRate));
    for (let i = first; i <= frameNumber; i++) {
      renderFrame(state.frames[i], context.display);
    }
  }

  // Toolbar: explode, download, and options
  // =======================================

  function downloadZip() {
    if (dom.zipIcon[0].classList.contains('fa-spin')) return false;
    console.time('download-generate');
    for (const icon of dom.zipIcon) {
      icon.classList.toggle('fa-download');
      icon.classList.toggle('fa-spinner');
      icon.classList.toggle('fa-spin');
    };
    downloadReady.then(() => {
      let p = Promise.resolve();
      if (!state.zipGenerated) {
        p = state.frames.map(frame => () => {
          return new Promise(resolve => {
            frame.canvas.toBlob((blob) => {
              state.zipGen.file(`Frame ${frame.number}.png`, blob);
              frame.blob = blob;
              resolve();
            }, 'image/png', 1.00);
          });
        }).reduce(...chainPromises);
      }
      p.then(() => {
        state.zipGen.generateAsync({type: 'blob'}).then((blob) => {
          saveAs(blob, 'gif-scrubber.zip');
          for (const icon of dom.zipIcon) {
            icon.classList.toggle('fa-download');
            icon.classList.toggle('fa-spinner');
            icon.classList.toggle('fa-spin');
          };
        });
        state.zipGenerated = true;
        console.timeEnd('download-generate');
      });
    });
  }

  function toggleExplodeView() {
    togglePlaying(false);
    for (const el of dom.explodeView) el.classList.toggle('displayed');
  }

  function options() {
    chrome.tabs.create({url: 'options.html'});
  }

  for (const a of document.getElementsByTagName('a')) a.addEventListener('click', e => e.preventDefault());
  document.getElementById('gear').addEventListener('click', options);
  document.getElementById('zip').addEventListener('click', downloadZip);
  for (const toggle of dom.explodeViewToggles) toggle.addEventListener('click', toggleExplodeView);

  // Drag and drop
  // =============

  document.body.addEventListener('dragover', (evt) => {
    evt.stopPropagation();
    evt.preventDefault();
    evt.dataTransfer.dropEffect = 'copy';
  });
  document.body.addEventListener('drop', (evt) => {
    evt.preventDefault();
    togglePlaying(false);
    const reader = new FileReader();
    reader.onload = e => handleGIF(e.target.result);
    reader.readAsArrayBuffer(evt.dataTransfer.files[0]);
  });

  // Player controls
  // ===============

  function updateScrub(e) {
    mouseX = parseInt(e.pageX - dom.spacer.offsetLeft, 10);
    togglePlaying(false);
    mouseX = clamp(mouseX, 0, state.barWidth - 1);
    frame = parseInt((mouseX/state.barWidth) / (1/state.frames.length), 10);
    if (frame !== state.currentFrame) showFrame(frame);
  }

  function advanceFrame(direction = 'auto') {
    let frameNumber = state.currentFrame;
    if (direction === 'auto') frameNumber += (state.speed > 0 ? 1 : -1);
    else frameNumber += direction;

    const loopBackward = frameNumber < 0;
    const loopForward = frameNumber >= state.frames.length;
    const lastFrame = state.frames.length - 1;

    if (loopBackward || loopForward) {
      if (preference('loop-anim')) frameNumber = loopForward ? 0 : lastFrame;
      else return togglePlaying(false);
    }

    showFrame(frameNumber);

    if (direction === 'auto') {
      state.playTimeoutId = setTimeout(advanceFrame, state.frameDelay());
    } else {
      togglePlaying(false);
    }
  }

  function togglePlaying(playing) {
    if (state.playing === playing) return;
    dom.pausePlayIcon.classList.toggle('fa-pause', playing);
    if (state.playing = playing) {
      state.playTimeoutId = setTimeout(advanceFrame, state.frameDelay());
    } else {
      clearTimeout(state.playTimeoutId);
    }
  }

  for (const speed of dom.speeds) {
    speed.addEventListener('click', e => {
      if (e.currentTarget.id === 'play-pause') return togglePlaying(!state.playing);
      state.speed = Number(e.currentTarget.innerText);
      togglePlaying(true);

      for (const speed of dom.speeds) speed.classList.remove('selected');
      e.currentTarget.classList.add('selected');
    });
  }

}, false);

// Utilities
// =========

Uint8Array.prototype.concat = function(newArr) {
  const result = new Uint8Array(this.length + newArr.length);
  result.set(this);
  result.set(newArr, this.length);
  return result;
}

Uint8Array.prototype.string = function() {
  return this.reduce((prev, curr) => prev + String.fromCharCode(curr), '');
}

Number.prototype.bits = function(startBit, length) {
  let string = this.toString(2);
  while (string.length < 8) string = '0' + string; // Zero pad
  string = string.substring(startBit, startBit + (length || 1))
  return parseInt(string, 2);
}
