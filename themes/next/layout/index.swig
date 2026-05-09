{% extends '_layout.swig' %}
{% import '_macro/sidebar.swig' as sidebar_template with context %}

{% block title %}{{ title }}{%- if theme.index_with_subtitle and subtitle %} - {{ subtitle }}{%- endif %}{% endblock %}

{% block class %}index posts-expand{% endblock %}

{% block content %}

  <section class="home-hero" aria-label="site introduction">
    <p class="home-hero__eyebrow">security research</p>
    <h2 class="home-hero__title">N0ZoM1z0</h2>
    <p class="home-hero__subtitle">Code audit notes, vulnerability analysis, and practical security writing.</p>
  </section>

  {%- for post in page.posts.toArray() %}
    {{ partial('_macro/post.swig', {post: post, is_index: true}) }}
  {%- endfor %}

  {% include '_partials/pagination.swig' %}

{% endblock %}

{% block sidebar %}
  {{ sidebar_template.render(false) }}
{% endblock %}
