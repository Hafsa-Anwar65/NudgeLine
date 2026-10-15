// Nudgeline landing page: theme toggle and the typing headline.
(function () {
  var root = document.documentElement;
  var btn = document.getElementById('theme-toggle');

  function label(theme) {
    return theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  }
  function apply(theme) {
    root.setAttribute('data-theme', theme);
    if (btn) {
      btn.setAttribute('aria-label', label(theme));
      btn.setAttribute('title', label(theme));
    }
  }

  // The inline script in <head> already set data-theme (saved choice, else the OS setting).
  apply(root.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

  if (btn) {
    btn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      apply(next);
      try { localStorage.setItem('nudgeline-theme', next); } catch (e) { /* storage may be blocked */ }
    });
  }

  // Typing headline. Skipped when the visitor prefers reduced motion.
  var target = document.getElementById('typed');
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!target || reduce) return;

  var words = ['start conversations', 'write better emails', 'reply like a human'];
  var w = 0;
  var i = words[0].length;
  var deleting = true;

  function tick() {
    var wait = 80;
    if (deleting) {
      i -= 1;
      wait = 40;
      if (i <= 0) {
        i = 0;
        deleting = false;
        w = (w + 1) % words.length;
        wait = 350;
      }
    } else {
      i += 1;
      if (i >= words[w].length) {
        deleting = true;
        wait = 1800;
      }
    }
    target.textContent = words[w].slice(0, i);
    setTimeout(tick, wait);
  }

  setTimeout(tick, 2400);
})();
