#!/usr/bin/env python
"""CaptchaArena dataset gallery.

Browse the benchmark: pick a split and puzzle type on the left, scan thumbnails on
the right, click one to open **the real benchmark page** for that puzzle — the exact
1280x1080 page the computer-use agent is scored on — next to its ground truth.

    pip install flask pillow requests
    GALLERY_DATA_ROOT=/path/to/data \
    GALLERY_CAPTCHA_URL=http://127.0.0.1:7860 \
    python gallery/app.py                      # http://localhost:48040

The live page is reverse-proxied through this app, so only one port needs to be
reachable. The data itself is not in this repository — see data/README.md.
"""
import io
import json
import os
import re
from functools import lru_cache

import requests
from flask import Flask, Response, abort, jsonify, request, send_file
from PIL import Image

ROOT = os.path.abspath(os.environ.get(
    "GALLERY_DATA_ROOT",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data"),
))
# app.py instance that serves the live puzzle pages (must be able to resolve
# every split via `?split=<name>`).
CAPTCHA_URL = os.environ.get("GALLERY_CAPTCHA_URL", "http://127.0.0.1:7860").rstrip("/")
PORT = int(os.environ.get("GALLERY_PORT", "48040"))
THUMB_CACHE = os.environ.get(
    "GALLERY_THUMB_CACHE", os.path.join("/tmp", "captcha_arena_thumbs"))
THUMB_PX = 320
SPLITS = ["Train", "Val", "Test"]
IMG_EXT = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")

# Mean agent actions per puzzle type, measured over the 2100-puzzle Train split
# (ground_truth_cu answer_cu tool-call counts). Drives the star rating, same as
# the live benchmark page.
AVG_ACTION_STEPS = {
    "Geometry_Click": 1.00, "Hold_Button": 1.00, "Misleading_Click": 1.00,
    "Pick_Area": 1.00, "Place_Dot": 2.00, "Select_Animal": 2.00,
    "Image_Matching": 2.98, "Bingo": 3.00, "Dice_Count": 3.00,
    "Slide_Puzzle": 3.00, "Coordinates": 3.00, "Object_Match": 3.01,
    "Connect_icon": 3.55, "Dart_Count": 3.67, "Path_Finder": 3.67,
    "Unusual_Detection": 4.50, "Rotation_Match": 4.50, "Image_Recognition": 4.54,
    "Click_Order": 4.98, "Patch_Select": 8.49,
}

# static_folder=None: Flask's own /static route would otherwise shadow the proxy,
# and /static/js/script.js belongs to the embedded benchmark page.
app = Flask(__name__, static_folder=None)


def base_type(name):
    """`Bingo_2100` -> `Bingo`."""
    return re.sub(r"_\d+$", "", name)


def stars_for(type_name):
    avg = AVG_ACTION_STEPS.get(base_type(type_name))
    if avg is None:
        return None, None
    n = 1 if avg <= 1.5 else 2 if avg <= 2.5 else 3 if avg <= 3.5 else 4 if avg <= 4.75 else 5
    return n, avg


def safe_join(*parts):
    """Join under ROOT and refuse anything that escapes it."""
    p = os.path.abspath(os.path.join(ROOT, *parts))
    if p != ROOT and not p.startswith(ROOT + os.sep):
        abort(400)
    return p


GT_FILES = ("ground_truth.json", "ground_truth_cu.json")


@lru_cache(maxsize=256)
def _load_gt(split, type_name, _stamp):
    """Parse the two ground-truth files. Keyed on _stamp so an edit invalidates."""
    d = safe_join(split, type_name)
    out = []
    for fn in GT_FILES:
        try:
            with open(os.path.join(d, fn)) as f:
                out.append(json.load(f))
        except Exception:
            out.append({})
    return out[0], out[1]


def load_gt(split, type_name):
    """Return (ground_truth, ground_truth_cu) for a split/type.

    Cached, but keyed on the files' mtimes: ground truth gets corrected in place
    (relabelling passes, regenerated splits), and a long-lived process must not
    keep serving the answers it happened to read at startup.
    """
    d = safe_join(split, type_name)
    stamp = []
    for fn in GT_FILES:
        try:
            st = os.stat(os.path.join(d, fn))
            stamp.append((int(st.st_mtime), st.st_size))
        except OSError:
            stamp.append(None)
    return _load_gt(split, type_name, tuple(stamp))


