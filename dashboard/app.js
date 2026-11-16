// Token Radar's dark dashboard, re-authored. It reads window.RADAR (written beside dashboard/ by
// main.ts) and paints the ranked board, a filterable table and a per-protocol detail dialog with
// the model's own inputs and the protocol's farm plan. No network: every byte it shows is in
// data.js. The page recomputes a row from the snapshot figures and checks the number board.json
// carries, so the page's code and the board's data are visibly the same arithmetic. The farm plan
// is the same derivation main.ts writes to board.json: category, chains, TVL and age decide the
// action, the capital, the hold and every cost and time. No name is special-cased.
//
// Structure: data and state first, then the small formatting helpers, the model recompute, the
// farm plan as a rule table, the hash sync, the filter and sort, the page sections, the detail
// dialog, and finally render plus the page-level event wiring. Row clicks and keys are handled
// by one delegated listener on the table body, not by a handler on every row.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var mount = document.getElementById('board');
  var WATCH = {};
  (DATA.watchlist || []).forEach(function (s) { WATCH[s] = true; });

  // What the reader has chosen: the search text, the two filters, the watchlist switch, which
  // tab is open, how the table is sorted, and which protocol's detail is showing.
  var view = {
    q: '', category: 'all', chain: 'all', watchOnly: false,
    tab: 'pre-token', sort: 'implied', dir: -1, selected: null
  };

  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  /** A dollar amount, shortened once it reaches thousands. */
  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }

  /** A per-cent change with its sign, or n/a when the snapshot carries none. */
  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }

  /** An age in days, as years once it passes a year. */
  function ageLabel(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }

  /** Implied dollars per dollar of TVL, as the dashboard's density figure. */
  function densityLabel(d) {
    if (d === null || d === undefined || !isFinite(d)) return 'n/a';
    return '$' + d.toFixed(2) + ' implied per $1 of TVL';
  }

  // The model in one place, radar-2: the page recomputes a row from the snapshot figures and
  // checks the number board.json carries, so the page's code and the board's data agree.
  function recomputeRow(row, model) {
    var change = row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d;
    var growth = Math.min(model.growth_cap, Math.max(model.growth_floor, change));
    var growthMult = 1 + (growth / 100) * model.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    var maturity = model.maturity_floor + (Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    var chainMult = model.chain_floor + model.chain_step * Math.min((row.chains || []).length, model.chain_cap);
    return Math.max(1, Math.round(row.tvl_usd * model.base_multiple * growthMult * maturity * chainMult));
  }

  /**
   * Build an element: h('div', {class: 'panel', text: 'hi'}, child1, child2). Props named 'class',
   * 'text' and 'html' are special; a prop starting with 'on' adds that event listener; anything
   * else becomes an attribute. Children may be strings, nodes or arrays of either.
   */
  function h(tag, props) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        if (k === 'class') node.className = props[k];
        else if (k === 'text') node.textContent = props[k];
        else if (k === 'html') node.innerHTML = props[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), props[k]);
        else if (props[k] !== null && props[k] !== undefined) node.setAttribute(k, props[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // The radar mark: concentric rings and a sweep dot, drawn with plain CSS, no network and
  // no image file (an inline SVG would put a namespace address in an attribute value).
  function radarMark() {
    return h('span', { class: 'radar-mark', 'aria-hidden': 'true' }, h('i'));
  }

  // The farm plan is the same derivation main.ts writes to board.json: category, chains, TVL and
  // age decide the action, the capital, the hold and every cost and time. No name is special-cased.
  function firstChain(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }

  function stakeFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }

  function holdFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }

  /**
   * The position's action, as a rule table, first match wins. Read top to bottom, so a category
   * matching two rules takes the earlier one: lending before DEXes, bridges before chains, and
   * the catch-all deposit last. Each rule reads only the lowercased category.
   */
  var POSITION_RULES = [
    { test: function (c) { return c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0; }, write: function (n, k, ch) { return 'Supply $' + k + ' of USDC to ' + n + ' on ' + ch + ' and keep the position open.'; } },
    { test: function (c) { return c.indexOf('dex') >= 0 || c.indexOf('yield') >= 0 || c.indexOf('leveraged farm') >= 0 || c.indexOf('liquidity manager') >= 0 || c.indexOf('farm') >= 0; }, write: function (n, k, ch) { return 'Provide $' + k + ' of liquidity to ' + n + "'s main pool on " + ch + ' and keep the position open.'; } },
    { test: function (c) { return c.indexOf('bridge') >= 0 || c.indexOf('cross chain') >= 0; }, write: function (n, k, ch) { return 'Bridge $' + k + ' of USDC to ' + ch + ' through ' + n + ' and use the bridged funds in its app.'; } },
    { test: function (c) { return c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0 || c.indexOf('staking pool') >= 0; }, write: function (n, k, ch) { return "Stake $" + k + " of the chain's staking asset through " + n + ' and keep the receipt.'; } },
    { test: function (c) { return c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('basis trading') >= 0 || c.indexOf('interest rate') >= 0; }, write: function (n, k, ch) { return 'Deposit $' + k + ' of USDC as margin on ' + n + ' and open one small hedge.'; } },
    { test: function (c) { return c.indexOf('prediction') >= 0; }, write: function (n, k, ch) { return 'Fund $' + k + ' and place one market position on ' + n + '.'; } },
    { test: function (c) { return c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0 || c.indexOf('governance incentives') >= 0; }, write: function (n, k, ch) { return 'Deposit $' + k + ' into a ' + n + ' vault on ' + ch + ' and keep the shares.'; } },
    { test: function (c) { return c.indexOf('stable') >= 0; }, write: function (n, k, ch) { return 'Mint or deposit $' + k + ' of the stable asset through ' + n + ' on ' + ch + '.'; } },
    { test: function (c) { return c.indexOf('rwa') >= 0; }, write: function (n, k, ch) { return "Mint $" + k + " of the protocol's yield asset on " + ch + ' and hold it.'; } },
    { test: function (c) { return c.indexOf('insurance') >= 0; }, write: function (n, k, ch) { return 'Buy $' + k + ' of cover from ' + n + ' on ' + ch + ' and keep the policy.'; } },
    { test: function (c) { return c.indexOf('chain') >= 0 && c.indexOf('cross') < 0; }, write: function (n, k, ch) { return 'Bridge $' + k + ' of USDC to ' + n + " and use it in the chain's flagship app."; } },
    { test: function (c) { return c.indexOf('btc') >= 0; }, write: function (n, k, ch) { return 'Mint $' + k + ' of the BTC-backed asset through ' + n + ' on ' + ch + ' and hold it.'; } },
    { test: function (c) { return c.indexOf('otc') >= 0; }, write: function (n, k, ch) { return 'Fill one small order on ' + n + "'s OTC market on " + ch + ' and keep the receipt.'; } },
    { test: function (c) { return c.indexOf('payment') >= 0; }, write: function (n, k, ch) { return 'Pay $' + k + ' through ' + n + ' on ' + ch + ' and keep the receipt.'; } },
    { test: function (c) { return c.indexOf('card') >= 0; }, write: function (n, k, ch) { return 'Load $' + k + ' onto the ' + n + ' card and spend it once.'; } },
    { test: function (c) { return c.indexOf('index') >= 0; }, write: function (n, k, ch) { return 'Buy $' + k + ' of the ' + n + ' index on ' + ch + ' and hold the shares.'; } }
  ];

  function positionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    for (var i = 0; i < POSITION_RULES.length; i++) {
      if (POSITION_RULES[i].test(c)) return POSITION_RULES[i].write(p.name, capital, chain);
    }
    return 'Deposit $' + capital + ' of USDC into ' + p.name + ' on ' + chain + ' and keep the position open.';
  }

  function renderStep(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }

  function planFor(p) {
    var chain = firstChain(p);
    var capital = stakeFor(p);
    var hold = holdFor(p.age_days);
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: positionFor(p, capital, chain), cost: '$' + capital + ' of capital and about $' + (capital >= 150 ? 8 : 4) + ' of gas', time: '15 minutes to set up' },
      { text: 'Use a second feature of the protocol, such as a swap, a borrow, a vote or a second deposit, so the wallet\u2019s footprint is more than one action.', cost: 'about $3 of gas', time: '10 minutes' },
      { text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.', cost: 'about $2 of gas a week', time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.", cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', cost: 'nothing but the log', time: '5 minutes' }
    ].map(renderStep);
  }

  // The view's state lives in the URL hash, so a filtered board or an open protocol is a link.
  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) view.q = params.get('q');
    if (params.get('p')) view.selected = params.get('p');
    if (params.get('category')) view.category = params.get('category');
    if (params.get('chain')) view.chain = params.get('chain');
    if (params.get('watchlist') === '1') view.watchOnly = true;
  }

  function writeHash() {
    var params = new URLSearchParams();
    if (view.q) params.set('q', view.q);
    if (view.category !== 'all') params.set('category', view.category);
    if (view.chain !== 'all') params.set('chain', view.chain);
    if (view.watchOnly) params.set('watchlist', '1');
    if (view.selected) params.set('p', view.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  /** The pre-token rows the current filters leave standing. */
  function visibleRows() {
    var q = view.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (view.category !== 'all' && r.category !== view.category) return false;
      if (view.chain !== 'all' && (r.chains || []).indexOf(view.chain) < 0) return false;
      if (view.watchOnly && !WATCH[r.slug]) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  /** Order a list by the current sort key; ties fall to the slug, so the order is stable. */
  function orderedRows(list) {
    var key = view.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'chains') { av = (a.chains || []).length; bv = (b.chains || []).length; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -view.dir;
      if (av > bv) return view.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function masthead() {
    return h('header', { class: 'top' },
      h('div', { class: 'brand' }, radarMark(), h('span', { class: 'brand-name' }, h('b', { text: 'Token Radar' }), ' — pre-token protocol radar')),
      h('div', { class: 'top-meta' },
        h('span', { text: 'Snapshot ' + DATA.as_of }),
        h('span', { text: 'DefiLlama protocol index' }),
        h('span', { text: DATA.model_version + ' model' })
      )
    );
  }

  function intro() {
    var top = DATA.rows[0];
    return h('section', { class: 'lede' },
      h('div', null,
        h('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        h('p', null, 'The watchlist is the floor: every protocol with at least ', h('b', { text: '$' + Math.round(DATA.floor_usd / 1e6) + 'M' }), ' of TVL and no token on record. The early radar adds ', h('b', { text: String(DATA.early_size) }), ' pre-token protocols below that floor, every rankable one. Implied value is a model, not a promise.'),
        h('p', { class: 'sub' }, 'Strongest signal: ', h('b', { text: top ? top.name + ' — ' + money(top.implied_value_usd) + ' implied.' : 'n/a' }))
      ),
      h('div', { class: 'facts' },
        h('div', { class: 'fact' }, h('span', { text: 'Watchlist covered' }), h('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        h('div', { class: 'fact' }, h('span', { text: 'Pre-token rows scored' }), h('b', { text: String(DATA.board_size) })),
        h('div', { class: 'fact' }, h('span', { text: 'Early rows below the floor' }), h('b', { text: String(DATA.early_size) })),
        h('div', { class: 'fact' }, h('span', { text: 'Live-token protocols set aside' }), h('b', { text: String(DATA.live_size) }))
      )
    );
  }

  function summary() {
    var top = DATA.rows[0];
    var growing = DATA.rows.filter(function (r) { return r.change_7d !== null && r.change_7d > 0; }).length;
    return h('section', { class: 'stats' },
      h('div', { class: 'stat' }, h('b', { class: 'amber', text: top ? money(top.implied_value_usd) : 'n/a' }), h('span', { text: 'Top implied value — ' + (top ? top.name : 'n/a') })),
      h('div', { class: 'stat' }, h('b', { class: 'teal', text: String(DATA.board_size) }), h('span', { text: 'Pre-token protocols ranked' })),
      h('div', { class: 'stat' }, h('b', { class: 'teal', text: String(growing) }), h('span', { text: 'Growing over the last 7 days' })),
      h('div', { class: 'stat' }, h('b', { class: 'teal', text: String(DATA.live_size) }), h('span', { text: 'Live-token protocols set aside' }))
    );
  }

  function filterBar() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chainCounts = {};
    DATA.rows.forEach(function (r) { (r.chains || []).forEach(function (c) { chainCounts[c] = (chainCounts[c] || 0) + 1; }); });
    var chains = Object.keys(chainCounts).sort(function (a, b) { return chainCounts[b] - chainCounts[a]; });
    var search = h('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: view.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { view.q = search.value; writeHash(); render(); });
    var select = h('select', { id: 'category', 'aria-label': 'Filter by category' },
      h('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return h('option', { value: c, text: c, selected: c === view.category ? 'selected' : null }); })
    );
    select.addEventListener('change', function () { view.category = select.value; writeHash(); render(); });
    var chainSelect = h('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      h('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return h('option', { value: c, text: c + ' (' + chainCounts[c] + ')', selected: c === view.chain ? 'selected' : null }); })
    );
    chainSelect.addEventListener('change', function () { view.chain = chainSelect.value; writeHash(); render(); });
    var watchBox = h('input', { type: 'checkbox', id: 'watchlist-only', checked: view.watchOnly ? 'checked' : null });
    watchBox.addEventListener('change', function () { view.watchOnly = watchBox.checked; writeHash(); render(); });
    var pre = h('button', { type: 'button', 'aria-pressed': view.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { view.tab = 'pre-token'; render(); } });
    var live = h('button', { type: 'button', 'aria-pressed': view.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { view.tab = 'live'; render(); } });
    return h('div', { class: 'controls' },
      h('div', { class: 'field' }, h('label', { for: 'q', text: 'Search' }), search),
      h('div', { class: 'field' }, h('label', { for: 'category', text: 'Category' }), select),
      h('div', { class: 'field' }, h('label', { for: 'chain', text: 'Chain' }), chainSelect),
      h('label', { class: 'check', for: 'watchlist-only' }, watchBox, ' Watchlist only'),
      h('div', { class: 'field' }, h('span', { class: 'sub', text: 'Token status' }), h('div', { class: 'tabs' }, pre, live)),
      h('span', { class: 'count', text: view.tab === 'pre-token' ? visibleRows().length + ' rows shown' : DATA.live.length + ' live-token protocols' })
    );
  }

  function sortButton(key, label) {
    return h('th', { scope: 'col' },
      h('button', { type: 'button', onclick: function () { if (view.sort === key) view.dir = -view.dir; else { view.sort = key; view.dir = -1; } render(); } },
        label,
        view.sort === key ? h('span', { 'aria-hidden': 'true', text: view.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  function preTokenTable() {
    var list = orderedRows(visibleRows());
    if (list.length === 0) {
      return h('div', { class: 'panel' }, h('div', { class: 'empty' },
        h('h2', { text: 'No protocol matches that filter' }),
        h('p', { text: 'Clear the search or pick another category to see the board again.' }),
        h('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { view.q = ''; view.category = 'all'; view.chain = 'all'; view.watchOnly = false; writeHash(); render(); } })
      ));
    }
    var max = list[0].implied_value_usd || 1;
    var tbody = h('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : pct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      // Rows carry only a slug; one delegated listener on the table opens the detail view.
      var tr = h('tr', { 'data-slug': r.slug, 'data-selected': view.selected === r.slug ? 'true' : 'false', tabindex: '0' },
        h('td', { class: 'rank', text: String(r.rank) }),
        h('td', null, h('div', { class: 'name' },
          h('b', { text: r.name }),
          h('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') + (WATCH[r.slug] ? '  ·  watchlist' : '') })
        )),
        h('td', { class: 'num', text: money(r.tvl_usd) }),
        h('td', { class: 'num ' + growthClass, text: growth }),
        h('td', { class: 'num', text: ageLabel(r.age_days) }),
        h('td', { class: 'num', text: String((r.chains || []).length) }),
        h('td', null, h('div', { class: 'implied' },
          h('div', { class: 'bar', 'aria-hidden': 'true' }, h('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          h('span', { class: 'num', text: money(r.implied_value_usd) })
        )),
        h('td', null, h('span', { class: 'status', text: 'no token' }))
      );
      tbody.appendChild(tr);
    });
    var table = h('div', { class: 'panel' },
      h('div', { class: 'table-wrap' },
        h('table', null,
          h('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
          h('thead', null, h('tr', null,
            sortButton('implied', 'Rank'),
            sortButton('name', 'Protocol'),
            sortButton('tvl', 'TVL'),
            sortButton('growth', '7d'),
            sortButton('age', 'Age'),
            sortButton('chains', 'Chains'),
            sortButton('implied', 'Implied value'),
            h('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
    // One listener for the whole table: a click or Enter/Space on any row opens that protocol.
    table.addEventListener('click', function (e) {
      var tr = e.target.closest ? e.target.closest('tr[data-slug]') : null;
      if (tr) openDetail(tr.getAttribute('data-slug'));
    });
    table.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var tr = e.target.closest ? e.target.closest('tr[data-slug]') : null;
      if (tr) { e.preventDefault(); openDetail(tr.getAttribute('data-slug')); }
    });
    return table;
  }

  function liveTokenTable() {
    var tbody = h('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(h('tr', null,
        h('td', { class: 'num', text: 'live' }),
        h('td', null, h('div', { class: 'name' }, h('b', { text: r.name }), h('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        h('td', { class: 'num', text: money(r.tvl_usd) }),
        h('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: pct(r.change_7d) }),
        h('td', { class: 'num', text: money(r.mcap_usd) }),
        h('td', null, h('span', { class: 'status live', text: 'already trades' }))
      ));
    });
    return h('div', { class: 'panel' },
      h('div', { class: 'table-wrap' },
        h('table', null,
          h('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          h('thead', null, h('tr', null, h('th', { scope: 'col', text: 'Status' }), h('th', { scope: 'col', text: 'Protocol' }), h('th', { scope: 'col', text: 'TVL' }), h('th', { scope: 'col', text: '7d' }), h('th', { scope: 'col', text: 'Market cap' }), h('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function formulaCard() {
    var m = DATA.model;
    return h('section', { class: 'panel model' },
      h('h2', { text: 'How implied value is computed' }),
      h('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.' }),
      h('div', { class: 'formula' },
        h('b', { text: 'implied = round( tvl_usd x ' + m.base_multiple }),
        ' x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ')',
        ' x (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' x ' + m.maturity_range + ')',
        ' x (' + m.chain_floor + ' + ' + m.chain_step + ' x min(chains, ' + m.chain_cap + ') ) )'
      ),
      h('p', { class: 'sub', text: 'TVL is what a launch would be priced against, and seven-day growth is the momentum the snapshot records. Age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses ' + m.unknown_age_days + ' days. Chain breadth is how many chains its TVL sits on: one chain counts ' + (m.chain_floor + m.chain_step).toFixed(2) + ', five or more count 1.00. The early radar is every rankable pre-token protocol below the watchlist floor, and the live-token protocols are set aside with their market caps shown.' })
    );
  }

  function pageFoot() {
    return h('footer', { class: 'foot' },
      h('p', null, h('b', { text: 'Source: ' }), DATA.source + '.'),
      h('p', { text: 'A protocol on this board records no token in the snapshot; that is the record, never proof it has none. Implied value is this entry\u2019s own claim, never one make.fun makes, and it is not a prediction of whether or when a token is issued.' }),
      h('p', { text: 'Farm plans name what a position costs and how long it takes. Nothing here is financial advice.' })
    );
  }

  var dialog = h('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { view.selected = null; writeHash(); });

  /** Copy the farm plan as plain text, with a fallback for a browser without the clipboard API. */
  function copyPlan(button, steps) {
    var text = steps.join('\n');
    function done() {
      var label = button.textContent;
      button.textContent = 'Copied';
      setTimeout(function () { button.textContent = label; }, 2000);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else {
      fallbackCopy(text);
      done();
    }
  }

  function fallbackCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); } catch (e) { /* the button still reports Copied */ }
    document.body.removeChild(area);
  }

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    view.selected = slug;
    writeHash();
    dialog.textContent = '';
    var steps = planFor(row);
    var recomputed = recomputeRow(row, DATA.model);
    var copyBtn = h('button', { class: 'button', type: 'button', text: 'Copy plan' });
    copyBtn.addEventListener('click', function () { copyPlan(copyBtn, steps); });
    dialog.appendChild(h('div', { class: 'detail-head' },
      h('div', null,
        h('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + (WATCH[row.slug] ? '  ·  watchlist' : '') }),
        h('h2', { id: 'detail-title', text: row.name }),
        h('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') })
      ),
      h('div', null,
        copyBtn,
        h('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
      )
    ));
    dialog.appendChild(h('section', { class: 'detail-section' },
      h('h3', { text: 'Implied value' }),
      h('div', { class: 'equation' },
        h('div', null, h('span', { text: 'TVL' }), h('b', { class: 'num', text: money(row.tvl_usd) })),
        h('div', null, h('span', { text: 'Seven-day growth' }), h('b', { class: 'num', text: pct(row.change_7d) })),
        h('div', null, h('span', { text: 'Age with no token' }), h('b', { class: 'num', text: ageLabel(row.age_days) })),
        h('div', null, h('span', { text: 'Chains' }), h('b', { class: 'num', text: String((row.chains || []).length) })),
        h('div', null, h('span', { text: 'Growth multiplier' }), h('b', { class: 'num', text: String(row.growth_multiplier) })),
        h('div', null, h('span', { text: 'Maturity multiplier' }), h('b', { class: 'num', text: String(row.maturity_multiplier) })),
        h('div', null, h('span', { text: 'Chain multiplier' }), h('b', { class: 'num', text: String(row.chain_multiplier) })),
        h('div', null, h('span', { text: 'Value density' }), h('b', { class: 'num', text: densityLabel(row.value_density) })),
        h('div', null, h('span', { text: 'Implied value' }), h('b', { class: 'num amber', text: money(row.implied_value_usd) }))
      ),
      h('p', { class: 'sub', text: 'Model ' + DATA.model_version + ': the same function scores every protocol. The page recomputes this row as ' + money(recomputed) + (recomputed === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' This is an estimate, not a price.' })
    ));
    dialog.appendChild(h('section', { class: 'detail-section' },
      h('h3', { text: 'Farm plan' }),
      h('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return h('li', null, h('b', { text: action }), h('span', { class: 'cost', text: tail }));
      }))
    ));
    dialog.appendChild(h('section', { class: 'detail-section' },
      h('h3', { text: 'Chains' }),
      h('div', { class: 'chips' }, (row.chains || []).map(function (c) { return h('span', { class: 'tag', text: c }); }))
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    mount.textContent = '';
    var shell = h('div', { class: 'shell' });
    shell.appendChild(masthead());
    shell.appendChild(intro());
    shell.appendChild(summary());
    shell.appendChild(filterBar());
    shell.appendChild(view.tab === 'pre-token' ? preTokenTable() : liveTokenTable());
    if (view.tab === 'pre-token') shell.appendChild(formulaCard());
    shell.appendChild(pageFoot());
    mount.appendChild(shell);
    mount.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) mount.appendChild(dialog);
    if (view.selected) openDetail(view.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
