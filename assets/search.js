// Client-side search over window.SEARCH_INDEX (posts) + window.SEARCH_META (summaries, Q&A, topics,
// hashtags, studies, synonyms). Works from file://. Results update as you type.
(function () {
  const IDX = window.SEARCH_INDEX || [], META = window.SEARCH_META || {}, TOP = window.TOPICS || {};
  const AUTH = META.authors || {};
  IDX.forEach((r, n) => { r._i = n; r._t = r.t.toLowerCase(); r._x = r.x.toLowerCase(); r._s = (r.s || '').toLowerCase(); });
  const GUIDES = (META.guides || []).map((g) => Object.assign(g, {
    _t: g.t.toLowerCase(), _m: (g.m || '').toLowerCase(), _c: g.c.toLowerCase(),
    _h: g.h.map(([id, h]) => [id, h, h.toLowerCase()]) }));
  const GMAP = Object.fromEntries(GUIDES.map((g) => [g.s, g]));
  const FAQ = (META.faq || []).map((f) => Object.assign(f, { _q: f.q.toLowerCase(), _a: f.a.toLowerCase() }));
  const TOPS = (META.topics || []).map((t) => Object.assign(t, { _n: t.n.toLowerCase() }));
  const TAGS = META.tags || [];
  const STUD = (META.studies || []).map(([n, c, i]) => ({ n, c, i, _n: n.toLowerCase() }));
  const SYN = (META.synonyms || []).map((g) => g.map((w) => w.toLowerCase()));
  const PAGE = 20;
  // too broad to suggest unless they match the query itself
  const GENERIC_TAGS = new Set(['cardiovascular', 'cvd', 'heart', 'heartdisease', 'health', 'publichealth', 'research',
    'study', 'studies', 'rct', 'rcts', 'jama', 'nejm', 'bmj', 'lancet', 'jacc', 'circulation', 'trump', 'news', 'ncpv']);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fdate = (d) => { const [y, m, day] = (d || '').split('-'); return y && m ? `${MON[+m - 1]} ${+day}, ${y}` : ''; };

  // ---- query parsing: each term is a set of alternatives (synonyms); short words match whole words
  // light stemming so reverse / reversal / reversing / reversed all match ('revers'); stems keep 5+ letters
  const SUF = ['ations', 'ation', 'ings', 'ing', 'ions', 'ion', 'ally', 'al', 'ed', 'es', 's', 'e'];
  function stem(w) {
    if (w.length < 6 || /[^a-z]/.test(w)) return w;
    for (const x of SUF) if (w.endsWith(x) && w.length - x.length >= 5) return w.slice(0, -x.length);
    return w;
  }
  function altsFor(w) {
    const st = w.includes(' ') ? w : stem(w);
    for (const g of SYN) if (g.includes(w) || g.includes(st)) return g;
    return [st];
  }
  function compile(a) {
    if (a.length <= 3) {   // 'cac' must not match 'cacao'; allow plurals ('eggs', 'nuts')
      const src = '(^|[^a-z0-9])' + rx(a) + '(s|es)?(?=$|[^a-z0-9])';
      const one = new RegExp(src), all = new RegExp(src, 'g');
      return { test: (h) => one.test(h), count: (h) => (h.match(all) || []).length, re: src };
    }
    return {
      test: (h) => h.includes(a),
      count: (h) => { let n = 0, i = 0; while ((i = h.indexOf(a, i)) !== -1) { n++; i += a.length; if (n > 20) break; } return n; },
      re: rx(a) };
  }
  function parse(q) {
    q = q.toLowerCase().trim();
    const whole = q.replace(/"/g, '').trim();
    if (whole.includes(' ') && !/(^|\s)-/.test(q) && SYN.some((g) => g.includes(whole))) q = '"' + whole + '"';
    const terms = [], neg = [];
    for (const m of q.matchAll(/(-?)"([^"]+)"|(-?)(\S+)/g)) {
      const w = (m[2] || m[4] || '').trim().replace(/^#/, ''); if (!w) continue;
      if (m[1] || m[3]) { neg.push(w); continue; }
      terms.push({ w, ms: altsFor(w).map(compile) });
    }
    return { terms, neg };
  }
  const hit = (t, h) => t.ms.some((m) => m.test(h));
  const hitsAll = (terms, h) => terms.every((t) => hit(t, h));
  function mark(text, terms) {   // one pass over the raw text, so tags/entities are never matched
    const srcs = terms.flatMap((t) => t.ms.map((m) => '(?:' + m.re + ')'));
    if (!srcs.length) return esc(text);
    let out = '', last = 0;
    for (const m of String(text).matchAll(new RegExp(srcs.join('|'), 'gi'))) {
      let s = m.index, e = s + m[0].length;
      while (s < e && /[^a-z0-9]/i.test(text[s])) s++;          // short-word matches include the char before
      if (s < last) continue;
      while (s > last && /[a-z0-9]/i.test(text[s - 1])) s--;    // highlight whole words ('pitavastatin')
      while (e < text.length && /[a-z0-9]/i.test(text[e])) e++;
      out += esc(text.slice(last, s)) + '<mark>' + esc(text.slice(s, e)) + '</mark>';
      last = e;
    }
    return out + esc(text.slice(last));
  }

  // ---- matching
  function searchPosts(terms, neg, fa, ft) {
    const out = [];
    for (const r of IDX) {
      if (fa && r.a !== fa) continue;
      if (ft && !r.o.includes(ft)) continue;
      let score = 0, ok = true;
      for (const t of terms) {
        const inT = hit(t, r._t), inG = hit(t, r.g), inS = hit(t, r._s);
        const c = t.ms.reduce((n, m) => n + m.count(r._x), 0);
        if (!inT && !inG && !inS && !c) { ok = false; break; }
        score += (inT ? 6 : 0) + (inG ? 4 : 0) + (inS ? 3 : 0) + Math.min(c, 6)
          + (r.p && TOP[r.p] && hit(t, TOP[r.p].toLowerCase()) ? 2 : 0);
      }
      if (!ok) continue;
      if (neg.some((w) => r._t.includes(w) || r._x.includes(w))) continue;
      out.push([score + Math.min(r.n, 10) * 0.4 + Math.min((r.r || 0) + 2 * (r.c || 0), 100) * 0.02, r]);
    }
    return out.sort((a, b) => b[0] - a[0] || b[1].d.localeCompare(a[1].d)).map((x) => x[1]);
  }
  // weight of each top-ranked post (rank 0 = 1, rank 10 = .5 …), used to rank summaries and facets
  function rankWeights(posts, k) {
    const w = new Map();
    posts.slice(0, k).forEach((r, n) => w.set(r._i, 1 / (1 + n / 10)));
    return w;
  }
  function searchGuides(terms, w) {
    const out = [];
    for (const g of GUIDES) {
      let score = 0, direct = true;
      for (const t of terms) {
        const inT = hit(t, g._t), inC = hit(t, g._c), inM = hit(t, g._m), nh = g._h.filter((h) => hit(t, h[2])).length;
        if (!inT && !inC && !inM && !nh) direct = false;
        score += (inT ? 8 : 0) + (inC ? 3 : 0) + (inM ? 2 : 0) + Math.min(nh, 3)
          + (t.ms.some((m) => m.test(g.s.replace(/-/g, ' '))) ? 4 : 0);   // the page is named after it (cac-score)
      }
      if (!direct) score = 0;
      let cite = 0;
      for (const i of g.k || []) cite += w.get(i) || 0;               // the best matching posts it builds on
      if (!direct && cite < 1.5) continue;
      if (direct && score < 8 && cite < 0.5) continue;               // a passing mention only
      score += 5 * cite;
      // deep link to the first section whose heading matches every word, unless the title already does
      const sec = hitsAll(terms, g._t) ? null : (g._h.find((h) => hitsAll(terms, h[2])) || null);
      out.push([score - g.s.length * 0.01, g, sec]);
    }
    return out.sort((a, b) => b[0] - a[0]);
  }
  function facets(posts, w, key) {      // topics / hashtags most common among the top-ranked posts
    const f = new Map();
    for (const r of posts.slice(0, w.size)) {
      const keys = key === 'p' ? (r.p ? [r.p] : []) : (r.g ? r.g.split(' ') : []);
      for (const k of keys) f.set(k, (f.get(k) || 0) + w.get(r._i));
    }
    return f;
  }
  function searchFaq(terms) {
    return FAQ.map((f) => {
      const inQ = terms.filter((t) => hit(t, f._q)).length;
      return [inQ === terms.length ? 10 + inQ : (hitsAll(terms, f._q + ' ' + f._a) && inQ ? inQ : 0), f];
    }).filter((x) => x[0] > 0).sort((a, b) => b[0] - a[0]).map((x) => x[1]);
  }
  const byName = (list, terms, key) => list.filter((x) => hitsAll(terms, x[key])).sort((a, b) => b.c - a.c);

  // ---- rendering
  function guideCard(g, sec, terms) {
    return `<a class="guide-card" href="guides/${g.s}.html${sec ? '#' + sec[0] : ''}">`
      + (g.img ? `<span class="gc-img"><img loading="lazy" src="${g.img}" alt=""></span>` : '')
      + `<span class="gc-body"><span class="gc-cat">${esc(g.c)}</span><strong>${mark(g.t, terms)}</strong>`
      + (sec ? `<span class="gc-sec">Section: ${mark(sec[1], terms)}</span>` : '')
      + `<span class="gc-sum">${esc(g.m)}</span><span class="gc-meta">${g.min} min · ${g.src} sources</span></span></a>`;
  }
  function postCard(r, terms) {
    const eng = r.r != null ? `<span class="eng" title="reactions · comments on Facebook">♥ ${r.r}${r.c ? ' · 💬 ' + r.c : ''}</span> ` : '';
    const refs = r.n ? `<span class="refs" title="referenced by other posts">↩ ${r.n}</span> ` : '';
    const chip = r.p ? `<a class="chip" href="topics/${r.p}.html">${esc(TOP[r.p] || r.p)}</a>` : '';
    return `<article class="card">${r.im ? `<img class="thumb" loading="lazy" src="${r.im}" alt="">` : ''}<div class="cbody">`
      + `<h3><a href="posts/${r.i}.html">${mark(r.t, terms)}</a></h3>`
      + `<div class="meta">${fdate(r.d)} · ${esc(AUTH[r.a] || r.a)} ${eng}${refs}${chip}</div>`
      + `<p>${r.s ? mark(r.s, terms) : snippet(r, terms)}</p></div></article>`;
  }
  function snippet(r, terms) {
    let at = -1;
    for (const t of terms) { for (const m of t.ms) { const k = r._x.search(new RegExp(m.re)); if (k >= 0) { at = k; break; } } if (at >= 0) break; }
    const s = at < 0 ? r.x.slice(0, 260) : (at > 90 ? '…' : '') + r.x.slice(Math.max(0, at - 90), at + 200) + '…';
    return mark(s, terms);
  }
  function chips(label, items) {
    return items.length ? `<div class="sr-row"><span class="sr-lab">${label}</span>${items.join('')}</div>` : '';
  }
  function quick(f, terms) {
    const g = GMAP[f.g];
    return `<section class="sr-quick"><span class="sr-eyebrow">Quick answer</span><h3>${mark(f.q, terms)}</h3><p>${esc(f.a)}</p>`
      + '<div class="faq-links">'
      + (g ? `<a class="go" href="guides/${g.s}.html${f.an ? '#' + f.an : ''}" title="${esc(g.t)}">Read the answer →</a>` : '')
      + (f.p ? `<a class="${f.pv ? 'vid' : 'post'}" href="${f.p}">${f.pv ? '▶ Watch the video' : 'Key post'}</a>` : '')
      + '</div></section>';
  }

  let posts = [], terms = [], shown = PAGE;
  function renderPosts() {
    const n = posts.length;
    $('stat').innerHTML = n ? `<h2 class="sr-h">Posts <small>${n.toLocaleString()}</small></h2>` : '<p class="muted">No matching posts. Try fewer or different words.</p>';
    $('res').innerHTML = posts.slice(0, shown).map((r) => postCard(r, terms)).join('');
    const left = n - shown;
    $('more').hidden = left <= 0;
    $('more').textContent = `Show ${Math.min(PAGE, left)} more (${left.toLocaleString()} left)`;
  }
  function renderEmpty() {
    const ex = ['Lp(a)', 'calcium score', 'statin side effects', 'seed oils', 'ApoB', 'nattokinase'];
    const start = (META.start || []).map((s) => GMAP[s]).filter(Boolean);
    $('best').innerHTML = `<div class="sr-row sr-try"><span class="sr-lab">Try</span>${ex.map((e) => `<button type="button" class="sr-ex">${esc(e)}</button>`).join('')}</div>`
      + chips('Topics', TOPS.slice(0, 14).map((t) => `<a href="topics/${t.s}.html">${esc(t.n)} <small>${t.c}</small></a>`))
      + (start.length ? `<h2 class="sr-h">Start here</h2><div class="guide-grid sr-guides">${start.map((g) => guideCard(g, null, [])).join('')}</div>` : '');
    $('stat').innerHTML = `<p class="muted small">${IDX.length.toLocaleString()} posts, ${GUIDES.length} research summaries, ${TOPS.length} topics and ${TAGS.length.toLocaleString()} hashtags searchable.</p>`;
    $('res').innerHTML = ''; $('more').hidden = true;
    $('best').querySelectorAll('.sr-ex').forEach((b) => b.addEventListener('click', () => { $('q').value = b.textContent; run(); }));
  }
  function run() {
    const q = $('q').value.trim(), fa = $('fa').value, ft = $('ft').value;
    // only non-empty filters go in the URL (no '?q=&a=&t=' on a fresh visit)
    const sp = new URLSearchParams();
    if (q) sp.set('q', q); if (fa) sp.set('a', fa); if (ft) sp.set('t', ft);
    history.replaceState(null, '', sp.toString() ? '?' + sp : location.pathname);
    const parsed = parse(q);
    terms = parsed.terms; shown = PAGE;
    if (!terms.length && !ft && !fa) { renderEmpty(); return; }   // an author alone lists their posts
    posts = searchPosts(terms, parsed.neg, fa, ft);
    let best = '';
    if (terms.length) {
      const w = rankWeights(posts, 60);
      const f = searchFaq(terms)[0];
      if (f) best += quick(f, terms);
      const gs = searchGuides(terms, w);
      if (gs.length) {
        best += `<h2 class="sr-h">Research summaries <small>${gs.length}</small></h2><div class="guide-grid sr-guides">`
          + gs.slice(0, 3).map(([, g, sec]) => guideCard(g, sec, terms)).join('') + '</div>'
          + (gs.length > 3 ? `<p class="sr-also">Also: ${gs.slice(3, 9).map(([, g, sec]) =>
            `<a href="guides/${g.s}.html${sec ? '#' + sec[0] : ''}">${esc(g.t.split(':')[0])}</a>`).join(' · ')}</p>` : '');
      }
      // topics/hashtags: name matches plus what the top-ranked posts are filed under
      const ft_ = facets(posts, w, 'p'), fg = facets(posts, w, 'g');
      const tops = TOPS.map((t) => [(hitsAll(terms, t._n) ? 3 : 0) + (ft_.get(t.s) || 0), t]).filter((x) => x[0] >= 1)
        .sort((a, b) => b[0] - a[0]).slice(0, 6).map((x) => x[1]);
      const tags = TAGS.map(([t, c]) => [hitsAll(terms, t) ? 3 + Math.log10(c) + (fg.get(t) || 0)
          : (c >= 8 && !GENERIC_TAGS.has(t) ? fg.get(t) || 0 : 0), t, c]).filter((x) => x[0] >= 1.5)
        .sort((a, b) => b[0] - a[0]).slice(0, 8);
      const browse = chips('Topics', tops.map((t) => `<a href="topics/${t.s}.html">${mark(t.n, terms)} <small>${t.c}</small></a>`))
        + chips('Hashtags', tags.map(([, t, c]) => `<a href="tags/${t}.html">#${mark(t, terms)} <small>${c}</small></a>`))
        + chips('Studies', byName(STUD.filter((x) => x.c >= 3), terms, '_n').slice(0, 5).map((s) => `<a href="search.html?q=${encodeURIComponent(s.n)}">${mark(s.n, terms)} <small>${s.c}</small></a>`));
      if (browse) best += `<div class="sr-browse">${browse}</div>`;
    }
    $('best').innerHTML = best;
    renderPosts();
  }

  const params = new URLSearchParams(location.search);
  $('q').value = params.get('q') || ''; $('fa').value = params.get('a') || ''; $('ft').value = params.get('t') || '';
  let timer;
  $('q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 180); });
  $('sf').addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(timer); run(); });
  $('fa').onchange = run; $('ft').onchange = run;
  $('more').addEventListener('click', () => { shown += PAGE; renderPosts(); });
  run();
})();