def n_actions(entry):
    ac = entry.get("answer_cu")
    if isinstance(ac, list) and ac and isinstance(ac[0], list):
        ac = ac[0]          # multi_swap: first alternative
    return len(ac) if isinstance(ac, list) else None


def resolve_images(split, type_name, pid, entry):
    """Map a ground-truth key to image files on disk.

    Three shapes exist: the key IS the image file; the key is a directory of
    images (Image_Recognition); or the key is a json name and the entry points at
    the image through a field (Connect_icon).
    """
    d = safe_join(split, type_name)
    p = os.path.join(d, pid)
    if os.path.isfile(p) and pid.lower().endswith(IMG_EXT):
        return [pid]
    if os.path.isdir(p):
        return sorted(f"{pid}/{f}" for f in os.listdir(p)
                      if f.lower().endswith(IMG_EXT))
    rels = []
    for field in ("image", "images", "reference_image", "puzzle_image",
                  "image_path", "background_image", "option_images",
                  "order_image", "source_image"):
        v = entry.get(field)
        if isinstance(v, str):
            rels.append(v)
        elif isinstance(v, list):
            rels.extend(x for x in v if isinstance(x, str))
    out, seen = [], set()
    for r in rels:
        r = r.lstrip("/")
        for cand in (r, os.path.basename(r)):
            cp = os.path.join(d, cand)
            if os.path.isfile(cp):
                rel = os.path.relpath(cp, d)
                if rel not in seen:
                    seen.add(rel)
                    out.append(rel)
                break
    return out


# ----------------------------------------------------------------- gallery API
# All gallery endpoints live under /g/ so that everything else can be proxied
# straight through to the live benchmark server (which owns /api, /static, ...).

@app.route("/g/tree")
def api_tree():
    tree = []
    if not os.path.isdir(ROOT):
        return jsonify({"root": ROOT, "splits": [], "error": "data root not found"})
    for s in SPLITS:
        sd = os.path.join(ROOT, s)
        if not os.path.isdir(sd):
            continue
        types = []
        for t in sorted(os.listdir(sd)):
            td = os.path.join(sd, t)
            if not os.path.isdir(td):
                continue
            if not os.path.exists(os.path.join(td, "ground_truth.json")):
                continue
            gt, _ = load_gt(s, t)
            n, avg = stars_for(t)
            types.append({"name": t, "base": base_type(t), "count": len(gt),
                          "stars": n, "avg_actions": avg})
        if types:
            tree.append({"split": s, "types": types})
    return jsonify({"root": ROOT, "captcha_url": CAPTCHA_URL, "splits": tree})


@app.route("/g/items")
def api_items():
    split = request.args.get("split", "")
    type_name = request.args.get("type", "")
    offset = max(0, int(request.args.get("offset", 0)))
    limit = min(300, max(1, int(request.args.get("limit", 60))))
    gt, gtc = load_gt(split, type_name)
    keys = list(gt.keys())
    items = []
    for pid in keys[offset:offset + limit]:
        e = dict(gt.get(pid) or {})
        ec = gtc.get(pid) or {}
        imgs = resolve_images(split, type_name, pid, {**e, **ec})
        items.append({
            "id": pid,
            "thumb": imgs[0] if imgs else None,
            "n_images": len(imgs),
            "actions": n_actions(ec),
        })
    n, avg = stars_for(type_name)
    return jsonify({"split": split, "type": type_name, "total": len(keys),
                    "offset": offset, "items": items, "stars": n,
                    "avg_actions": avg})


@app.route("/g/item")
def api_item():
    split = request.args.get("split", "")
    type_name = request.args.get("type", "")
    pid = request.args.get("id", "")
    gt, gtc = load_gt(split, type_name)
    if pid not in gt and pid not in gtc:
        abort(404)
    e = dict(gt.get(pid) or {})
    ec = dict(gtc.get(pid) or {})
    n, avg = stars_for(type_name)
    return jsonify({
        "id": pid, "split": split, "type": type_name,
        "prompt": e.get("prompt") or ec.get("prompt") or "",
        "tolerance": e.get("tolerance"),
        "answer_cu": ec.get("answer_cu"),
        "actions": n_actions(ec),
        "stars": n, "avg_actions": avg,
        "images": resolve_images(split, type_name, pid, {**e, **ec}),
        "ground_truth": e,
    })


