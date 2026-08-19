// Page inventory shared by all specs. Both v3 and v4 have identical page
// structure, so the same list drives tests against both projects.

const HOME_PAGE = { name: 'home', path: '/' };

const SUB_PAGES = [
  { name: 'bang-gia', path: '/bang-gia/' },
  { name: 'gioi-thieu', path: '/gioi-thieu/' },
  { name: 'cam-nang-10-diem-check-in', path: '/cam-nang/10-diem-check-in/' },
  { name: 'cam-nang-am-thuc-gia-nghia', path: '/cam-nang/am-thuc-gia-nghia/' },
  { name: 'cam-nang-du-lich-gia-nghia', path: '/cam-nang/du-lich-gia-nghia/' },
];

const ALL_PAGES = [HOME_PAGE, ...SUB_PAGES];

module.exports = { HOME_PAGE, SUB_PAGES, ALL_PAGES };
