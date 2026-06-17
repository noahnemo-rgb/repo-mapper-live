// Repo Mapper — MultiVerse (static GitHub Pages edition)
// All GitHub API calls go directly to api.github.com from the browser.
// AI summary features are gracefully disabled (no backend).

import * as d3 from 'https://esm.sh/d3@7';

const GH_API = 'https://api.github.com';
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const esc = (s) => String(s||'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);

// ============================================================
// GITHUB API HELPERS (direct, no backend)
// ============================================================
async function ghFetch(path) {
  const r = await fetch(`${GH_API}${path}`, {
    headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'repo-mapper-static' }
  });
  if (r.status === 404) return { _status: 404 };
  if (!r.ok) return { _status: r.status, _error: await r.text().catch(()=>'error') };
  return r.json();
}

async function getRepoMeta(owner, repo) {
  const r = await ghFetch(`/repos/${owner}/${repo}`);
  if (r._status) throw new Error(`Repo not found (${r._status})`);
  return r;
}

async function getRepoTree(owner, repo, branch) {
  const br = await ghFetch(`/repos/${owner}/${repo}/branches/${branch}`);
  if (br._status) throw new Error(`Branch ${branch} not found`);
  const sha = br.commit.sha;
  const tree = await ghFetch(`/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`);
  if (tree._status) throw new Error(`Tree fetch failed`);
  return { sha, truncated: tree.truncated, items: tree.tree };
}

