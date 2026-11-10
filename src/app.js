/* Shared print shop and viewing room above Explore in 3D. */
(function () {
  var viewer = document.querySelector('.explore-room-viewer');
  var panel = document.querySelector('.explore-room-panel');
  var controls = document.querySelector('.explore-room-controls');
  if (!viewer || !panel || !controls || !window.RoomView || !window.RoomView.create) return;

  var room = window.RoomView.create({ mode: 'standalone' });
  room.mount(viewer, panel, controls);
  var requestedSlug = new URLSearchParams(window.location.search).get('room-art');
  var requestedIndex = (window.WORKS || []).findIndex(function (work) { return work.slug === requestedSlug; });
  room.show(requestedIndex >= 0 ? requestedIndex : 0);
  window.LandingRoomView = room;
  var status = document.getElementById('checkout-status');
  if (window.SITE && window.SITE.checkoutEnabled === true) status.textContent = 'Shopify checkout';
  document.addEventListener('click', function (event) {
    var link = event.target.closest('.room-view-details');
    if (!link) return;
    event.preventDefault();
    window.ArtworkDetails.open(Number(link.dataset.workIndex), link);
  });

  if (window.location.hash === '#viewing-room') {
    requestAnimationFrame(function () {
      var section = document.getElementById('viewing-room');
      if (section) section.scrollIntoView({ block: 'start' });
    });
  }
})();
