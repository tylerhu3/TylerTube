---
name: add-page
description: Add a new top-level page (like History or Favorites) to TylerTube, wired into the side menu, mobile bottom nav and page switch.
---

Pages are switched by the `currentPage` string in `src/App.jsx` (no router).

1. Create `src/components/<Name>Page.jsx`. Start from `HistoryPage.jsx` or `FavoritesPage.jsx`
   (closest match), and reuse their layout classes and empty-state card. Accept
   `onNavigateHome` and whatever data it needs as props.
2. `src/App.jsx`:
   - import the component;
   - render it in the page switch: `{currentPage === "<name>" && (<NamePage ... />)}`,
     next to the History/Favorites blocks;
   - add a button to `<nav className="mobile-bottom-nav">` mirroring the existing items.
3. `src/components/SideMenu.jsx`: add a `side-menu-item` button that calls `onNavigate("<name>")`
   with the `active` class when `currentPage === "<name>"`, like History/Favorites.
4. `src/styles.css`: add a `/* <Name> Page */` section after the Favorites section, plus any
   overrides in the "Subpages (History & Favorites) in Mobile Mode" section.
   Use theme variables (`--accent`, etc.), not hard-coded colors.
5. Note: when a video is selected while not on `home` and the side player is off, App navigates
   back to `home` (see `handleSelectVideo`). Pass it as `onSelectVideo` if the page lists videos.
6. Verify: `npm run build`; open the page from the side menu and from the mobile bottom nav,
   in desktop and mobile view mode, light and dark theme.