async function getFileText(owner, repo, path, branch) {
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`);
    if (!r.ok) return null;
    return r.text();
  } catch { return null; }
}

function parseRepoUrl(url) {
  if (!url) return null;
  url = url.trim().replace(/\.git$/, '').replace(/\/$/, '');
  const patterns = [
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)/,
    /^github\.com\/([^/]+)\/([^/]+)/,
    /^([^/\s]+)\/([^/\s]+)$/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return { owner: m[1], repo: m[2] };
  }
  return null;
}

// ============================================================
// TREE BUILDER
// ============================================================
function buildTree(items) {
  const root = { name: '', path: '', type: 'dir', children: {}, size: 0 };
  for (const it of items) {
    const parts = it.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      if (!node.children[part]) {
        node.children[part] = {
          name: part,
          path: parts.slice(0, i + 1).join('/'),
          type: isLast ? (it.type === 'tree' ? 'dir' : 'file') : 'dir',
          size: 0, children: {},
        };
      }
      node = node.children[part];
      if (isLast && it.type === 'blob') { node.size = it.size || 0; node.sha = it.sha; }
    }
  }
  function finalize(n) {
    const kids = Object.values(n.children);
    kids.forEach(finalize);
    kids.sort((a, b) => a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name));
    n.children = kids;
    if (n.type === 'dir') {
      n.size = kids.reduce((s, k) => s + (k.size || 0), 0);
      n.fileCount = kids.reduce((s, k) => s + (k.fileCount || (k.type === 'file' ? 1 : 0)), 0);
    } else { n.fileCount = 1; }
    return n;
  }
  finalize(root);
  return root;
}

// ============================================================
// CRITICAL FILES PICKER
// ============================================================
const CRITICAL_NAMES = ['README.md','readme.md','README.rst','README','package.json',
  'pyproject.toml','setup.py','requirements.txt','Cargo.toml','go.mod','pom.xml',
  'build.gradle','Gemfile','composer.json','tsconfig.json','next.config.js',
  'next.config.ts','vite.config.js','vite.config.ts','webpack.config.js',
  'Dockerfile','docker-compose.yml','docker-compose.yaml','Makefile','LICENSE'];
const ENTRY_HINTS = ['index','main','app','server','cli','__init__'];
const CODE_EXTS = new Set(['.js','.jsx','.ts','.tsx','.py','.rb','.go','.rs','.java',
  '.kt','.swift','.c','.cc','.cpp','.h','.hpp','.php','.cs','.scala','.ex','.exs','.sh']);

function pickCriticalFiles(items, limit=8) {
  const files = items.filter(i => i.type === 'blob');
  const scored = files.map(f => {
    let score = 0;
    const name = f.path.split('/').pop();
    const base = name.toLowerCase();
    const depth = f.path.split('/').length;
    const ext = '.' + (name.split('.').pop() || '');
    if (CRITICAL_NAMES.includes(name) || CRITICAL_NAMES.includes(f.path)) score += 100;
    if (base.startsWith('readme')) score += 90;
    if (['package.json','pyproject.toml','cargo.toml','go.mod'].includes(base)) score += 80;
    for (const h of ENTRY_HINTS) {
      const stem = name.replace(/\.[^.]+$/, '').toLowerCase();
      if (stem === h) score += 30 - depth * 2;
    }
    if (CODE_EXTS.has(ext)) score += 10;
    score -= depth * 3;
    if (f.size) {
      if (f.size > 200 && f.size < 50000) score += Math.log10(f.size) * 4;
      if (f.size > 100000) score -= 5;
    }
    if (/\/test|\/tests|\.test\.|\.spec\.|__tests__/.test(f.path)) score -= 15;
    if (/dist\/|build\/|\.min\./.test(f.path)) score -= 30;
    if (/vendor\/|node_modules\//.test(f.path)) score -= 100;
    return { ...f, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ============================================================
// TODO EXTRACTOR
// ============================================================
const TODO_RE = /(?:\/\/|#|\/\*|\*|<!--|--)\s*(TODO|FIXME|HACK|XXX|BUG|NOTE|OPTIMIZE)\b[: ]*(.*?)(?:\*\/|-->|$)/gim;
function extractTodos(path, text) {
  if (!text) return [];
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    TODO_RE.lastIndex = 0;
    const m = TODO_RE.exec(lines[i]);
    if (m) {
      const kind = m[1].toUpperCase();
      let msg = (m[2] || '').trim().replace(/\*\/$/, '').replace(/-->$/, '').trim() || '(no description)';
      out.push({ path, line: i + 1, kind, message: msg.slice(0, 240) });
    }
  }
  return out;
}

// ============================================================
// IMPORT PARSER
// ============================================================
const JS_IMPORT_RE = /(?:import\s+(?:[\w*{}\s,]+\s+from\s+)?|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g;
const PY_IMPORT_RE = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;

function parseImports(path, text) {
  if (!text) return [];
  const imports = [];
  const ext = path.split('.').pop().toLowerCase();
  if (['js','jsx','ts','tsx','mjs','cjs'].includes(ext)) {
    let m; JS_IMPORT_RE.lastIndex = 0;
    while ((m = JS_IMPORT_RE.exec(text)) !== null) imports.push(m[1]);
  } else if (ext === 'py') {
    let m; PY_IMPORT_RE.lastIndex = 0;
    while ((m = PY_IMPORT_RE.exec(text)) !== null) imports.push(m[1] || m[2]);
  }
  return imports;
}

function resolveImport(fromPath, importStr, allPaths) {
  if (!importStr) return null;
  if (!importStr.startsWith('.') && !importStr.startsWith('/'))
    return { external: true, name: importStr.split('/')[0] };
  const dir = fromPath.split('/').slice(0, -1);
  for (const p of importStr.split('/')) {
    if (p === '.') continue;
    else if (p === '..') dir.pop();
    else dir.push(p);
  }
  const base = dir.join('/');
  const candidates = [base, base+'.js', base+'.jsx', base+'.ts', base+'.tsx',
    base+'/index.js', base+'/index.ts', base+'.py', base+'/__init__.py'];
  for (const c of candidates) if (allPaths.has(c)) return { external: false, path: c };
  return null;
}

// ============================================================
// STATE
// ============================================================
let CURRENT_REPO = null;
let CURRENT_MANIFEST = null;
let CURRENT_SCAFFOLD = null;
let CURRENT_GAPS = null;
let CURRENT_MULTIVERSE = null;
let CURRENT_MODE = 'single';

const MATURITY = {
  'placeholder':  { color: '#7a82a8', order: 0, label: 'Placeholder' },
  'scaffolded':   { color: '#9b6bff', order: 1, label: 'Scaffolded' },
  'drafting':     { color: '#ff7eb6', order: 2, label: 'Drafting' },
  'mvp-partial':  { color: '#ffd27a', order: 3, label: 'MVP partial' },
  'mvp-near':     { color: '#7ce8d4', order: 4, label: 'MVP near' },
  'production':   { color: '#86efac', order: 5, label: 'Production' },
};
const ROLE_SIZE = {
  'master': 28, 'governance': 22, 'governance-subsystem': 14,
  'container': 22, 'ecosystem': 18, 'product': 14, 'codex': 12,
};

// ============================================================
// MANIFEST — inline one-universe.yaml + parse logic
// ============================================================
const ONE_UNIVERSE_RAW = `universe:
  name: ONE Universe
  tagline: One Universe. Many Ecosystems. Infinite Becoming.
  brand:
    logo: BRAND/logo.jpg
    palette:
      cosmos: "#0a0820"
      prism_violet: "#9b6bff"
      prism_rose: "#ff7eb6"
      prism_gold: "#ffd27a"
      prism_teal: "#7ce8d4"
      ivory: "#f5efe6"
    typography:
      display: "Cormorant Garamond"
      body: "Inter"
      mono: "JetBrains Mono"
  vision: >
    ONE Universe is a constellation of ecosystems unified by a single
    governance philosophy (HASEOS) and a shared ecological intent
    (ONE Ecology). Each ecosystem is sovereign in its own domain
    yet bound by the same principles of stewardship, transparency,
    and continuous becoming.

repos:
  - id: one-universe
    name: ONE Universe
    role: master
    repo: github.com/noahnemo-rgb/ONE-
    maturity: scaffolded
    tags: [master, brand, manifest]
    owner: noahnemo-rgb
    description: >
      The master brand repo. Holds the canonical universe.yaml, brand
      assets, top-level ADRs, and the front-door README that maps the
      entire universe.
    contains: [BRAND/, ADR/, docs/, universe.yaml, README.md, STATUS.md]
    references: [haseos, one-ecology]

  - id: haseos
    name: HASEOS
    role: governance
    repo: github.com/noahnemo-rgb/haseos-spiral-swarm
    maturity: drafting
    tags: [governance, cross-cutting, charter]
    owner: noahnemo-rgb
    applies_to: [all]
    description: >
      The overarching governance layer that applies to every ecosystem
      within ONE Ecology. Defines policies, compliance frameworks,
      shared identity primitives, and treasury rules.
    contains: [charter.md, policies/, compliance/, identity/, treasury/, BRAND/]
    subsystems: [haos, dsm, haia]

  - id: haos
    name: HAOS — Human-AI Operating Subsystem
    role: governance-subsystem
    repo: github.com/noahnemo-rgb/haos
    maturity: placeholder
    tags: [governance, subsystem, human-ai]
    owner: noahnemo-rgb
    parent: haseos
    description: >
      Defines how humans and AI agents co-operate within ONE Universe.

  - id: dsm
    name: DSM — Defensive Sentinel Mode
    role: governance-subsystem
    repo: github.com/noahnemo-rgb/dsm
    maturity: placeholder
    tags: [governance, subsystem, security]
    owner: noahnemo-rgb
    parent: haseos
    description: >
      Security policy, incident response, and defensive postures.

  - id: haia
    name: HAIA — Human-AI Alliance
    role: governance-subsystem
    repo: github.com/noahnemo-rgb/haia
    maturity: placeholder
    tags: [governance, subsystem, dao, voting]
    owner: noahnemo-rgb
    parent: haseos
    description: >
      The voting DAO membership system for ONE Universe.

  - id: one-ecology
    name: ONE Ecology
    role: container
    repo: github.com/noahnemo-rgb/ONE-
    maturity: scaffolded
    tags: [container, ecology, ecosystems]
    owner: noahnemo-rgb
    parent: one-universe
    description: >
      Container grouping the six member ecosystems.
    members: [one-church, oceanus, one-mesoflex-ai, hpm, one-seedfeast-ai, one-urban-mines]

  - id: one-church
    name: ONE Church
    role: ecosystem
    repo: github.com/noahnemo-rgb/OurNewEra-ONE-Church
    maturity: drafting
    tags: [ecosystem, spiritual, worldwide]
    owner: noahnemo-rgb
    parent: one-ecology
    governed_by: haseos
    description: >
      A worldwide spiritual movement containing the ONE Aetheric Codex.
    known_gaps: [aetheric-codex-draft, liturgy-framework]

  - id: oceanus
    name: Oceanus
    role: ecosystem
    repo: github.com/noahnemo-rgb/Oceanus
    maturity: drafting
    tags: [ecosystem, sovereign-nation, maritime]
    owner: noahnemo-rgb
    parent: one-ecology
    governed_by: haseos
    description: >
      A boundless, borderless worldwide ONE sovereign ocean nation.
    known_gaps: [constitution, citizenship-protocol, maritime-law-framework]

  - id: one-mesoflex-ai
    name: ONE MesoFlex.ai
    role: ecosystem
    repo: github.com/noahnemo-rgb/MesoFlex
    maturity: mvp-partial
    tags: [ecosystem, design-studio, franchise, ai]
    owner: noahnemo-rgb
    parent: one-ecology
    governed_by: haseos
    description: >
      A worldwide vastly distributed franchised multiplex design studio ecosystem.

  - id: hpm
    name: Human Potential Movement (HPM)
    role: ecosystem
    repo: github.com/noahnemo-rgb/Human-Potential-Movement
    maturity: drafting
    tags: [ecosystem, training, retreats, healing]
    owner: noahnemo-rgb
    parent: one-ecology
    governed_by: haseos
    description: >
      Large-group training, self-healing encounters, seminars, and retreats.

  - id: one-seedfeast-ai
    name: ONE SeedFeast.ai
    role: ecosystem
    repo: github.com/noahnemo-rgb/SeedFeast
    maturity: mvp-partial
    tags: [ecosystem, seeds, marketplace, food-sovereignty, ai]
    owner: noahnemo-rgb
    parent: one-ecology
    governed_by: haseos
    description: >
      A worldwide Seed Exchange Vault. Buy, sell, trade, and gift seeds and heirloom foods.

  - id: one-urban-mines
    name: ONE Urban Mines
    role: ecosystem
    repo: github.com/noahnemo-rgb/one-urban-mines
    maturity: drafting
    tags: [ecosystem, recycling, restoration, environment]
    owner: noahnemo-rgb
    parent: one-ecology
    governed_by: haseos
    description: >
      A worldwide restoration ecosystem focused on recycling refuse and restoring land and water.
`;

const ONE_MULTIVERSE_RAW = `
multiverse:
  name: ONE Multiverse
  tagline: "One Multiverse. Many Universes. Infinite Becoming."
  governance:
    framework: HASEOS
    repo: github.com/noahnemo-rgb/haseos-spiral-swarm

universes:
  - id: one-universe
    name: ONE Universe
    role: reference-implementation
    manifest: one-universe
    repo: github.com/noahnemo-rgb/ONE-
    maturity: scaffolded
    description: The reference implementation. All child universes inherit its structural grammar.
    
  - id: one-in-fun-net-universe
    name: ONE In-Fun.net Universe
    role: child-universe
    repo: github.com/noahnemo-rgb/one-in-fun-net-universe
    maturity: placeholder
    known_gaps:
      - universe.yaml not yet created
      - governance layer missing
      - no ecosystems defined
      - no MVPs
    
  - id: one-hyper-dimensional-universe
    name: ONE Hyper-dimensional Universe
    role: child-universe
    repo: github.com/noahnemo-rgb/one-hyper-dimensional-universe
    maturity: placeholder
    known_gaps:
      - universe.yaml not yet created
      - governance layer missing
      - no ecosystems defined
      - no MVPs

structural_gaps:
  - id: one-in-fun-net-universe-repo
    severity: major
    description: Repository not yet created on GitHub
    layer: universe
  - id: one-hyper-dimensional-universe-repo
    severity: major
    description: Repository not yet created on GitHub
    layer: universe
  - id: shared-templates
    severity: minor
    description: shared-templates/ folder not yet scaffolded
    layer: multiverse
  - id: haseos-restructure
    severity: critical
    description: haseos-spiral-swarm needs governance/ directory restructured per SCAFFOLD.md
    layer: governance
`;

const MULTIVERSE_DATA = {
  multiverse: {
    name: 'ONE Multiverse',
    tagline: 'One Multiverse. Many Universes. Infinite Becoming.',
    governance: { framework: 'HASEOS', repo: 'github.com/noahnemo-rgb/haseos-spiral-swarm' }
  },
  universes: [
    { id: 'one-universe', name: 'ONE Universe', role: 'reference-implementation',
      repo: 'github.com/noahnemo-rgb/ONE-', maturity: 'scaffolded',
      description: 'The reference implementation. All child universes inherit its structural grammar.',
      known_gaps: [] },
    { id: 'one-in-fun-net-universe', name: 'ONE In-Fun.net Universe', role: 'child-universe',
      repo: 'github.com/noahnemo-rgb/one-in-fun-net-universe', maturity: 'placeholder',
      known_gaps: ['universe.yaml not yet created', 'governance layer missing', 'no ecosystems defined', 'no MVPs'] },
    { id: 'one-hyper-dimensional-universe', name: 'ONE Hyper-dimensional Universe', role: 'child-universe',
      repo: 'github.com/noahnemo-rgb/one-hyper-dimensional-universe', maturity: 'placeholder',
      known_gaps: ['universe.yaml not yet created', 'governance layer missing', 'no ecosystems defined', 'no MVPs'] }
  ],
  structural_gaps: [
    { id: 'haseos-restructure', severity: 'critical', description: 'haseos-spiral-swarm needs governance/ directory restructured per SCAFFOLD.md', layer: 'governance' },
    { id: 'one-in-fun-net-universe-repo', severity: 'major', description: 'Repository not yet created on GitHub', layer: 'universe' },
    { id: 'one-hyper-dimensional-universe-repo', severity: 'major', description: 'Repository not yet created on GitHub', layer: 'universe' },
    { id: 'shared-templates', severity: 'minor', description: 'shared-templates/ folder not yet scaffolded', layer: 'multiverse' }
  ]
};

// In-memory uploaded manifests
const UPLOADED_MANIFESTS = new Map();

function parseManifest(raw) {
  const doc = jsyaml.load(raw);
  if (!doc || !doc.universe) throw new Error('Manifest missing "universe:" block');
  if (!Array.isArray(doc.repos)) throw new Error('Manifest missing "repos:" list');
  return doc;
}

function structureManifest(doc) {
  const repos = doc.repos.map(r => ({ ...r, children_ids: [] }));
  const byId = new Map(repos.map(r => [r.id, r]));
  for (const r of repos) {
    if (r.parent && byId.has(r.parent)) byId.get(r.parent).children_ids.push(r.id);
  }
  const stats = { total: repos.length, by_role: {}, by_maturity: {} };
  for (const r of repos) {
    stats.by_role[r.role] = (stats.by_role[r.role] || 0) + 1;
    stats.by_maturity[r.maturity] = (stats.by_maturity[r.maturity] || 0) + 1;
  }
  return { universe: doc.universe, repos, stats, _raw: '' };
}

function renderMultiverseView(data) {
  const view = $('#multiverseView');
  if (!view) return;
  const mv = data.multiverse;

  // Build HASEOS badge
  const govBadge = mv.governance ? `<span class="haseos-badge">&#x2696; ${esc(mv.governance.framework)}</span>` : '';

  // Universe cards
  const universeCards = data.universes.map(u => {
    const matColor = MATURITY[u.maturity]?.color || '#7a82a8';
    const isRef = u.role === 'reference-implementation';
    const gapCount = (u.known_gaps || []).length;
    const gapBadge = gapCount ? `<span class="gap-badge">${gapCount} gap${gapCount > 1 ? 's' : ''}</span>` : '';
    const refBadge = isRef ? `<span class="badge-reference">reference impl</span>` : '';
    return `
      <div class="universe-card ${isRef ? 'universe-card--reference' : ''}">
        <div class="universe-card-header">
          <span class="universe-card-name">${esc(u.name)}</span>
          ${refBadge}
          <span class="maturity-chip" style="background:${matColor}22;color:${matColor};border:1px solid ${matColor}44">${esc(u.maturity)}</span>
        </div>
        ${u.description ? `<p class="universe-card-desc">${esc(u.description)}</p>` : ''}
        ${u.repo ? `<a class="universe-card-repo" href="https://${u.repo}" target="_blank" rel="noopener">&nearr; ${esc(u.repo)}</a>` : ''}
        ${gapBadge}
        ${gapCount ? `<ul class="universe-gap-list">${(u.known_gaps||[]).map(g=>`<li>${esc(g)}</li>`).join('')}</ul>` : ''}
      </div>`;
  }).join('');

  // Structural gaps panel
  const structuralGapsHtml = data.structural_gaps.map(g => `
    <div class="structural-gap gap-severity-${esc(g.severity)}">
      <span class="gap-severity-label gap-severity-${esc(g.severity)}">${esc(g.severity.toUpperCase())}</span>
      <span class="gap-layer">[${esc(g.layer)}]</span>
      <span class="gap-desc">${esc(g.description)}</span>
    </div>`).join('');

  view.innerHTML = `
    <div class="multiverse-header">
      <h2 class="multiverse-title">${esc(mv.name)}</h2>
      <p class="multiverse-tagline">${esc(mv.tagline)}</p>
      ${govBadge}
    </div>

    <div class="hierarchy-breadcrumb">
      <span class="crumb crumb--active">ONE Multiverse</span>
      <span class="crumb-sep">&rarr;</span>
      <span class="crumb">Child Universes</span>
      <span class="crumb-sep">&rarr;</span>
      <span class="crumb">Container Layers</span>
      <span class="crumb-sep">&rarr;</span>
      <span class="crumb">Ecosystems</span>
      <span class="crumb-sep">&rarr;</span>
      <span class="crumb">MVPs / Products</span>
    </div>

    <section class="universe-cards-section">
      <h3 class="section-label">Universes</h3>
      <div class="universe-cards-grid">${universeCards}</div>
    </section>

    <section class="structural-gaps-section">
      <h3 class="section-label">Structural Gaps <span class="gap-count-badge">${data.structural_gaps.length}</span></h3>
      <div class="structural-gaps-panel">${structuralGapsHtml}</div>
    </section>
  `;
}

