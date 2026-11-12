// Royal chamber theme flag. ON by default. Off: ?royal=0 (remembered in localStorage kr_royal=0). Back on: ?royal=1.
// It only adds a stylesheet and an html attribute. No ids, handlers or state logic are touched.
(function () {
  var KEY = 'kr_royal';
  function enabled(search, store) {
    var m = /[?&]royal=([01])\b/.exec(search || '');
    if (m) { try { store.setItem(KEY, m[1]); } catch (e) {} return m[1] === '1'; }
    try { return store.getItem(KEY) !== '0'; } catch (e) { return true; } // only an explicit opt-out turns it off; blocked storage keeps the default
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { enabled: enabled }; return; }
  if (!enabled(location.search, localStorage)) return;
  document.documentElement.setAttribute('data-royal', '');
  var link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/warroom/warroom-royal.css';
  document.head.appendChild(link);
})();
