---
name: deploy-local
description: Build TylerTube and deploy it to the local Nginx (production on this Mac), then smoke-test it.
disable-model-invocation: true
---

Run on the Mac (macOS, Homebrew Nginx). Stop and report on the first failure.

1. `git status --short`: tell the user if there are uncommitted changes being deployed.
2. `npm run build`: must succeed. Check that `dist/index.html`, `dist/jsmpeg.min.js` and the favicons exist.
3. If `nginx.conf` changed: `cp nginx.conf /opt/homebrew/etc/nginx/nginx.conf`.
4. `nginx -t && brew services restart nginx`
5. Drive mode needs the Vite server: check `lsof -iTCP:5173 -sTCP:LISTEN`. If nothing is
   listening, tell the user to run `npm run dev` (don't leave it running in the background
   yourself unless asked).
6. Smoke test:
   - `curl -sI http://localhost:8080/ | head -1` → `200`
   - `curl -sI "http://localhost:8080/videos/<some file>" -H "Range: bytes=0-1" | head -1` → `206`
     (pick a file with `ls public/videos | head`; do not recurse into it)
   - `grep -o 'v[0-9.]* (build [^)]*)' dist/assets/*.js | head -1`: report the deployed version.
7. Report: version, build result, Nginx status, whether Drive mode is available (dev server up).