function getManifestList() {
  const list = [{ id: 'one-universe', name: 'ONE Universe', builtin: true }];
  for (const [id, { name }] of UPLOADED_MANIFESTS) list.push({ id, name, builtin: false });
  return list;
}

function getManifestRaw(id) {
  if (id === 'one-universe') return ONE_UNIVERSE_RAW;
  return UPLOADED_MANIFESTS.get(id)?.raw || null;
}

// ============================================================
// MODE SWITCHING
// ============================================================
function setMode(mode) {
  CURRENT_MODE = mode;
  $$('.mode-pill').forEach(p => p.classList.toggle('active', p.dataset.mode === mode));
  $$('.view').forEach(v => { v.hidden = v.dataset.view !== mode; });
  if (mode === 'multiverse') {
    if (!CURRENT_MULTIVERSE) { CURRENT_MULTIVERSE = MULTIVERSE_DATA; }
    renderMultiverseView(CURRENT_MULTIVERSE);
  }
  if (mode === 'universe') {
    populateManifestPickers();
    if (!CURRENT_MANIFEST) loadManifest('one-universe');
  }
  if (mode === 'scaffold') { populateManifestPickers(); }
  if (mode === 'gaps') { populateManifestPickers(); }
}

$$('.mode-pill').forEach(p => p.addEventListener('click', () => setMode(p.dataset.mode)));

// ============================================================
// HASH ROUTING
// ============================================================
window.addEventListener('load', async () => {
  const h = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (!h) { setMode('single'); return; }
  const parts = h.split('/');
  const mode = parts[0];
  if (['single','universe','scaffold','gaps','multiverse'].includes(mode)) {
    setMode(mode);
    const target = parts.slice(1).join('/');
    if (mode === 'single' && target) { $('#repoUrl').value = target; analyze(target); }
    if (mode === 'universe' && target) loadManifest(target);
  } else {
    setMode('single');
    if (h) { $('#repoUrl').value = h; analyze(h); }
  }
});

