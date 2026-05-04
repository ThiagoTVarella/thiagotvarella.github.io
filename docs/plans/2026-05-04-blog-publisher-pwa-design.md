# Blog Publisher PWA — Design

**Date:** 2026-05-04  
**Goal:** Publish blog posts to ThiagoTVarella.github.io from a Pixel phone, no computer needed.

## Problem

Current workflow requires SSHing into the home computer via Termius and manually editing HTML files. Too much friction to post regularly.

## Solution

A PWA (Progressive Web App) hosted at `thiagotvarella.github.io/admin`. Opened from a home screen shortcut on Android, looks and feels like a native app. Uses the GitHub API to commit new posts directly from the phone.

## Files

```
admin/
  index.html     — the entire PWA (single file)
  manifest.json  — makes Chrome treat it as installable
  icon.png       — home screen icon
```

## User Flow

1. First time: paste GitHub PAT into setup screen → saved to localStorage
2. Every time: open app, fill Title + Body, tap Publish
3. App pushes to GitHub, post is live within ~30 seconds

## GitHub API Mechanics

On Publish, three sequential API calls:

1. **GET** `blog/footerblog.html` — read current archive, determine next post number
2. **PUT** `blog/N.html` — create new post using existing HTML template
3. **PUT** `blog/footerblog.html` — append new `<li>` to archive list

Two commits per publish (one per file write) — GitHub API limitation, acceptable.

## Authentication

- GitHub Fine-grained PAT scoped to `ThiagoTVarella.github.io` only
- Permissions: Contents (read+write), Metadata (read-only)
- Token stored in browser `localStorage` on the phone
- Never committed to the repo
- Expiry: 1 year (May 2027)

## Security

The `/admin` URL is unlisted (not linked from the site). Without the token in localStorage, the form is inert. Worst-case blast radius: blog posts on one repo.

## Out of Scope (for now)

- Rich text / markdown formatting
- PIN/password gate
- Post preview before publishing
- Edit/delete existing posts
