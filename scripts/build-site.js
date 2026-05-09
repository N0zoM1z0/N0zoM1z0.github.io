const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { marked } = require('marked');

const root = path.resolve(__dirname, '..');
const contentDir = path.join(root, 'content', 'posts');
const outDir = path.join(root, '_site');
const siteUrl = 'https://n0zom1z0.github.io';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugify(value = '') {
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value].filter(Boolean);
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '');
  return date.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}

function stripMarkdown(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
    .replace(/\[[^\]]+]\(([^)]+)\)/g, '$1')
    .replace(/[#>*_`~|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function makeExcerpt(markdown, length = 230) {
  const text = stripMarkdown(markdown);
  return text.length > length ? `${text.slice(0, length).trim()}...` : text;
}

function readingTime(markdown) {
  const words = stripMarkdown(markdown).split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 220));
}

function groupBy(items, getKeys) {
  const groups = new Map();
  for (const item of items) {
    for (const key of getKeys(item)) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function readPosts() {
  if (!fs.existsSync(contentDir)) return [];
  return fs.readdirSync(contentDir)
    .filter(file => file.endsWith('.md'))
    .map(file => {
      const raw = fs.readFileSync(path.join(contentDir, file), 'utf8');
      const parsed = matter(raw);
      const slug = parsed.data.slug || path.basename(file, '.md');
      const markdown = parsed.content.trim();
      const title = parsed.data.title || slug;
      return {
        title,
        slug,
        url: `/posts/${slug}/`,
        date: parsed.data.date || '',
        categories: asArray(parsed.data.categories),
        tags: asArray(parsed.data.tags),
        project: parsed.data.project || '',
        markdown,
        excerpt: parsed.data.excerpt || makeExcerpt(markdown),
        readingMinutes: readingTime(markdown),
        searchable: stripMarkdown(markdown)
      };
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

function renderMarkdown(markdown) {
  const renderer = new marked.Renderer();
  renderer.heading = (text, level) => {
    const id = slugify(text);
    const anchor = `<a class="heading-anchor" href="#${id}" aria-label="Copy link to ${escapeHtml(text)}">#</a>`;
    return `<h${level} id="${id}">${text}${anchor}</h${level}>`;
  };
  return marked.parse(markdown, { renderer });
}

function tocFromMarkdown(markdown) {
  const headings = [...markdown.matchAll(/^##\s+(.+)$/gm)].slice(0, 12);
  if (!headings.length) return '';
  const links = headings.map(([, text]) => {
    const id = slugify(text);
    return `<a href="#${id}">${escapeHtml(text)}</a>`;
  }).join('');
  return `<section class="panel-card toc"><h2>Contents</h2>${links}</section>`;
}

function tagCloud(posts) {
  return groupBy(posts, post => post.tags)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 8)
    .map(([tag]) => `<a href="/tags/#tag-${slugify(tag)}">${escapeHtml(tag)}</a>`)
    .join('');
}

function rightPanel(posts, toc = '') {
  const recent = posts.slice(0, 3)
    .map(post => `<a href="${post.url}">${escapeHtml(post.title)}</a>`)
    .join('');
  const tags = tagCloud(posts) || '<span>No tags yet</span>';
  return `${toc}
      <section class="panel-card">
        <h2>Recently Updated</h2>
        ${recent}
      </section>
      <section class="panel-card">
        <h2>Project Index</h2>
        <a href="/projects/">View all projects</a>
      </section>
      <section class="panel-card">
        <h2>Trending Tags</h2>
        <div class="tag-cloud">${tags}</div>
      </section>`;
}

function layout({ title, description, active = 'home', content, posts = [], toc = '', type = 'website', url = '/' }) {
  const year = new Date().getFullYear();
  const fullUrl = new URL(url, siteUrl).toString();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeHtml(description)}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="${type}">
  <meta property="og:url" content="${fullUrl}">
  <meta name="twitter:card" content="summary">
  <title>${escapeHtml(title)}</title>
  <link rel="alternate" type="application/rss+xml" title="N0ZoM1z0" href="/feed.xml">
  <link rel="stylesheet" href="/assets/css/chirpy-like.css">
</head>
<body>
  <div class="spinner-gate" role="dialog" aria-modal="true" aria-label="Spin to unlock the page">
    <div class="spinner-stage">
      <div class="spinner-approach"></div>
      <div class="spinner-disc">
        <div class="spinner-orbit-dot"></div>
        <div class="spinner-crosshair"></div>
      </div>
      <div class="spinner-copy">
        <p class="spinner-kicker">SPIN TO REVEAL</p>
        <p class="spinner-count"><span id="spinner-progress">0</span>%</p>
        <p class="spinner-hint">Trace the circle. Wake the page.</p>
      </div>
    </div>
    <button class="spinner-skip" type="button">skip ritual</button>
  </div>

  <button class="theme-toggle" type="button" aria-label="Toggle day and night mode" title="Toggle day/night">
    <span class="theme-toggle-track">
      <span class="theme-toggle-orb"></span>
    </span>
    <span class="theme-toggle-label">Day</span>
  </button>

  <aside class="site-sidebar">
    <div class="brand" aria-label="Site identity">
      <img class="avatar" src="/assets/img/avatar.jpg" alt="N0ZoM1z0 avatar">
      <span class="brand-title">N0ZoM1z0</span>
      <span class="brand-subtitle">Code. Break. Learn. Rise.</span>
    </div>
    <div class="profile-links" aria-label="Profile links">
      <a href="https://github.com/N0zoM1z0" target="_blank" rel="noreferrer" title="GitHub" aria-label="GitHub">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.03c-3.34.73-4.04-1.42-4.04-1.42-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.92 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6.01 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.6-2.8 5.61-5.48 5.91.43.37.81 1.1.81 2.22v3.29c0 .32.22.69.83.57A12 12 0 0 0 12 .5Z"/></svg>
      </a>
      <a href="https://x.com/r00tth3w0r1d" target="_blank" rel="noreferrer" title="X" aria-label="X">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.9 2h3.3l-7.2 8.24L23.5 22h-6.65l-5.2-6.8L5.7 22H2.4l7.7-8.8L2 2h6.82l4.7 6.22L18.9 2Zm-1.16 17.93h1.83L7.82 3.96H5.86l11.88 15.97Z"/></svg>
      </a>
      <a href="mailto:r00tth3w0r1d@gmail.com" title="Email" aria-label="Email">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 5h17A2.5 2.5 0 0 1 23 7.5v9A2.5 2.5 0 0 1 20.5 19h-17A2.5 2.5 0 0 1 1 16.5v-9A2.5 2.5 0 0 1 3.5 5Zm0 2a.5.5 0 0 0-.5.5v.42l9 5.4 9-5.4V7.5a.5.5 0 0 0-.5-.5h-17Zm17 10a.5.5 0 0 0 .5-.5V10.25l-8.49 5.1a1 1 0 0 1-1.02 0L3 10.25v6.25a.5.5 0 0 0 .5.5h17Z"/></svg>
      </a>
    </div>
    <nav class="site-nav" aria-label="Primary">
      <a class="${active === 'home' ? 'active' : ''}" href="/">Home</a>
      <a class="${active === 'posts' ? 'active' : ''}" href="/posts/">Posts</a>
      <a class="${active === 'archive' ? 'active' : ''}" href="/archive/">Archive</a>
      <a class="${active === 'categories' ? 'active' : ''}" href="/categories/">Categories</a>
      <a class="${active === 'tags' ? 'active' : ''}" href="/tags/">Tags</a>
      <a class="${active === 'projects' ? 'active' : ''}" href="/projects/">Projects</a>
      <a class="${active === 'about' ? 'active' : ''}" href="/about/">About</a>
      <a class="${active === 'search' ? 'active' : ''}" href="/search/">Search</a>
    </nav>
    <div class="sidebar-footer">
      <span>© ${year}</span>
      <span>Powered by caffeine and broken assumptions.</span>
    </div>
  </aside>

  <header class="mobile-header">
    <a href="/">N0ZoM1z0</a>
    <span>Code. Break. Learn. Rise.</span>
  </header>

  <main class="page-shell">
    <section class="content-pane">
      ${content}
    </section>
    <aside class="right-panel">
      ${rightPanel(posts, toc)}
    </aside>
  </main>

  <footer class="site-footer">
    <div class="site-stats">
      <span>PV <strong id="busuanzi_value_site_pv">--</strong></span>
      <span>UV <strong id="busuanzi_value_site_uv">--</strong></span>
    </div>
  </footer>

  <button class="back-to-top" type="button" aria-label="Back to top" title="Back to top">
    <span class="cat-ear left"></span>
    <span class="cat-ear right"></span>
    <span class="cat-face">↑</span>
  </button>

  <script>
    const root = document.documentElement;
    const themeToggle = document.querySelector('.theme-toggle');
    const themeLabel = document.querySelector('.theme-toggle-label');
    const preferredTheme = localStorage.getItem('theme') || 'day';
    const applyTheme = theme => {
      root.dataset.theme = theme;
      themeLabel.textContent = theme === 'night' ? 'Night' : 'Day';
      localStorage.setItem('theme', theme);
    };
    applyTheme(preferredTheme);
    themeToggle.addEventListener('click', () => {
      applyTheme(root.dataset.theme === 'night' ? 'day' : 'night');
    });

    const spinnerGate = document.querySelector('.spinner-gate');
    const spinnerDisc = document.querySelector('.spinner-disc');
    const spinnerApproach = document.querySelector('.spinner-approach');
    const spinnerProgress = document.querySelector('#spinner-progress');
    const spinnerSkip = document.querySelector('.spinner-skip');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const unlockPage = (skipped = false) => {
      document.body.classList.remove('spinner-locked');
      document.body.style.setProperty('--unlock-progress', 1);
      localStorage.setItem('intro:spinner', 'unlocked');
      if (skipped) {
        document.body.classList.add('spinner-unlocked');
        spinnerGate.remove();
        return;
      }
      document.body.classList.add('spinner-burst');
      window.setTimeout(() => {
        document.body.classList.remove('spinner-burst');
        document.body.classList.add('spinner-unlocked');
        spinnerGate.remove();
      }, 720);
    };
    if (localStorage.getItem('intro:spinner') === 'unlocked' || reduceMotion) {
      document.body.classList.add('spinner-skip');
      spinnerGate.remove();
    } else {
      document.body.classList.add('spinner-locked');
      let lastAngle = null;
      let spin = 0;
      const targetSpin = Math.PI * 2 * 5.5;
      const updateSpinner = event => {
        const rect = spinnerDisc.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const angle = Math.atan2(event.clientY - cy, event.clientX - cx);
        if (lastAngle !== null) {
          let delta = angle - lastAngle;
          if (delta > Math.PI) delta -= Math.PI * 2;
          if (delta < -Math.PI) delta += Math.PI * 2;
          spin += Math.abs(delta);
          const progress = Math.min(spin / targetSpin, 1);
          document.body.style.setProperty('--unlock-progress', progress.toFixed(3));
          spinnerDisc.style.rotate = (spin * 28) + 'deg';
          spinnerApproach.style.scale = 1.08 - progress * 0.42;
          spinnerProgress.textContent = Math.floor(progress * 100);
          if (progress >= 1) unlockPage();
        }
        lastAngle = angle;
      };
      const resetAngle = () => {
        lastAngle = null;
      };
      spinnerGate.addEventListener('pointermove', updateSpinner);
      spinnerGate.addEventListener('pointerleave', resetAngle);
      spinnerGate.addEventListener('pointercancel', resetAngle);
      spinnerSkip.addEventListener('click', () => unlockPage(true));
    }
  </script>

  <script>
    document.querySelectorAll('.markdown-body pre').forEach(pre => {
      const button = document.createElement('button');
      button.className = 'code-copy';
      button.type = 'button';
      button.textContent = 'copy';
      button.addEventListener('click', async () => {
        await navigator.clipboard.writeText(pre.innerText);
        button.textContent = 'copied';
        window.setTimeout(() => { button.textContent = 'copy'; }, 1200);
      });
      pre.appendChild(button);
    });

    document.querySelectorAll('.heading-anchor').forEach(anchor => {
      anchor.addEventListener('click', async event => {
        event.preventDefault();
        const url = location.origin + location.pathname + anchor.getAttribute('href');
        history.replaceState(null, '', anchor.getAttribute('href'));
        await navigator.clipboard.writeText(url);
        anchor.dataset.copied = 'true';
        window.setTimeout(() => { delete anchor.dataset.copied; }, 1100);
      });
    });

    const tocLinks = [...document.querySelectorAll('.toc a')];
    const tocTargets = tocLinks.map(link => document.querySelector(link.getAttribute('href'))).filter(Boolean);
    if (tocLinks.length && 'IntersectionObserver' in window) {
      const observer = new IntersectionObserver(entries => {
        const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!visible) return;
        tocLinks.forEach(link => link.classList.toggle('active', link.getAttribute('href') === '#' + visible.target.id));
      }, { rootMargin: '-15% 0px -70% 0px', threshold: [0, 1] });
      tocTargets.forEach(target => observer.observe(target));
    }
  </script>

  <script>
    if (window.matchMedia('(min-width: 768px) and (prefers-reduced-motion: no-preference)').matches) {
      const cursorEffect = document.createElement('script');
      cursorEffect.async = true;
      cursorEffect.src = '/assets/js/cursor/fireworks.js';
      document.body.appendChild(cursorEffect);
    }
  </script>
  <script src="/assets/live2dw/lib/L2Dwidget.min.js"></script>
  <script>
    L2Dwidget.init({
      pluginRootPath: '/assets/live2dw/',
      pluginJsPath: 'lib/',
      pluginModelPath: 'assets/',
      tagMode: false,
      log: false,
      model: { jsonPath: '/assets/live2dw/assets/z16.model.json' },
      display: { position: 'right', width: 160, height: 256, hOffset: 24, vOffset: -20 },
      mobile: { show: false }
    });
  </script>
  <script>
    const backToTop = document.querySelector('.back-to-top');
    const toggleBackToTop = () => {
      backToTop.classList.toggle('is-visible', window.scrollY > 420);
    };
    window.addEventListener('scroll', toggleBackToTop, { passive: true });
    backToTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    toggleBackToTop();
  </script>
  <script async src="//busuanzi.ibruce.info/busuanzi/2.3/busuanzi.pure.mini.js"></script>
</body>
</html>`;
}

function postCard(post) {
  const categoryLinks = post.categories
    .map(category => `<a href="/categories/#category-${slugify(category)}">${escapeHtml(category)}</a>`)
    .join('');
  return `<article class="post-card">
        <a class="post-card-title" href="${post.url}">${escapeHtml(post.title)}</a>
        <p>${escapeHtml(post.excerpt)}</p>
        <div class="post-card-meta">
          <time datetime="${escapeHtml(post.date)}">${escapeHtml(formatDate(post.date))}</time>
          <span>${post.readingMinutes} min read</span>
          ${categoryLinks}
        </div>
      </article>`;
}

function archivePage(posts) {
  const groups = new Map();
  for (const post of posts) {
    const date = new Date(post.date);
    const year = Number.isNaN(date.getTime()) ? 'Undated' : String(date.getFullYear());
    if (!groups.has(year)) groups.set(year, []);
    groups.get(year).push(post);
  }
  const years = [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  const timeline = years.map(([year, yearPosts]) => `<section class="archive-year">
        <h2>${escapeHtml(year)}</h2>
        <div class="archive-list">
          ${yearPosts.map(post => `<article class="archive-item">
            <time datetime="${escapeHtml(post.date)}">${escapeHtml(formatDate(post.date))}</time>
            <a href="${post.url}">${escapeHtml(post.title)}</a>
            <span>${post.readingMinutes} min read</span>
          </article>`).join('')}
        </div>
      </section>`).join('');
  return layout({
    title: 'Archive | N0ZoM1z0',
    description: 'Chronological archive for N0ZoM1z0 posts.',
    active: 'archive',
    posts,
    url: '/archive/',
    content: `<header class="page-title">
        <p class="eyebrow">Archive</p>
        <h1>Timeline of proofs and mistakes</h1>
      </header>
      <section class="archive-timeline">${timeline}</section>`
  });
}

function indexPage(posts) {
  const latest = posts[0];
  return layout({
    title: 'N0ZoM1z0',
    description: 'Security research notes by N0ZoM1z0',
    posts,
    content: `<header class="page-title">
        <p class="eyebrow">Home</p>
        <h1>Break assumptions. Prove guarantees.</h1>
      </header>
      ${latest ? postCard(latest) : '<p>No posts yet.</p>'}
      <section class="section-block">
        <div class="section-heading">
          <p class="eyebrow">Projects</p>
          <a href="/projects/">View all</a>
        </div>
        <article class="project-card compact">
          <div>
            <h2>oszillator</h2>
            <p>osu!standard-style gameplay running inside a browser tab.</p>
          </div>
          <a class="project-link" href="/projects/">Open</a>
        </article>
      </section>`
  });
}

function postsPage(posts) {
  return layout({
    title: 'Posts | N0ZoM1z0',
    description: 'Posts by N0ZoM1z0.',
    active: 'posts',
    posts,
    url: '/posts/',
    content: `<header class="page-title">
        <p class="eyebrow">Posts</p>
        <h1>Recent notes</h1>
      </header>
      <section class="post-list">${posts.map(postCard).join('')}</section>`
  });
}

function categoriesPage(posts) {
  const groups = groupBy(posts, post => post.categories);
  const cards = groups.map(([category, categoryPosts]) => `<article class="category-card" id="category-${slugify(category)}">
          <div>
            <h2>${escapeHtml(category)}</h2>
            <p>${categoryPosts.length} note${categoryPosts.length === 1 ? '' : 's'} filed here.</p>
          </div>
          <div class="category-links">
            ${categoryPosts.map(post => `<a href="${post.url}">${escapeHtml(post.title)}</a>`).join('')}
          </div>
        </article>`).join('');
  return layout({
    title: 'Categories | N0ZoM1z0',
    description: 'Categories for N0ZoM1z0 posts.',
    active: 'categories',
    posts,
    url: '/categories/',
    content: `<header class="page-title">
        <p class="eyebrow">Categories</p>
        <h1>Filed notes</h1>
      </header>
      <section class="category-list">${cards}</section>`
  });
}

function tagsPage(posts) {
  const groups = groupBy(posts, post => post.tags);
  const sections = groups.map(([tag, tagPosts]) => `<article class="tag-section" id="tag-${slugify(tag)}">
        <h2>#${escapeHtml(tag)}</h2>
        ${tagPosts.map(postCard).join('')}
      </article>`).join('');
  return layout({
    title: 'Tags | N0ZoM1z0',
    description: 'Tags for N0ZoM1z0 posts.',
    active: 'tags',
    posts,
    url: '/tags/',
    content: `<header class="page-title">
        <p class="eyebrow">Tags</p>
        <h1>Find notes by signal</h1>
      </header>
      <section class="tag-index">${sections}</section>`
  });
}

function projectsPage(posts) {
  return layout({
    title: 'Projects | N0ZoM1z0',
    description: 'Project index for N0ZoM1z0.',
    active: 'projects',
    posts,
    url: '/projects/',
    content: `<header class="page-title">
        <p class="eyebrow">Projects</p>
        <h1>Things I built</h1>
      </header>
      <section class="project-grid">
        <article class="project-card">
          <div class="project-kicker">Browser rhythm experiment</div>
          <h2>oszillator</h2>
          <p>An unofficial osu!standard-style browser player focused on local .osz import, Web Audio timing, Pixi rendering, autoplay, sliders, mods, and readable gameplay feedback.</p>
          <div class="project-actions">
            <a href="https://n0zom1z0.github.io/oszillator/" target="_blank" rel="noreferrer">Live demo</a>
            <a href="https://github.com/N0zoM1z0/oszillator" target="_blank" rel="noreferrer">Source</a>
            <a href="/posts/osu-in-browser/">Write-up</a>
          </div>
        </article>
      </section>`
  });
}

function aboutPage(posts) {
  return layout({
    title: 'About | N0ZoM1z0',
    description: 'About N0ZoM1z0.',
    active: 'about',
    posts,
    url: '/about/',
    content: `<article class="post-article">
        <header class="post-hero">
          <p class="eyebrow">About</p>
          <h1>N0ZoM1z0</h1>
          <div class="post-meta-line">
            <span>Code. Break. Learn. Rise.</span>
          </div>
        </header>
        <div class="markdown-body">
          <p>TouHou University. Learning to break assumptions and prove guarantees.</p>
          <p>ZK &amp; FV enthusiast. Security researcher in the making.</p>
          <p>Reach me at <a href="mailto:r00tth3w0r1d@gmail.com">r00tth3w0r1d@gmail.com</a>.</p>
        </div>
      </article>`
  });
}

function searchPage(posts) {
  return layout({
    title: 'Search | N0ZoM1z0',
    description: 'Search N0ZoM1z0 posts.',
    active: 'search',
    posts,
    url: '/search/',
    content: `<header class="page-title">
        <p class="eyebrow">Search</p>
        <h1>grep the notebook</h1>
      </header>
      <section class="search-box">
        <label for="site-search">Query</label>
        <input id="site-search" class="search-input" type="search" placeholder="try: osu, browser, Web Audio, assumptions" autocomplete="off">
        <p class="search-help">Client-side search. No backend, no drama.</p>
      </section>
      <section id="search-results" class="search-results" aria-live="polite"></section>
      <script>
        const input = document.querySelector('#site-search');
        const results = document.querySelector('#search-results');
        const htmlEscape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
        const renderResult = post => '<article class="search-result"><a href="' + htmlEscape(post.url) + '">' + htmlEscape(post.title) + '</a><p>' + htmlEscape(post.excerpt) + '</p><span>' + htmlEscape(post.categories.join(' / ')) + '</span></article>';
        fetch('/search.json')
          .then(response => response.json())
          .then(index => {
            const render = () => {
              const query = input.value.trim().toLowerCase();
              if (!query) {
                results.innerHTML = '<p class="empty-state">Type something to search posts.</p>';
                return;
              }
              const hits = index.filter(post => [post.title, post.excerpt, post.content, post.categories.join(' '), post.tags.join(' ')].join(' ').toLowerCase().includes(query));
              results.innerHTML = hits.length ? hits.map(renderResult).join('') : '<p class="empty-state">No matching notes.</p>';
            };
            input.addEventListener('input', render);
            render();
          });
      </script>`
  });
}

function relatedPosts(post, posts) {
  return posts
    .filter(candidate => candidate.slug !== post.slug)
    .map(candidate => {
      const tagScore = candidate.tags.filter(tag => post.tags.includes(tag)).length * 3;
      const categoryScore = candidate.categories.filter(category => post.categories.includes(category)).length * 2;
      return { post: candidate, score: tagScore + categoryScore };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || new Date(b.post.date) - new Date(a.post.date))
    .slice(0, 3)
    .map(item => item.post);
}

function relatedBlock(post, posts) {
  const related = relatedPosts(post, posts);
  return `<section class="related-posts">
        <div class="section-heading">
          <p class="eyebrow">Related</p>
          <a href="/tags/">More signals</a>
        </div>
        <div class="related-grid">
          ${related.length ? related.map(item => `<article class="related-card">
            <a href="${item.url}">${escapeHtml(item.title)}</a>
            <span>${escapeHtml(formatDate(item.date))} · ${item.readingMinutes} min read</span>
          </article>`).join('') : '<p class="empty-state">No neighboring proof paths yet. Future notes with shared tags will appear here.</p>'}
        </div>
      </section>`;
}

function postPage(post, posts) {
  const categories = post.categories
    .map(category => `<a href="/categories/#category-${slugify(category)}">${escapeHtml(category)}</a>`)
    .join('');
  const tags = post.tags
    .map(tag => `<a href="/tags/#tag-${slugify(tag)}">#${escapeHtml(tag)}</a>`)
    .join('');
  return layout({
    title: `${post.title} | N0ZoM1z0`,
    description: post.excerpt,
    active: 'posts',
    posts,
    toc: tocFromMarkdown(post.markdown),
    type: 'article',
    url: post.url,
    content: `<article class="post-article">
        <header class="post-hero">
          <p class="eyebrow">${post.project ? 'Project Write-up' : 'Post'}</p>
          <h1>${escapeHtml(post.title)}</h1>
          <div class="post-meta-line">
            <time datetime="${escapeHtml(post.date)}">${escapeHtml(formatDate(post.date))}</time>
            <span>${post.readingMinutes} min read</span>
            ${categories}
            <span><strong id="busuanzi_value_page_pv">--</strong> views</span>
          </div>
          <div class="post-tags-inline">${tags}</div>
        </header>
        <div class="markdown-body">${renderMarkdown(post.markdown)}</div>
        ${relatedBlock(post, posts)}
      </article>`
  });
}

function notFoundPage(posts) {
  return layout({
    title: '404 | Constraint Not Satisfied',
    description: 'The requested proof path does not exist.',
    posts,
    url: '/404.html',
    content: `<article class="not-found-card">
        <p class="eyebrow">404</p>
        <h1>Constraint system not satisfied.</h1>
        <p>The witness was missing, the selector pointed nowhere, and the verifier rejected this route.</p>
        <div class="zk-proof-box" aria-label="404 proof sketch">
          <code>∀ route ∈ Blog, verify(path) = 1</code>
          <code>current_path ∉ Blog</code>
          <code>∴ proof rejected: unsatisfied constraint</code>
        </div>
        <div class="not-found-actions">
          <a href="/">Return home</a>
          <a href="/archive/">Check archive</a>
          <a href="/search/">Search notes</a>
        </div>
      </article>`
  });
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFeed(posts) {
  const items = posts.map(post => `<item>
    <title>${escapeHtml(post.title)}</title>
    <link>${siteUrl}${post.url}</link>
    <guid>${siteUrl}${post.url}</guid>
    <pubDate>${new Date(post.date).toUTCString()}</pubDate>
    <description>${escapeHtml(post.excerpt)}</description>
  </item>`).join('\n');
  fs.writeFileSync(path.join(outDir, 'feed.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>N0ZoM1z0</title>
  <link>${siteUrl}</link>
  <description>Security research notes by N0ZoM1z0</description>
  ${items}
</channel>
</rss>
`);
}

function writeSitemap(posts) {
  const urls = ['/', '/posts/', '/archive/', '/categories/', '/tags/', '/projects/', '/about/', '/search/', '/404.html', ...posts.map(post => post.url)];
  fs.writeFileSync(path.join(outDir, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(url => `  <url><loc>${siteUrl}${url}</loc></url>`).join('\n')}
</urlset>
`);
}

function main() {
  const posts = readPosts();
  fs.rmSync(outDir, { recursive: true, force: true });
  ensureDir(outDir);
  fs.cpSync(path.join(root, 'assets'), path.join(outDir, 'assets'), { recursive: true });

  const routes = [
    ['', indexPage(posts)],
    ['posts', postsPage(posts)],
    ['archive', archivePage(posts)],
    ['categories', categoriesPage(posts)],
    ['tags', tagsPage(posts)],
    ['projects', projectsPage(posts)],
    ['about', aboutPage(posts)],
    ['search', searchPage(posts)]
  ];

  for (const [route, html] of routes) {
    const dir = path.join(outDir, route);
    ensureDir(dir);
    fs.writeFileSync(path.join(dir, 'index.html'), html);
  }

  for (const post of posts) {
    const dir = path.join(outDir, 'posts', post.slug);
    ensureDir(dir);
    fs.writeFileSync(path.join(dir, 'index.html'), postPage(post, posts));
  }

  fs.writeFileSync(path.join(outDir, '404.html'), notFoundPage(posts));

  writeJson(path.join(outDir, 'search.json'), posts.map(post => ({
    title: post.title,
    url: post.url,
    date: post.date,
    excerpt: post.excerpt,
    readingMinutes: post.readingMinutes,
    categories: post.categories,
    tags: post.tags,
    content: post.searchable
  })));
  writeFeed(posts);
  writeSitemap(posts);
}

main();
