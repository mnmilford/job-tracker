// Landing page behavior: load the demo iframe on wide screens only,
// copy buttons on the command blocks, and the OS tabs.
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