def _img_path(split, type_name, rel):
    p = safe_join(split, type_name, rel)
    if not os.path.isfile(p):
        abort(404)
    return p


@app.route("/g/image")
def image():
    return send_file(_img_path(request.args.get("split", ""),
                               request.args.get("type", ""),
                               request.args.get("rel", "")))


@app.route("/g/thumb")
def thumb():
    split = request.args.get("split", "")
    type_name = request.args.get("type", "")
    rel = request.args.get("rel", "")
    p = _img_path(split, type_name, rel)
    st = os.stat(p)
    key = (f"{split}__{type_name}__{rel}".replace("/", "_")
           + f"__{int(st.st_mtime)}_{THUMB_PX}.jpg")
    cached = os.path.join(THUMB_CACHE, key)
    if os.path.isfile(cached):
        return send_file(cached, mimetype="image/jpeg")
    try:
        im = Image.open(p).convert("RGB")
        im.thumbnail((THUMB_PX, THUMB_PX), Image.LANCZOS)
        os.makedirs(THUMB_CACHE, exist_ok=True)
        im.save(cached, "JPEG", quality=82)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=82)
        buf.seek(0)
        return send_file(buf, mimetype="image/jpeg")
    except Exception:
        return send_file(p)


# ------------------------------------------------- live benchmark page (proxy)
# The lightbox embeds the real page served by app.py. Proxying it through this
# app means a single port has to be reachable, and the page's absolute asset and
# API paths (/static/..., /api/..., /captcha_data/...) keep working unchanged.

_HOP_BY_HOP = {"content-encoding", "content-length", "transfer-encoding",
               "connection", "keep-alive", "proxy-authenticate",
               "proxy-authorization", "te", "trailers", "upgrade"}


def _proxy(path):
    url = f"{CAPTCHA_URL}{path}"
    headers = {k: v for k, v in request.headers.items() if k.lower() != "host"}
    try:
        r = requests.request(request.method, url, params=request.args,
                             data=request.get_data(), headers=headers,
                             cookies=request.cookies, allow_redirects=False,
                             timeout=60)
    except Exception as e:
        return Response(f"live benchmark server unreachable at {CAPTCHA_URL}: {e}",
                        502, mimetype="text/plain")
    out = [(k, v) for k, v in r.headers.items() if k.lower() not in _HOP_BY_HOP]
    return Response(r.content, r.status_code, out)


@app.route("/live", methods=["GET"])
def live():
    """Entry point for the iframe: proxies the benchmark page root."""
    return _proxy("/")


@app.route("/<path:p>", methods=["GET", "POST"])
def proxy_rest(p):
    """Everything the embedded page asks for (/static, /api, /captcha_data, ...)."""
    return _proxy("/" + p)


@app.route("/")
def index():
    return Response(HTML, mimetype="text/html")


