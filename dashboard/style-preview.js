(function () {
  'use strict';

  const style = new URLSearchParams(window.location.search).get('style');
  if (style !== 'editorial' && style !== 'studio') return;

  const names = {
    editorial: 'Community report',
    studio: 'Insights studio'
  };

  const bar = document.createElement('aside');
  bar.className = 'style-preview-bar';
  bar.setAttribute('aria-label', 'Style preview controls');

  const label = document.createElement('p');
  label.innerHTML = '<span>Previewing</span><strong>' + names[style] + '</strong>';

  const navigation = document.createElement('nav');
  navigation.setAttribute('aria-label', 'Compare dashboard styles');

  [
    { href: 'index.html?style=editorial', label: 'Community report', key: 'editorial' },
    { href: 'index.html?style=studio', label: 'Insights studio', key: 'studio' },
    { href: 'index.html', label: 'Current style', key: 'current' }
  ].forEach(function (item) {
    const link = document.createElement('a');
    link.href = item.href + window.location.hash;
    link.textContent = item.label;
    if (item.key === style) link.setAttribute('aria-current', 'page');
    navigation.appendChild(link);
  });

  const close = document.createElement('a');
  close.className = 'style-preview-close';
  close.href = 'style-drafts.html';
  close.textContent = 'All drafts';

  bar.append(label, navigation, close);
  document.body.prepend(bar);
})();