// ============================================================
// SINGLE-REPO MODE
// ============================================================
$('#repoForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await analyze($('#repoUrl').value.trim());
});
$$('.chip').forEach(c => c.addEventListener('click', () => {
  $('#repoUrl').value = c.dataset.url;
  analyze(c.dataset.url);
}));
$$('.tab').forEach(t => t.addEventListener('click', () => {
  $$('.tab').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  const which = t.dataset.tab;
  $$('.panel[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== which; });
  if (which === 'deps' && CURRENT_REPO) renderDepGraph();
}));

async function analyze(url) {
  if (!url) return;
  $('#errorBox').hidden = true;
  $('#loadingBar').hidden = false;
  $('#analyzeBtn').disabled = true;
  $('#result').hidden = true;
  try {
    const parsed = parseRepoUrl(url);
    if (!parsed) throw new Error('Invalid GitHub URL. Use https://github.com/owner/repo');
    const { owner, repo } = parsed;

    const meta = await getRepoMeta(owner, repo);
    const branch = meta.default_branch || 'main';
    const treeData = await getRepoTree(owner, repo, branch);
    const allItems = treeData.items;
    const tree = buildTree(allItems);
    const critical = pickCriticalFiles(allItems, 10);

    const TEXT_EXTS = ['.js','.jsx','.ts','.tsx','.py','.rb','.go','.rs','.java','.kt',
      '.c','.cc','.cpp','.h','.hpp','.php','.cs','.md','.html','.css','.scss','.sh',
      '.yml','.yaml','.json'];
    const textFiles = allItems.filter(i => {
      if (i.type !== 'blob') return false;
      if (/node_modules|vendor\/|dist\/|build\/|\.min\./.test(i.path)) return false;
      if ((i.size || 0) > 100000) return false;
      const ext = '.' + (i.path.split('.').pop() || '').toLowerCase();
      return TEXT_EXTS.includes(ext);
    }).slice(0, 60);

    const allPathSet = new Set(allItems.filter(i => i.type === 'blob').map(i => i.path));
    const todos = [];
    const importEdges = [];
    const externalDeps = new Map();

    await Promise.all(textFiles.map(async (f) => {
      const text = await getFileText(owner, repo, f.path, branch);
      if (!text) return;
      todos.push(...extractTodos(f.path, text));
      const ext = '.' + (f.path.split('.').pop() || '').toLowerCase();
      if (['.js','.jsx','.ts','.tsx','.mjs','.cjs','.py'].includes(ext)) {
        for (const imp of parseImports(f.path, text)) {
          const resolved = resolveImport(f.path, imp, allPathSet);
          if (!resolved) continue;
          if (resolved.external) externalDeps.set(resolved.name, (externalDeps.get(resolved.name)||0)+1);
          else importEdges.push({ from: f.path, to: resolved.path });
        }
      }
    }));

    const criticalWithContent = await Promise.all(critical.map(async cf => {
      const text = await getFileText(owner, repo, cf.path, branch);
      return { path: cf.path, size: cf.size, score: cf.score, snippet: (text||'').slice(0,6000), htmlUrl: meta.html_url };
    }));

    CURRENT_REPO = {
      repo: {
        owner, repo: meta.name, fullName: meta.full_name, description: meta.description,
        stars: meta.stargazers_count, forks: meta.forks_count, language: meta.language,
        defaultBranch: branch, htmlUrl: meta.html_url, topics: meta.topics||[],
        license: meta.license?.spdx_id||null, updatedAt: meta.pushed_at,
      },
      tree, truncated: treeData.truncated,
      stats: { totalFiles: allItems.filter(i=>i.type==='blob').length, totalDirs: allItems.filter(i=>i.type==='tree').length, sampledFiles: textFiles.length },
      critical: criticalWithContent,
      todos,
      dependencies: {
        edges: importEdges,
        external: Array.from(externalDeps.entries()).map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count).slice(0,50),
      },
    };
    history.replaceState(null, '', `#single/${owner}/${meta.name}`);
    renderRepo(CURRENT_REPO);
  } catch (err) {
    showError(err.message);
  } finally {
    $('#loadingBar').hidden = true;
    $('#analyzeBtn').disabled = false;
  }
}

function showError(msg) {
  const box = $('#errorBox');
  box.textContent = '⚠ ' + msg;
  box.hidden = false;
}

function renderRepo(d) {
  $('#result').hidden = false;
  $('#repoName').textContent = d.repo.fullName;
  $('#repoDesc').textContent = d.repo.description || 'No description provided.';
  $('#badgeLang').textContent = d.repo.language || 'mixed';
  $('#badgeStars').textContent = `★ ${fmt(d.repo.stars)}`;
  $('#badgeForks').textContent = `⑂ ${fmt(d.repo.forks)}`;
  $('#badgeFiles').textContent = `${d.stats.totalFiles} files`;
  if (d.repo.license) { $('#badgeLicense').hidden = false; $('#badgeLicense').textContent = d.repo.license; }
  const gh = $('#ghLink'); gh.hidden = false; gh.href = d.repo.htmlUrl;
  // reset tabs
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'tree'));
  $$('.panel[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== 'tree'; });
  renderTree(d.tree);
  renderTodos(d.todos);
  renderDepsExternals(d.dependencies);
  renderCriticalFiles(d.critical);
}

function fmt(n) {
  if (!n && n!==0) return '0';
  if (n>=1000) return (n/1000).toFixed(1).replace(/\.0$/,'')+'k';
  return String(n);
}

// ---- Tree ----
function renderTree(root) {
  const c = $('#treeView'); c.innerHTML = '';
  for (const child of root.children) c.appendChild(buildNode(child, true));
}
function humanSize(b) {
  if (b<1024) return b+'B'; if (b<1048576) return (b/1024).toFixed(1)+'K';
  return (b/1048576).toFixed(1)+'M';
}
function buildNode(node, openByDefault=false) {
  const wrap = document.createElement('div');
  const row = document.createElement('div');
  row.className = `tree-node ${node.type}`;
  row.dataset.path = node.path;
  const icon = document.createElement('span'); icon.className = 'tree-icon';
  icon.textContent = node.type==='dir' ? '▸' : '·';
  row.appendChild(icon);
  const name = document.createElement('span'); name.className = 'tree-name'; name.textContent = node.name;
  row.appendChild(name);
  const size = document.createElement('span'); size.className = 'tree-size';
  size.textContent = node.type==='file' ? humanSize(node.size||0) : `${node.fileCount||0}`;
  row.appendChild(size);
  wrap.appendChild(row);
  if (node.type==='dir') {
    const kids = document.createElement('div'); kids.className = 'tree-children'; kids.hidden = !openByDefault;
    for (const c of node.children) kids.appendChild(buildNode(c, false));
    wrap.appendChild(kids);
    icon.textContent = openByDefault ? '▾' : '▸';
    row.addEventListener('click', e => {
      e.stopPropagation(); kids.hidden = !kids.hidden;
      icon.textContent = kids.hidden ? '▸' : '▾';
    });
  } else {
    row.addEventListener('click', e => {
      e.stopPropagation();
      $$('.tree-node.selected').forEach(n=>n.classList.remove('selected'));
      row.classList.add('selected');
      selectFile(node);
    });
  }
  return wrap;
}
$('#treeSearch').addEventListener('input', e => filterTree(e.target.value.trim().toLowerCase()));
function filterTree(q) {
  const all = $$('#treeView .tree-node');
  if (!q) { all.forEach(n=>{n.parentElement.style.display='';}); return; }
  const tree = $('#treeView');
  const showMap = new WeakSet();
  all.forEach(n => {
    if ((n.dataset.path||'').toLowerCase().includes(q)) {
      let cur = n.parentElement;
      while (cur && cur!==tree) { showMap.add(cur); cur=cur.parentElement; }
      showMap.add(n.parentElement);
    }
  });
  $$('#treeView .tree-children').forEach(kc => { if (showMap.has(kc.parentElement)) kc.hidden=false; });
  all.forEach(n => { n.parentElement.style.display = showMap.has(n.parentElement) ? '' : 'none'; });
}
function selectFile(node) {
  if (node.type!=='file') { $('#fileDetail').hidden=true; return; }
  const det = $('#fileDetail'); det.hidden = false;
  $('#fdPath').textContent = node.path;
  $('#fdMeta').textContent = humanSize(node.size||0);
  const btn = $('#fdSummarize');
  btn.hidden = false; btn.disabled = false; btn.textContent = 'View on GitHub';
  btn.onclick = () => {
    if (CURRENT_REPO) window.open(`${CURRENT_REPO.repo.htmlUrl}/blob/${CURRENT_REPO.repo.defaultBranch}/${node.path}`, '_blank');
  };
  $('#fdSummary').hidden = true;
}

