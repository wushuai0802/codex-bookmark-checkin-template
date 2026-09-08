(() => {
  const key = 'fabricTheme';
  const normalize = value => ['light', 'dark', 'system'].includes(value) ? value : 'system';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try { preference = normalize(window.localStorage.getItem(key)); } catch { /* Private browsing may deny storage. */ }

  function apply() {
    const theme = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    if (document.querySelectorAll) document.querySelectorAll('[data-theme-choice]').forEach(button => {
      const selected = button.dataset.themeChoice === preference;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    const label = document.getElementById('theme-choice-label');
    if (label) label.textContent = { system: '跟随系统', light: '明亮', dark: '暗夜' }[preference];
    const select = document.getElementById('theme-select');
    if (select) select.value = preference;
  }

  // Run before styles load to avoid a light flash when a dark preference is saved.
  apply();
  system.addEventListener('change', apply);
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) {
      preference = normalize(event.newValue);
      apply();
    }
  });
    document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.getElementById('theme-select')?.addEventListener('change', event => {
      preference = normalize(event.target.value);
      try { window.localStorage.setItem(key, preference); } catch { /* Keep the choice for this page. */ }
      apply();
    });
    if (!document.querySelectorAll) return;
    document.querySelectorAll('[data-theme-choice]').forEach(button => button.addEventListener('click', event => {
      preference = normalize(event.currentTarget.dataset.themeChoice);
      try { window.localStorage.setItem(key, preference); } catch { /* Keep the choice for this page. */ }
      apply();
    }));
  });
})();
