// Legacy visual previews are opt in. Keep their original stylesheet order.
if (document.documentElement.dataset.glassPreview) {
  for (const file of ['glass-preview.css', 'article-glass.css', 'ios26-v2.css', 'ios26-glass.css']) {
    const sheet = document.createElement('link');
    sheet.rel = 'stylesheet';
    sheet.href = '/' + file;
    document.head.append(sheet);
  }
}