// ---- TODOs ----
let TODO_FILTER = { kind: 'ALL', q: '' };
function renderTodos(todos) {
  const filters = $('#todoFilters'); filters.innerHTML = '';
  const kinds = ['ALL', ...new Set(todos.map(t=>t.kind))];
  for (const k of kinds) {
    const b = document.createElement('button');
    b.className = 'filter-btn' + (k==='ALL'?' active':'');
    b.textContent = `${k} ${k==='ALL'?todos.length:todos.filter(t=>t.kind===k).length}`;
    b.addEventListener('click', () => {
      $$('#todoFilters .filter-btn').forEach(x=>x.classList.remove('active'));
      b.classList.add('active'); TODO_FILTER.kind=k; drawTodos();
    });
    filters.appendChild(b);
  }
  drawTodos();
}
$('#todoSearch').addEventListener('input', e => { TODO_FILTER.q=e.target.value.toLowerCase(); drawTodos(); });
function drawTodos() {
  const list = $('#todoList'); list.innerHTML = '';
  let todos = (CURRENT_REPO&&CURRENT_REPO.todos)||[];
  if (TODO_FILTER.kind!=='ALL') todos=todos.filter(t=>t.kind===TODO_FILTER.kind);
  if (TODO_FILTER.q) todos=todos.filter(t=>(t.message+' '+t.path).toLowerCase().includes(TODO_FILTER.q));
  if (!todos.length) { list.innerHTML='<div class="empty">No matching TODOs found.</div>'; return; }
  for (const t of todos) {
    const div = document.createElement('div'); div.className=`todo-item ${t.kind}`;
    const url = `${CURRENT_REPO.repo.htmlUrl}/blob/${CURRENT_REPO.repo.defaultBranch}/${t.path}#L${t.line}`;
    div.innerHTML=`<span class="kind ${t.kind}">${t.kind}</span><div><div class="msg">${esc(t.message)}</div><div class="path"><a href="${url}" target="_blank" rel="noopener">${esc(t.path)}:${t.line}</a></div></div>`;
    list.appendChild(div);
  }
}

// ---- Deps ----
function renderDepsExternals(deps) {
  const list = $('#extDepsList'); list.innerHTML='';
  if (!deps.external.length) { list.innerHTML='<li class="muted">No external imports detected.</li>'; }
  for (const d of deps.external) {
    const li=document.createElement('li');
    li.innerHTML=`<span>${esc(d.name)}</span><span class="count">${d.count}</span>`;
    list.appendChild(li);
  }
  $('#depStats').textContent=`${deps.edges.length} internal edges · ${deps.external.length} external`;
}
$('#showExternal').addEventListener('change', () => { if (CURRENT_REPO) renderDepGraph(); });
function renderDepGraph() {
  const svg = d3.select('#depGraph'); svg.selectAll('*').remove();
  const showExt = $('#showExternal').checked;
  const edges = CURRENT_REPO.dependencies.edges;
  const nodeSet = new Set();
  edges.forEach(e=>{ nodeSet.add(e.from); nodeSet.add(e.to); });
  const nodes = Array.from(nodeSet).map(p=>({id:p, type:'internal'}));
  let links = edges.map(e=>({source:e.from, target:e.to}));
  if (showExt) {
    for (const ext of CURRENT_REPO.dependencies.external.slice(0,20))
      nodes.push({id:`ext:${ext.name}`, type:'external', count:ext.count});
  }
  if (!nodes.length) { svg.append('text').attr('x',20).attr('y',40).attr('fill','#8a82b8').text('No internal dependencies detected.'); return; }
  const width = svg.node().clientWidth||800, height=560;
  svg.attr('viewBox',`0 0 ${width} ${height}`);
  const inDeg = new Map();
  links.forEach(l=>inDeg.set(l.target,(inDeg.get(l.target)||0)+1));
  const sim = d3.forceSimulation(nodes)
    .force('link',d3.forceLink(links).id(d=>d.id).distance(50).strength(0.5))
    .force('charge',d3.forceManyBody().strength(-120))
    .force('center',d3.forceCenter(width/2,height/2))
    .force('collide',d3.forceCollide().radius(d=>(d.type==='external'?8:4+Math.sqrt(inDeg.get(d.id)||1)*2)));
  const g = svg.append('g');
  svg.call(d3.zoom().scaleExtent([0.2,4]).on('zoom',ev=>g.attr('transform',ev.transform)));
  const link = g.append('g').selectAll('line').data(links).join('line').attr('stroke','#443a8c').attr('stroke-width',1).attr('stroke-opacity',0.7);
  const node = g.append('g').selectAll('circle').data(nodes).join('circle')
    .attr('r',d=>d.type==='external'?6:3+Math.sqrt(inDeg.get(d.id)||1)*1.8)
    .attr('fill',d=>d.type==='external'?'#ff7eb6':'#7ce8d4')
    .attr('stroke','#0a0820').attr('stroke-width',1.2).style('cursor','pointer')
    .call(drag(sim));
  const label = g.append('g').selectAll('text').data(nodes).join('text')
    .text(d=>d.id.startsWith('ext:')?d.id.slice(4):d.id.split('/').pop())
    .attr('font-size',9).attr('font-family','JetBrains Mono').attr('fill','#c8c0e3')
    .attr('pointer-events','none').attr('dx',7).attr('dy',3);
  node.append('title').text(d=>d.id);
  sim.on('tick',()=>{
    link.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y).attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);
    node.attr('cx',d=>d.x).attr('cy',d=>d.y);
    label.attr('x',d=>d.x).attr('y',d=>d.y);
  });
}
function drag(sim) {
  return d3.drag()
    .on('start',(event,d)=>{ if(!event.active) sim.alphaTarget(0.3).restart(); d.fx=d.x; d.fy=d.y; })
    .on('drag',(event,d)=>{ d.fx=event.x; d.fy=event.y; })
    .on('end',(event,d)=>{ if(!event.active) sim.alphaTarget(0); d.fx=null; d.fy=null; });
}

// ---- Key files ----
function renderCriticalFiles(critical) {
  const list = $('#summariesList'); list.innerHTML = '';
  if (!critical.length) { list.innerHTML='<div class="empty">No critical files identified.</div>'; return; }
  for (const f of critical) {
    const card = document.createElement('div'); card.className='sum-card';
    const url = f.htmlUrl ? `${f.htmlUrl}/blob/HEAD/${f.path}` : '#';
    card.innerHTML=`<h4><a href="${url}" target="_blank" rel="noopener">${esc(f.path)}</a></h4><div class="meta">${humanSize(f.size||0)} · score ${Math.round(f.score)}</div><div class="body muted small">Open in GitHub to view contents.</div>`;
    list.appendChild(card);
  }
}

// ============================================================
// UNIVERSE MODE
// ============================================================
function populateManifestPickers() {
  const manifests = getManifestList();
  const opts = manifests.map(m=>`<option value="${esc(m.id)}">${esc(m.name)}${m.builtin?'':' (custom)'}</option>`).join('');
  ['#universePicker','#scaffoldPicker','#gapsPicker'].forEach(sel=>{
    const el=$(sel); if (el) el.innerHTML=opts;
  });
}

$('#universePicker').addEventListener('change', e=>loadManifest(e.target.value));
document.querySelector('.upload-label').addEventListener('click', ()=>$('#universeUploadInput').click());
$('#universeUploadInput').addEventListener('change', async e=>{
  const file=e.target.files[0]; if(!file) return;
  const text=await file.text();
  try {
    parseManifest(text); // validate
    const id=`m-${Date.now().toString(36)}`;
    const name=file.name.replace(/\.ya?ml$/i,'');
    UPLOADED_MANIFESTS.set(id,{raw:text,name});
    populateManifestPickers();
    $('#universePicker').value=id;
    loadManifest(id);
  } catch(err) { alert('Upload failed: '+err.message); }
});

async function loadManifest(id) {
  $('#universeLoading').hidden=false;
  $('#universeResult').hidden=true;
  try {
    const raw = getManifestRaw(id);
    if (!raw) throw new Error('Manifest not found: ' + id);
    const doc = parseManifest(raw);
    const structured = structureManifest(doc);
    structured._raw = raw;
    CURRENT_MANIFEST = { id, universe: structured.universe, repos: structured.repos, stats: structured.stats, raw };
    history.replaceState(null,'',`#universe/${id}`);
    renderUniverse(CURRENT_MANIFEST);
  } catch(e) {
    $('#universeLoading').hidden=true;
    alert('Could not load manifest: '+e.message);
  }
}