HTML = r"""<!doctype html>
<html><head><meta charset="utf-8"><title>CaptchaArena — dataset gallery</title>
<style>
  :root{ --bg:#f5f6f8; --panel:#fff; --line:#e3e6ea; --ink:#1f2933; --muted:#7b8794; --accent:#2f6feb; }
  @media (prefers-color-scheme: dark){
    :root{ --bg:#14171c; --panel:#1b1f26; --line:#2b313a; --ink:#e6e9ee; --muted:#95a1b0; --accent:#5b8dff; }
  }
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.5 system-ui,-apple-system,Segoe UI,Arial;background:var(--bg);color:var(--ink)}
  header{display:flex;align-items:center;gap:14px;padding:10px 16px;background:var(--panel);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:10}
  header h1{margin:0;font-size:17px;letter-spacing:.2px}
  header .sub{color:var(--muted);font-size:12px}
  .layout{display:grid;grid-template-columns:250px 1fr;height:calc(100vh - 49px)}
  aside{border-right:1px solid var(--line);background:var(--panel);overflow-y:auto}
  .splits{display:flex;gap:4px;padding:10px;border-bottom:1px solid var(--line)}
  .splits button{flex:1;padding:6px 8px;border:1px solid var(--line);background:transparent;color:var(--ink);border-radius:6px;cursor:pointer;font-size:12px}
  .splits button.on{background:var(--accent);color:#fff;border-color:var(--accent)}
  .types{padding:6px}
  .type{display:flex;justify-content:space-between;align-items:center;gap:6px;padding:7px 9px;border-radius:6px;cursor:pointer}
  .type:hover{background:rgba(127,127,127,.12)}
  .type.on{background:var(--accent);color:#fff}
  .type .n{font-size:11px;opacity:.75}
  .type .st{font-size:10px;color:#e8b100;letter-spacing:-1px}
  .type.on .st{color:#ffe9a3}
  main{overflow-y:auto;padding:14px}
  .bar{display:flex;align-items:baseline;gap:12px;margin-bottom:12px;flex-wrap:wrap}
  .bar h2{margin:0;font-size:16px}
  .bar .meta{color:var(--muted);font-size:12px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:9px;overflow:hidden;cursor:pointer;transition:transform .08s,box-shadow .08s}
  .card:hover{transform:translateY(-2px);box-shadow:0 6px 18px rgba(0,0,0,.13)}
  .card img{width:100%;height:150px;object-fit:contain;display:block;background:rgba(127,127,127,.06)}
  .card .ph{height:150px;display:flex;align-items:center;justify-content:center;background:rgba(127,127,127,.08);color:var(--muted);font-size:12px}
  /* Hold_Button has no puzzle picture — the live page is just the HOLD button,
     so the card mirrors that instead of showing the unused source image. */
  .holdthumb{height:150px;display:flex;align-items:center;justify-content:center;background:#f4f5f7}
  .holdthumb span{padding:13px 36px;border:3px solid #23272e;border-radius:40px;background:#fafbfc;
    font-weight:700;letter-spacing:2px;color:#23272e;font-size:15px}
  .card .cap{padding:7px 9px;font-size:11px;display:flex;justify-content:space-between;gap:6px}
  .card .cap b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .card .cap span{color:var(--muted);white-space:nowrap}
  .more{margin:16px auto;display:block;padding:8px 18px;border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:7px;cursor:pointer}
  .empty{color:var(--muted);padding:40px;text-align:center}
  /* lightbox: the REAL benchmark page in an iframe + its ground truth */
  .lb{position:fixed;inset:0;background:rgba(0,0,0,.94);display:none;z-index:50;padding:16px;gap:14px}
  .lb.on{display:flex}
  .stage{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px}
  .stagebar{display:flex;align-items:center;gap:10px;color:#fff;font-size:12px}
  .stagebar b{font-size:14px}
  .stagebar button{padding:4px 10px;border:1px solid rgba(255,255,255,.35);background:transparent;color:#fff;border-radius:6px;cursor:pointer;font-size:12px}
  .stagebar button.on{background:var(--accent);border-color:var(--accent)}
  .stagebar button.back{background:rgba(255,255,255,.14);font-weight:600;padding:5px 14px}
  .stagebar button.back:hover{background:rgba(255,255,255,.28)}
  .frame{flex:1;position:relative;overflow:hidden;border-radius:8px;background:#fff}
  .frame iframe{position:absolute;top:0;left:0;width:1280px;height:1080px;border:0;transform-origin:top left}
  .frame img.raw{position:absolute;inset:0;margin:auto;max-width:100%;max-height:100%;object-fit:contain}
  .info{width:340px;background:var(--panel);border-radius:9px;padding:14px;overflow-y:auto;color:var(--ink)}
  .info h3{margin:0 0 4px;font-size:15px;word-break:break-all}
  .info .k{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.6px;margin-top:12px}
  .info pre{background:rgba(127,127,127,.12);padding:8px;border-radius:6px;font-size:11px;overflow:auto;max-height:220px;margin:4px 0 0}
  .close{position:absolute;top:10px;right:14px;color:#fff;font-size:26px;cursor:pointer;line-height:1;opacity:.85;z-index:60}
  .nav{position:absolute;top:50%;transform:translateY(-50%);color:#fff;font-size:34px;cursor:pointer;opacity:.55;user-select:none;padding:12px;z-index:55}
  .nav:hover{opacity:1}
  .nav.prev{left:2px} .nav.next{right:366px}
</style></head><body>
<header>
  <h1>CaptchaArena</h1>
  <span class="sub" id="rootlabel"></span>
</header>
<div class="layout">
  <aside>
    <div class="splits" id="splits"></div>
    <div class="types" id="types"></div>
  </aside>
  <main>
    <div class="bar"><h2 id="title">Pick a puzzle type</h2><span class="meta" id="meta"></span></div>
    <div class="grid" id="grid"></div>
    <div id="tail"></div>
  </main>
</div>

<div class="lb" id="lb">
  <span class="close" onclick="closeLb()">&times;</span>
  <span class="nav prev" onclick="step(-1)">&#8249;</span>
  <span class="nav next" onclick="step(1)">&#8250;</span>
  <div class="stage">
    <div class="stagebar">
      <button class="back" onclick="closeLb()">&#8592; Back</button>
      <b id="lbtitle"></b>
      <span id="lbsub"></span>
      <span style="flex:1"></span>
      <button id="btnlive" class="on" onclick="setMode('live')">Live benchmark page</button>
      <button id="btnraw" onclick="setMode('raw')">Raw image</button>
      <button onclick="reloadFrame()">Reload &#8635;</button>
    </div>
    <div class="frame" id="frame"></div>
  </div>
  <aside class="info" id="lbinfo"></aside>
</div>

<script>
let TREE=[], split=null, type=null, items=[], offset=0, total=0, cur=-1, mode='live', curItem=null;
const $=id=>document.getElementById(id);
const starStr=n=>n==null?'':'★'.repeat(n)+'☆'.repeat(5-n);
const q=o=>Object.entries(o).map(([k,v])=>k+'='+encodeURIComponent(v)).join('&');

async function boot(){
  const t=await (await fetch('/g/tree')).json();
  $('rootlabel').textContent='data root: '+t.root+'   ·   live page: '+t.captcha_url;
  TREE=t.splits;
  if(!TREE.length){ $('grid').innerHTML='<div class="empty">No data under '+t.root+'</div>'; return; }
  $('splits').innerHTML=TREE.map(s=>`<button id="sp-${s.split}" onclick="pickSplit('${s.split}')">${s.split}</button>`).join('');
  pickSplit(TREE[0].split);
}
function pickSplit(s){
  split=s;
  TREE.forEach(x=>$('sp-'+x.split).className = x.split===s?'on':'');
  const node=TREE.find(x=>x.split===s);
  $('types').innerHTML=node.types.map(t=>`
    <div class="type" id="ty-${t.name}" onclick="pickType('${t.name}')">
      <span>${t.base}<div class="st">${starStr(t.stars)}</div></span>
      <span class="n">${t.count}</span>
    </div>`).join('');
  if(node.types.length) pickType(node.types[0].name);
}
function pickType(t){
  type=t; offset=0; items=[];
  document.querySelectorAll('.type').forEach(e=>e.classList.remove('on'));
  const el=$('ty-'+t); if(el) el.classList.add('on');
  $('grid').innerHTML=''; $('tail').innerHTML='';
  load();
}
async function load(){
  const r=await (await fetch('/g/items?'+q({split,type,offset,limit:60}))).json();
  total=r.total;
  const node=TREE.find(x=>x.split===split).types.find(x=>x.name===type);
  $('title').textContent=`${node.base}  ·  ${split}`;
  $('meta').textContent=`${total} puzzles · action steps ${starStr(r.stars)}`+
      (r.avg_actions!=null?` (avg ${r.avg_actions.toFixed(1)})`:'');
  const start=items.length;
  items=items.concat(r.items);
  // Hold_Button's source image never appears on the live page (it is just the
  // HOLD button), so show what the agent actually sees.
  const isHold = node.base === 'Hold_Button';
  $('grid').insertAdjacentHTML('beforeend', r.items.map((it,i)=>`
    <div class="card" onclick="openLb(${start+i})">
      ${isHold ? `<div class="holdthumb"><span>HOLD</span></div>`
        : it.thumb ? `<img loading="lazy" src="/g/thumb?${q({split,type,rel:it.thumb})}">`
                   : `<div class="ph">no image</div>`}
      <div class="cap"><b title="${it.id}">${it.id}</b><span>${it.actions!=null?it.actions+' act':''}</span></div>
    </div>`).join(''));
  offset += r.items.length;
  $('tail').innerHTML = offset<total ? `<button class="more" onclick="load()">Load more (${offset}/${total})</button>` : '';
}
async function openLb(i){
  cur=i; const it=items[i];
  const d=await (await fetch('/g/item?'+q({split,type,id:it.id}))).json();
  curItem=d;
  $('lbtitle').textContent=d.id;
  $('lbsub').textContent=`${d.split} / ${d.type}`;
  const cu=d.answer_cu?JSON.stringify(d.answer_cu,null,1):'(none)';
  const gt=JSON.stringify(d.ground_truth,null,1);
  $('lbinfo').innerHTML=`
    <h3>${d.id}</h3>
    <div style="color:var(--muted);font-size:12px">${d.split} / ${d.type}</div>
    <div class="k">Prompt</div><div>${d.prompt||'—'}</div>
    <div class="k">Action steps</div>
    <div><span style="color:#e8b100">${starStr(d.stars)}</span>
      ${d.actions!=null?d.actions+' actions for this puzzle':''}
      ${d.avg_actions!=null?'· type avg '+d.avg_actions.toFixed(1):''}</div>
    ${d.tolerance!=null?`<div class="k">Tolerance</div><div>${d.tolerance} natural px</div>`:''}
    <div class="k">answer_cu (what the agent must do)</div><pre>${cu.replace(/</g,'&lt;')}</pre>
    <div class="k">ground_truth.json</div><pre>${gt.replace(/</g,'&lt;')}</pre>`;
  $('lb').classList.add('on');
  render();
}
function setMode(m){
  mode=m;
  $('btnlive').className = m==='live'?'on':'';
  $('btnraw').className  = m==='raw'?'on':'';
  render();
}
function render(){
  const f=$('frame'); if(!curItem){ f.innerHTML=''; return; }
  if(mode==='live'){
    const src='/live?'+q({single_puzzle:'true', puzzle_type:curItem.type,
                          puzzle_id:curItem.id, split:curItem.split});
    f.innerHTML=`<iframe id="lbframe" src="${src}"></iframe>`;
    fit();
  }else{
    const rel=(curItem.images&&curItem.images[0])||null;
    f.innerHTML = rel ? `<img class="raw" src="/g/image?${q({split:curItem.split,type:curItem.type,rel})}">`
                      : `<div class="ph" style="height:100%">no image</div>`;
  }
}
function fit(){
  const fr=$('frame'), ifr=$('lbframe');
  if(!ifr||!fr) return;
  const s=Math.min(fr.clientWidth/1280, fr.clientHeight/1080);
  ifr.style.transform=`scale(${s})`;
  ifr.style.left=Math.max(0,(fr.clientWidth-1280*s)/2)+'px';
}
function reloadFrame(){ render(); }
function step(d){ const n=cur+d; if(n>=0&&n<items.length) openLb(n); }
function closeLb(){ $('lb').classList.remove('on'); $('frame').innerHTML=''; }
window.addEventListener('resize',fit);
document.addEventListener('keydown',e=>{
  if(!$('lb').classList.contains('on')) return;
  if(e.key==='Escape') closeLb();
  if(e.key==='ArrowRight') step(1);
  if(e.key==='ArrowLeft') step(-1);
});
$('lb').addEventListener('click',e=>{ if(e.target.id==='lb') closeLb(); });
boot();
</script></body></html>"""


if __name__ == "__main__":
    print(f"CaptchaArena gallery — data {ROOT} — live page {CAPTCHA_URL} "
          f"— http://127.0.0.1:{PORT}", flush=True)
    app.run(host="0.0.0.0", port=PORT, threaded=True)
