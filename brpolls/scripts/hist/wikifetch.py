"""Polite, cached Wikipedia fetcher (raw wikitext and API queries) with backoff.

    python wikifetch.py raw pt "Pesquisas de opinião para a eleição presidencial no Brasil em 2022"
    python wikifetch.py search pt 'intitle:Pesquisas intitle:eleição'
"""
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

CACHE = os.environ.get("WIKI_CACHE", os.path.expanduser("~/.cache/brpolls-wiki"))
UA = "brpolls-research/0.1 (personal research project)"


def _get(url, tries=6):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, hashlib.sha1(url.encode()).hexdigest())
    if os.path.exists(path):
        return open(path, encoding="utf-8").read()
    delay = 5
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            body = urllib.request.urlopen(req, timeout=60).read().decode("utf-8")
            if "too many requests" in body[:300].lower():
                raise urllib.error.HTTPError(url, 429, "rate limited", None, None)
            open(path, "w", encoding="utf-8").write(body)
            time.sleep(1.5)
            return body
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(delay)
            delay *= 2
        except urllib.error.URLError:
            time.sleep(delay)
            delay *= 2
    raise RuntimeError(f"failed after {tries} tries: {url}")


def raw(lang, title):
    t = urllib.parse.quote(title.replace(" ", "_"))
    return _get(f"https://{lang}.wikipedia.org/w/index.php?title={t}&action=raw")


def search(lang, query, limit=100):
    q = urllib.parse.urlencode({"action": "query", "list": "search", "srsearch": query,
                                "srlimit": limit, "format": "json"})
    return json.loads(_get(f"https://{lang}.wikipedia.org/w/api.php?{q}"))["query"]["search"]


if __name__ == "__main__":
    cmd, lang, arg = sys.argv[1:4]
    if cmd == "raw":
        text = raw(lang, arg)
        sys.stdout.write(text if text is not None else "")
        sys.exit(0 if text is not None else 1)
    for r in search(lang, arg):
        print(r["pageid"], r["size"], r["title"], sep="\t")
