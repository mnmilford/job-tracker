// Landing page behavior: load the demo iframe on wide screens only,
// copy buttons on the command blocks, the screenshot viewer, and the OS tabs.
(function () {
  'use strict';

  // ---- Demo iframe: only load it where it is shown (phones get a screenshot) ----
  var frame = document.getElementById('demo-iframe');
  var wide = window.matchMedia('(min-width: 901px)');
  function loadDemo() {
    if (frame && wide.matches && !frame.getAttribute('src')) {
      frame.setAttribute('src', frame.getAttribute('data-src'));
    }
  }
  loadDemo();
  if (wide.addEventListener) wide.addEventListener('change', loadDemo);
  else if (wide.addListener) wide.addListener(loadDemo);

  // ---- Copy buttons ----
  var copyIcon = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
  var doneIcon = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok ? Promise.resolve() : Promise.reject(new Error('copy failed'));
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () { return fallbackCopy(text); });
    }
    return fallbackCopy(text);
  }

  var codes = document.querySelectorAll('.cmds code');
  Array.prototype.forEach.call(codes, function (code) {
    var li = code.closest('li');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy';
    btn.setAttribute('aria-label', 'Copy command: ' + code.textContent);
    btn.innerHTML = copyIcon + '<span>Copy</span>';
    var timer;
    btn.addEventListener('click', function () {
      copyText(code.textContent).then(function () {
        btn.dataset.state = 'done';
        btn.innerHTML = doneIcon + '<span>Copied</span>';
      }, function () {
        btn.innerHTML = copyIcon + '<span>Select it</span>';
      });
      clearTimeout(timer);
      timer = setTimeout(function () {
        delete btn.dataset.state;
        btn.innerHTML = copyIcon + '<span>Copy</span>';
      }, 1800);
    });
    li.appendChild(btn);
  });

  // ---- Screenshot viewer ----
  // Every screenshot is a link to its full-size file, which still works without
  // JavaScript. With it, a click opens this viewer instead: arrows (and the
  // arrow keys, and swipes) step through every screenshot on the page.
  var zooms = Array.prototype.slice.call(document.querySelectorAll('a.zoom'));
  if (zooms.length && typeof HTMLDialogElement === 'function') {
    var arrow = function (d) {
      return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="' + d + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    };
    var lb = document.createElement('dialog');
    lb.className = 'lightbox';
    lb.setAttribute('aria-label', 'Screenshot viewer');
    lb.innerHTML =
      '<div class="lb-top"><p class="lb-count" aria-live="polite"></p>' +
      '<a class="lb-full" target="_blank" rel="noopener">Full size</a>' +
      '<button type="button" class="lb-btn lb-close" aria-label="Close">' + arrow('M6 6l12 12M18 6L6 18') + '</button></div>' +
      '<figure class="lb-figure"><img class="lb-img" alt=""><figcaption class="lb-cap"></figcaption></figure>' +
      '<button type="button" class="lb-btn lb-nav lb-prev" aria-label="Previous screenshot">' + arrow('M15 5l-7 7 7 7') + '</button>' +
      '<button type="button" class="lb-btn lb-nav lb-next" aria-label="Next screenshot">' + arrow('M9 5l7 7-7 7') + '</button>';
    document.body.appendChild(lb);
    var img = lb.querySelector('.lb-img');
    var cap = lb.querySelector('.lb-cap');
    var count = lb.querySelector('.lb-count');
    var full = lb.querySelector('.lb-full');
    var current = 0;

    var show = function (i) {
      current = (i + zooms.length) % zooms.length;
      var a = zooms[current];
      var thumb = a.querySelector('img');
      var fig = a.closest('figure');
      var fc = fig && fig.querySelector('figcaption');
      img.classList.remove('lb-in');
      img.src = a.getAttribute('href');
      img.alt = thumb ? thumb.alt : '';
      if (thumb && thumb.getAttribute('width')) {
        img.width = thumb.getAttribute('width');
        img.height = thumb.getAttribute('height');
      }
      cap.innerHTML = '';
      if (fc) Array.prototype.forEach.call(fc.childNodes, function (n) { cap.appendChild(n.cloneNode(true)); });
      cap.hidden = !fc;
      count.textContent = (current + 1) + ' / ' + zooms.length;
      full.href = a.getAttribute('href');
      // Warm up the neighbours so arrowing through is instant.
      [current - 1, current + 1].forEach(function (j) {
        var n = zooms[(j + zooms.length) % zooms.length];
        new Image().src = n.getAttribute('href');
      });
      requestAnimationFrame(function () { img.classList.add('lb-in'); });
    };
    var open = function (i) {
      show(i);
      if (!lb.open) lb.showModal();
      document.documentElement.classList.add('lb-open');
    };

    zooms.forEach(function (a, i) {
      a.addEventListener('click', function (e) {
        // Let cmd/ctrl/shift/middle clicks open the file as usual.
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        open(i);
      });
    });
    lb.querySelector('.lb-prev').addEventListener('click', function () { show(current - 1); });
    lb.querySelector('.lb-next').addEventListener('click', function () { show(current + 1); });
    lb.querySelector('.lb-close').addEventListener('click', function () { lb.close(); });
    lb.addEventListener('close', function () {
      document.documentElement.classList.remove('lb-open');
      var a = zooms[current];
      if (a) a.focus({ preventScroll: true });
    });
    // A click on the dark area around the picture closes it.
    lb.addEventListener('click', function (e) {
      var t = e.target;
      if (t === lb || t.classList.contains('lb-figure') || t.classList.contains('lb-top')) lb.close();
    });
    lb.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { e.preventDefault(); show(current + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); show(current - 1); }
      else if (e.key === 'Home') { e.preventDefault(); show(0); }
      else if (e.key === 'End') { e.preventDefault(); show(zooms.length - 1); }
    });
    // Swipe left or right on touch screens.
    var startX = null, startY = null;
    lb.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse') return;
      startX = e.clientX; startY = e.clientY;
    });
    lb.addEventListener('pointerup', function (e) {
      if (startX === null) return;
      var dx = e.clientX - startX, dy = e.clientY - startY;
      startX = null;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) show(current + (dx < 0 ? 1 : -1));
    });
  }

  // ---- OS tabs (WAI-ARIA tabs pattern) ----
  Array.prototype.forEach.call(document.querySelectorAll('[data-tabs]'), function (root) {
    var tabs = Array.prototype.slice.call(root.querySelectorAll('[role="tab"]'));
    function select(tab, focus) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
      });
      if (focus) tab.focus();
    }
    tabs.forEach(function (tab, i) {
      tab.addEventListener('click', function () { select(tab, false); });
      tab.addEventListener('keydown', function (e) {
        var next = null;
        if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
        else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (e.key === 'Home') next = tabs[0];
        else if (e.key === 'End') next = tabs[tabs.length - 1];
        if (next) { e.preventDefault(); select(next, true); }
      });
    });
    // Start on Windows for Windows visitors.
    var ua = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '';
    if (/^win/i.test(ua) || /Windows/.test(ua)) {
      var win = root.querySelector('#tab-win');
      if (win) select(win, false);
    }
  });
})();
