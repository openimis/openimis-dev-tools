// Pages the workflow specs open, by the label of their menu entry. Specs reach
// them by URL: the menu layout is configuration (fe-core "menus", pinned from the
// release server in uat/module-config.pinned.json) and groups entries differently
// from the default menu, so following labels would tie every workflow to one layout.
export const ROUTES = {
  'Health Facility Claims': '/front/claim/healthFacilities',
  Reviews: '/front/claim/reviews',
  Insurees: '/front/insuree/insurees',
  'Families/Group': '/front/insuree/families',
  'Families/Groups': '/front/insuree/families',
  Products: '/front/admin/products',
};

export function routeFor(submenu) {
  if (typeof submenu === 'string' && submenu.startsWith('/')) return submenu;
  return ROUTES[submenu];
}
