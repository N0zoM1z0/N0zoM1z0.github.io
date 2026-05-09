const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, '_site');
const articlePath = '/home/pentester/Github/articles/osu_in_browser.md';
const postDir = path.join(outDir, 'posts', 'osu-in-browser');
const postsDir = path.join(outDir, 'posts');
const projectsDir = path.join(outDir, 'projects');
const categoriesDir = path.join(outDir, 'categories');
const assetGif = '/assets/img/posts/osu-in-browser/makeamove.gif';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readArticle() {
  let markdown = fs.readFileSync(articlePath, 'utf8');
  markdown = markdown.replace(
    /!\[makeamove\]\(https:\/\/img2024\.cnblogs\.com\/blog\/3092507\/202605\/3092507-20260509120257652-1079783289\.gif\)/,
    `![makeamove](${assetGif})`
  );
  return markdown;
}

function makeExcerpt(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*]\([^)]+\)/g, '')
    .replace(/\[[^\]]+]\(([^)]+)\)/g, '$1')
    .replace(/[#>*_`-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 230);
}

function layout({ title, description, active = 'home', content, toc = '' }) {
  const year = new Date().getFullYear();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${description}">
  <title>${title}</title>
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
        <p class="spinner-kicker">SPIN TO UNLOCK</p>
        <p class="spinner-count"><span id="spinner-progress">0</span>%</p>
        <p class="spinner-hint">circle around the spinner</p>
      </div>
    </div>
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
      <a class="${active === 'categories' ? 'active' : ''}" href="/categories/">Categories</a>
      <a class="${active === 'projects' ? 'active' : ''}" href="/projects/">Projects</a>
      <a class="${active === 'about' ? 'active' : ''}" href="/about/">About</a>
    </nav>
    <div class="sidebar-footer">
      <div class="site-stats">
        <span>PV <strong id="busuanzi_value_site_pv">--</strong></span>
        <span>UV <strong id="busuanzi_value_site_uv">--</strong></span>
      </div>
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
      ${toc}
      <section class="panel-card">
        <h2>Recently Updated</h2>
        <a href="/posts/osu-in-browser/">osu! in browser: oszillator</a>
      </section>
      <section class="panel-card">
        <h2>Project Index</h2>
        <a href="/projects/">View all projects</a>
      </section>
      <section class="panel-card">
        <h2>Trending Tags</h2>
        <div class="tag-cloud">
          <span>osu</span>
          <span>browser</span>
          <span>webgl</span>
          <span>security</span>
        </div>
      </section>
    </aside>
  </main>

  <button class="back-to-top" type="button" aria-label="Back to top" title="Back to top">
    <span class="cat-ear left"></span>
    <span class="cat-ear right"></span>
    <span class="cat-face">↑</span>
  </button>

  <script>
    const root = document.documentElement;
    const themeToggle = document.querySelector('.theme-toggle');
    const themeLabel = document.querySelector('.theme-toggle-label');
    const preferredTheme = localStorage.getItem('theme') ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'day');
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
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const unlockPage = () => {
      document.body.classList.remove('spinner-locked');
      document.body.classList.add('spinner-unlocked');
      document.body.style.setProperty('--unlock-progress', 1);
      sessionStorage.setItem('intro:spinner', 'unlocked');
      window.setTimeout(() => spinnerGate.remove(), 420);
    };
    if (sessionStorage.getItem('intro:spinner') === 'unlocked' || reduceMotion) {
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

function postsPage(excerpt) {
  return layout({
    title: 'Posts | N0ZoM1z0',
    description: 'Posts by N0ZoM1z0.',
    active: 'posts',
    content: `<header class="page-title">
        <p class="eyebrow">Posts</p>
        <h1>Recent notes</h1>
      </header>
      <article class="post-card">
        <a class="post-card-title" href="/posts/osu-in-browser/">Welcome to osu! in a browser</a>
        <p>${excerpt}...</p>
        <div class="post-card-meta">
          <time datetime="2026-05-09">May 9, 2026</time>
          <a href="/categories/#web-experiments">Web Experiments</a>
          <a href="/categories/#projects">Projects</a>
        </div>
      </article>`
  });
}

function indexPage(excerpt) {
  return layout({
    title: 'N0ZoM1z0',
    description: 'Security research notes by N0ZoM1z0',
    content: `<header class="page-title">
        <p class="eyebrow">Home</p>
        <h1>Break assumptions. Prove guarantees.</h1>
      </header>
      <article class="post-card">
        <a class="post-card-title" href="/posts/osu-in-browser/">Welcome to osu! in a browser</a>
        <p>${excerpt}...</p>
        <div class="post-card-meta">
          <time datetime="2026-05-09">May 9, 2026</time>
          <a href="/categories/#web-experiments">Web Experiments</a>
          <a href="/categories/#projects">Projects</a>
        </div>
      </article>
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

function categoriesPage() {
  return layout({
    title: 'Categories | N0ZoM1z0',
    description: 'Categories for N0ZoM1z0 posts.',
    active: 'categories',
    content: `<header class="page-title">
        <p class="eyebrow">Categories</p>
        <h1>Filed notes</h1>
      </header>
      <section class="category-list">
        <article class="category-card" id="web-experiments">
          <div>
            <h2>Web Experiments</h2>
            <p>Browser-native builds, interactive demos, and weird client-side ideas.</p>
          </div>
          <a href="/posts/osu-in-browser/">Welcome to osu! in a browser</a>
        </article>
        <article class="category-card" id="projects">
          <div>
            <h2>Projects</h2>
            <p>Build logs and project retrospectives.</p>
          </div>
          <a href="/posts/osu-in-browser/">oszillator write-up</a>
        </article>
      </section>`
  });
}

function projectsPage() {
  return layout({
    title: 'Projects | N0ZoM1z0',
    description: 'Project index for N0ZoM1z0.',
    active: 'projects',
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

function aboutPage() {
  return layout({
    title: 'About | N0ZoM1z0',
    description: 'About N0ZoM1z0.',
    active: 'about',
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

function tocFromMarkdown(markdown) {
  const headings = [...markdown.matchAll(/^##\s+(.+)$/gm)].slice(0, 12);
  if (!headings.length) return '';
  const links = headings.map(([, text]) => {
    const id = text.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
    return `<a href="#${id}">${text}</a>`;
  }).join('');
  return `<section class="panel-card toc"><h2>Contents</h2>${links}</section>`;
}

function postPage(markdown) {
  const renderer = new marked.Renderer();
  renderer.heading = (text, level) => {
    const id = String(text).toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
    return `<h${level} id="${id}">${text}</h${level}>`;
  };
  const html = marked.parse(markdown, { renderer });
  return layout({
    title: 'Welcome to osu! in a browser | N0ZoM1z0',
    description: 'A write-up about oszillator, an osu!standard-style browser experiment.',
    active: 'posts',
    toc: tocFromMarkdown(markdown),
    content: `<article class="post-article">
        <header class="post-hero">
          <p class="eyebrow">Project Write-up</p>
          <h1>Welcome to osu! in a browser</h1>
          <div class="post-meta-line">
            <time datetime="2026-05-09">May 9, 2026</time>
            <a href="/categories/#web-experiments">Web Experiments</a>
            <a href="/categories/#projects">Projects</a>
            <span><strong id="busuanzi_value_page_pv">--</strong> views</span>
          </div>
        </header>
        <div class="markdown-body">${html}</div>
      </article>`
  });
}

function main() {
  const markdown = readArticle();
  fs.rmSync(outDir, { recursive: true, force: true });
  ensureDir(postsDir);
  ensureDir(postDir);
  ensureDir(projectsDir);
  ensureDir(categoriesDir);
  ensureDir(path.join(outDir, 'about'));
  fs.cpSync(path.join(root, 'assets'), path.join(outDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), indexPage(makeExcerpt(markdown)));
  fs.writeFileSync(path.join(postsDir, 'index.html'), postsPage(makeExcerpt(markdown)));
  fs.writeFileSync(path.join(postDir, 'index.html'), postPage(markdown));
  fs.writeFileSync(path.join(projectsDir, 'index.html'), projectsPage());
  fs.writeFileSync(path.join(categoriesDir, 'index.html'), categoriesPage());
  fs.writeFileSync(path.join(outDir, 'about', 'index.html'), aboutPage());
}

main();
