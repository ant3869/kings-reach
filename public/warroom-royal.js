// Royal chamber theme flag. On: ?royal=1 (remembered) or localStorage kr_royal=1. Off: ?royal=0 or nothing set.
// It only adds a stylesheet, one SVG crest per seat and an html attribute. No ids, handlers or state logic are touched.
(function () {
  var KEY = 'kr_royal';
  function enabled(search, store) {
    var m = /[?&]royal=([01])\b/.exec(search || '');
    if (m) { try { store.setItem(KEY, m[1]); } catch (e) {} return m[1] === '1'; }
    try { return store.getItem(KEY) === '1'; } catch (e) { return false; }
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { enabled: enabled }; return; }
  if (!enabled(location.search, localStorage)) return;
  document.documentElement.setAttribute('data-royal', '');
  var link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/warroom/warroom-royal.css';
  document.head.appendChild(link);
  var NS = 'http://www.w3.org/2000/svg';
  var sprite = document.createElementNS(NS, 'svg');
  sprite.setAttribute('width', '0'); sprite.setAttribute('height', '0'); sprite.setAttribute('aria-hidden', 'true');
  sprite.style.position = 'absolute';
  sprite.innerHTML = '<symbol id="kr-crest" viewBox="0 0 32 32"><path d="M16 2 28 6v10c0 7-5 12-12 14C9 28 4 23 4 16V6z" fill="#0b0905" stroke="currentColor" stroke-width="1.6"/><path d="M9 20l1-7 4 3 2-5 2 5 4-3 1 7z" fill="currentColor"/></symbol>';
  document.body.insertBefore(sprite, document.body.firstChild);
  Array.prototype.forEach.call(document.querySelectorAll('.seat'), function (seat) {
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'crest'); svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = '<use href="#kr-crest"/>';
    seat.appendChild(svg);
  });
})();
