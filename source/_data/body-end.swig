{# 鼠标点击特效 #}
{% if theme.cursor_effect == "fireworks" %}
  <script>
    if (window.matchMedia('(min-width: 768px) and (prefers-reduced-motion: no-preference)').matches) {
      var cursorEffect = document.createElement('script');
      cursorEffect.async = true;
      cursorEffect.src = '/js/cursor/fireworks.js';
      document.body.appendChild(cursorEffect);
    }
  </script>
{% elseif theme.cursor_effect == "explosion" %}
  <canvas class="fireworks" style="position: fixed;left: 0;top: 0;z-index: 1; pointer-events: none;" ></canvas>
  <script src="//cdn.bootcss.com/animejs/2.2.0/anime.js"></script>
  <script async src="/js/cursor/explosion.js"></script>
{% elseif theme.cursor_effect == "love" %}
  <script async src="/blog/js/cursor/love.js"></script>
{% elseif theme.cursor_effect == "text" %}
  <script async src="/blog/js/cursor/text.js"></script>
{% endif %}

{% if theme.snow2.enabled %}
  <script defer src="/js/snow2.js"></script>
{% endif %}