function renderUniverse(m) {
  $('#universeLoading').hidden=true;
  $('#universeResult').hidden=false;
  $('#universeStats').hidden=false;
  // Inject multiverse breadcrumb link above stats
  const statsEl = $('#universeStats');
  let mvCrumb = $('#universeMvCrumb');
  if (!mvCrumb) {
    mvCrumb = document.createElement('div');
    mvCrumb.id = 'universeMvCrumb';
    mvCrumb.className = 'hierarchy-breadcrumb';
    mvCrumb.style.marginBottom = '12px';
    statsEl.parentNode.insertBefore(mvCrumb, statsEl);
  }
  mvCrumb.innerHTML = `<span class="crumb" onclick="setMode('multiverse')" style="cursor:pointer;text-decoration:underline">ONE Multiverse</span><span class="crumb-sep">&rarr;</span><span class="crumb crumb--active">${esc(m.universe?.name||'ONE Universe')}</span>`;
  $('#statRepos').textContent=m.repos.length;
  $('#statEcosystems').textContent=m.repos.filter(r=>r.role==='ecosystem').length;
  const avg=m.repos.reduce((s,r)=>s+(MATURITY[r.maturity]?.order??0),0)/m.repos.length;
  $('#statMaturity').textContent=avg.toFixed(1);
  renderUniverseMap(m);
  renderRepoIndex(m);
  $('#manifestYaml').textContent=m.raw;
}

$$('.utab').forEach(t=>t.addEventListener('click',()=>{
  $$('.utab').forEach(x=>x.classList.remove('active')); t.classList.add('active');
  const which=t.dataset.utab;
  $$('.panel[data-upanel]').forEach(p=>{p.hidden=p.dataset.upanel!==which;});
}));

$('#repoIndexSearch').addEventListener('input',e=>filterRepoIndex(e.target.value.toLowerCase()));
function filterRepoIndex(q) {
  $$('#repoIndexBody tr').forEach(tr=>{tr.style.display=tr.dataset.search?.includes(q)?'':'none';});
}
function renderRepoIndex(m) {
  const tbody=$('#repoIndexBody'); tbody.innerHTML='';
  for (const r of m.repos) {
    const tr=document.createElement('tr');
    tr.dataset.search=`${r.id} ${r.name} ${r.role} ${r.maturity} ${(r.tags||[]).join(' ')}`.toLowerCase();
    tr.innerHTML=`
      <td class="repo-cell"><span class="repo-name-display">${esc(r.name)}</span><span class="repo-id">${esc(r.id)}</span></td>
      <td><span class="badge muted">${esc(r.role)}</span></td>
      <td><span class="maturity-pill ${esc(r.maturity)}">${esc(MATURITY[r.maturity]?.label||r.maturity)}</span></td>
      <td>${r.parent?`<code>${esc(r.parent)}</code>`:'<span class="muted">—</span>'}</td>
      <td class="desc-cell">${esc((r.description||'').trim().slice(0,240))}</td>`;
    tr.style.cursor='pointer';
    tr.addEventListener('click',()=>{ showRepoDetail(r); $('.utab[data-utab=map]').click(); });
    tbody.appendChild(tr);
  }
}
$('#manifestCopyBtn').addEventListener('click',()=>{
  navigator.clipboard.writeText(CURRENT_MANIFEST.raw);
  const btn=$('#manifestCopyBtn'); btn.textContent='Copied!';
  setTimeout(()=>btn.textContent='Copy',1400);
});
$('#manifestDownloadBtn').addEventListener('click',()=>{
  const blob=new Blob([CURRENT_MANIFEST.raw],{type:'text/yaml'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download='universe.yaml'; a.click();
  URL.revokeObjectURL(url);
});

function renderUniverseMap(m) {
  const svg=d3.select('#universeMap'); svg.selectAll('*').remove();
  const wrap=svg.node().getBoundingClientRect();
  const width=wrap.width||800, height=640;
  svg.attr('viewBox',`0 0 ${width} ${height}`);
  const nodes=m.repos.map(r=>({...r,radius:ROLE_SIZE[r.role]||12,color:MATURITY[r.maturity]?.color||'#7a82a8'}));
  const byId=new Map(nodes.map(n=>[n.id,n]));
  const links=[];
  for (const r of m.repos) {
    if (r.parent&&byId.has(r.parent)) links.push({source:r.parent,target:r.id,kind:'parent'});
  }
  for (const r of m.repos) {
    if (r.role==='governance'&&Array.isArray(r.references)) {
      for (const ref of r.references) {
        const id=ref.split('/').pop();
        if (byId.has(id)&&id!==r.id&&!links.find(l=>l.source===r.id&&l.target===id))
          links.push({source:r.id,target:id,kind:'reference'});
      }
    }
  }
  const legend=$('#mapLegend');
  legend.innerHTML=Object.entries(MATURITY).sort((a,b)=>a[1].order-b[1].order)
    .map(([k,v])=>`<span class="leg"><span class="dot" style="background:${v.color}"></span>${v.label}</span>`).join('');
  const g=svg.append('g');
  svg.call(d3.zoom().scaleExtent([0.3,3]).on('zoom',ev=>g.attr('transform',ev.transform)));
  const defs=svg.append('defs');
  const glow=defs.append('filter').attr('id','glow').attr('x','-50%').attr('y','-50%').attr('width','200%').attr('height','200%');
  glow.append('feGaussianBlur').attr('stdDeviation','3').attr('result','blur');
  const merge=glow.append('feMerge');
  merge.append('feMergeNode').attr('in','blur');
  merge.append('feMergeNode').attr('in','SourceGraphic');
  for (const n of nodes) {
    if (n.role==='master') { n.fx=width/2; n.fy=height/2; }
    else {
      const i=nodes.indexOf(n), angle=(i/nodes.length)*Math.PI*2;
      n.x=width/2+Math.cos(angle)*180; n.y=height/2+Math.sin(angle)*180;
    }
  }
  const sim=d3.forceSimulation(nodes)
    .force('link',d3.forceLink(links).id(d=>d.id).distance(l=>l.kind==='reference'?130:80).strength(l=>l.kind==='reference'?0.12:0.55))
    .force('charge',d3.forceManyBody().strength(-260))
    .force('center',d3.forceCenter(width/2,height/2).strength(0.06))
    .force('x',d3.forceX(width/2).strength(0.05))
    .force('y',d3.forceY(height/2).strength(0.05))
    .force('collide',d3.forceCollide().radius(d=>d.radius+14));
  const link=g.append('g').selectAll('line').data(links).join('line')
    .attr('stroke',d=>d.kind==='reference'?'#9b6bff':'#443a8c')
    .attr('stroke-width',d=>d.kind==='reference'?1:1.8)
    .attr('stroke-opacity',d=>d.kind==='reference'?0.45:0.75)
    .attr('stroke-dasharray',d=>d.kind==='reference'?'4,4':null);
  const nodeGroup=g.append('g').selectAll('g').data(nodes).join('g')
    .style('cursor','pointer')
    .call(drag(sim))
    .on('click',(ev,d)=>{ ev.stopPropagation(); showRepoDetail(d); });
  nodeGroup.append('circle').attr('r',d=>d.radius+4).attr('fill','none').attr('stroke',d=>d.color).attr('stroke-opacity',0.3).attr('stroke-width',1);
  nodeGroup.append('circle').attr('r',d=>d.radius).attr('fill',d=>d.color).attr('stroke','#0a0820').attr('stroke-width',2).attr('filter',d=>d.role==='master'?'url(#glow)':null);
  nodeGroup.append('text').text(d=>d.name).attr('text-anchor','middle').attr('dy',d=>d.radius+18)
    .attr('font-family','Cormorant Garamond, serif')
    .attr('font-size',d=>d.role==='master'?18:d.role==='governance'||d.role==='container'?15:13)
    .attr('font-weight',d=>d.role==='master'?600:500).attr('fill','#f5efe6').attr('pointer-events','none');
  nodeGroup.append('title').text(d=>`${d.name}\n${d.role} · ${d.maturity}\n${d.description||''}`);
  sim.on('tick',()=>{
    const pad=40;
    for (const n of nodes) {
      if (n.fx==null) { n.x=Math.max(pad,Math.min(width-pad,n.x)); n.y=Math.max(pad,Math.min(height-pad,n.y)); }
    }
    link.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y).attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);
    nodeGroup.attr('transform',d=>`translate(${d.x},${d.y})`);
  });
}

