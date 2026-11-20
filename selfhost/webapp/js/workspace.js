(function () {
  const paths = {
    hospital: '<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6Z"/>',
    heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/><path d="M3 12h5l2-4 3 8 2-4h6"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18m-14 4h3m4 0h3"/>',
    spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>',
    dashboard: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m2-16a3 3 0 0 1 0 6m2 10v-3a6 6 0 0 0-2-4"/>',
    chat: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0Z"/><path d="M7 9h9M7 13h6"/>',
    inbox: '<path d="M4 4h16l2 12v4H2v-4L4 4ZM2 16h6l2 3h4l2-3h6M8 8h8M8 11h5"/>',
    phone: '<path d="m5 3 4 1 1 5-3 2a15 15 0 0 0 6 6l2-3 5 1 1 4-3 2C10 22 2 14 3 6Z"/>',
    book: '<path d="M12 5c-3-2-6-2-10-1v15c4-1 7-1 10 1 3-2 6-2 10-1V4c-4-1-7-1-10 1Zm0 0v15"/>',
    upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/>',
    download: '<path d="M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5"/>',
    sheet: '<path d="M14 2H4v20h16V8l-6-6Zm0 0v6h6M7 12h10M7 16h10M11 12v8"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    search: '<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/>',
    arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
    external: '<path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7"/>',
    chevron: '<path d="m8 10 4 4 4-4"/>',
    shield: '<path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4Z"/><path d="m8 12 3 3 5-6"/>',
    logout: '<path d="M9 3H3v18h6m5-14 5 5-5 5m-7-5h12"/>',
    mic: '<rect x="8" y="2" width="8" height="13" rx="4"/><path d="M5 10v2a7 7 0 0 0 14 0v-2m-7 9v3m-4 0h8"/>',
    box: '<path d="m12 2 10 5v10l-10 5-10-5V7l10-5Zm-10 5 10 5 10-5M12 12v10M7 4.5l10 5"/>',
    return: '<path d="M9 4 3 10l6 6M3 10h12a6 6 0 0 1 0 12"/>',
    tools: '<path d="m14 6 4 4 4-4a7 7 0 0 1-9 9l-7 7-4-4 7-7a7 7 0 0 1 9-9l-4 4Z"/>'
  };
  window.renderIcons = function (root) {
    (root || document).querySelectorAll('[data-icon]').forEach(function (el) {
      const p = paths[el.dataset.icon];
      if (p) el.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
    });
  };
  window.renderIcons();
  const date = document.getElementById('todayDate');
  if (date) date.textContent = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  document.querySelectorAll('input,select,textarea').forEach(function (el) {
    if (!el.labels?.length && !el.hasAttribute('aria-label')) el.setAttribute('aria-label', el.placeholder || el.options?.[0]?.text || '输入内容');
  });
  document.querySelectorAll('.panel > table').forEach(function (table) {
    const wrapper = document.createElement('div'); wrapper.className = 'table-scroll'; table.before(wrapper); wrapper.append(table);
  });
})();
