# Blog Publisher PWA — Edit & Delete Design

**Date:** 2026-05-04  
**Goal:** Add Edit and Delete post capabilities to the existing PWA at `thiagotvarella.github.io/admin`.

## UI

Three-tab layout added to the main app screen (after token setup): **New · Edit · Delete**. Existing "New Post" form becomes the first tab. Tab bar only visible after token is saved.

## Edit Flow

1. Dropdown populated from `footerblog.html` archive links
2. On post select: GET `blog/N.html`, parse `<h3>` → title, `<p>` tags → body (joined with blank lines), pre-fill form
3. User edits → Save: PUT `blog/N.html` with updated content + file SHA; if title changed, also update the `<li>` text in `footerblog.html`

## Delete Flow

1. Same dropdown from `footerblog.html`
2. User selects post → Delete button → confirm message shown inline
3. On confirm: DELETE `blog/N.html` via GitHub API (requires file SHA); remove matching `<li>` from `footerblog.html` and PUT it back

## Implementation Notes

- All changes in `admin/index.html` only — no new files
- Post list always loaded fresh from `footerblog.html` when a tab is activated
- SHA for `blog/N.html` is fetched at operation time (GET returns it), not cached
- Edit saves the post using the same `buildPostHtml` template as New Post

## Out of Scope

- Reordering posts
- Draft/preview before saving