function showRepoDetail(r) {
  const side=$('#repoSide'); side.hidden=false;
  $('#rsName').textContent=r.name;
  $('#rsRole').textContent=`${r.role}${r.parent?' · child of '+r.parent:''}`;
  const pill=$('#rsMaturity'); pill.textContent=MATURITY[r.maturity]?.label||r.maturity;
  pill.className=`maturity-pill ${r.maturity}`;
  $('#rsDesc').textContent=(r.description||'').trim()||'—';
  const tagsWrap=$('#rsTagsWrap');
  if (Array.isArray(r.tags)&&r.tags.length) { tagsWrap.hidden=false; $('#rsTags').innerHTML=r.tags.map(t=>`<span>${esc(t)}</span>`).join(''); }
  else tagsWrap.hidden=true;
  const gapsWrap=$('#rsGapsWrap');
  if (Array.isArray(r.known_gaps)&&r.known_gaps.length) { gapsWrap.hidden=false; $('#rsGaps').innerHTML=r.known_gaps.map(g=>`<li>${esc(g)}</li>`).join(''); }
  else gapsWrap.hidden=true;
  const containsWrap=$('#rsContainsWrap');
  if (Array.isArray(r.contains)&&r.contains.length) { containsWrap.hidden=false; $('#rsContains').innerHTML=r.contains.map(c=>`<li>${esc(c)}</li>`).join(''); }
  else containsWrap.hidden=true;
  const ghUrl=r.repo?.startsWith('http')?r.repo:`https://${r.repo||''}`;
  $('#rsLink').href=ghUrl;
}
$('#repoSideClose').addEventListener('click',()=>{ $('#repoSide').hidden=true; });

// ============================================================
// SCAFFOLD MODE
// ============================================================
function filesForRepo(repo, universe) {
  const COMMON = [
    {path:'README.md',kind:'readme'},{path:'STATUS.md',kind:'status'},
    {path:'charter.md',kind:'charter'},{path:'roadmap.md',kind:'roadmap'},
    {path:'compliance/privacy.md',kind:'stub',topic:'Privacy Policy'},
    {path:'compliance/terms.md',kind:'stub',topic:'Terms of Service'},
    {path:'compliance/jurisdiction.md',kind:'stub',topic:'Jurisdiction'},
    {path:'compliance/data-handling.md',kind:'stub',topic:'Data Handling'},
    {path:'compliance/accessibility.md',kind:'stub',topic:'Accessibility'},
    {path:'compliance/checklist.md',kind:'checklist'},
    {path:'governance/principles.md',kind:'principles'},
    {path:'docs/overview.md',kind:'docs-overview'},
    {path:'BRAND/README.md',kind:'brand-readme'},
  ];
  const files=[];
  const all=[...COMMON];
  if (['ecosystem','product','master'].includes(repo.role))
    all.push({path:'product/IMPORT.md',kind:'import-readme'});
  for (const t of all) {
    let content='';
    if (t.kind==='readme') content=`# ${repo.name}\n\n> ${repo.description||'Part of '+universe.name+'.'}\n\n**Role:** \`${repo.role}\`  ·  **Maturity:** \`${repo.maturity}\`\n`;
    else if (t.kind==='status') content=`# ${repo.name} — STATUS\n\n**Maturity:** \`${repo.maturity}\`\n\n_(Describe current state.)_\n`;
    else if (t.kind==='charter') content=`# ${repo.name} — Charter\n\n_(Draft this document.)_\n`;
    else if (t.kind==='roadmap') content=`# ${repo.name} — Roadmap\n\n## Now\n\n- _(current focus)_\n`;
    else if (t.kind==='stub') content=`# ${t.topic} — ${repo.name}\n\n_(Draft this document. It must cover ${(t.topic||'').toLowerCase()} for this repo.)_\n\n## What does this cover?\n\n_(What does this cover?)_\n`;
    else if (t.kind==='checklist') content=`# ${repo.name} — Compliance checklist\n\n- [ ] Privacy policy drafted\n- [ ] Terms of service drafted\n- [ ] Jurisdiction defined\n- [ ] Data handling documented\n- [ ] Accessibility statement drafted\n`;
    else if (t.kind==='principles') content=`# ${repo.name} — Governance principles\n\nInherited from ${universe.name}.\n`;
    else if (t.kind==='brand-readme') content=`# ${repo.name} — BRAND/\n\nVisual identity for **${repo.name}**.\n`;
    else if (t.kind==='docs-overview') content=`# ${repo.name} — docs/\n\n_(Entry point for documentation.)_\n`;
    else if (t.kind==='import-readme') content=`# ${repo.name} — product/IMPORT.md\n\nDrop MVP export zips here.\n`;
    files.push({path:t.path,content,kind:t.kind});
  }
  return files;
}

function buildTreeFromFiles(files) {
  const root={name:'',type:'dir',children:{}};
  for (const f of files) {
    const parts=f.path.split('/');
    let node=root;
    for (let i=0;i<parts.length;i++) {
      const part=parts[i], isLast=i===parts.length-1;
      if (!node.children[part]) node.children[part]={name:part,type:isLast?'file':'dir',children:{},size:isLast?(f.content||'').length:0,kind:isLast?f.kind:''};
      node=node.children[part];
    }
  }
  function fin(n) {
    const kids=Object.values(n.children);
    kids.forEach(fin);
    kids.sort((a,b)=>a.type!==b.type?(a.type==='dir'?-1:1):a.name.localeCompare(b.name));
    n.children=kids;
    n.fileCount=kids.reduce((s,k)=>s+(k.fileCount||(k.type==='file'?1:0)),0);
    return n;
  }
  fin(root);
  return root;
}

$('#scaffoldPreviewBtn').addEventListener('click', async ()=>{
  const id=$('#scaffoldPicker').value; if(!id) return;
  const btn=$('#scaffoldPreviewBtn'); btn.disabled=true; btn.textContent='Generating…';
  $('#scaffoldStatus').textContent='';
  try {
    const raw=getManifestRaw(id); if(!raw) throw new Error('Manifest not found');
    const doc=parseManifest(raw);
    const structured=structureManifest(doc);
    const universe=doc.universe;
    const reposOut=structured.repos.map(repo=>{
      const files=filesForRepo(repo,universe);
      return {id:repo.id,name:repo.name,role:repo.role,maturity:repo.maturity,fileCount:files.length,tree:buildTreeFromFiles(files)};
    });
    const totalFiles=reposOut.reduce((s,r)=>s+r.fileCount,0);
    CURRENT_SCAFFOLD={universe,repos:reposOut,totalFiles,totalRepos:reposOut.length};
    history.replaceState(null,'',`#scaffold/${id}`);
    renderScaffold(CURRENT_SCAFFOLD);
    $('#scaffoldDownloadBtn').hidden=false;
    $('#scaffoldStatus').textContent=`${reposOut.length} repos · ${totalFiles} files`;
  } catch(e){ $('#scaffoldStatus').textContent='Error: '+e.message; }
  finally { btn.disabled=false; btn.textContent='Generate preview'; }
});

$('#scaffoldDownloadBtn').addEventListener('click', async ()=>{
  const id=$('#scaffoldPicker').value;
  const btn=$('#scaffoldDownloadBtn'); btn.disabled=true; btn.textContent='Building zip…';
  try {
    const raw=getManifestRaw(id); if(!raw) throw new Error('Manifest not found');
    const doc=parseManifest(raw);
    const structured=structureManifest(doc);
    const zip=new JSZip();
    let fileCount=0;
    for (const repo of structured.repos) {
      const files=filesForRepo(repo,doc.universe);
      for (const f of files) { zip.file(`${repo.id}/${f.path}`,f.content); fileCount++; }
    }
    zip.file('universe.yaml',raw);
    const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url; a.download=`${id}-scaffold.zip`; a.click();
    URL.revokeObjectURL(url);
    btn.textContent='Downloaded';
    setTimeout(()=>btn.textContent='Download .zip',1500);
  } catch(e){ $('#scaffoldStatus').textContent='Download failed: '+e.message; btn.textContent='Download .zip'; }
  finally{ btn.disabled=false; }
});

function renderScaffold(s) {
  $('#scaffoldResult').hidden=false;
  $('#scaffoldUniverseName').textContent=s.universe?.name||'Universe';
  $('#scaffoldCounts').textContent=`${s.totalRepos} repos · ${s.totalFiles} files — ready to download as zip`;
  const grid=$('#scaffoldGrid'); grid.innerHTML='';
  for (const repo of s.repos) {
    const card=document.createElement('div'); card.className='scaffold-card';
    card.innerHTML=`<div class="scaffold-card-head"><div><h4>${esc(repo.name)}</h4><div class="sc-role">${esc(repo.role)} · ${esc(repo.maturity)}</div></div><div class="sc-count">${repo.fileCount} files</div></div><div class="mini-tree"></div>`;
    const treeEl=card.querySelector('.mini-tree');
    for (const child of repo.tree.children) treeEl.appendChild(buildMiniNode(child,true));
    grid.appendChild(card);
  }
}
function buildMiniNode(node,openByDefault=false) {
  const wrap=document.createElement('div');
  const row=document.createElement('div'); row.className=`mt-node mt-${node.type}`;
  const icon=document.createElement('span'); icon.className='mt-icon';
  icon.textContent=node.type==='dir'?'▸':'·';
  row.appendChild(icon);
  const name=document.createElement('span'); name.textContent=node.name;
  row.appendChild(name);
  wrap.appendChild(row);
  if (node.type==='dir') {
    const kids=document.createElement('div'); kids.className='mt-children'; kids.hidden=!openByDefault;
    for (const c of node.children) kids.appendChild(buildMiniNode(c,false));
    wrap.appendChild(kids);
    icon.textContent=openByDefault?'▾':'▸';
    row.addEventListener('click',e=>{ e.stopPropagation(); kids.hidden=!kids.hidden; icon.textContent=kids.hidden?'▸':'▾'; });
  }
  return wrap;
}

