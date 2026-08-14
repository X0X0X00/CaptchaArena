#!/usr/bin/env python3
"""Check that README.md and README.zh-CN.md have not drifted apart.

Prose is expected to differ — that is the point of a translation. Everything a
reader would copy or follow is not: commands, links, images, and the puzzle
table must stay identical, or one language quietly starts telling people to run
something the other does not.

Run from the repository root: python .github/check_readme_parity.py
"""
from __future__ import annotations

import os
import re
import sys
import urllib.parse

EN, ZH = "README.md", "README.zh-CN.md"
FENCE = "```"
# lines inside a fence that a reader would actually run
CMD = re.compile(r"^\s*(hf |huggingface-cli |python|pip |playwright|CAPTCHA_|GALLERY_|--|"
                 r"http://|https://)")

failures: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)


def read(path: str) -> str:
    if not os.path.isfile(path):
        fail(f"{path} is missing")
        return ""
    with open(path, encoding="utf-8") as f:
        return f.read()


def fences(text: str) -> list[str]:
    return re.findall(FENCE + r"[a-zA-Z]*\n(.*?)" + FENCE, text, re.S)


def commands(text: str) -> list[str]:
    return [ln.rstrip() for block in fences(text)
            for ln in block.split("\n") if CMD.match(ln)]


def table_rows(text: str) -> list[tuple[str, str]]:
    """(type, actions) for each row of the puzzle table."""
    out = []
    for ln in text.split("\n"):
        if ln.startswith("| `"):
            cells = [c.strip() for c in ln.strip("|").split("|")]
            if len(cells) >= 4:
                out.append((cells[0], cells[-1]))
    return out


def images(text: str) -> list[str]:
    return re.findall(r"!\[[^\]]*\]\(([^)]+)\)", text)


def ext_links(text: str) -> set[str]:
    return set(re.findall(r"\]\((https?://[^)]+)\)", text))


def local_links(text: str) -> list[str]:
    return [l for l in re.findall(r"\]\(([^)#][^)]*)\)", text)
            if not l.startswith("http")]


def sections(text: str) -> list[str]:
    return [h for h in re.findall(r"^## (.+)$", text, re.M)
            if h not in ("Table of Contents", "目录")]


def anchors(text: str) -> list[str]:
    return re.findall(r"^- \[.+?\]\(#(.+?)\)$", text, re.M)


def slug(heading: str) -> str:
    return re.sub(r"[^\w一-鿿 -]", "", heading.lower()).replace(" ", "-")


en, zh = read(EN), read(ZH)
if not en or not zh:
    print("\n".join(failures))
    sys.exit(1)

# --- things that must be identical across the two languages -------------------
ec, zc = commands(en), commands(zh)
if ec != zc:
    fail(f"commands differ ({len(ec)} in {EN}, {len(zc)} in {ZH})")
    for a, b in zip(ec, zc):
        if a != b:
            fail(f"    {EN}: {a}\n    {ZH}: {b}")
            break

if len(fences(en)) != len(fences(zh)):
    fail(f"code-block count differs: {len(fences(en))} vs {len(fences(zh))}")

if table_rows(en) != table_rows(zh):
    fail("the puzzle table differs (type names, order, or action counts)")

if images(en) != images(zh):
    fail(f"image paths differ:\n    {EN}: {images(en)}\n    {ZH}: {images(zh)}")

if ext_links(en) != ext_links(zh):
    only_en = sorted(ext_links(en) - ext_links(zh))
    only_zh = sorted(ext_links(zh) - ext_links(en))
    fail(f"external links differ — only in {EN}: {only_en}; only in {ZH}: {only_zh}")

if len(sections(en)) != len(sections(zh)):
    fail(f"section count differs: {len(sections(en))} vs {len(sections(zh))}")

# --- things that must hold within each file -----------------------------------
for name, text in ((EN, en), (ZH, zh)):
    n_sec, n_anchor = len(sections(text)), len(anchors(text))
    if n_sec != n_anchor:
        fail(f"{name}: {n_sec} sections but {n_anchor} table-of-contents entries")
    real = {slug(h) for h in sections(text)}
    for a in anchors(text):
        if a not in real:
            fail(f"{name}: table-of-contents anchor #{a} matches no heading")
    for link in local_links(text):
        if not os.path.exists(urllib.parse.unquote(link)):
            fail(f"{name}: broken local link {link}")

# --- the two must point at each other -----------------------------------------
if f'href="{ZH}"' not in en:
    fail(f"{EN} has no language link to {ZH}")
if f'href="{EN}"' not in zh:
    fail(f"{ZH} has no language link to {EN}")

if failures:
    print("README parity check failed:\n")
    print("\n".join(f"  - {f}" for f in failures))
    sys.exit(1)

print(f"README parity OK — {len(ec)} commands, {len(table_rows(en))} table rows, "
      f"{len(images(en))} images, {len(sections(en))} sections matched across both files.")
