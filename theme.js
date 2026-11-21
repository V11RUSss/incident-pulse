(() => {
  'use strict';
  const KEY = 'incident-pulse-theme';
  let theme = 'dark';
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === 'light' || stored === 'dark') {
      theme = stored;
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      theme = 'light';
    }
  } catch (error) {
    theme = 'dark';
  }
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
})();