// ============================================================
// GAP DASHBOARD (direct GitHub API calls)
// ============================================================
function isStub(body) {
  if (!body) return true;
  const stripped=body.replace(/^#+\s.*$/gm,'').replace(/\s+/g,'');
  const hasPlaceholder=body.includes('_(Draft this document')||body.includes('_(What does this cover?)_');
  return hasPlaceholder||stripped.length<200;
}

async function scanRepo(owner, repoName) {
  const base=`/repos/${owner}/${repoName}`;
  const [meta, commits, issues, compliance] = await Promise.all([
    ghFetch(base),
    ghFetch(base+'/commits?per_page=1'),
    ghFetch(base+'/issues?state=open&per_page=100'),
    ghFetch(base+'/contents/compliance'),
  ]);
  if (meta._status===404) return {owner,repo:repoName,status:'missing',flagged:true,flags:['repo not found']};
  if (meta._error||meta._status) return {owner,repo:repoName,status:'error',flagged:false,flags:[],error:meta._error||`HTTP ${meta._status}`};
  const latestCommit=Array.isArray(commits)&&commits[0]?{
    sha:commits[0].sha, date:commits[0].commit?.author?.date,
    message:commits[0].commit?.message?.split('\n')[0]?.slice(0,120),
  }:null;
  const openIssues=Array.isArray(issues)?issues.filter(i=>!i.pull_request).map(i=>({number:i.number,title:i.title,url:i.html_url})):[];
  const stubs=[];
  let uncheckedCount=0;
  if (Array.isArray(compliance)) {
    const mdFiles=compliance.filter(f=>f.name?.endsWith('.md')&&f.type==='file');
    const fetches=await Promise.all(mdFiles.map(async f=>{
      try { const r=await fetch(f.download_url); return {name:f.name,body:r.ok?await r.text():null}; }
      catch { return {name:f.name,body:null}; }
    }));
    for (const f of fetches) {
      if (f.name==='checklist.md') { if (f.body) uncheckedCount=(f.body.match(/- \[ \] /g)||[]).length; continue; }
      if (isStub(f.body)) stubs.push(f.name);
    }
  }
  const flags=[];
  if (latestCommit) {
    const days=(Date.now()-new Date(latestCommit.date).getTime())/86400000;
    if (days>30) flags.push(`stale (${Math.round(days)}d)`);
  } else { flags.push('no commits'); }
  if (openIssues.length) flags.push(`${openIssues.length} open issues`);
  if (stubs.length) flags.push(`${stubs.length} empty stubs`);
  if (uncheckedCount) flags.push(`${uncheckedCount} unchecked compliance items`);
  return {
    owner, repo:repoName, status:'ok', flagged:flags.length>0, flags,
    meta:{description:meta.description,defaultBranch:meta.default_branch,pushedAt:meta.pushed_at,stars:meta.stargazers_count,forks:meta.forks_count},
    latestCommit, openIssues:openIssues.slice(0,10), openIssueCount:openIssues.length,
    emptyStubs:stubs, uncheckedCompliance:uncheckedCount,
  };
}

$('#gapsScanBtn').addEventListener('click', async ()=>{
  const id=$('#gapsPicker').value; if(!id) return;
  const btn=$('#gapsScanBtn'); btn.disabled=true; btn.textContent='Scanning GitHub…';
  $('#gapsStatus').textContent='Hitting GitHub API…';
  try {
    const raw=getManifestRaw(id); if(!raw) throw new Error('Manifest not found');
    const doc=parseManifest(raw);
    const structured=structureManifest(doc);
    const tasks=structured.repos.map(r=>async()=>{
      const owner=r.owner||(r.repo?.includes('/')?r.repo.split('/').slice(-2,-1)[0]:'noahnemo-rgb');
      const repoName=r.repo?.split('/').pop()||r.id;
      const result=await scanRepo(owner,repoName);
      return {id:r.id,name:r.name,role:r.role,maturity:r.maturity,parent:r.parent||null,...result};
    });
    const out=[];
    let cursor=0;
    async function worker() { while(cursor<tasks.length){const i=cursor++;out[i]=await tasks[i]();} }
    await Promise.all(Array.from({length:Math.min(4,tasks.length)},worker));
    const flaggedCount=out.filter(r=>r.flagged).length;
    CURRENT_GAPS={scannedAt:new Date().toISOString(),universe:doc.universe?.name,totalRepos:out.length,flaggedCount,quietCount:out.length-flaggedCount,repos:out};
    history.replaceState(null,'',`#gaps/${id}`);
    renderGaps(CURRENT_GAPS);
    $('#gapsStatus').textContent=`Scanned ${out.length} repos at ${new Date(CURRENT_GAPS.scannedAt).toLocaleString()}`;
  } catch(e){ $('#gapsStatus').textContent='Error: '+e.message; }
  finally{ btn.disabled=false; btn.textContent='Scan now'; }
});

$('#gapsOnlyFlagged').addEventListener('change',()=>{ if(CURRENT_GAPS) renderGapsTable(CURRENT_GAPS); });
function renderGaps(data) {
  $('#gapsResult').hidden=false;
  $('#gapTotal').textContent=data.totalRepos;
  $('#gapFlagged').textContent=data.flaggedCount;
  $('#gapQuiet').textContent=data.quietCount;
  $('#gapMissing').textContent=data.repos.filter(r=>r.status==='missing').length;
  renderGapsTable(data);
}
function renderGapsTable(data) {
  const onlyFlagged=$('#gapsOnlyFlagged').checked;
  const tbody=$('#gapsBody'); tbody.innerHTML='';
  const rows=onlyFlagged?data.repos.filter(r=>r.flagged):data.repos;
  if (!rows.length){tbody.innerHTML=`<tr><td colspan="7" class="empty">All quiet.</td></tr>`;return;}
  for (const r of rows) {
    const tr=document.createElement('tr');
    const sc=r.status==='missing'?'status-missing':r.status==='error'?'status-error':r.flagged?'status-flagged':'status-ok';
    const sl=r.status==='missing'?'missing':r.status==='error'?'error':r.flagged?'flagged':'quiet';
    const commit=r.latestCommit?`<span class="commit-msg" title="${esc(r.latestCommit.message||'')}">${esc(r.latestCommit.message||'—')}</span><span class="commit-date">${esc((r.latestCommit.date||'').slice(0,10))} · <code>${esc((r.latestCommit.sha||'').slice(0,7))}</code></span>`:'<span class="muted">—</span>';
    const i=r.openIssueCount||0, s=(r.emptyStubs||[]).length, u=r.uncheckedCompliance||0;
    const pc=n=>n===0?'zero':n<3?'some':'lots';
    const flags=(r.flags||[]).map(f=>`<span class="flag-pill">${esc(f)}</span>`).join('');
    const ghUrl=r.repo?`https://github.com/${r.owner||'noahnemo-rgb'}/${r.repo}`:'#';
    tr.innerHTML=`
      <td class="repo-cell"><a href="${ghUrl}" target="_blank" rel="noopener" class="repo-name-display">${esc(r.name||r.id)}</a><span class="repo-id">${esc(r.owner||'noahnemo-rgb')}/${esc(r.repo||r.id)}</span></td>
      <td><span class="${sc}">${sl}</span></td>
      <td>${commit}</td>
      <td><span class="num-pill ${pc(i)}">${i}</span></td>
      <td><span class="num-pill ${pc(s)}">${s}</span>${s?` <span class="muted small">(${r.emptyStubs.map(esc).join(', ')})</span>`:''}</td>
      <td><span class="num-pill ${pc(u)}">${u}</span></td>
      <td class="flag-cell">${flags||'<span class="muted">—</span>'}</td>`;
    tbody.appendChild(tr);
  }
}
