/* Generic sample data. Replace these entries and images with your own work. */
var DEMO_ITEMS = [
  ['Study 01', 2026, '24 x 18 in', 'portrait', 'Collection A', 'Structure', 'A modular study of form and repetition.'],
  ['Study 02', 2025, '36 x 24 in', 'portrait', 'Collection A', 'Structure', 'An arrangement of overlapping shapes.'],
  ['Study 03', 2024, '36 x 48 in', 'landscape', 'Collection A', 'Space', 'A study of open space and balance.'],
  ['Study 04', 2023, '30 x 20 in', 'portrait', 'Collection A', 'Rhythm', 'A series of repeated visual elements.'],
  ['Study 05', 2022, '24 x 18 in', 'portrait', 'Collection A', 'Structure', 'An exploration of scale and proportion.'],
  ['Study 06', 2021, '32 x 24 in', 'portrait', 'Collection A', 'Space', 'A composition of quiet geometric forms.'],
  ['Study 07', 2026, '24 x 18 in', 'portrait', 'Collection B', 'Rhythm', 'A study of movement across a surface.'],
  ['Study 08', 2025, '36 x 24 in', 'portrait', 'Collection B', 'Rhythm', 'A sequence of related shapes.'],
  ['Study 09', 2024, '36 x 48 in', 'landscape', 'Collection B', 'Space', 'A wide composition with contrasting areas.'],
  ['Study 10', 2023, '36 x 48 in', 'landscape', 'Collection B', 'Structure', 'A study of pattern and placement.']
];

window.WORKS = DEMO_ITEMS.map(function (item, index) {
  var portrait = item[3] === 'portrait';
  return {
    title: item[0],
    slug: 'study-' + String(index + 1).padStart(2, '0'),
    year: item[1],
    medium: 'Sample artwork',
    dimensions: item[2],
    orientation: item[3],
    collection: item[4],
    theme: item[5],
    seoDescription: item[6],
    description: item[6],
    semanticProfile: {
      concepts: [item[5].toLowerCase(), 'composition'],
      motifs: [portrait ? 'vertical form' : 'horizontal form', index < 6 ? 'repetition' : 'movement'],
      values: ['exploration'],
      context: [item[4].toLowerCase()]
    },
    imagePath: 'images/art/placeholder-' + item[3] + '.svg',
    prints: [
      { size: portrait ? '18 x 12 in' : '12 x 18 in', price: '$40', variant: '' },
      { size: portrait ? '24 x 16 in' : '16 x 24 in', price: '$60', variant: '' }
    ]
  };
});
