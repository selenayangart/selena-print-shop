(function () {
  var dictionaries = window.TRANSLATIONS || { en: {} };
  var current = 'en';
  function t(key) { return (dictionaries[current] || {})[key] || dictionaries.en[key] || key; }
  function sweep() {
    ['data-i18n', 'data-i18n-aria', 'data-i18n-placeholder'].forEach(function (attribute) {
      document.querySelectorAll('[' + attribute + ']').forEach(function (element) {
        var value = t(element.getAttribute(attribute));
        if (attribute === 'data-i18n') element.textContent = value;
        else element.setAttribute(attribute === 'data-i18n-aria' ? 'aria-label' : 'placeholder', value);
      });
    });
  }
  window.I18N = { t: t, sweep: sweep, lang: function () { return current; } };
  var selector = document.getElementById('language');
  selector.addEventListener('change', function () {
    current = dictionaries[selector.value] ? selector.value : 'en';
    document.documentElement.lang = current;
    sweep();
    document.dispatchEvent(new CustomEvent('langchange', { detail: { lang: current } }));
  });
  sweep();
})();
