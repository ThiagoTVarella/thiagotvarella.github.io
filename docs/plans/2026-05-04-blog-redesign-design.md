# Blog Redesign — Design

**Date:** 2026-05-04  
**Goal:** Give the blog a proper landing page with two tagged sections (Thoughts, Bookmarks), backed by a `posts.json` manifest.

## Structure

```
blog/
  index.html        ← new landing page
  posts.json        ← source of truth for all posts
  1.html            ← existing (tag: thoughts)
  2.html            ← existing (tag: thoughts)
  N.html            ← future posts (thoughts or bookmarks, flat numbering)
```

## posts.json Schema

```json
[
  { "num": 1, "title": "...", "tag": "thoughts", "date": "YYYY-MM-DD" },
  { "num": 2, "title": "...", "tag": "thoughts", "date": "YYYY-MM-DD" }
]
```

Tags: `"thoughts"` | `"bookmarks"`. Extensible — add new tags and columns later without structural changes.

## Landing Page (blog/index.html)

- Intro blurb: "A space for random thoughts."
- JS fetches `posts.json`, filters by tag, renders two columns: **Thoughts** (left) | **Bookmarks** (right), most recent first
- Mobile: columns stack vertically
- Matches existing site styles (Comfortaa, Bootstrap, main.css)

## Post Pages

- Thoughts: same template as today — `<h3>` title + `<p>` paragraphs
- Bookmarks: same template but `<section>` starts with external link: `→ Read the original` + comment paragraphs
- Both: replace `<div id="footerblog">` with a simple `<a href="/blog/">← Back to blog</a>` link
- `footerblog.html` is retired (not deleted, just unused)

## Nav

`header.html`: change `/blog/1.html` → `/blog/`

## PWA Publisher Changes (admin/index.html)

**New Post tab:**
- Tag selector: Thoughts / Bookmarks
- Bookmarks: extra URL field (external link)
- Post number: `Math.max(...posts.map(p => p.num)) + 1` from `posts.json`
- On publish: create `blog/N.html` + append entry to `posts.json`

**Edit tab:**
- Load post list from `posts.json` (not `footerblog.html`)
- For bookmarks: parse and show the external URL field for editing

**Delete tab:**
- Load post list from `posts.json`
- On delete: remove `blog/N.html` + remove entry from `posts.json`

## Migration

- Add `posts.json` with existing posts 1 and 2 (both tag: thoughts)
- Update `blog/1.html` and `blog/2.html`: swap `footerblog` div for back link

## Out of Scope

- Tags page / filtered views (beyond the two landing columns)
- Pagination
- RSS feed
