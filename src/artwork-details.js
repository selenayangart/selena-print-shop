(function () {
  var dialog = document.createElement('dialog');
  dialog.className = 'artwork-dialog';
  dialog.setAttribute('aria-labelledby', 'artwork-dialog-title');
  dialog.innerHTML = '<button class="artwork-dialog-close" type="button" aria-label="Close artwork details"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button><div class="artwork-dialog-content"><img class="artwork-dialog-image" alt=""><div><h2 id="artwork-dialog-title"></h2><p class="artwork-dialog-meta"></p><p class="artwork-dialog-description"></p></div></div>';
  document.body.appendChild(dialog);
  var returnFocus = null;
  dialog.querySelector('button').addEventListener('click', function () { dialog.close(); });
  dialog.addEventListener('click', function (event) {
    if (event.target !== dialog) return;
    var rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  dialog.addEventListener('close', function () {
    document.body.classList.remove('no-scroll');
    if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
  });
  window.ArtworkDetails = {
    open: function (index, trigger) {
      var work = (window.WORKS || [])[index];
      if (!work) return;
      returnFocus = trigger || document.activeElement;
      var image = dialog.querySelector('img');
      image.src = work.imagePath;
      image.alt = work.title;
      dialog.querySelector('h2').textContent = work.title;
      dialog.querySelector('.artwork-dialog-meta').textContent = [work.year, work.medium, work.dimensions, work.collection].filter(Boolean).join(' · ');
      dialog.querySelector('.artwork-dialog-description').textContent = work.seoDescription || (typeof work.description === 'string' ? work.description : '');
      document.body.classList.add('no-scroll');
      if (!dialog.open) dialog.showModal();
    }
  };
})();
