// DentalCAD design docs — navigation, table of contents, theme toggle.
// Works from file:// (no fetch). Pages set <html data-root="."> (or ".." for subfolders)
// and <body data-page="<path from docs root>">.

(function () {
  'use strict';

  /** Single source of truth for the sidebar and prev/next links. */
  var NAV = [
    { group: 'Start here', items: [
      { path: 'index.html', title: 'Overview', depth: 'L0' },
      { path: 'primer.html', title: '3D & infra primer', depth: 'L1' },
      { path: 'demo-data.html', title: 'Demo mode & sample data', depth: 'Guide' },
    ] },
    { group: 'Product', items: [
      { path: 'product.html', title: 'Product & workflow', depth: 'L1' },
    ] },
    { group: 'Architecture', items: [
      { path: 'architecture.html', title: 'System architecture', depth: 'L2' },
    ] },
    { group: 'Deep dives', items: [
      { path: 'frontend.html', title: 'Web app', depth: 'L3' },
      { path: 'geometry.html', title: 'Geometry pipeline', depth: 'L3' },
      { path: 'ai-assist.html', title: 'AI assist', depth: 'L3' },
      { path: 'backend.html', title: 'Backend API', depth: 'L3' },
      { path: 'deployment.html', title: 'Deployment & operations', depth: 'L3' },
      { path: 'testing.html', title: 'Testing & verification', depth: 'L3' },
    ] },
    { group: 'Reference', items: [
      { path: 'reference/schemas.html', title: 'Data contracts', depth: 'Ref' },
      { path: 'decisions.html', title: 'Decision log', depth: 'Ref' },
      { path: 'glossary.html', title: 'Glossary', depth: 'Ref' },
    ] },
  ];

  var root = document.documentElement.getAttribute('data-root') || '.';
  var current = document.body.getAttribute('data-page') || '';
  var href = function (path) { return root + '/' + path; };

  // ---------- Theme ----------
  var THEME_KEY = 'dcad-docs-theme';
  function readTheme() { try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; } }
  function writeTheme(v) { try { localStorage.setItem(THEME_KEY, v); } catch (e) { /* storage unavailable */ } }
  function effectiveTheme() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t) return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  var saved = readTheme();
  if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);

  var themeBtn = document.getElementById('theme-toggle');
  function syncThemeLabel() { if (themeBtn) themeBtn.textContent = effectiveTheme() === 'dark' ? '☀ Light' : '☾ Dark'; }
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      writeTheme(next);
      syncThemeLabel();
    });
    syncThemeLabel();
  }

  // ---------- Sidebar ----------
  var sidebar = document.getElementById('sidebar');
  var flat = [];
  if (sidebar) {
    var html = '';
    NAV.forEach(function (g) {
      html += '<h4>' + g.group + '</h4><ul>';
      g.items.forEach(function (it) {
        flat.push(it);
        var cur = it.path === current ? ' aria-current="page"' : '';
        html += '<li><a href="' + href(it.path) + '"' + cur + '>' + it.title +
          ' <span class="depth">' + it.depth + '</span></a></li>';
      });
      html += '</ul>';
    });
    sidebar.innerHTML = html;
  } else {
    NAV.forEach(function (g) { g.items.forEach(function (it) { flat.push(it); }); });
  }

  var menuBtn = document.getElementById('menu-toggle');
  if (menuBtn) {
    menuBtn.addEventListener('click', function () {
      var open = document.body.classList.toggle('nav-open');
      menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  // ---------- Heading anchors + on-this-page TOC ----------
  var main = document.querySelector('main');
  var toc = document.getElementById('toc');
  if (main) {
    var used = {};
    var items = [];
    main.querySelectorAll('h2, h3').forEach(function (h) {
      if (!h.id) {
        var base = h.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';
        var id = base, n = 2;
        while (used[id] || document.getElementById(id)) { id = base + '-' + n++; }
        h.id = id;
      }
      used[h.id] = true;
      var a = document.createElement('a');
      a.className = 'anchor'; a.href = '#' + h.id; a.textContent = '#';
      a.setAttribute('aria-label', 'Link to this section');
      h.appendChild(a);
      items.push({ id: h.id, text: h.firstChild ? h.childNodes[0].textContent : h.textContent, lvl: h.tagName === 'H2' ? 2 : 3 });
    });
    if (toc && items.length > 1) {
      toc.innerHTML = '<h4>On this page</h4><ul>' + items.map(function (i) {
        return '<li><a class="lvl-' + i.lvl + '" href="#' + i.id + '">' + i.text.replace(/</g, '&lt;') + '</a></li>';
      }).join('') + '</ul>';
    }
  }

  // ---------- Prev / next ----------
  var pageNav = document.getElementById('page-nav');
  if (pageNav) {
    var idx = -1;
    flat.forEach(function (it, i) { if (it.path === current) idx = i; });
    var out = '';
    if (idx > 0) {
      var p = flat[idx - 1];
      out += '<a class="prev" href="' + href(p.path) + '"><small>← Previous</small>' + p.title + '</a>';
    } else { out += '<span></span>'; }
    if (idx >= 0 && idx < flat.length - 1) {
      var n2 = flat[idx + 1];
      out += '<a class="next" href="' + href(n2.path) + '"><small>Next →</small>' + n2.title + '</a>';
    }
    pageNav.innerHTML = out;
  }
})();
