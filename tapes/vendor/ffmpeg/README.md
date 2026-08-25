# Vendored @ffmpeg/ffmpeg 0.12.10 (ESM build)

Copied verbatim from `https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/`. MIT licensed.

**Why these are vendored rather than loaded from a CDN:** `classes.js` starts its worker with
`new Worker(new URL("./worker.js", import.meta.url))`. Worker scripts must be **same-origin** —
a browser rule that CORS headers cannot relax — so importing this package straight from unpkg
makes the worker URL cross-origin and the browser refuses to construct it:

> Failed to construct 'Worker': Script at 'https://unpkg.com/…/worker.js' cannot be accessed
> from origin 'https://thiagotvarella.github.io'.

Serving these seven small files from our own origin fixes it. The 31 MB wasm core is still
fetched from the CDN, which is fine: the worker pulls it with a dynamic `import()`, and
cross-origin module imports *are* allowed when CORS permits.

Total here is about 15 KB. To update, re-fetch the same seven files at a new version and
change `CDN` in `../../js/ffmpeg.js` to the matching core version.
