---
name: add-persisted-setting
description: Add a user preference/state that survives reloads via localStorage in TylerTube (e.g. a toggle, view option, player pref).
---

1. In `src/App.jsx`, add a key constant next to the others at the top:
   `const FOO_STORAGE_KEY = "tylertube_foo";`
2. Add state with a lazy initializer and try/catch (copy the `theme` / `viewMode` pattern):
   ```js
   const [foo, setFoo] = useState(() => {
     try { return localStorage.getItem(FOO_STORAGE_KEY) ?? DEFAULT; } catch { return DEFAULT; }
   });
   ```
   For objects use `JSON.parse` inside the try and fall back to the default.
3. Persist in a `useEffect` on `[foo]` (or inside the setter callback, as `watchProgress` does),
   wrapped in try/catch.
4. Pass `foo` / a toggle handler as props to the component that shows the control
   (usually `Navbar.jsx` or `SideMenu.jsx`). Add a keyboard shortcut only if asked
   (shortcuts live in the `keydown` effect in `App.jsx`).
5. Style the control with existing classes and theme variables; check desktop and mobile view mode.
6. Never rename an existing key without a one-time migration (see `tylertube_theme_migrated_v2`).
7. Verify: `npm run build`, then reload the app and confirm the value survives a refresh.
