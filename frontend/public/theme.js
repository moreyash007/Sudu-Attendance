// Light/dark choice: saved per browser, defaults to the system setting. Loaded in <head> to avoid a flash.
(function () {
  const key = 'sudu_theme';
  let theme = null;
  try { theme = localStorage.getItem(key); } catch (e) {}
  if (theme !== 'light' && theme !== 'dark') {
    theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.dataset.theme = theme;
  window.toggleTheme = function () {
    theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(key, theme); } catch (e) {}
    window.dispatchEvent(new Event('themechange'));
  };
})();
