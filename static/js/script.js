let puzzleStartTime = null;

// ===== Human Trajectory Tracker =====
const HumanTrajectory = {
    steps: [],
    recording: false,

    reset() {
        this.steps = [];
        this.recording = true;
    },

    _capture() {
        // Capture the puzzle image via canvas (no external lib needed)
        const img = document.getElementById('puzzle-image');
        if (!img || !img.naturalWidth) return Promise.resolve(null);
        try {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            canvas.getContext('2d').drawImage(img, 0, 0);
            return Promise.resolve(canvas.toDataURL('image/png'));
        } catch(e) {
            return Promise.resolve(null);
        }
    },

    async record(action, params) {
        if (!this.recording) return;
        const screenshot = await this._capture();
        this.steps.push({
            timestamp: new Date().toISOString(),
            action,
            params: params || {},
            screenshot,
        });
    },

    // Synchronous record (no screenshot) for high-frequency events
    recordSync(action, params) {
        if (!this.recording) return;
        this.steps.push({
            timestamp: new Date().toISOString(),
            action,
            params: params || {},
            screenshot: null,
        });
    },

    async save(puzzleInfo, userAnswer, correct) {
        this.recording = false;
        // Study mode logs a compact record via /api/study/record (driven by the
        // shell); skip the heavy per-step screenshot upload entirely.
        if (this.study) return;
        // Take final screenshot
        const finalSS = await this._capture();
        this.steps.push({
            timestamp: new Date().toISOString(),
            action: 'submit',
            params: {answer: userAnswer, correct},
            screenshot: finalSS,
        });

        const payload = {
            puzzle_type: puzzleInfo.puzzle_type,
            puzzle_id: puzzleInfo.puzzle_id,
            prompt: puzzleInfo.prompt || '',
            steps: this.steps,
            user_answer: userAnswer,
            submitted: true,
            correct: correct,
        };

        fetch('/api/save_trajectory', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload),
        }).then(r => r.json())
          .then(d => console.log('[trajectory] saved:', d))
          .catch(e => console.error('[trajectory] save failed:', e));
    }
};

document.addEventListener('DOMContentLoaded', () => {
    // DOM elements
    const submitBtn = document.getElementById('submit-answer');
    const userAnswerInput = document.getElementById('user-answer');
    const puzzleImage = document.getElementById('puzzle-image');
    const puzzleImageContainer = document.querySelector('.puzzle-image-container');
    const resultMessage = document.getElementById('result-message');
    const totalCount = document.getElementById('total-count');
    const correctCount = document.getElementById('correct-count');
    const accuracyEl = document.getElementById('accuracy');
    const puzzlePrompt = document.getElementById('puzzle-prompt');
    const puzzleContainer = document.getElementById('puzzle-container');
    const inputGroup = document.querySelector('.input-group');
    const difficultyStars = document.getElementById('difficulty-stars');

    // Debug mode - auto-enable if debug_type is in URL params
    const _urlParams = new URLSearchParams(window.location.search);
    const DEBUG_TYPE = _urlParams.get('debug_type') || null;
    const DEBUG_MODE = !!DEBUG_TYPE;

    // Single-puzzle mode: load one specific puzzle, no auto-advance after submit
    const SINGLE_PUZZLE = _urlParams.get('single_puzzle') === 'true';
    const URL_PUZZLE_TYPE = _urlParams.get('puzzle_type') || null;
    const URL_PUZZLE_ID = _urlParams.get('puzzle_id') || null;
    // Dataset split (Train / Val / Test / Validation). When present, every
    // /api/* call below forwards it as `?split=<name>` and the server scopes
    // its file lookup to data/<name>/ — see app.py before_request hook.
    const URL_SPLIT = _urlParams.get('split') || null;

    // ── Human-study mode (study=1) ──────────────────────────────────────────
    // Two isolated app.py instances embed this page per puzzle and collect a
    // human baseline. All study code is guarded by STUDY so normal / eval / mock
    // behavior is byte-for-byte unchanged. Steps = type-agnostic pointerdown
    // count (excluding submit/answer controls); correctness is tapped centrally
    // from the /api/check_answer response below and reported up to the shell.
    // See docs/superpowers/specs/2026-07-27-captcha-human-study-design.md
    const STUDY = _urlParams.get('study') === '1';
    const _nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let studyActions = [];
    const studyT0 = _nowMs();
    if (STUDY) {
        HumanTrajectory.study = true;   // tell save() to skip the heavy screenshot POST
        const STUDY_SUBMIT_SEL = '#submit-answer,#user-answer,.submit-bingo,.submit-slider,' +
            '.submit-rotation,.submit-image-recognition,.submit-image-matching,.submit-unusual,' +
            '.submit-connect,.submit-btn,.reset-btn,[class*="submit"]';
        document.addEventListener('pointerdown', (e) => {
            try {
                if (e.target && e.target.closest && e.target.closest(STUDY_SUBMIT_SEL)) return;
                studyActions.push({ x: Math.round(e.clientX), y: Math.round(e.clientY),
                                    ms: Math.round(_nowMs() - studyT0) });
            } catch (_) { /* never break the page */ }
        }, true);
    }

    // Auto-forward `split` on every same-origin /api/ call so we don't have to
    // touch each fetch() site below. /captcha_data/ URLs already carry the
    // split query because app.py annotates them in get_puzzle_by_id responses.
    // The same wrapper also taps check_answer for study mode.
    if (URL_SPLIT || STUDY) {
        const _origFetch = window.fetch.bind(window);
        window.fetch = function(input, init) {
            try {
                if (URL_SPLIT) {
                    if (typeof input === 'string' && input.startsWith('/api/')) {
                        const sep = input.includes('?') ? '&' : '?';
                        if (!/[?&]split=/.test(input)) {
                            input = input + sep + 'split=' + encodeURIComponent(URL_SPLIT);
                        }
                    } else if (input instanceof Request && input.url && new URL(input.url, window.location.origin).pathname.startsWith('/api/')) {
                        const u = new URL(input.url, window.location.origin);
                        if (!u.searchParams.has('split')) {
                            u.searchParams.set('split', URL_SPLIT);
                            input = new Request(u.toString(), input);
                        }
                    }
                }
            } catch (e) {
                // Don't let the wrapper break legitimate fetches.
            }
            const _p = _origFetch(input, init);
            if (STUDY) {
                try {
                    const _url = (typeof input === 'string') ? input : (input && input.url) || '';
                    if (_url.indexOf('/api/check_answer') !== -1) {
                        _p.then((resp) => {
                            resp.clone().json().then((d) => {
                                const cp = window.currentPuzzle || {};
                                try {
                                    window.parent.postMessage({
                                        source: 'captcha-study',
                                        puzzle_type: cp.puzzle_type || URL_PUZZLE_TYPE,
                                        puzzle_id: cp.puzzle_id || URL_PUZZLE_ID,
                                        correct: !!(d && d.correct),
                                        steps: studyActions.length,
                                        actions: studyActions,
                                        time_ms: Math.round(_nowMs() - studyT0),
                                    }, '*');
                                } catch (_) {}
                            }).catch(() => {});
                        }).catch(() => {});
                    }
                } catch (_) {}
            }
            return _p;
        };
    }

    // Tracking state
    let currentPuzzle = null;
    let benchmarkStats = {
        total: 0,
        correct: 0
    };
    let clickCoordinates = null;
    let processingClick = false; // Flag to prevent multiple clicks while processing
    let currentRotationAngle = 0; // Track current rotation for Rotation_Match
    let selectedCells = []; // Track selected cells for Unusual_Detection
    let bingoSelectedCells = []; // Track selected cells for Bingo swap
    let selectedAnimalIndex = -1; // Track selected animal index for Select_Animal
    // Add debug type tracking variable 
    // let debugPuzzleType = null;
    
    // Initialize difficulty stars with default value (to show something immediately)
    displayDifficultyStars('Dice_Count');
    
    // Event listeners
    submitBtn.addEventListener('click', submitAnswer);
    userAnswerInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            submitAnswer();
        }
    });

    // Add click event handler directly to the puzzle image
    puzzleImage.addEventListener('click', handleImageClick);

    // ── postMessage bridge so the web viewer can auto-play GT trajectories ──
    // The viewer (iframe parent) posts `{type: 'cu_play_gt', answer_cu, kind,
    // alt_index, step_delay}` and the page executes the actions on the real
    // CAPTCHA UI: image clicks → option-arrow clicks → text/hold/rotate/drag →
    // finally Submit. Posts `cu_play_done` / `cu_play_error` back when finished.
    window.addEventListener('message', (e) => {
        const data = e?.data;
        if (!data || typeof data !== 'object') return;
        if (data.type === 'cu_play_gt') {
            playGtTrajectory(data).catch((err) => {
                console.error('[cu_play_gt] failed:', err);
                try { e.source && e.source.postMessage({type: 'cu_play_error', error: String(err)}, '*'); } catch {}
            });
        }
    });

    async function playGtTrajectory(payload) {
        const kind = payload.kind || null;
        const cu = payload.answer_cu;
        const altIndex = Number.isInteger(payload.alt_index) ? payload.alt_index : 0;
        const stepDelay = Number.isFinite(payload.step_delay) ? payload.step_delay : 700;
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));

        // Different puzzle types swap out the main image element entirely
        // (e.g. Click_Order replaces #puzzle-image with #click-order-main-image).
        // Find whichever visible <img> is currently the largest inside the
        // puzzle container — that's the one the GT coords are authored against.
        function imgEl() {
            for (const id of ['puzzle-image', 'click-order-main-image']) {
                const e = document.getElementById(id);
                if (e && e.naturalWidth > 0 && e.getClientRects().length > 0) return e;
            }
            const container = document.getElementById('puzzle-container') || document.body;
            let best = null, bestArea = 0;
            for (const im of container.querySelectorAll('img')) {
                if (!im.naturalWidth) continue;
                const r = im.getBoundingClientRect();
                const a = r.width * r.height;
                if (a > bestArea) { bestArea = a; best = im; }
            }
            return best;
        }
        function dispatchClickAt(target, vx, vy) {
            const opts = {bubbles: true, cancelable: true, view: window, button: 0, clientX: vx, clientY: vy};
            target.dispatchEvent(new MouseEvent('mousedown', opts));
            target.dispatchEvent(new MouseEvent('mouseup', opts));
            target.dispatchEvent(new MouseEvent('click', opts));
        }
        // Overlay markers live above the page so they're visible regardless of
        // whether the active puzzle type renders its own .click-marker. We
        // also inject a style rule that hides the page's native red-circle
        // markers — they look identical to ours and stack 1:1 with each click,
        // giving the impression of a double click.
        let __cuOverlay = null;
        let __cuSuppressStyle = null;
        let __cuStep = 0;
        function ensureOverlay() {
            if (__cuOverlay && document.body.contains(__cuOverlay)) return __cuOverlay;
            __cuOverlay = document.createElement('div');
            __cuOverlay.id = 'cu-gt-overlay';
            Object.assign(__cuOverlay.style, {
                position: 'fixed', inset: '0', pointerEvents: 'none',
                zIndex: '2147483647',
            });
            document.body.appendChild(__cuOverlay);
            if (!__cuSuppressStyle) {
                __cuSuppressStyle = document.createElement('style');
                __cuSuppressStyle.id = 'cu-suppress-page-markers';
                __cuSuppressStyle.textContent =
                    '.click-marker, .click-markers-container > * { display: none !important; }';
                document.head.appendChild(__cuSuppressStyle);
            }
            return __cuOverlay;
        }
        function clearOverlay() {
            __cuStep = 0;
            if (__cuOverlay) __cuOverlay.innerHTML = '';
        }
        function addOverlayMarker(vx, vy, label) {
            const layer = ensureOverlay();
            const m = document.createElement('div');
            const text = label != null ? String(label) : String(++__cuStep);
            Object.assign(m.style, {
                position: 'fixed',
                left: (vx - 16) + 'px',
                top: (vy - 16) + 'px',
                width: '32px',
                height: '32px',
                borderRadius: '50%',
                background: 'rgba(244,63,94,0.85)',
                color: 'white',
                font: 'bold 14px sans-serif',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 0 0 3px white, 0 4px 12px rgba(0,0,0,0.4)',
                transition: 'transform 0.15s',
                transform: 'scale(1.4)',
            });
            m.textContent = text;
            layer.appendChild(m);
            // Settle to normal size after the entrance pop
            setTimeout(() => { m.style.transform = 'scale(1)'; }, 120);
        }
        function clickAtImage(natX, natY, stepLabel) {
            const img = imgEl();
            if (!img) return false;
            const r = img.getBoundingClientRect();
            const sx = r.width / (img.naturalWidth || r.width);
            const sy = r.height / (img.naturalHeight || r.height);
            const vx = r.left + natX * sx;
            const vy = r.top + natY * sy;
            addOverlayMarker(vx, vy, stepLabel);
            dispatchClickAt(img, vx, vy);
            return true;
        }
        function isVisibleEnabled(el) {
            if (!el || el.disabled) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        }
        function findSubmit() {
            const sels = [
                '.submit-bingo', '.submit-slider', '.submit-rotation',
                '.submit-image-recognition', '.submit-image-matching',
                '.submit-unusual', '.submit-connect', '.submit-btn',
                '#submit-answer'
            ];
            for (const sel of sels) {
                for (const b of document.querySelectorAll(sel)) {
                    if (isVisibleEnabled(b)) return b;
                }
            }
            for (const b of document.querySelectorAll('button')) {
                const tag = (b.className || '') + ' ' + (b.id || '') + ' ' + (b.textContent || '');
                if (/submit/i.test(tag) && isVisibleEnabled(b)) return b;
            }
            return null;
        }
        function markElementCenter(el, label) {
            if (!el) return;
            const r = el.getBoundingClientRect();
            addOverlayMarker(r.left + r.width / 2, r.top + r.height / 2, label);
        }
        async function clickSubmit() {
            const b = findSubmit();
            if (b) {
                markElementCenter(b, '✓');
                b.click();
                return true;
            }
            return false;
        }
        function findArrow(side) {
            const sels = side === 'left'
                ? ['.navigate-left', '.left-arrow', '.rotate-left']
                : ['.navigate-right', '.right-arrow', '.rotate-right'];
            for (const sel of sels) {
                for (const b of document.querySelectorAll(sel)) {
                    if (isVisibleEnabled(b)) return b;
                }
            }
            return null;
        }
        function extractXY(item) {
            if (Array.isArray(item) && item.length === 2 && typeof item[0] === 'number') return item;
            if (item && typeof item === 'object' && item.arguments) {
                const {x, y} = item.arguments;
                if (typeof x === 'number' && typeof y === 'number') return [x, y];
            }
            return null;
        }

        const post = (msg) => { try { window.parent && window.parent.postMessage(msg, '*'); } catch {} };
        clearOverlay();
        post({type: 'cu_play_start', kind});

        // Dispatch a single tool call in `tool_calls` mode. Coordinates are
        // VIEWPORT pixels (not image-natural) — the GT was generated against
        // the canonical 1280×1080 window so they can be used as-is.
        async function execToolCall(call, stepNum, total) {
            if (!call || typeof call !== 'object') return false;
            const a = call.action || call.name;
            const args = call.arguments || {};
            if (a === 'click') {
                const vx = Number(args.x), vy = Number(args.y);
                if (!Number.isFinite(vx) || !Number.isFinite(vy)) return false;
                addOverlayMarker(vx, vy, String(stepNum));
                // Click whatever element currently sits at this viewport coord
                // (image cell, button, etc.) — bypassing puzzle-image-only logic.
                const target = document.elementFromPoint(vx, vy) || document.body;
                dispatchClickAt(target, vx, vy);
                post({type: 'cu_play_step', step: stepNum, total});
                return true;
            }
            if (a === 'scroll') {
                // Fixed step — matches computeruse_cli.scroll(SCROLL_STEP=500).
                const STEP = 500;
                const dir = String(args.direction || 'down').toLowerCase();
                let dx = 0, dy = 0;
                if (dir === 'down') dy = STEP;
                else if (dir === 'up') dy = -STEP;
                else if (dir === 'right') dx = STEP;
                else if (dir === 'left') dx = -STEP;
                window.scrollBy({left: dx, top: dy, behavior: 'instant'});
                return true;
            }
            if (a === 'type_text') {
                const txt = String(args.text ?? '');
                const input = document.getElementById('user-answer');
                if (input) {
                    markElementCenter(input, 'type');
                    input.focus();
                    input.value = txt;
                    input.dispatchEvent(new Event('input', {bubbles: true}));
                }
                return true;
            }
            if (a === 'press_key') {
                document.dispatchEvent(new KeyboardEvent('keydown', {key: String(args.key || 'Enter'), bubbles: true}));
                return true;
            }
            if (a === 'drag') {
                const sx = Number(args.start_x), sy = Number(args.start_y);
                const ex = Number(args.end_x), ey = Number(args.end_y);
                if (![sx, sy, ex, ey].every(Number.isFinite)) return false;
                addOverlayMarker(sx, sy, '↓');
                addOverlayMarker(ex, ey, '↑');
                const target = document.elementFromPoint(sx, sy) || document.body;
                const opts = (x, y) => ({bubbles: true, cancelable: true, view: window, button: 0, clientX: x, clientY: y});
                target.dispatchEvent(new MouseEvent('mousedown', opts(sx, sy)));
                const steps = 20;
                for (let i = 1; i <= steps; i++) {
                    const x = sx + (ex - sx) * (i / steps);
                    const y = sy + (ey - sy) * (i / steps);
                    target.dispatchEvent(new MouseEvent('mousemove', opts(x, y)));
                    await sleep(20);
                }
                target.dispatchEvent(new MouseEvent('mouseup', opts(ex, ey)));
                return true;
            }
            if (a === 'mouse_down' || a === 'mouse_move' || a === 'mouse_up') {
                const vx = Number(args.x), vy = Number(args.y);
                if (!Number.isFinite(vx) || !Number.isFinite(vy)) return false;
                const target = document.elementFromPoint(vx, vy) || document.body;
                const evtName = a === 'mouse_down' ? 'mousedown' : a === 'mouse_up' ? 'mouseup' : 'mousemove';
                target.dispatchEvent(new MouseEvent(evtName, {bubbles: true, cancelable: true, view: window, button: 0, clientX: vx, clientY: vy}));
                return true;
            }
            if (a === 'hold') {
                const vx = Number(args.x), vy = Number(args.y);
                const ms = Number(args.duration_ms || 10000);
                if (!Number.isFinite(vx) || !Number.isFinite(vy)) return false;
                addOverlayMarker(vx, vy, 'hold ' + Math.round(ms / 1000) + 's');
                const target = document.elementFromPoint(vx, vy) || document.body;
                const opts = {bubbles: true, cancelable: true, view: window, button: 0, clientX: vx, clientY: vy};
                target.dispatchEvent(new MouseEvent('mousedown', opts));
                await sleep(ms);
                target.dispatchEvent(new MouseEvent('mouseup', opts));
                return true;
            }
            if (a === 'screenshot' || a === 'done') return true;  // no-op in playback
            console.warn('[tool_calls] unsupported action:', a);
            return false;
        }

        switch (kind) {
            case 'tool_calls': {
                // Flat sequence (single solution) or list-of-sequences (alts).
                let items = cu;
                if (Array.isArray(cu) && cu.length > 0 && Array.isArray(cu[0])) {
                    items = cu[altIndex] || cu[0];
                }
                if (!Array.isArray(items)) break;
                let step = 0;
                for (const call of items) {
                    step += 1;
                    await execToolCall(call, step, items.length);
                    await sleep(stepDelay);
                }
                // No implicit submit — the GT must include it explicitly.
                break;
            }
            case 'single_xy': {
                const xy = extractXY(cu);
                if (xy) { clickAtImage(xy[0], xy[1], '1'); await sleep(stepDelay); }
                await sleep(stepDelay);
                await clickSubmit();
                break;
            }
            case 'multi_xy': {
                if (Array.isArray(cu)) {
                    let i = 0;
                    for (const item of cu) {
                        const xy = extractXY(item);
                        if (xy) {
                            i += 1;
                            clickAtImage(xy[0], xy[1], String(i));
                            post({type: 'cu_play_step', step: i, total: cu.length});
                            await sleep(stepDelay);
                        }
                    }
                }
                await sleep(stepDelay);
                await clickSubmit();
                break;
            }
            case 'multi_swap': {
                const pair = Array.isArray(cu) ? cu[altIndex] : null;
                if (Array.isArray(pair)) {
                    let i = 0;
                    for (const item of pair) {
                        const xy = extractXY(item);
                        if (xy) { i += 1; clickAtImage(xy[0], xy[1], String(i)); await sleep(stepDelay); }
                    }
                }
                await sleep(stepDelay);
                await clickSubmit();
                break;
            }
            case 'option': {
                const idx = (cu && typeof cu === 'object') ? (cu.select_option_index ?? 0) : 0;
                const right = findArrow('right');
                for (let i = 0; i < idx; i++) {
                    if (!right) break;
                    markElementCenter(right, '→' + (i + 1));
                    right.click();
                    post({type: 'cu_play_step', step: i + 1, total: idx});
                    await sleep(stepDelay / 2);
                }
                await sleep(stepDelay);
                await clickSubmit();
                break;
            }
            case 'rotate': {
                const target = (cu && typeof cu === 'object') ? (cu.rotate_to_angle ?? 0) : 0;
                const turns = Math.round(((target % 360) + 360) % 360 / 90);
                const right = findArrow('right');
                for (let i = 0; i < turns; i++) {
                    if (!right) break;
                    markElementCenter(right, '↻' + (i + 1));
                    right.click();
                    await sleep(stepDelay / 2);
                }
                await sleep(stepDelay);
                await clickSubmit();
                break;
            }
            case 'type_text': {
                const txt = (cu && typeof cu === 'object') ? String(cu.type_text ?? '') : '';
                const input = document.getElementById('user-answer');
                if (input) {
                    markElementCenter(input, 'type');
                    input.focus();
                    input.value = txt;
                    input.dispatchEvent(new Event('input', {bubbles: true}));
                }
                await sleep(stepDelay);
                await clickSubmit();
                break;
            }
            case 'hold': {
                const ms = (cu && typeof cu === 'object') ? (cu.duration_ms ?? 3000) : 3000;
                const btn = document.querySelector(
                    '.hold-button, .hold-btn, button.hold, .submit-btn, #hold-button'
                );
                if (btn) {
                    markElementCenter(btn, 'hold ' + Math.round(ms / 1000) + 's');
                    const r = btn.getBoundingClientRect();
                    const cx = r.left + r.width / 2;
                    const cy = r.top + r.height / 2;
                    const opts = {bubbles: true, cancelable: true, view: window, button: 0, clientX: cx, clientY: cy};
                    btn.dispatchEvent(new MouseEvent('mousedown', opts));
                    await sleep(ms);
                    btn.dispatchEvent(new MouseEvent('mouseup', opts));
                }
                break;
            }
            case 'drag': {
                const drag = (cu && typeof cu === 'object') ? cu.drag : null;
                if (!drag || !Array.isArray(drag.to)) break;
                const img = imgEl();
                if (!img) break;
                const r = img.getBoundingClientRect();
                const sx = r.width / (img.naturalWidth || r.width);
                const sy = r.height / (img.naturalHeight || r.height);
                const target = document.querySelector(
                    '.component-image, .slider-component, .drag-component, [data-draggable]'
                ) || img;
                const tr = target.getBoundingClientRect();
                const fromX = Array.isArray(drag.from) ? r.left + drag.from[0] * sx : tr.left + tr.width / 2;
                const fromY = Array.isArray(drag.from) ? r.top + drag.from[1] * sy : tr.top + tr.height / 2;
                const toX = r.left + drag.to[0] * sx;
                const toY = r.top + drag.to[1] * sy;
                addOverlayMarker(fromX, fromY, '↓');
                addOverlayMarker(toX, toY, '↑');
                const opts = (x, y) => ({bubbles: true, cancelable: true, view: window, button: 0, clientX: x, clientY: y});
                target.dispatchEvent(new MouseEvent('mousedown', opts(fromX, fromY)));
                await sleep(80);
                const steps = 20;
                for (let i = 1; i <= steps; i++) {
                    const x = fromX + (toX - fromX) * (i / steps);
                    const y = fromY + (toY - fromY) * (i / steps);
                    target.dispatchEvent(new MouseEvent('mousemove', opts(x, y)));
                    await sleep(20);
                }
                target.dispatchEvent(new MouseEvent('mouseup', opts(toX, toY)));
                await sleep(stepDelay);
                await clickSubmit();
                break;
            }
            default:
                console.warn('[cu_play_gt] unsupported kind:', kind);
        }
        post({type: 'cu_play_done', kind});
    }

    // Tell the parent the page is hydrated enough to receive `cu_play_gt`.
    // Sent once on every puzzle load (see displayPuzzle below).
    function notifyReady() {
        try { window.parent && window.parent.postMessage({type: 'cu_ready'}, '*'); } catch {}
    }

    // Warm the browser image cache for every option/grid image the page might
    // swap in later (right/left arrow on Image_Matching etc.). Validation
    // option PNGs are ~2.4 MB at 1024×1024 — without preload, each arrow click
    // would block on the network for several seconds and the playback would
    // look frozen.
    function preloadPuzzleImages(data) {
        // Returns a Promise that resolves once every image needed for playback
        // has actually completed loading (or errored). Callers that need to
        // signal "ready" to the parent frame must await this — otherwise the
        // first arrow-click can land before the angle-variant image is fetched
        // and the iframe shows the stale frame.
        if (!data || typeof data !== 'object') return Promise.resolve();
        const urls = [];
        for (const k of ['option_images', 'images']) {
            const v = data[k];
            if (Array.isArray(v)) urls.push(...v);
        }
        for (const k of ['reference_image', 'object_image', 'order_image', 'background_image', 'component_image', 'image_path']) {
            const v = data[k];
            if (typeof v === 'string') urls.push(v);
        }
        // Rotation_Match swaps object_image src to {base}_{angle}.png on every
        // arrow click. Preload all 8 variants so rotations are instant.
        if (data.puzzle_type === 'Rotation_Match' && typeof data.object_image === 'string') {
            // object_image looks like /captcha_data/Rotation_Match/cat_0.png?split=X
            const m = data.object_image.match(/^(.+_)\d+(\.[a-zA-Z]+)(\?.*)?$/);
            if (m) {
                const [, prefix, ext, query = ''] = m;
                for (const a of [0, 45, 90, 135, 180, 225, 270, 315]) {
                    urls.push(`${prefix}${a}${ext}${query}`);
                }
            }
        }
        const dedup = Array.from(new Set(urls.filter((u) => typeof u === 'string' && u)));
        if (dedup.length === 0) return Promise.resolve();
        return Promise.all(dedup.map((u) => new Promise((resolve) => {
            const im = new Image();
            im.onload = () => resolve();
            im.onerror = () => resolve();  // don't block on a 404
            im.src = u;
        })));
    }

    // Add debug mode selector
    // setupDebugModeSelector();

    // Functions
    function handleImageClick(e) {
        if (currentPuzzle && currentPuzzle.input_type === 'click' && !processingClick) {
            // Prevent multiple clicks while processing
            processingClick = true;
            
            // Get click coordinates relative to the image (CSS rect frame —
            // used for the visual marker)
            const rect = e.target.getBoundingClientRect();
            const rectX = Math.round(e.clientX - rect.left);
            const rectY = Math.round(e.clientY - rect.top);
            let x = rectX;
            let y = rectY;

            // Pick_Area and Geometry_Click are judged in image-natural pixels
            // (mask-based GT), so scale-correct the submitted click like
            // Click_Order does. Other click types (Misleading_Click) keep rect coords.
            const baseType = currentPuzzle.puzzle_type.replace(/_\d+$/, '');
            const isPickArea = baseType === 'Pick_Area';
            // Misleading_Click is mask-judged (natural pixels) only when the
            // server flags mask_mode; legacy rect-avoid_area data stays rect.
            const isMaskClick = isPickArea || baseType === 'Geometry_Click' ||
                (baseType === 'Misleading_Click' && currentPuzzle.mask_mode);
            if (isMaskClick && e.target.naturalWidth > 0 && rect.width > 0) {
                x = Math.round((e.clientX - rect.left) * e.target.naturalWidth / rect.width);
                y = Math.round((e.clientY - rect.top) * e.target.naturalHeight / rect.height);
            }

            // Store coordinates for submission
            clickCoordinates = [x, y];

            // Show where user clicked (always in rect/CSS coords)
            showClickMarker(rectX, rectY);

            // Record trajectory step
            HumanTrajectory.record('click', {x, y});

            // Log for debugging
            console.log('Click received:', { x, y, target: e.target.id });
            
            // Special handling for Misleading_Click to show if click is in avoid area
            if (currentPuzzle.puzzle_type === 'Misleading_Click' && currentPuzzle.avoid_area) {
                const { x: areaX, y: areaY, width: areaWidth, height: areaHeight } = currentPuzzle.avoid_area;
                
                // Check if click is within the avoid area
                const inAvoidArea = (
                    areaX <= x && x <= areaX + areaWidth &&
                    areaY <= y && y <= areaY + areaHeight
                );
                
                if (inAvoidArea) {
                    console.log('Click is inside the avoid area! This is incorrect.');
                    
                    // Add a visual indicator
                    const marker = document.querySelector('.click-marker');
                    if (marker) {
                        marker.style.borderColor = 'red';
                        marker.style.backgroundColor = 'rgba(255, 0, 0, 0.7)';
                    }
                } else {
                    console.log('Click is outside the avoid area! This is correct.');
                    
                    // Add a visual indicator
                    const marker = document.querySelector('.click-marker');
                    if (marker) {
                        marker.style.borderColor = 'green';
                        marker.style.backgroundColor = 'rgba(0, 255, 0, 0.7)';
                    }
                }
            }
            // Special handling for Pick_Area to show if click is in the target area.
            // NOTE: this marker color is approximate feedback only (bbox/polygon
            // check in natural pixels); the authoritative judgement is the
            // server-side mask check in /api/check_answer.
            else if (isPickArea) {
                // Get the ground truth data to validate the click
                fetch('/api/get_ground_truth', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        puzzle_type: currentPuzzle.puzzle_type,
                        puzzle_id: currentPuzzle.puzzle_id
                    })
                })
                .then(response => response.json())
                .then(gtData => {
                    if (gtData.answer && gtData.answer.area) {
                        // Extract area boundaries from the ground truth
                        const [[minX, minY], [maxX, maxY]] = gtData.answer.area;
                        
                        // Basic rectangular check
                        const inRectArea = (minX <= x && x <= maxX && minY <= y && y <= maxY);
                        
                        // For more accurate curve detection:
                        let polygon = gtData.answer.polygon || null;
                        // New mask-based GT carries the exact region outline as
                        // normalized [0,1] coords — scale to natural pixels.
                        if (!polygon && gtData.answer.region_polygon_norm && e.target.naturalWidth > 0) {
                            polygon = gtData.answer.region_polygon_norm.map(
                                ([px, py]) => [px * e.target.naturalWidth, py * e.target.naturalHeight]
                            );
                        }
                        let inPolygonArea = false;
                        if (polygon) {
                            // If we have a polygon definition for the curved area
                            inPolygonArea = pointInPolygon(x, y, polygon);
                        }

                        // Determine if the click is in the target area
                        // Use polygon if available, otherwise fall back to rectangular check
                        const inArea = polygon ? inPolygonArea : inRectArea;
                        
                        // Get the marker element
                        const marker = document.querySelector('.click-marker');
                        if (marker) {
                            if (inArea) {
                                console.log('Click is inside the target area! This is correct.');
                                marker.style.borderColor = 'green';
                                marker.style.backgroundColor = 'rgba(0, 255, 0, 0.7)';
                                
                                // Add a success message
                                const successMsg = document.createElement('div');
                                successMsg.className = 'success-msg';
                                successMsg.textContent = 'In largest area!';
                                successMsg.style.position = 'absolute';
                                successMsg.style.top = '-25px';
                                successMsg.style.left = '50%';
                                successMsg.style.transform = 'translateX(-50%)';
                                successMsg.style.backgroundColor = 'rgba(0, 128, 0, 0.9)';
                                successMsg.style.color = 'white';
                                successMsg.style.padding = '3px 8px';
                                successMsg.style.borderRadius = '3px';
                                successMsg.style.fontSize = '12px';
                                successMsg.style.fontWeight = 'bold';
                                marker.appendChild(successMsg);
                            } else {
                                console.log('Click is outside the target area! This is incorrect.');
                                marker.style.borderColor = 'red';
                                marker.style.backgroundColor = 'rgba(255, 0, 0, 0.7)';
                                
                                // Add an error message
                                const errorMsg = document.createElement('div');
                                errorMsg.className = 'error-msg';
                                errorMsg.textContent = 'Not in largest area!';
                                errorMsg.style.position = 'absolute';
                                errorMsg.style.top = '-25px';
                                errorMsg.style.left = '50%';
                                errorMsg.style.transform = 'translateX(-50%)';
                                errorMsg.style.backgroundColor = 'rgba(255, 0, 0, 0.9)';
                                errorMsg.style.color = 'white';
                                errorMsg.style.padding = '3px 8px';
                                errorMsg.style.borderRadius = '3px';
                                errorMsg.style.fontSize = '12px';
                                errorMsg.style.fontWeight = 'bold';
                                marker.appendChild(errorMsg);
                            }
                        }
                    }
                })
                .catch(error => {
                    console.error('Error validating click for Pick_Area:', error);
                });
            }
            
            // Auto-submit after click
            setTimeout(() => {
                submitAnswer();
            }, 500); // Increase delay slightly to allow for fetch response
        }
    }

    // Function to handle rotation
    function setupRotationControls() {
        // Remove any existing controls first
        const existingControls = document.querySelector('.rotation-controls');
        if (existingControls) {
            existingControls.remove();
        }
        
        // Create rotation controls
        const rotationControls = document.createElement('div');
        rotationControls.className = 'rotation-controls';
        
        // Create left rotation button
        const leftBtn = document.createElement('button');
        leftBtn.className = 'rotate-left';
        leftBtn.innerHTML = '&#8630;'; // Counter-clockwise arrow
        leftBtn.setAttribute('aria-label', 'Rotate left');
        
        // Create right rotation button
        const rightBtn = document.createElement('button');
        rightBtn.className = 'rotate-right';
        rightBtn.innerHTML = '&#8631;'; // Clockwise arrow
        rightBtn.setAttribute('aria-label', 'Rotate right');
        
        // Add buttons to controls
        rotationControls.appendChild(leftBtn);
        rotationControls.appendChild(rightBtn);
        
        // Add to puzzle container
        const imageWrapper = document.querySelector('.puzzle-image-wrapper');
        
        // Create a container for the reference image
        const referenceContainer = document.createElement('div');
        referenceContainer.className = 'reference-image-container';
        const referenceImg = document.createElement('img');
        referenceImg.id = 'reference-image';
        referenceImg.src = currentPuzzle.reference_image;
        referenceImg.alt = 'Reference direction';
        referenceContainer.appendChild(referenceImg);
        
        // Create a container for the object image
        const objectContainer = document.createElement('div');
        objectContainer.className = 'object-image-container';
        const objectImg = document.createElement('img');
        objectImg.id = 'object-image';
        objectImg.src = currentPuzzle.object_image;
        objectImg.alt = 'Rotatable object';
        objectContainer.appendChild(objectImg);
        
        // Create a two-column layout for rotation puzzle
        const rotationLayout = document.createElement('div');
        rotationLayout.className = 'rotation-layout';
        rotationLayout.appendChild(referenceContainer);
        rotationLayout.appendChild(objectContainer);
        
        // Replace the existing puzzle image
        puzzleImageContainer.innerHTML = '';
        puzzleImageContainer.appendChild(rotationLayout);
        
        // Add rotation controls below the image
        imageWrapper.appendChild(rotationControls);

        // Indicator dots (8 discrete 45° steps), built as REAL DOM nodes — not a
        // static CSS pseudo-element — so the active dot tracks the angle as the
        // user rotates. Reuses .indicator-dots/.dot, positioned by body.arrow-cycle.
        const rotationDots = document.createElement('div');
        rotationDots.className = 'indicator-dots rotation-dots';
        for (let i = 0; i < 8; i++) {
            const dot = document.createElement('span');
            dot.className = 'dot';
            rotationDots.appendChild(dot);
        }
        imageWrapper.appendChild(rotationDots);
        
        // Add event listeners for rotation buttons
        leftBtn.addEventListener('click', () => rotateObject(-45));
        rightBtn.addEventListener('click', () => rotateObject(45));
        
        // Set initial angle
        currentRotationAngle = currentPuzzle.current_angle || 0;
        updateObjectRotation();
    }
    
    function rotateObject(angleDelta) {
        // Update the current angle
        currentRotationAngle = (currentRotationAngle + angleDelta) % 360;
        if (currentRotationAngle < 0) {
            currentRotationAngle += 360;
        }
        HumanTrajectory.recordSync('rotate', {delta: angleDelta, angle: currentRotationAngle});
        
        // Apply the rotation
        updateObjectRotation();
        
        // Log for debugging
        console.log('Rotated to:', currentRotationAngle);
    }
    
    function updateObjectRotation() {
        const objectImg = document.getElementById('object-image');
        if (objectImg) {
            // Option 1: Use CSS transform to rotate the image
            objectImg.style.transform = `rotate(${currentRotationAngle}deg)`;
            
            // Option 2: Load a pre-rotated image if available
            // This would require having images at each rotation angle
            const baseName = currentPuzzle.object_base;
            // Find the closest pre-rotated image (0, 90, 180, 270)
            const angles = [0, 45, 90, 135, 180, 225, 270, 315];
            const closestAngle = angles.reduce((prev, curr) => 
                Math.abs(curr - currentRotationAngle) < Math.abs(prev - currentRotationAngle) ? curr : prev
            );
            
            // Load the pre-rotated image. Preserve the ?split=... query from
            // currentPuzzle.object_image so the right split's data dir is hit
            // (otherwise the bare /captcha_data/... 404s under split routing).
            const srcQ = (currentPuzzle.object_image || '').split('?')[1];
            const qs = srcQ ? `?${srcQ}` : '';
            const rotatedImagePath = `/captcha_data/${currentPuzzle.puzzle_type}/${baseName}_${closestAngle}.png${qs}`;
            objectImg.src = rotatedImagePath;
            
            // Apply any additional rotation needed
            const remainingRotation = currentRotationAngle - closestAngle;
            if (remainingRotation !== 0) {
                objectImg.style.transform = `rotate(${remainingRotation}deg)`;
            } else {
                objectImg.style.transform = 'none';
            }
        }
        // Sync indicator dots to the current 45° step (active dot follows the angle).
        // Runs on initial setup and every rotateObject() call.
        const rotStep = (((Math.round(currentRotationAngle / 45)) % 8) + 8) % 8;
        document.querySelectorAll('.rotation-dots .dot').forEach((d, i) => {
            d.classList.toggle('active', i === rotStep);
        });
    }

    // Function to set up sliding puzzle
    function setupSlidePuzzle() {
        // Remove any existing controls first
        const existingSlider = document.querySelector('.slider-component');
        if (existingSlider) {
            existingSlider.remove();
        }
        
        // Clear the puzzle image container
        puzzleImageContainer.innerHTML = '';
        
        // Create a container for the background image
        const backgroundContainer = document.createElement('div');
        backgroundContainer.className = 'background-container';
        backgroundContainer.style.position = 'relative';
        backgroundContainer.style.width = '100%';
        backgroundContainer.style.height = 'auto';
        
        // Add background image. NOTE: `src` is assigned LAST so callers below
        // can register onload before the network load completes. With the new
        // preload pipeline the image is usually already in the HTTP cache and
        // would otherwise resolve synchronously — registering onload after
        // .src would silently miss the event, leaving the slider unpositioned.
        const backgroundImg = document.createElement('img');
        backgroundImg.alt = 'Slide puzzle background';
        backgroundImg.style.width = '100%';
        backgroundImg.style.height = 'auto';
        backgroundImg.style.display = 'block';
        backgroundContainer.appendChild(backgroundImg);
        
        // Create draggable slider component
        // Declare drag-state vars early — onBgReady can fire synchronously
        // when the image is HTTP-cached, and would otherwise hit `let` TDZ.
        let currentX = 0;
        let currentY = 0;

        const sliderComponent = document.createElement('div');
        sliderComponent.className = 'slider-component';
        sliderComponent.style.position = 'absolute';
        sliderComponent.style.cursor = 'move';
        sliderComponent.style.zIndex = '10';
        sliderComponent.style.userSelect = 'none';
        sliderComponent.style.touchAction = 'none';
        // Width is computed in onBgReady to match the bg's CSS scale so the
        // piece visually fits the cut-out hole. Default keeps old behaviour
        // for any non-Slide_Puzzle path that might query it.
        sliderComponent.style.width = '50px';

        // Add component image. Same pattern as backgroundImg: defer src.
        const componentImg = document.createElement('img');
        componentImg.alt = 'Slide component';
        // Fill the slider element exactly — no 150% overflow trick, so the
        // bounding rect matches the visible piece and submit math is honest.
        componentImg.style.width = '100%';
        componentImg.style.height = 'auto';
        componentImg.style.display = 'block';
        componentImg.draggable = false; // Prevent default dragging behavior
        sliderComponent.appendChild(componentImg);
        
        // Add slider component to the background container
        backgroundContainer.appendChild(sliderComponent);
        
        // Add the whole setup to the puzzle image container
        puzzleImageContainer.appendChild(backgroundContainer);
        
        // Wait for images to load to get proper dimensions. Register handlers
        // BEFORE assigning .src so a cache-hit (preloaded image) still triggers
        // the positioning code. If the image is already complete by the time
        // we get here, we invoke the handler explicitly.
        const onBgReady = () => {
            // Get container dimensions
            const containerWidth = backgroundImg.width;
            const containerHeight = backgroundImg.height;

            const onCompReady = () => {
                // Don't override the slider's default 50-px width. The original
                // dataset was designed for a ~75-px-on-screen piece (50 × the
                // 150% inner styling), and the puzzle "hole" in each bg image
                // is sized to match that. Earlier code rescaled the slider to
                // `bg.w * 0.08` (= 40 px for a 500-px bg) which made the piece
                // visibly smaller than the hole. Leaving the 50 px default lets
                // the natural piece-vs-hole proportions hold.
                //
                // `componentHeight` is still needed only as a fallback for the
                // initial Y calculation below — the actual lockedTop reads the
                // post-layout `componentImg.getBoundingClientRect().height`.
                // Size the slider piece to match the bg's CSS scale so the
                // piece's rendered footprint equals the hole's footprint.
                const bgScaleX = backgroundImg.naturalWidth > 0
                    ? backgroundImg.getBoundingClientRect().width / backgroundImg.naturalWidth
                    : 1;
                const naturalCompW = componentImg.naturalWidth || 112;
                const naturalCompH = componentImg.naturalHeight || 112;
                const componentWidth = Math.round(naturalCompW * bgScaleX);
                sliderComponent.style.width = `${componentWidth}px`;
                const aspectRatio = naturalCompW / naturalCompH;
                const componentHeight = componentWidth / aspectRatio;

                // Place the slider on the **horizontal track** of the answer:
                // start x = 0 (far left) and y = target_y - rendered_compH/2 so
                // the slider's *submit centre* is exactly on `slider_track_y`.
                // CRUCIAL: use the componentImg's actually-rendered height
                // (which is `slider width * 150% / aspectRatio`), NOT the JS
                // `componentHeight` variable above. The submit handler reads
                // `componentImg.getBoundingClientRect().height` — using a
                // different value here makes Y land off-target.
                const compImgRect = componentImg.getBoundingClientRect();
                const compRenderedH = compImgRect.height || componentHeight;
                const initialLeft = 0;
                // slider_track_y is in **image-natural** pixels and represents
                // the hole's TOP-LEFT (per gen_slide_puzzle.py:121). Place the
                // piece so its TOP-LEFT matches the hole's TOP-LEFT in rect.
                const bgScaleY = backgroundImg.naturalHeight > 0
                    ? backgroundImg.getBoundingClientRect().height / backgroundImg.naturalHeight
                    : 1;
                const trackTopRect = (typeof currentPuzzle.slider_track_y === 'number')
                    ? currentPuzzle.slider_track_y * bgScaleY
                    : (containerHeight / 2);
                // Y-center piece on hole. When hole_size is provided (oversized-
                // validation fix where piece PNG was upsized but bg hole stayed
                // small), piece > hole; shift piece UP by half the diff so the
                // piece visually centers on the hole. For sane puzzles
                // (piece == hole), this reduces to initialTop = trackTopRect.
                const holeNaturalH = (Array.isArray(currentPuzzle.hole_size) ? currentPuzzle.hole_size[1] : null) || naturalCompH;
                const holeRenderedH = holeNaturalH * bgScaleY;
                const initialTop = trackTopRect + (holeRenderedH - compRenderedH) / 2;
                // Remember bgScale for the submit handler so user_xy is
                // emitted in NATURAL pixels (matching the server's target).
                sliderComponent.dataset.bgScaleX = String(bgScaleX);
                sliderComponent.dataset.bgScaleY = String(bgScaleY);
                // Remember this fixed Y — drag handlers will pin newTop to it.
                sliderComponent.dataset.lockedTop = String(initialTop);

                sliderComponent.style.left = `${initialLeft}px`;
                sliderComponent.style.top = `${initialTop}px`;

                // Initialize current position tracking variables
                currentX = initialLeft;
                currentY = initialTop;
                
                // In debug mode, fetch and show the target area
                if (DEBUG_MODE) {
                    fetch('/api/get_ground_truth', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            puzzle_type: currentPuzzle.puzzle_type,
                            puzzle_id: currentPuzzle.puzzle_id
                        })
                    })
                    .then(response => response.json())
                    .then(gtData => {
                        if (gtData.answer) {
                            // Get tolerance value if available
                            const tolerance = gtData.answer.tolerance || 15; // Default to 15px
                            showSliderTargetArea(gtData.answer, backgroundContainer, tolerance);
                        }
                    })
                    .catch(error => {
                        console.error('Error fetching ground truth:', error);
                    });
                }
            };
            componentImg.onload = onCompReady;
            componentImg.src = currentPuzzle.component_image;
            if (componentImg.complete && componentImg.naturalWidth > 0) {
                onCompReady();
            }
        };
        backgroundImg.onload = onBgReady;
        backgroundImg.src = currentPuzzle.background_image;
        if (backgroundImg.complete && backgroundImg.naturalWidth > 0) {
            onBgReady();
        }

        // NEW LAYOUT (preview, Tencent-style): the puzzle piece is display-only
        // — dragging it directly is disabled. A horizontal slider track below
        // the background hosts a square handle with an arrow; moving the
        // handle slides the puzzle piece. Handle range maps to piece range so
        // the piece centre can reach the full bg width (fixes small-target_x).
        sliderComponent.style.cursor = 'default';
        sliderComponent.style.pointerEvents = 'none';

        // Build the slider track: fill (behind) + hint text + handle (front).
        const slideTrack = document.createElement('div');
        slideTrack.className = 'slide-track';
        const slideFill = document.createElement('div');
        slideFill.className = 'slide-track-fill';
        const slideHint = document.createElement('div');
        slideHint.className = 'slide-track-hint';
        slideHint.textContent = 'Drag the puzzle piece into place';
        const slideHandle = document.createElement('div');
        slideHandle.className = 'slide-handle';
        const slideArrow = document.createElement('div');
        slideArrow.className = 'slide-handle-arrow';
        slideHandle.appendChild(slideArrow);
        slideTrack.appendChild(slideFill);
        slideTrack.appendChild(slideHint);
        slideTrack.appendChild(slideHandle);
        puzzleImageContainer.appendChild(slideTrack);

        // Drag state (currentX/currentY were declared earlier to avoid TDZ).
        let isDragging = false;
        let startMouseX, startHandleLeft;

        // Map handle.left ∈ [0, trackW - handleW] → slider.left ∈ [-ci.w/2, bg.w - ci.w/2]
        function syncPieceFromHandle(handleLeft) {
            const bgRect = backgroundContainer.getBoundingClientRect();
            const trackRect = slideTrack.getBoundingClientRect();
            const handleRect = slideHandle.getBoundingClientRect();
            const slRect = sliderComponent.getBoundingClientRect();
            const handleRange = Math.max(1, trackRect.width - handleRect.width);
            // Slider piece stays fully INSIDE the bg image (user requirement):
            // piece.left ∈ [0, bg.w - piece.w]. No overflow either side.
            const pieceMin = 0;
            const pieceMax = Math.max(0, bgRect.width - slRect.width);
            const t = handleRange > 0 ? handleLeft / handleRange : 0;
            const newLeft = pieceMin + t * (pieceMax - pieceMin);
            const lockedTop = parseFloat(sliderComponent.dataset.lockedTop);
            const newTop = isNaN(lockedTop) ? currentY : lockedTop;
            sliderComponent.style.left = `${newLeft}px`;
            sliderComponent.style.top = `${newTop}px`;
            currentX = newLeft;
            currentY = newTop;
            slideHandle.style.left = `${handleLeft}px`;
            // Progress fill follows the handle's leading edge.
            slideFill.style.width = `${handleLeft + handleRect.width / 2}px`;
        }

        // Initial: handle at 0, piece slides to match
        requestAnimationFrame(() => syncPieceFromHandle(0));

        function onMouseDown(e) {
            isDragging = true;
            startMouseX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0].clientX);
            startHandleLeft = parseFloat(slideHandle.style.left) || 0;
            slideTrack.classList.add('is-active');
            e.preventDefault();
        }
        function onMouseMove(e) {
            if (!isDragging) return;
            const cx = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0].clientX);
            const deltaX = cx - startMouseX;
            const trackRect = slideTrack.getBoundingClientRect();
            const handleRect = slideHandle.getBoundingClientRect();
            let nh = startHandleLeft + deltaX;
            const maxH = trackRect.width - handleRect.width;
            if (nh < 0) nh = 0;
            if (nh > maxH) nh = maxH;
            syncPieceFromHandle(nh);
        }
        function onMouseUp() {
            if (!isDragging) return;
            isDragging = false;
            slideTrack.classList.remove('is-active');
            const componentRect = componentImg.getBoundingClientRect();
            const centerX = currentX + (componentRect.width / 2);
            const centerY = currentY + (componentRect.height / 2);
            console.log('Slider final position (top-left):', { x: currentX, y: currentY });
            console.log('Slider center position:', { x: centerX, y: centerY });
            HumanTrajectory.record('drag', {start_x: 0, start_y: 0, end_x: Math.round(currentX), end_y: Math.round(currentY)});
        }
        slideHandle.addEventListener('mousedown', onMouseDown);
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        slideHandle.addEventListener('touchstart', onMouseDown);
        document.addEventListener('touchmove', onMouseMove);
        document.addEventListener('touchend', onMouseUp);
        
        // Add submit button for the sliding puzzle
        const submitSection = document.createElement('div');
        submitSection.className = 'slider-submit';
        const sliderSubmitBtn = document.createElement('button');
        sliderSubmitBtn.textContent = 'Submit';
        sliderSubmitBtn.className = 'submit-slider';
        
        sliderSubmitBtn.addEventListener('click', () => {
            // Server stores target_position as the hole's TOP-LEFT in image-
            // natural pixels. The piece may be visually larger than the hole
            // (oversized-validation fix), so submit the HOLE top-left computed
            // from piece CENTER (so user wins when piece centers on hole).
            // For sane puzzles (piece == hole), this reduces to piece top-left.
            const sx = parseFloat(sliderComponent.dataset.bgScaleX) || 1;
            const sy = parseFloat(sliderComponent.dataset.bgScaleY) || 1;
            const pRect = sliderComponent.getBoundingClientRect();
            const holeNaturalW = (Array.isArray(currentPuzzle.hole_size) ? currentPuzzle.hole_size[0] : null) || (pRect.width / sx);
            const holeNaturalH = (Array.isArray(currentPuzzle.hole_size) ? currentPuzzle.hole_size[1] : null) || (pRect.height / sy);
            const holeRenderedW = holeNaturalW * sx;
            const holeRenderedH = holeNaturalH * sy;
            const holeTopLeftXRect = currentX + (pRect.width - holeRenderedW) / 2;
            const holeTopLeftYRect = currentY + (pRect.height - holeRenderedH) / 2;
            const naturalX = Math.round(holeTopLeftXRect / sx);
            const naturalY = Math.round(holeTopLeftYRect / sy);
            console.log('Submitting slider position (natural hole top-left):', { x: naturalX, y: naturalY });
            submitSliderPosition(naturalX, naturalY);
        });
        
        submitSection.appendChild(sliderSubmitBtn);
        
        // Add to puzzle container
        const imageWrapper = document.querySelector('.puzzle-image-wrapper');
        imageWrapper.appendChild(submitSection);
    }
    
    // Function to show the target area for the slider in debug mode
    function showSliderTargetArea(targetPosition, container, tolerance = 15) {
        if (!DEBUG_MODE || !targetPosition) return;
        
        // Remove any existing debug targets
        const existingTarget = document.querySelector('.target-area');
        if (existingTarget) {
            existingTarget.remove();
        }
        
        // Create a target element
        const targetArea = document.createElement('div');
        targetArea.className = 'target-area';
        
        // Get target coordinates
        const [targetX, targetY] = targetPosition;
        
        // We'll visualize this as a circle
        const diameter = tolerance * 2;
        
        // Style the target area
        targetArea.style.position = 'absolute';
        targetArea.style.left = `${targetX - tolerance}px`;
        targetArea.style.top = `${targetY - tolerance}px`;
        targetArea.style.width = `${diameter}px`;
        targetArea.style.height = `${diameter}px`;
        targetArea.style.borderRadius = '50%';
        targetArea.style.border = '2px dashed green';
        targetArea.style.backgroundColor = 'rgba(0, 255, 0, 0.2)';
        targetArea.style.zIndex = '5';
        targetArea.style.pointerEvents = 'none'; // Allow clicks to pass through
        
        // Add coordinates label
        const coordsLabel = document.createElement('div');
        coordsLabel.className = 'coords-label';
        coordsLabel.textContent = `Target: (${targetX}, ${targetY}) ±${tolerance}px`;
        coordsLabel.style.position = 'absolute';
        coordsLabel.style.top = '-25px';
        coordsLabel.style.left = '0';
        coordsLabel.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
        coordsLabel.style.color = 'white';
        coordsLabel.style.padding = '2px 5px';
        coordsLabel.style.fontSize = '10px';
        coordsLabel.style.borderRadius = '3px';
        coordsLabel.style.whiteSpace = 'nowrap';
        targetArea.appendChild(coordsLabel);
        
        // Add to the container
        container.appendChild(targetArea);
        
        // Log the target details
        console.log('Target position:', { 
            x: targetX, 
            y: targetY,
            tolerance: tolerance
        });
    }

    // Function to submit slider position
    function submitSliderPosition(x, y) {
        if (!currentPuzzle) {
            resultMessage.textContent = 'Loading puzzle, please wait...';
            resultMessage.className = 'result-message incorrect';
            return;
        }
        
        // Send position to the server for verification
        fetch('/api/check_answer', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                puzzle_type: currentPuzzle.puzzle_type,
                puzzle_id: currentPuzzle.puzzle_id,
                answer: [x, y]
            })
        })
        .then(response => response.json())
        .then(data => {
            // Update stats
            benchmarkStats.total++;
            if (data.correct) {
                benchmarkStats.correct++;
                resultMessage.textContent = 'Correct! The slider was placed in the right position.';
                resultMessage.className = 'result-message correct';
            } else {
                resultMessage.textContent = 'Incorrect. Please try again with a better position.';
                resultMessage.className = 'result-message incorrect';
            }
            
            updateStats();

            // Save step-level human trajectory
            HumanTrajectory.save(
                {puzzle_type: currentPuzzle.puzzle_type, puzzle_id: currentPuzzle.puzzle_id, prompt: currentPuzzle.prompt},
                [x, y],
                data.correct,
            );

            // Record benchmark result
            recordBenchmarkResult({
                puzzle_type: currentPuzzle.puzzle_type,
                puzzle_id: currentPuzzle.puzzle_id,
                user_answer: [x, y],
                correct_answer: data.correct_answer,
                correct: data.correct
            });

            // Disable the submit button to prevent multiple submissions
            const submitBtn = document.querySelector('.submit-slider');
            if (submitBtn) {
                submitBtn.disabled = true;
            }
            
            // Also disable rotation submit button if it exists
            const rotateSubmitBtn = document.querySelector('.submit-rotation');
            if (rotateSubmitBtn) {
                rotateSubmitBtn.disabled = true;
            }
            
            // Also disable image recognition submit button if it exists
            const imageRecognitionSubmitBtn = document.querySelector('.submit-image-recognition');
            if (imageRecognitionSubmitBtn) {
                imageRecognitionSubmitBtn.disabled = true;
            }
            
            // Also disable bingo submit button if it exists
            const bingoSubmitBtn = document.querySelector('.submit-bingo');
            if (bingoSubmitBtn) {
                bingoSubmitBtn.disabled = true;
            }
            
            // Also disable image matching submit button if it exists
            const imageMatchingSubmitBtn = document.querySelector('.submit-image-matching');
            if (imageMatchingSubmitBtn) {
                imageMatchingSubmitBtn.disabled = true;
            }
            
            // Load a new puzzle after a delay
            setTimeout(loadNewPuzzle, 2000);
        })
        .catch(error => {
            console.error('Error checking answer:', error);
            resultMessage.textContent = 'Error checking answer. Please try again.';
            resultMessage.className = 'result-message incorrect';
        });
    }

    // Add this new function to show the ground truth area
    function showGroundTruthArea(answer) {
        if (!DEBUG_MODE) return;
        
        // Remove any existing debug areas
        const existingArea = document.querySelector('.debug-area');
        if (existingArea) {
            existingArea.remove();
        }
        
        // Create and style the debug area element
        const debugArea = document.createElement('div');
        debugArea.className = 'debug-area';
        debugArea.style.position = 'absolute';
        debugArea.style.pointerEvents = 'none'; // Allow clicks to pass through
        debugArea.style.zIndex = '5';
        
        if (answer && answer.area) {
            // For standard area format (geometry_click, etc.)
            const [[x1, y1], [x2, y2]] = answer.area;
            
            debugArea.style.left = `${x1}px`;
            debugArea.style.top = `${y1}px`;
            debugArea.style.width = `${x2 - x1}px`;
            debugArea.style.height = `${y2 - y1}px`;
            debugArea.style.border = '2px dashed yellow';
            debugArea.style.backgroundColor = 'rgba(255, 255, 0, 0.2)';
            
            // Add coordinates label
            const coordsLabel = document.createElement('div');
            coordsLabel.className = 'coords-label';
            coordsLabel.textContent = `TL: (${x1},${y1}) BR: (${x2},${y2})`;
            coordsLabel.style.position = 'absolute';
            coordsLabel.style.bottom = '0';
            coordsLabel.style.right = '0';
            coordsLabel.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
            coordsLabel.style.color = 'white';
            coordsLabel.style.padding = '2px 5px';
            coordsLabel.style.fontSize = '10px';
            coordsLabel.style.borderRadius = '3px';
            debugArea.appendChild(coordsLabel);
            
            // Log the area details
            console.log('Ground truth area:', { 
                topLeft: [x1, y1], 
                bottomRight: [x2, y2], 
                width: x2 - x1, 
                height: y2 - y1,
                type: answer.type
            });
        } else if (answer && answer.avoid_area) {
            // For Misleading_Click avoid_area format
            const { x, y, width, height } = answer.avoid_area;
            
            debugArea.style.left = `${x}px`;
            debugArea.style.top = `${y}px`;
            debugArea.style.width = `${width}px`;
            debugArea.style.height = `${height}px`;
            debugArea.style.border = '3px dashed red';
            debugArea.style.backgroundColor = 'rgba(255, 0, 0, 0.3)';
            
            // Add coordinates label
            const coordsLabel = document.createElement('div');
            coordsLabel.className = 'coords-label';
            coordsLabel.textContent = `Avoid Area: (${x},${y}) ${width}x${height}`;
            coordsLabel.style.position = 'absolute';
            coordsLabel.style.bottom = '0';
            coordsLabel.style.right = '0';
            coordsLabel.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
            coordsLabel.style.color = 'white';
            coordsLabel.style.padding = '2px 5px';
            coordsLabel.style.fontSize = '10px';
            coordsLabel.style.borderRadius = '3px';
            debugArea.appendChild(coordsLabel);
            
            // Add a "DO NOT CLICK HERE" sign in the middle of the area
            const warningSign = document.createElement('div');
            warningSign.className = 'warning-sign';
            warningSign.textContent = 'DO NOT CLICK HERE';
            warningSign.style.position = 'absolute';
            warningSign.style.top = '50%';
            warningSign.style.left = '50%';
            warningSign.style.transform = 'translate(-50%, -50%)';
            warningSign.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
            warningSign.style.color = '#ff5555';
            warningSign.style.padding = '5px 10px';
            warningSign.style.fontSize = '12px';
            warningSign.style.fontWeight = 'bold';
            warningSign.style.borderRadius = '3px';
            warningSign.style.whiteSpace = 'nowrap';
            warningSign.style.zIndex = '10';
            debugArea.appendChild(warningSign);
            
            // Log the area details
            console.log('Avoid area:', { x, y, width, height });
        } else {
            // If we don't have a valid format, don't show anything
            return;
        }
        
        // Add to the image container
        puzzleImageContainer.appendChild(debugArea);
    }

    // Function to fetch and show geometry click target area
    function fetchAndShowGeometryClickArea(container) {
        if (!DEBUG_MODE || !currentPuzzle) return;
        
        // Fetch ground truth data to show the correct geometric shape area
        fetch('/api/get_ground_truth', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                puzzle_type: currentPuzzle.puzzle_type,
                puzzle_id: currentPuzzle.puzzle_id
            })
        })
        .then(response => response.json())
        .then(gtData => {
            if (gtData.answer) {
                // Call showGroundTruthArea with the answer data
                showGroundTruthArea(gtData.answer);
                
                // Log for debugging
                console.log('Geometry_Click ground truth fetched:', gtData.answer);
            }
        })
        .catch(error => {
            console.error('Error fetching ground truth for Geometry_Click:', error);
        });
    }

    function showClickMarker(x, y) {
        // Remove any existing markers
        const existingMarker = document.querySelector('.click-marker');
        if (existingMarker) {
            existingMarker.remove();
        }
        
        // Create and add new marker
        const marker = document.createElement('div');
        marker.className = 'click-marker';
        marker.style.left = `${x}px`;
        marker.style.top = `${y}px`;
        
        // Add coordinates label to the marker
        const coordsLabel = document.createElement('div');
        coordsLabel.className = 'coords-label';
        coordsLabel.textContent = `(${x},${y})`;
        coordsLabel.style.position = 'absolute';
        coordsLabel.style.top = '20px';
        coordsLabel.style.left = '20px';
        coordsLabel.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
        coordsLabel.style.color = 'white';
        coordsLabel.style.padding = '2px 5px';
        coordsLabel.style.fontSize = '10px';
        coordsLabel.style.borderRadius = '3px';
        coordsLabel.style.whiteSpace = 'nowrap';
        marker.appendChild(coordsLabel);
        
        // Add it directly to the image container for proper positioning
        puzzleImageContainer.appendChild(marker);
        
        // Log for debugging
        console.log('Marker placed at:', { x, y });
        
        // Check if this is a Misleading_Click puzzle and we're in debug mode
        if (DEBUG_MODE && currentPuzzle && currentPuzzle.puzzle_type === 'Misleading_Click' && currentPuzzle.avoid_area) {
            // Get the avoid area
            const { x: areaX, y: areaY, width: areaWidth, height: areaHeight } = currentPuzzle.avoid_area;
            
            // Check if click is within the avoid area
            const inAvoidArea = (
                areaX <= x && x <= areaX + areaWidth &&
                areaY <= y && y <= areaY + areaHeight
            );
            
            // Add status indicator
            const statusIndicator = document.createElement('div');
            statusIndicator.className = 'click-status';
            statusIndicator.style.position = 'absolute';
            statusIndicator.style.top = '40px';
            statusIndicator.style.left = '20px';
            statusIndicator.style.padding = '3px 6px';
            statusIndicator.style.borderRadius = '3px';
            statusIndicator.style.fontSize = '10px';
            statusIndicator.style.fontWeight = 'bold';
            
            if (inAvoidArea) {
                statusIndicator.textContent = 'INSIDE AVOID AREA - WRONG';
                statusIndicator.style.backgroundColor = 'rgba(255, 0, 0, 0.8)';
                statusIndicator.style.color = 'white';
                marker.style.borderColor = 'red';
            } else {
                statusIndicator.textContent = 'OUTSIDE AVOID AREA - CORRECT';
                statusIndicator.style.backgroundColor = 'rgba(0, 255, 0, 0.8)';
                statusIndicator.style.color = 'black';
                marker.style.borderColor = 'green';
            }
            
            marker.appendChild(statusIndicator);
            
            // Log result
            console.log('Click check:', { inAvoidArea, message: inAvoidArea ? 'INSIDE avoid area (incorrect)' : 'OUTSIDE avoid area (correct)' });
        }
    }

    // Function to set up unusual detection grid.
    // Renders identically to Select_Animal (480px centered composite + transparent
    // overlay grid) but MULTI-select: click every unusual cell to toggle it, then
    // hit the standard Submit button below. Fixed geometry => cell centers + submit
    // are the same constants across all splits (see gen_unusual_detection.py).
    function setupUnusualDetectionGrid() {
        // Remove any existing grid first
        const existingGrid = document.querySelector('.unusual-detection-grid, .animal-select-grid');
        if (existingGrid) {
            existingGrid.remove();
        }

        // Clear the puzzle image container + reset selection
        puzzleImageContainer.innerHTML = '';
        selectedCells = [];

        // Fixed-width centered container (matches Select_Animal template)
        const container = document.createElement('div');
        container.className = 'unusual-detection-grid';
        container.style.width = '480px';
        container.style.maxWidth = '480px';
        container.style.margin = '0 auto';
        container.style.position = 'relative';

        // Display the full composite image directly
        const img = document.createElement('img');
        img.src = currentPuzzle.image_path;
        img.alt = 'CAPTCHA image with unusual items';
        img.style.width = '100%';
        img.style.display = 'block';
        img.style.border = '2px solid #ccc';
        img.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.15)';
        container.appendChild(img);

        const gridSize = currentPuzzle.grid_size || [2, 3];
        const [rows, cols] = gridSize;

        img.onload = function() {
            // Transparent overlay grid aligned to the image
            const grid = document.createElement('div');
            grid.style.position = 'absolute';
            grid.style.top = '0';
            grid.style.left = '0';
            grid.style.width = '100%';
            grid.style.height = '100%';
            grid.style.display = 'grid';
            grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
            grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

            for (let i = 0; i < rows * cols; i++) {
                const cell = document.createElement('div');
                cell.className = 'grid-cell';
                cell.dataset.index = i;
                cell.style.border = '1px solid rgba(255, 255, 255, 0.3)';
                cell.style.cursor = 'pointer';
                cell.style.position = 'relative';
                cell.style.transition = 'all 0.2s ease';

                // Checkmark shown when the cell is selected
                const checkmark = document.createElement('div');
                checkmark.className = 'checkmark';
                checkmark.innerHTML = '✓';
                checkmark.style.position = 'absolute';
                checkmark.style.top = '50%';
                checkmark.style.left = '50%';
                checkmark.style.transform = 'translate(-50%, -50%)';
                checkmark.style.color = 'white';
                checkmark.style.fontSize = '40px';
                checkmark.style.fontWeight = 'bold';
                checkmark.style.opacity = '0';
                checkmark.style.textShadow = '0 0 8px rgba(0,0,0,0.8)';
                checkmark.style.pointerEvents = 'none';
                checkmark.style.transition = 'opacity 0.2s ease';
                cell.appendChild(checkmark);

                cell.addEventListener('mouseover', () => {
                    if (!selectedCells.includes(i)) {
                        cell.style.backgroundColor = 'rgba(76, 175, 80, 0.2)';
                    }
                });
                cell.addEventListener('mouseout', () => {
                    if (!selectedCells.includes(i)) {
                        cell.style.backgroundColor = 'transparent';
                    }
                });

                // Multi-select toggle
                cell.addEventListener('click', () => {
                    const pos = selectedCells.indexOf(i);
                    if (pos >= 0) {
                        selectedCells.splice(pos, 1);
                        cell.style.backgroundColor = 'transparent';
                        cell.style.border = '1px solid rgba(255, 255, 255, 0.3)';
                        checkmark.style.opacity = '0';
                    } else {
                        selectedCells.push(i);
                        cell.style.backgroundColor = 'rgba(76, 175, 80, 0.35)';
                        cell.style.border = '2px solid rgba(76, 175, 80, 0.95)';
                        checkmark.style.opacity = '1';
                    }
                    // Keep the hidden input in sync (sorted, for consistency)
                    userAnswerInput.value = JSON.stringify([...selectedCells].sort((a, b) => a - b));
                    submitBtn.disabled = selectedCells.length === 0;
                    console.log('Selected cells:', selectedCells);
                });

                grid.appendChild(cell);
            }

            container.appendChild(grid);
        };

        puzzleImageContainer.appendChild(container);

        // Prompt styling (matches Select_Animal)
        puzzlePrompt.style.fontSize = '20px';
        puzzlePrompt.style.fontWeight = 'bold';
        puzzlePrompt.style.marginBottom = '20px';
        puzzlePrompt.textContent = currentPuzzle.prompt || 'Select the unusual items in the image';

        // Use the standard submit button below the grid
        userAnswerInput.style.display = 'none';
        submitBtn.textContent = 'Submit';
    }
    
    function toggleCellSelection(index, cellElement) {
        // Check if this cell is already selected
        const isSelected = selectedCells.includes(index);
        HumanTrajectory.recordSync('cell_toggle', {index, selected: !isSelected});

        if (isSelected) {
            // Deselect the cell
            selectedCells = selectedCells.filter(i => i !== index);
            cellElement.querySelector('.cell-overlay').style.opacity = '0';
            cellElement.querySelector('.checkmark').style.opacity = '0';
            cellElement.style.transform = 'scale(1)';
            cellElement.style.borderColor = '#333';
        } else {
            // Select the cell
            selectedCells.push(index);
            cellElement.querySelector('.cell-overlay').style.opacity = '1';
            cellElement.querySelector('.checkmark').style.opacity = '1';
            cellElement.style.transform = 'scale(0.95)';
            cellElement.style.borderColor = '#0078ff';
        }
        
        console.log('Selected cells:', selectedCells);
    }

    // Function to set up Bingo swap puzzle
    function setupBingoSwap() {
        // Remove any existing grid
        const existingGrid = document.querySelector('.bingo-grid');
        if (existingGrid) {
            existingGrid.remove();
        }
        
        // Clear the puzzle image container
        puzzleImageContainer.innerHTML = '';
        
        // Get the grid dimensions from the current puzzle data
        const gridSize = currentPuzzle.grid_size || [3, 3]; // Default to 3x3 if not specified
        const [rows, cols] = gridSize;
        
        // Create the grid container
        const gridContainer = document.createElement('div');
        gridContainer.className = 'bingo-grid';
        gridContainer.style.display = 'grid';
        gridContainer.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
        gridContainer.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
        gridContainer.style.gap = '2px';
        gridContainer.style.width = '100%';
        gridContainer.style.aspectRatio = `${cols} / ${rows}`;
        
        // First, load the full image to get its dimensions
        const fullImg = new Image();
        fullImg.onload = () => {
            const imgWidth = fullImg.width;
            const imgHeight = fullImg.height;
            const cellWidth = imgWidth / cols;
            const cellHeight = imgHeight / rows;
            
            // Create individual image elements for each cell
            const totalCells = rows * cols;
            for (let i = 0; i < totalCells; i++) {
                const cell = document.createElement('div');
                cell.className = 'grid-cell';
                cell.dataset.index = i;
                cell.style.position = 'relative';
                cell.style.border = '2px solid #333';
                cell.style.cursor = 'pointer';
                cell.style.overflow = 'hidden';
                
                // Create an individual image for this cell
                const cellImg = document.createElement('img');
                cellImg.className = 'cell-image';
                cellImg.style.width = '100%';
                cellImg.style.height = '100%';
                cellImg.style.objectFit = 'cover';
                cellImg.style.display = 'block';
                cell.appendChild(cellImg);
                
                // Calculate which part of the source image this cell represents
                const row = Math.floor(i / cols);
                const col = i % cols;
                
                // Create a canvas to extract just this portion of the image
                const canvas = document.createElement('canvas');
                canvas.width = cellWidth;
                canvas.height = cellHeight;
                const ctx = canvas.getContext('2d');
                
                // Draw just the portion we want
                ctx.drawImage(
                    fullImg,
                    col * cellWidth, row * cellHeight, // Source x, y
                    cellWidth, cellHeight, // Source width, height
                    0, 0, // Destination x, y
                    cellWidth, cellHeight // Destination width, height
                );
                
                // Create a data URL and set it as the image source
                cellImg.src = canvas.toDataURL();
                
                // Create an overlay for selection state
                const overlay = document.createElement('div');
                overlay.className = 'cell-overlay';
                overlay.style.position = 'absolute';
                overlay.style.top = '0';
                overlay.style.left = '0';
                overlay.style.width = '100%';
                overlay.style.height = '100%';
                overlay.style.backgroundColor = 'rgba(0, 120, 255, 0.5)';
                overlay.style.opacity = '0';
                overlay.style.transition = 'opacity 0.2s ease';
                overlay.style.pointerEvents = 'none';
                cell.appendChild(overlay);
                
                // Add click handler for selection
                cell.addEventListener('click', (e) => {
                    toggleBingoCellSelection(i, cell);
                });
                
                // Add the cell to the grid
                gridContainer.appendChild(cell);
            }
            
            // Add the grid to the puzzle image container
            puzzleImageContainer.appendChild(gridContainer);
            
            // Add a submit button below the grid
            const submitSection = document.createElement('div');
            submitSection.className = 'bingo-submit';
            submitSection.style.textAlign = 'center';
            submitSection.style.marginTop = '15px';
            
            const bingoSubmitBtn = document.createElement('button');
            bingoSubmitBtn.textContent = 'Swap and Submit';
            bingoSubmitBtn.className = 'submit-bingo';
            bingoSubmitBtn.addEventListener('click', () => {
                if (bingoSelectedCells.length === 2) {
                    // Visually swap the cells
                    swapBingoCells();
                    // Submit the answer
                    setTimeout(submitAnswer, 500);
                } else {
                    resultMessage.textContent = 'Please select exactly two cells to swap.';
                    resultMessage.className = 'result-message error';
                }
            });
            submitSection.appendChild(bingoSubmitBtn);
            
            // Add to puzzle container
            const imageWrapper = document.querySelector('.puzzle-image-wrapper');
            imageWrapper.appendChild(submitSection);
            
            // Reset selected cells
            bingoSelectedCells = [];
        };
        
        // Set the source to load the image
        fullImg.src = currentPuzzle.image_path;
        fullImg.style.display = 'none';
    }

    function toggleBingoCellSelection(index, cellElement) {
        const overlay = cellElement.querySelector('.cell-overlay');
        
        // Check if this cell is already selected
        const selectedIndex = bingoSelectedCells.indexOf(index);
        
        if (selectedIndex !== -1) {
            // If already selected, unselect it
            bingoSelectedCells.splice(selectedIndex, 1);
            overlay.style.opacity = '0';
        } else {
            // If we already have 2 selected cells, remove the first one
            if (bingoSelectedCells.length >= 2) {
                const firstCell = document.querySelector(`.grid-cell[data-index="${bingoSelectedCells[0]}"]`);
                if (firstCell) {
                    firstCell.querySelector('.cell-overlay').style.opacity = '0';
                }
                bingoSelectedCells.shift(); // Remove the first element
            }
            
            // Add this cell to selected
            bingoSelectedCells.push(index);
            overlay.style.opacity = '0.5';
        }
        
        console.log('Selected cells for Bingo:', bingoSelectedCells);
    }

    function swapBingoCells() {
        if (bingoSelectedCells.length !== 2) return;
        
        // Get the two cells to swap
        const cell1 = document.querySelector(`.grid-cell[data-index="${bingoSelectedCells[0]}"]`);
        const cell2 = document.querySelector(`.grid-cell[data-index="${bingoSelectedCells[1]}"]`);
        
        if (!cell1 || !cell2) return;
        
        // Get the images inside the cells
        const img1 = cell1.querySelector('.cell-image');
        const img2 = cell2.querySelector('.cell-image');
        
        if (!img1 || !img2) return;
        
        // Swap the image sources
        const tempSrc = img1.src;
        img1.src = img2.src;
        img2.src = tempSrc;
        
        // Apply a highlight to the solution line if it exists
        if (currentPuzzle.solution_line) {
            // Get the answer from the ground truth
            const correctSwaps = currentPuzzle.answer;
            const selectedSwapSet = new Set(bingoSelectedCells);
            
            // Check which solution was achieved by comparing our selection with possible answers
            let solutionKey = null;
            
            // Check vertical solution
            if (currentPuzzle.solution_line.vertical && 
                checkIfSolutionMatches(correctSwaps, selectedSwapSet)) {
                solutionKey = 'vertical';
            } 
            // Check horizontal solution
            else if (currentPuzzle.solution_line.horizontal && 
                checkIfSolutionMatches(correctSwaps, selectedSwapSet)) {
                solutionKey = 'horizontal';
            }
            // Check diagonal solution
            else if (currentPuzzle.solution_line.diagonal && 
                checkIfSolutionMatches(correctSwaps, selectedSwapSet)) {
                solutionKey = 'diagonal';
            }
            
            // If we found a matching solution, highlight it
            if (solutionKey && currentPuzzle.solution_line[solutionKey]) {
                for (const cellIndex of currentPuzzle.solution_line[solutionKey]) {
                    const solutionCell = document.querySelector(`.grid-cell[data-index="${cellIndex}"]`);
                    if (solutionCell) {
                        solutionCell.style.border = '2px solid green';
                    }
                }
            }
        }
    }
    
    // Helper function to check if selected cells match any solution
    function checkIfSolutionMatches(correctSwaps, selectedSwapSet) {
        // Go through each possible correct swap and check if our selection matches any of them
        for (const correctSwap of correctSwaps) {
            const correctSwapSet = new Set(correctSwap);
            // Check if our selected cells match this solution (order doesn't matter)
            if (setsEqual(selectedSwapSet, correctSwapSet)) {
                return true;
            }
        }
        return false;
    }
    
    // Helper function to compare sets for equality
    function setsEqual(set1, set2) {
        if (set1.size !== set2.size) return false;
        for (const item of set1) {
            if (!set2.has(item)) return false;
        }
        return true;
    }

    // // Function to set up the debug mode selector

    // function setupDebugModeSelector() {
    //     // Create the debug selector container
    //     const debugContainer = document.createElement('div');
    //     debugContainer.className = 'debug-selector';
    //     debugContainer.style.marginTop = '10px';
    //     debugContainer.style.marginBottom = '10px';
    //     debugContainer.style.padding = '10px';
    //     debugContainer.style.backgroundColor = '#f0f0f0';
    //     debugContainer.style.borderRadius = '4px';
    //     debugContainer.style.display = 'flex';
    //     debugContainer.style.alignItems = 'center';
    //     debugContainer.style.justifyContent = 'center';
    //     debugContainer.style.flexWrap = 'wrap';
        
    //     // Create a label
    //     const label = document.createElement('label');
    //     label.htmlFor = 'debug-type-selector';
    //     label.textContent = 'Puzzle Type: ';
    //     label.style.marginRight = '10px';
    //     label.style.fontWeight = 'bold';
        
    //     // Create the select element
    //     const select = document.createElement('select');
    //     select.id = 'debug-type-selector';
    //     select.style.padding = '5px';
    //     select.style.marginRight = '10px';
        
    //     // Default option - random puzzles
    //     const defaultOption = document.createElement('option');
    //     defaultOption.value = '';
    //     defaultOption.textContent = 'Random (All Types)';
    //     select.appendChild(defaultOption);
        
    //     // Fetch available CAPTCHA types from the API
    //     fetch('/api/types')
    //         .then(response => response.json())
    //         .then(data => {
    //             if (data.types && data.types.length > 0) {
    //                 // Add options for each CAPTCHA type
    //                 data.types.forEach(type => {
    //                     const option = document.createElement('option');
    //                     option.value = type;
    //                     option.textContent = type;
    //                     select.appendChild(option);
    //                 });
                    
    //                 // Check if there's a debug type in URL parameters
    //                 const urlParams = new URLSearchParams(window.location.search);
    //                 const typeParam = urlParams.get('type');
    //                 if (typeParam) {
    //                     select.value = typeParam;
    //                     debugPuzzleType = typeParam;
    //                 }
    //             }
    //         })
    //         .catch(error => {
    //             console.error('Error fetching CAPTCHA types:', error);
    //         });
        
    //     // Create apply button
    //     const applyBtn = document.createElement('button');
    //     applyBtn.textContent = 'Apply';
    //     applyBtn.style.padding = '5px 10px';
    //     applyBtn.style.backgroundColor = '#4CAF50';
    //     applyBtn.style.color = 'white';
    //     applyBtn.style.border = 'none';
    //     applyBtn.style.borderRadius = '4px';
    //     applyBtn.style.cursor = 'pointer';
        
    //     // Add event listener to the button
    //     applyBtn.addEventListener('click', () => {
    //         debugPuzzleType = select.value;
    //         // Update URL parameter
    //         const url = new URL(window.location);
    //         if (debugPuzzleType) {
    //             url.searchParams.set('type', debugPuzzleType);
    //             // Show the debug indicator
    //             const debugIndicator = document.getElementById('debug-indicator');
    //             const debugTypeDisplay = document.getElementById('debug-type-display');
    //             if (debugIndicator && debugTypeDisplay) {
    //                 debugTypeDisplay.textContent = debugPuzzleType;
    //                 debugIndicator.style.display = 'block';
    //             }
    //         } else {
    //             url.searchParams.delete('type');
    //             // Hide the debug indicator
    //             const debugIndicator = document.getElementById('debug-indicator');
    //             if (debugIndicator) {
    //                 debugIndicator.style.display = 'none';
    //             }
    //         }
    //         window.history.pushState({}, '', url);
            
    //         // Load a new puzzle with the selected type
    //         loadNewPuzzle();
    //     });
        
    //     // Initialize the debug indicator if there's a type parameter
    //     if (debugPuzzleType) {
    //         const debugIndicator = document.getElementById('debug-indicator');
    //         const debugTypeDisplay = document.getElementById('debug-type-display');
    //         if (debugIndicator && debugTypeDisplay) {
    //             debugTypeDisplay.textContent = debugPuzzleType;
    //             debugIndicator.style.display = 'block';
    //         }
    //     }
        
    //     // Add elements to container
    //     debugContainer.appendChild(label);
    //     debugContainer.appendChild(select);
    //     debugContainer.appendChild(applyBtn);
        
    //     // Add container to the benchmark stats section
    //     const benchmarkStats = document.querySelector('.benchmark-stats');
    //     benchmarkStats.parentNode.insertBefore(debugContainer, benchmarkStats.nextSibling);
    // }
     // // Function to set up the debug mode selector



    function loadNewPuzzle() {
        // Reset state
        clickCoordinates = null;
        processingClick = false;
        currentRotationAngle = 0;
        selectedCells = [];
        bingoSelectedCells = [];
        
        // Remove any click markers and debug areas
        const existingMarker = document.querySelector('.click-marker');
        if (existingMarker) {
            existingMarker.remove();
        }
        
        const existingArea = document.querySelector('.debug-area');
        if (existingArea) {
            existingArea.remove();
        }
        
        // Remove any rotation controls
        const existingControls = document.querySelector('.rotation-controls');
        if (existingControls) {
            existingControls.remove();
        }
        
        // Remove any existing rotation submit buttons
        const existingRotationSubmit = document.querySelector('.rotation-submit');
        if (existingRotationSubmit) {
            existingRotationSubmit.remove();
        }
        
        // Remove any slider components and submit buttons
        const existingSliderSubmit = document.querySelector('.slider-submit');
        if (existingSliderSubmit) {
            existingSliderSubmit.remove();
        }
        
        // Remove any unusual detection grid and submit buttons
        const existingUnusualSubmit = document.querySelector('.unusual-submit');
        if (existingUnusualSubmit) {
            existingUnusualSubmit.remove();
        }
        
        // Remove any image recognition grid and submit buttons
        const existingImageRecognitionSubmit = document.querySelector('.image-recognition-submit');
        if (existingImageRecognitionSubmit) {
            existingImageRecognitionSubmit.remove();
        }
        
        // Remove any bingo grid and submit buttons
        const existingBingoSubmit = document.querySelector('.bingo-submit');
        if (existingBingoSubmit) {
            existingBingoSubmit.remove();
        }
        
        // After checking and removing existingImageMatchingControls
        const existingImageMatchingControls = document.querySelector('.image-matching-controls');
        if (existingImageMatchingControls) {
            existingImageMatchingControls.remove();
        }
        
        const existingImageMatchingSubmit = document.querySelector('.image-matching-submit');
        if (existingImageMatchingSubmit) {
            existingImageMatchingSubmit.remove();
        }
        
        // Remove any dart count controls and submit buttons
        const existingDartCountSubmit = document.querySelector('.dart-count-submit');
        if (existingDartCountSubmit) {
            existingDartCountSubmit.remove();
        }
        
        // Remove any object match controls and submit buttons
        const existingObjectMatchSubmit = document.querySelector('.object-match-submit');
        if (existingObjectMatchSubmit) {
            existingObjectMatchSubmit.remove();
        }
        
        // Remove any connect icon controls and submit buttons
        const existingConnectIconSubmit = document.querySelector('.connect-icon-submit');
        if (existingConnectIconSubmit) {
            existingConnectIconSubmit.remove();
        }
        
        // Remove any hold button components
        const existingHoldButton = document.querySelector('.hold-button-container');
        if (existingHoldButton) {
            existingHoldButton.remove();
        }
        
        // Reset the puzzle prompt and image
        puzzlePrompt.textContent = 'Loading puzzle...';
        resultMessage.textContent = '';
        resultMessage.className = 'result-message';
        
        // Reset the submit button text
        submitBtn.textContent = 'Submit';
        submitBtn.disabled = false;
        
        // Reset input field display
        userAnswerInput.style.display = 'block';
        
        // Construct URL: use specific puzzle endpoint in single-puzzle mode
        let url;
        if (SINGLE_PUZZLE && URL_PUZZLE_TYPE && URL_PUZZLE_ID) {
            url = `/api/get_puzzle_by_id?type=${encodeURIComponent(URL_PUZZLE_TYPE)}&id=${encodeURIComponent(URL_PUZZLE_ID)}`;
        } else {
            url = '/api/get_puzzle?mode=sequential';
        }
        
        // Get a random puzzle from any available type
        fetch(url)
            .then(response => response.json())
            .then(data => {
                console.log("Received puzzle data:", data);
                currentPuzzle = data;
                window.currentPuzzle = data;
                // Defer cu_ready until every puzzle image has finished loading
                // (option variants, reference, all 8 rotation angles, etc.) so
                // the first arrow-click in playback can't land before the
                // target image is in the HTTP cache.
                preloadPuzzleImages(data).then(notifyReady);

                // Start trajectory recording for this puzzle
                HumanTrajectory.reset();
                HumanTrajectory.record('puzzle_loaded', {
                    puzzle_type: data.puzzle_type,
                    puzzle_id: data.puzzle_id,
                    input_type: data.input_type,
                    prompt: data.prompt,
                });

                // Update the puzzle prompt
                if (data.prompt) {
                    puzzlePrompt.textContent = data.prompt;
                } else if (data.puzzle_type === 'Dice_Count') {
                    puzzlePrompt.textContent = "Sum up the numbers on all the dice";
                }
                
                // Important: Always display difficulty stars based on puzzle type
                displayDifficultyStars(data.puzzle_type);
                
                // Reset container
                puzzleImageContainer.innerHTML = '';

                // Bingo renders a 3x3 grid sliced from the source image, so it is
                // sized off the image (big/odd Validation images blow it up and drift
                // every cell). The .bingo-fixed rules in style.css pin it to a fixed
                // 414x414 centered grid + submit on its own line. Toggle the class on
                // every load so only Bingo is affected and task-switching cleans up.
                document.body.classList.toggle('bingo-fixed', data.input_type === 'bingo_swap');

                // Arrow-cycle family (Connect_icon, Coordinates, Dart_Count,
                // Image_Matching, Object_Match, Path_Finder, Rotation_Match —
                // collapsed to 5 input_types) shares ONE fixed layout: each
                // card half centers its image, a single circular ←/→ sits at
                // (560,847)/(720,847) and Submit at (640,924). The
                // body.arrow-cycle rules in style.css pin those so the buttons
                // land at identical coords across every task AND split — which
                // is exactly what lets the tool_calls GT use one shared set of
                // arrow/submit constants. Toggle per load so task-switching
                // cleans up.
                const ARROW_CYCLE_INPUTS = ['rotation', 'image_matching', 'dart_count', 'object_match', 'connect_icon'];
                document.body.classList.toggle('arrow-cycle', ARROW_CYCLE_INPUTS.indexOf(data.input_type) !== -1);

                // Configure input based on puzzle type
                if (data.input_type === 'click') {
                    // Setup for click-based CAPTCHAs (Geometry_Click, Misleading_Click, Pick_Area)
                    puzzleImage.src = data.image_path;
                    inputGroup.style.display = 'none';
                    puzzleImage.style.cursor = 'pointer';
                    puzzleImage.classList.add('clickable');
                    
                    // Add puzzle image back to container
                    if (puzzleImageContainer.innerHTML === '') {
                        puzzleImageContainer.appendChild(puzzleImage);
                    }
                    
                    puzzleImageContainer.style.display = 'block';
                    puzzleImage.style.display = 'block';
                    
                    // Reset click coordinates for new puzzle
                    clickCoordinates = null;
                    
                    // Update prompt text
                    if (data.prompt) {
                        puzzlePrompt.textContent = data.prompt;
                    } else if (data.puzzle_type === 'Geometry_Click') {
                        puzzlePrompt.textContent = "Click on the geometric shape";
                    } else if (data.puzzle_type === 'Misleading_Click') {
                        puzzlePrompt.textContent = "Click the image to continue";

                        // Make sure avoid_area is stored in currentPuzzle object
                        if (data.avoid_area) {
                            currentPuzzle.avoid_area = data.avoid_area;
                            console.log('Loaded avoid_area:', data.avoid_area);
                        }
                    } else if (data.puzzle_type === 'Pick_Area') {
                        puzzlePrompt.textContent = "Click on the largest area outlined by the dotted line";
                    }

                    // Don't force a width on Geometry_Click. The server
                    // compares rect-relative click against `answer.area`
                    // (image-natural bbox), so the image must render at its
                    // natural size for click coords to match.
                    puzzleImage.style.width = '';
                    puzzleImage.style.height = '';
                    
                    // For debugging, when image loads, show the target areas
                    puzzleImage.onload = () => {
                        if (DEBUG_MODE) {
                            // Show ground truth area differently based on puzzle type
                            if (data.puzzle_type === 'Pick_Area') {
                                showPickAreaTargets(puzzleImageContainer);
                            } else if (data.puzzle_type === 'Geometry_Click') {
                                fetchAndShowGeometryClickArea(puzzleImageContainer);
                            } else if (data.puzzle_type === 'Misleading_Click') {
                                // For misleading click, show the area to avoid
                                if (data.avoid_area) {
                                    showMisleadingClickArea(puzzleImageContainer, data.avoid_area);
                                }
                            }
                        }
                    };
                } else if (data.input_type === 'rotation') {
                    // Setup for rotation-based CAPTCHAs
                    inputGroup.style.display = 'none';
                    puzzleImage.style.display = 'none';
                    puzzleImageContainer.style.display = 'block';
                    
                    // Update prompt first to ensure it's from the rotation puzzle
                    if (data.prompt) {
                        puzzlePrompt.textContent = data.prompt;
                    } else {
                        puzzlePrompt.textContent = "Use the arrows to rotate the object to match the reference direction.";
                    }
                    
                    // Set up rotation interface
                    setupRotationControls();
                    
                    // Auto-show submit button for rotation puzzles
                    const submitSection = document.createElement('div');
                    submitSection.className = 'rotation-submit';
                    const rotateSubmitBtn = document.createElement('button');
                    rotateSubmitBtn.textContent = 'Submit';
                    rotateSubmitBtn.className = 'submit-rotation';
                    rotateSubmitBtn.addEventListener('click', submitAnswer);
                    submitSection.appendChild(rotateSubmitBtn);
                    
                    // Add to puzzle container
                    const imageWrapper = document.querySelector('.puzzle-image-wrapper');
                    imageWrapper.appendChild(submitSection);
                } else if (data.input_type === 'slide') {
                    // Setup for slide-based CAPTCHAs
                    inputGroup.style.display = 'none';
                    puzzleImage.style.display = 'none';
                    puzzleImageContainer.style.display = 'block';
                    
                    // Update prompt for the slide puzzle
                    if (data.prompt) {
                        puzzlePrompt.textContent = data.prompt;
                    } else {
                        puzzlePrompt.textContent = "Drag the slider component to the correct position.";
                    }
                    
                    // Set up sliding puzzle interface
                    setupSlidePuzzle();
                } else if (data.input_type === 'multiselect') {
                    // Setup for unusual detection CAPTCHAs
                    puzzleImage.style.display = 'none';
                    puzzleImageContainer.style.display = 'block';

                    // Keep the input-group visible so the standard submit button shows
                    // (like Select_Animal); only hide the raw text input.
                    inputGroup.style.display = '';
                    userAnswerInput.style.display = 'none';
                    submitBtn.textContent = 'Submit';
                    submitBtn.style.display = 'block';

                    // Update prompt for the unusual detection puzzle
                    if (data.prompt) {
                        puzzlePrompt.textContent = data.prompt;
                    } else {
                        puzzlePrompt.textContent = "Select the unusual items in the image.";
                    }

                    // Set up unusual detection grid
                    setupUnusualDetectionGrid();
                } else if (data.input_type === 'image_grid') {
                    // Setup for image recognition CAPTCHAs
                    inputGroup.style.display = 'none';
                    puzzleImage.style.display = 'none';
                    puzzleImageContainer.style.display = 'block';
                    
                    // Update prompt for the image recognition puzzle
                    if (data.prompt) {
                        puzzlePrompt.textContent = data.prompt;
                    } else if (data.question) {
                        puzzlePrompt.textContent = data.question;
                    } else {
                        puzzlePrompt.textContent = "Select all images that match the description.";
                    }
                    
                    // Set up image recognition grid
                    setupImageRecognition();
                } else if (data.input_type === 'bingo_swap') {
                    // Setup for Bingo swap CAPTCHA
                    inputGroup.style.display = 'none';
                    puzzleImage.style.display = 'none';
                    puzzleImageContainer.style.display = 'block';
                    
                    // Update prompt for the Bingo puzzle
                    if (data.prompt) {
                        puzzlePrompt.textContent = data.prompt;
                    } else {
                        puzzlePrompt.textContent = "Please click two images to exchange their position to line up the same images to a line, you can only exchange the images once.";
                    }
                    
                    // Set up Bingo grid
                    setupBingoSwap();
                } else if (data.input_type === 'image_matching') {
                    // Setup for Image Matching CAPTCHA
                    inputGroup.style.display = 'none';
                    puzzleImage.style.display = 'none';
                    puzzleImageContainer.style.display = 'block';
                    
                    // Update prompt for the Image Matching puzzle
                    if (data.prompt) {
                        puzzlePrompt.textContent = data.prompt;
                    } else {
                        puzzlePrompt.textContent = "Using the arrows, match the animal in the left and right image.";
                    }
                    
                    // Set up Image Matching interface
                    setupImageMatching();
                } else if (data.input_type === 'patch_select') {
                    // Hide standard input display but keep it for value storage
                    userAnswerInput.style.display = 'none';
                    
                    // Customize submit button
                    submitBtn.textContent = 'Verify';
                    submitBtn.style.display = 'block';
                    
                    // Setup patch selection grid
                    setupPatchSelectGrid();
                } else if (data.input_type === 'dart_count') {
                    // Hide standard input display but keep it for value storage
                    userAnswerInput.style.display = 'none';
                    inputGroup.style.display = 'none';
                    puzzleImage.style.display = 'none';
                    puzzleImageContainer.style.display = 'block';
                    
                    // Update prompt for the dart count puzzle
                    if (data.prompt) {
                        puzzlePrompt.textContent = data.prompt;
                    } else {
                        puzzlePrompt.textContent = "Use the arrows to find the darts that add up to the target number.";
                    }
                    
                    // Debug log
                    console.log('Setting up Dart Count puzzle with data:', data);
                    
                    // Setup dart count interface
                    setupDartCount();
                } else if (data.input_type === 'select_animal') {
                    // Hide standard input display but keep it for value storage
                    userAnswerInput.style.display = 'none';
                    
                    // Customize submit button
                    submitBtn.textContent = 'Submit';
                    submitBtn.style.display = 'block';
                    
                    // Setup animal selection grid
                    setupSelectAnimalGrid();
                } else if (data.input_type === 'object_match') {
                    // Setup for object match puzzles
                    inputGroup.style.display = 'none';
                    puzzleImage.style.display = 'none';
                    puzzleImageContainer.style.display = 'block';
                    
                    // Update prompt
                    if (data.prompt) {
                        puzzlePrompt.textContent = data.prompt;
                    } else {
                        puzzlePrompt.textContent = "Use the arrows to change the number of objects until it matches the left image.";
                    }
                    
                    // Set up object match interface
                    setupObjectMatch();
                } else if (data.input_type === 'place_dot') {
                    // Setup for Place_Dot CAPTCHAs
                    inputGroup.style.display = 'none';
                    puzzleImage.style.display = 'none';
                    puzzleImageContainer.style.display = 'block';
                    
                    // Update prompt
                    if (data.prompt) {
                        puzzlePrompt.textContent = data.prompt;
                    } else {
                        puzzlePrompt.textContent = "Click to place a Dot at the end of the car's path";
                    }
                    
                    // Set up place dot interface
                    setupPlaceDot();
                } else if (data.input_type === 'connect_icon') {
                    // Setup for Connect_icon CAPTCHAs
                    inputGroup.style.display = 'none';
                    puzzleImage.style.display = 'none';
                    puzzleImageContainer.style.display = 'block';
                    
                    // Update prompt
                    if (data.prompt) {
                        puzzlePrompt.textContent = data.prompt;
                    } else {
                        puzzlePrompt.textContent = "Using the arrows, connect the same two icons with the dotted line as shown on the left.";
                    }
                    
                    // Set up connect icon interface
                    setupConnectIcon();
                } else if (data.input_type === 'click_order') {
                    // Setup for Click_Order CAPTCHAs
                    inputGroup.style.display = 'none';
                    puzzleImage.style.display = 'none';
                    puzzleImageContainer.style.display = 'block';
                    
                    // Update prompt
                    if (data.prompt) {
                        puzzlePrompt.textContent = data.prompt;
                    } else {
                        puzzlePrompt.textContent = "Click the icons in order as shown in the reference image.";
                    }
                    
                    // Set up click order interface
                    setupClickOrder();
                } else if (data.input_type === 'hold_button') {
                    // Setup for Hold_Button CAPTCHAs — minimal static layout:
                    // just the HOLD button, no puzzle image, no submit row.
                    // The button auto-submits when the hold completes.
                    inputGroup.style.display = 'none';
                    puzzleImage.style.display = 'none';
                    puzzleImageContainer.style.display = 'block';

                    if (data.prompt) {
                        puzzlePrompt.textContent = data.prompt;
                    } else {
                        puzzlePrompt.textContent = "Press and hold the button to verify.";
                    }

                    setupHoldButton();

                    userAnswerInput.style.display = 'none';
                    submitBtn.style.display = 'none';
                } else {
                    // Default for text-based CAPTCHAs
                    puzzleImage.src = data.image_path;
                    inputGroup.style.display = 'flex';
                    puzzleImage.style.cursor = 'default';
                    puzzleImage.classList.remove('clickable');
                    
                    // Add puzzle image back to container
                    if (puzzleImageContainer.innerHTML === '') {
                        puzzleImageContainer.appendChild(puzzleImage);
                    }
                    
                    puzzleImageContainer.style.display = 'block';
                    puzzleImage.style.display = 'block';
                    
                    // Update prompt after clearing
                    if (data.prompt) {
                        puzzlePrompt.textContent = data.prompt;
                    } else if (data.puzzle_type === 'Dice_Count') {
                        puzzlePrompt.textContent = "Sum up the numbers on all the dice";
                    }
                    
                    // Reset submit button
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Submit';
                    
                    // Clear and focus input
                    userAnswerInput.value = '';
                    userAnswerInput.focus();
                    
                    // Set input type based on puzzle type
                    if (data.input_type === 'number') {
                        userAnswerInput.setAttribute('type', 'number');
                        userAnswerInput.setAttribute('placeholder', 'Enter the sum');
                    } else {
                        userAnswerInput.setAttribute('type', 'text');
                        userAnswerInput.setAttribute('placeholder', 'Your answer');
                    }
                    
                    // Ensure the input is visible
                    userAnswerInput.style.display = 'block';
                }
            })
            .catch(error => {
                console.error('Error loading puzzle:', error);
                // Try again after a delay if there was an error
                setTimeout(loadNewPuzzle, 3000);
            });
    }

    // Function to create fireworks effect for correct answers
    function createFireworks() {
        // Create container for fireworks
        const fireworksContainer = document.createElement('div');
        fireworksContainer.className = 'fireworks-container';
        document.body.appendChild(fireworksContainer);

        // Create happy face animation
        const happyFaceContainer = document.createElement('div');
        happyFaceContainer.className = 'happy-face-container';
        happyFaceContainer.textContent = '😄';
        happyFaceContainer.style.zIndex = '10000'; // Ensure it's above everything
        document.body.appendChild(happyFaceContainer);
        
        // Create multiple fireworks at random positions
        const colors = [
            '#FF0000', '#00FF00', '#0000FF', '#FFFF00', 
            '#FF00FF', '#00FFFF', '#FFA500', '#FF4500',
            '#FFD700', '#32CD32', '#8A2BE2', '#FF69B4'
        ];
        
        // Create more fireworks (150 instead of 100)
        for (let i = 0; i < 150; i++) {
            const firework = document.createElement('div');
            firework.className = 'firework';
            
            // Random position - spread across the screen, with more concentration near center
            const centerBias = Math.random() > 0.7; // 30% chance to be centered
            const x = centerBias 
                ? window.innerWidth/2 + (Math.random() - 0.5) * window.innerWidth/2
                : Math.random() * window.innerWidth;
            const y = centerBias
                ? window.innerHeight/2 + (Math.random() - 0.5) * window.innerHeight/2
                : Math.random() * window.innerHeight;
            
            // Random color
            const color = colors[Math.floor(Math.random() * colors.length)];
            
            // Random size (larger particles)
            const size = 5 + Math.random() * 8;
            
            // Random delay and duration
            const delay = Math.random() * 1.5;
            const duration = 0.8 + Math.random() * 1.2;
            
            // Apply styles
            firework.style.left = `${x}px`;
            firework.style.top = `${y}px`;
            firework.style.backgroundColor = color;
            firework.style.width = `${size}px`;
            firework.style.height = `${size}px`;
            firework.style.animationDelay = `${delay}s`;
            firework.style.animationDuration = `${duration}s`;
            
            // Add to container
            fireworksContainer.appendChild(firework);
        }
        
        // Remove containers after animation completes
        setTimeout(() => {
            fireworksContainer.remove();
            happyFaceContainer.remove();
        }, 3500);
    }
    
    // Function to create sad face effect for incorrect answers
    function createSadFace() {
        // Create container for sad face
        const sadFaceContainer = document.createElement('div');
        sadFaceContainer.className = 'sad-face-container';
        sadFaceContainer.textContent = '😢';
        document.body.appendChild(sadFaceContainer);

        // Remove container after animation completes
        setTimeout(() => {
            sadFaceContainer.remove();
        }, 2000);
    }

    function submitAnswer() {
        // Don't submit if there's no input for number/text input types
        if ((currentPuzzle.input_type === 'number' || currentPuzzle.input_type === 'text') && 
            !userAnswerInput.value.trim()) {
            // Don't submit empty answers for number/text inputs
            return;
        }
        
        // Disable submit button to prevent double submissions
        submitBtn.disabled = true;
        submitBtn.textContent = 'Processing...';
        
        let answerData = {
            puzzle_type: currentPuzzle.puzzle_type,
            puzzle_id: currentPuzzle.puzzle_id
        };

        // Record the type_text step if user typed something
        if (userAnswerInput.value.trim()) {
            HumanTrajectory.recordSync('type_text', {text: userAnswerInput.value.trim()});
        }

        // Handle different input types
        if (currentPuzzle.input_type === 'click' && clickCoordinates) {
            // For click input, send the click coordinates
            answerData.answer = clickCoordinates;
        } else if (currentPuzzle.input_type === 'rotation') {
            // For rotation input, send the current rotation angle
            answerData.answer = currentRotationAngle;
        } else if (currentPuzzle.input_type === 'slide') {
            // For slide puzzle, calculate the current position of the slider
            const sliderComponent = document.querySelector('.slider-component');
            if (sliderComponent) {
                // Get the current position (from CSS left/top values)
                const currentX = parseInt(sliderComponent.style.left) || 0;
                const currentY = parseInt(sliderComponent.style.top) || 0;
                
                // Add slider position to answer data
                answerData.answer = [currentX, currentY];
            } else {
                console.error('Slider component not found');
                // Re-enable submit button
                submitBtn.disabled = false;
                submitBtn.textContent = 'Check Position';
                return;
            }
        } else if (currentPuzzle.input_type === 'multiselect') {
            // For multiselect input, send the selected cell indices
            answerData.answer = selectedCells;
        } else if (currentPuzzle.input_type === 'image_grid') {
            // For image grid selection, send the selected image indices
            answerData.answer = selectedCells;
        } else if (currentPuzzle.input_type === 'bingo_swap') {
            // For bingo swap, send the selected cells to swap
            answerData.answer = bingoSelectedCells;
        } else if (currentPuzzle.input_type === 'image_matching') {
            // For image matching, send the current option index
            const currentOptionIndex = currentPuzzle.current_option_index || 0;
            answerData.answer = currentOptionIndex;
        } else if (currentPuzzle.input_type === 'dart_count') {
            // For dart count, send the selected option index
            const selectedIndex = parseInt(userAnswerInput.value);
            answerData.answer = selectedIndex;
        } else if (currentPuzzle.input_type === 'patch_select') {
            // For patch select, send the selected patch indices
            try {
                // Try to parse the JSON value from the input
                const parsedSelection = JSON.parse(userAnswerInput.value);
                
                // If parsed array is empty but global selectedCells is not, use global
                if (parsedSelection.length === 0 && selectedCells.length > 0) {
                    answerData.answer = selectedCells;
                } else {
                    answerData.answer = parsedSelection;
                }
            } catch (error) {
                console.error('Error parsing selected patches:', error);
                // Fallback to the global array if parsing fails
                answerData.answer = selectedCells;
            }
        } else if (currentPuzzle.input_type === 'select_animal') {
            // For select animal, send the selected animal index
            try {
                // If the value is empty, use the global selectedAnimalIndex
                if (userAnswerInput.value === '[]' || userAnswerInput.value.trim() === '') {
                    answerData.answer = selectedAnimalIndex >= 0 ? [selectedAnimalIndex] : [];
                } else {
                    // Otherwise parse the JSON from the input
                    const selectedAnimal = JSON.parse(userAnswerInput.value);
                    answerData.answer = selectedAnimal;
                }
            } catch (error) {
                console.error('Error parsing selected animal:', error);
                // Use the global variable as a fallback
                answerData.answer = selectedAnimalIndex >= 0 ? [selectedAnimalIndex] : [];
            }
        } else if (currentPuzzle.input_type === 'object_match') {
            // For object match, send the selected option index
            const selectedIndex = parseInt(puzzleImageContainer.dataset.currentOptionIndex);
            answerData.answer = selectedIndex;
        } else if (currentPuzzle.input_type === 'place_dot') {
            // For place_dot input, send the click coordinates
            if (!clickCoordinates) {
                console.error('No dot coordinates found');
                // Re-enable submit button
                submitBtn.disabled = false;
                submitBtn.textContent = 'Submit';
                return;
            }
            answerData.answer = clickCoordinates;
        } else if (currentPuzzle.input_type === 'connect_icon') {
            // For connect_icon, send the current option index
            answerData.answer = parseInt(userAnswerInput.value) || 0;
        } else if (currentPuzzle.input_type === 'hold_button') {
            // For hold button, get the elapsed time from the input field
            answerData.answer = parseFloat(userAnswerInput.value) || 0;
            answerData.elapsed_time = ((Date.now() - puzzleStartTime) / 1000).toFixed(2);
        } else {
            // For text/number inputs, use the input value
            answerData.answer = userAnswerInput.value.trim();
        }
        
        // Send answer to server for verification
        fetch('/api/check_answer', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(answerData)
        })
        .then(response => response.json())
        .then(data => {
            // Update stats
            benchmarkStats.total++;
            if (data.correct) {
                benchmarkStats.correct++;
                resultMessage.textContent = 'Correct!';
                resultMessage.className = 'result-message correct';
                
                // Create fireworks effect for correct answer
                createFireworks();
            } else {
                // Just show "Incorrect" without revealing the correct answer
                resultMessage.textContent = 'Incorrect.';
                resultMessage.className = 'result-message incorrect';
                
                // Create sad face effect for incorrect answer
                createSadFace();
            }
            
            updateStats();

            // Save step-level human trajectory
            HumanTrajectory.save(
                {puzzle_type: currentPuzzle.puzzle_type, puzzle_id: currentPuzzle.puzzle_id, prompt: currentPuzzle.prompt},
                answerData.answer,
                data.correct,
            );

            // Record benchmark result
            recordBenchmarkResult({
                puzzle_type: currentPuzzle.puzzle_type,
                puzzle_id: currentPuzzle.puzzle_id,
                user_answer: answerData.answer,
                correct_answer: data.correct_answer,
                correct: data.correct
            });
            
            // Disable the submit button after submission
            if (currentPuzzle.input_type !== 'click') {
                submitBtn.disabled = true;
                
                // Also disable rotation submit button if it exists
                const rotateSubmitBtn = document.querySelector('.submit-rotation');
                if (rotateSubmitBtn) {
                    rotateSubmitBtn.disabled = true;
                }
                
                // Also disable image recognition submit button if it exists
                const imageRecognitionSubmitBtn = document.querySelector('.submit-image-recognition');
                if (imageRecognitionSubmitBtn) {
                    imageRecognitionSubmitBtn.disabled = true;
                }
                
                // Also disable bingo submit button if it exists
                const bingoSubmitBtn = document.querySelector('.submit-bingo');
                if (bingoSubmitBtn) {
                    bingoSubmitBtn.disabled = true;
                }
                
                // Also disable image matching submit button if it exists
                const imageMatchingSubmitBtn = document.querySelector('.submit-image-matching');
                if (imageMatchingSubmitBtn) {
                    imageMatchingSubmitBtn.disabled = true;
                }
            }
            
            // After handling the result: advance to next puzzle unless in single-puzzle mode
            if (!SINGLE_PUZZLE) {
                setTimeout(() => {
                    submitBtn.textContent = 'Submit';
                    userAnswerInput.style.display = 'block';
                    loadNewPuzzle();
                }, 2000);
            }
            // In single-puzzle mode the result stays visible; the external orchestrator
            // detects the outcome and controls what happens next.
        })
        .catch(error => {
            console.error('Error checking answer:', error);
            resultMessage.textContent = 'Error checking answer. Please try again.';
            resultMessage.className = 'result-message incorrect';
            // Re-enable the submit button on error
            submitBtn.disabled = false;
            submitBtn.textContent = 'Submit';
        });
    }

    function updateStats() {
        totalCount.textContent = benchmarkStats.total;
        correctCount.textContent = benchmarkStats.correct;
        
        const accuracy = benchmarkStats.total > 0 
            ? ((benchmarkStats.correct / benchmarkStats.total) * 100).toFixed(1) 
            : '0.0';
        
        accuracyEl.textContent = `${accuracy}%`;
    }

    function recordBenchmarkResult(result) {
        // Ensure we have the timestamp field
        if (!result.timestamp) {
            result.timestamp = new Date().toISOString();
        }
        
        // Send the benchmark result to be recorded
        fetch('/api/benchmark_results', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(result)
        })
        .then(response => response.json())
        .then(data => {
            console.log('Benchmark result recorded:', data);
        })
        .catch(error => {
            console.error('Error recording benchmark result:', error);
        });
    }
    
    // Auto-start benchmark when page loads
    loadNewPuzzle();

    // Function to update position display for the slider
    function updateSliderPositionDisplay(x, y, componentWidth, componentHeight) {
        // Remove any existing position display
        const existingDisplay = document.querySelector('.slider-position-display');
        if (existingDisplay) {
            existingDisplay.remove();
        }
        
        if (!DEBUG_MODE) return;
        
        // Calculate center point
        const centerX = x + (componentWidth / 2);
        const centerY = y + (componentHeight / 2);
        
        // Create the position display element
        const posDisplay = document.createElement('div');
        posDisplay.className = 'slider-position-display';
        posDisplay.textContent = `Position: (${Math.round(centerX)}, ${Math.round(centerY)})`;
        posDisplay.style.position = 'fixed';
        posDisplay.style.top = '10px';
        posDisplay.style.right = '10px';
        posDisplay.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
        posDisplay.style.color = 'white';
        posDisplay.style.padding = '5px 10px';
        posDisplay.style.borderRadius = '4px';
        posDisplay.style.fontSize = '12px';
        posDisplay.style.zIndex = '1000';
        
        // Add to document body
        document.body.appendChild(posDisplay);
    }

    // Function to set up image recognition grid
    function setupImageRecognition() {
        // Remove any existing grid
        const existingGrid = document.querySelector('.image-recognition-grid');
        if (existingGrid) {
            existingGrid.remove();
        }
        
        // Clear the puzzle image container
        puzzleImageContainer.innerHTML = '';
        
        // Get the grid dimensions
        const gridSize = currentPuzzle.grid_size || [3, 3]; // Default to 3x3 grid
        const [rows, cols] = gridSize;
        
        // Create the grid container
        const gridContainer = document.createElement('div');
        gridContainer.className = 'image-recognition-grid';
        gridContainer.style.display = 'grid';
        gridContainer.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
        gridContainer.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
        gridContainer.style.gap = '5px';
        // Fixed visual size so the submit button has a predictable layout next
        // to it (mirrors what Bingo does). Height scales with cols/rows ratio.
        const _grWidth = 450;
        gridContainer.style.width = _grWidth + 'px';
        gridContainer.style.height = Math.round(_grWidth * rows / cols) + 'px';
        gridContainer.style.maxWidth = '100%';
        
        // Get the list of images
        const images = currentPuzzle.images || [];
        
        // Create individual cells for each image
        for (let i = 0; i < images.length; i++) {
            const cell = document.createElement('div');
            cell.className = 'grid-cell';
            cell.dataset.index = i;
            cell.style.position = 'relative';
            cell.style.border = '2px solid #333';
            cell.style.cursor = 'pointer';
            cell.style.overflow = 'hidden';
            
            // Create image element
            const img = document.createElement('img');
            img.src = images[i];
            img.style.width = '100%';
            img.style.height = '100%';
            img.style.objectFit = 'cover';
            img.style.display = 'block';
            cell.appendChild(img);
            
            // Create an overlay for selection state
            const overlay = document.createElement('div');
            overlay.className = 'cell-overlay';
            overlay.style.position = 'absolute';
            overlay.style.top = '0';
            overlay.style.left = '0';
            overlay.style.width = '100%';
            overlay.style.height = '100%';
            overlay.style.backgroundColor = 'rgba(0, 120, 255, 0.5)';
            overlay.style.opacity = '0';
            overlay.style.transition = 'opacity 0.2s ease';
            overlay.style.pointerEvents = 'none';
            cell.appendChild(overlay);
            
            // Add a checkmark icon to indicate selection
            const checkmark = document.createElement('div');
            checkmark.className = 'checkmark';
            checkmark.innerHTML = '✓';
            checkmark.style.position = 'absolute';
            checkmark.style.top = '50%';
            checkmark.style.left = '50%';
            checkmark.style.transform = 'translate(-50%, -50%)';
            checkmark.style.color = 'white';
            checkmark.style.fontSize = '32px';
            checkmark.style.fontWeight = 'bold';
            checkmark.style.opacity = '0';
            checkmark.style.transition = 'opacity 0.2s ease';
            checkmark.style.pointerEvents = 'none';
            cell.appendChild(checkmark);
            
            // Add click handler for selection
            cell.addEventListener('click', (e) => {
                toggleCellSelection(i, cell);
            });
            
            // Add the cell to the grid
            gridContainer.appendChild(cell);
        }
        
        // Add the grid to the puzzle image container
        puzzleImageContainer.appendChild(gridContainer);
        
        // Add a submit button below the grid
        const submitSection = document.createElement('div');
        submitSection.className = 'image-recognition-submit';
        submitSection.style.textAlign = 'center';
        submitSection.style.marginTop = '15px';
        submitSection.style.display = 'block';
        submitSection.style.width = '100%';

        const submitBtn = document.createElement('button');
        submitBtn.textContent = 'Submit';
        submitBtn.className = 'submit-image-recognition';
        submitBtn.addEventListener('click', submitAnswer);
        submitSection.appendChild(submitBtn);

        // Append below the grid (inside the same container) so the submit
        // button sits centered under the grid, not pushed off to one side.
        puzzleImageContainer.appendChild(submitSection);
        
        // Reset selected cells
        selectedCells = [];
    }

    // Function to set up Image Matching puzzle
    function setupImageMatching() {
        // Remove any existing controls first
        const existingControls = document.querySelector('.image-matching-controls');
        if (existingControls) {
            existingControls.remove();
        }
        
        // Clear the puzzle image container
        puzzleImageContainer.innerHTML = '';
        
        // Create a container for the reference image
        const referenceContainer = document.createElement('div');
        referenceContainer.className = 'reference-image-container';
        const referenceImg = document.createElement('img');
        referenceImg.id = 'reference-image';
        referenceImg.src = currentPuzzle.reference_image;
        referenceImg.alt = 'Reference image';
        referenceContainer.appendChild(referenceImg);
        
        // Create a container for the option image
        const optionContainer = document.createElement('div');
        optionContainer.className = 'option-image-container';
        const optionImg = document.createElement('img');
        optionImg.id = 'option-image';
        optionImg.src = currentPuzzle.option_images[0]; // Start with the first option
        optionImg.alt = 'Option image';
        optionContainer.appendChild(optionImg);
        
        // Create a two-column layout for image matching puzzle
        const matchingLayout = document.createElement('div');
        matchingLayout.className = 'matching-layout';
        matchingLayout.appendChild(referenceContainer);
        matchingLayout.appendChild(optionContainer);
        
        // Replace the existing puzzle image
        puzzleImageContainer.innerHTML = '';
        puzzleImageContainer.appendChild(matchingLayout);
        
        // Create navigation controls
        const navControls = document.createElement('div');
        navControls.className = 'image-matching-controls';
        
        // Create left navigation button
        const leftBtn = document.createElement('button');
        leftBtn.className = 'navigate-left';
        leftBtn.innerHTML = '&#9664;'; // Left arrow
        leftBtn.setAttribute('aria-label', 'Previous image');
        
        // Create right navigation button
        const rightBtn = document.createElement('button');
        rightBtn.className = 'navigate-right';
        rightBtn.innerHTML = '&#9654;'; // Right arrow
        rightBtn.setAttribute('aria-label', 'Next image');
        
        // Create indicator dots
        const indicatorContainer = document.createElement('div');
        indicatorContainer.className = 'indicator-dots';
        
        for (let i = 0; i < currentPuzzle.option_images.length; i++) {
            const dot = document.createElement('span');
            dot.className = i === 0 ? 'dot active' : 'dot';
            indicatorContainer.appendChild(dot);
        }
        
        // Add buttons and indicators to controls
        navControls.appendChild(leftBtn);
        navControls.appendChild(indicatorContainer);
        navControls.appendChild(rightBtn);
        
        // Add to puzzle container
        const imageWrapper = document.querySelector('.puzzle-image-wrapper');
        imageWrapper.appendChild(navControls);
        
        // Add event listeners for navigation buttons
        let currentIndex = 0;
        
        leftBtn.addEventListener('click', () => {
            currentIndex = (currentIndex - 1 + currentPuzzle.option_images.length) % currentPuzzle.option_images.length;
            updateOptionImage();
            HumanTrajectory.recordSync('arrow', {direction: 'left', index: currentIndex});
        });

        rightBtn.addEventListener('click', () => {
            currentIndex = (currentIndex + 1) % currentPuzzle.option_images.length;
            updateOptionImage();
            HumanTrajectory.recordSync('arrow', {direction: 'right', index: currentIndex});
        });
        
        function updateOptionImage() {
            // Update the option image
            optionImg.src = currentPuzzle.option_images[currentIndex];
            
            // Update the indicator dots
            const dots = indicatorContainer.querySelectorAll('.dot');
            dots.forEach((dot, i) => {
                dot.className = i === currentIndex ? 'dot active' : 'dot';
            });
            
            // Update the current index in the puzzle data
            currentPuzzle.current_option_index = currentIndex;
        }
        
        // Auto-show submit button for image matching puzzles
        const submitSection = document.createElement('div');
        submitSection.className = 'image-matching-submit';
        const matchingSubmitBtn = document.createElement('button');
        matchingSubmitBtn.textContent = 'Submit';
        matchingSubmitBtn.className = 'submit-image-matching';
        matchingSubmitBtn.addEventListener('click', submitAnswer);
        submitSection.appendChild(matchingSubmitBtn);
        
        // Add to puzzle container
        imageWrapper.appendChild(submitSection);
    }

    // Function to set up patch selection grid
    function setupPatchSelectGrid() {
        // Remove any existing grid first
        const existingGrid = document.querySelector('.patch-select-grid');
        if (existingGrid) {
            existingGrid.remove();
        }
        
        // Clear the puzzle image container
        puzzleImageContainer.innerHTML = '';
        
        // IMPORTANT: Reset the global selectedCells array to fix the bug
        // when encountering these puzzles multiple times
        selectedCells = [];
        
        // Create a container for the patch select grid
        const gridContainer = document.createElement('div');
        gridContainer.className = 'patch-select-grid';
        
        // Get grid dimensions from the puzzle data
        const gridSize = currentPuzzle.grid_size || [6, 6];
        const rows = gridSize[0];
        const cols = gridSize[1];
        
        // Set grid styles
        gridContainer.style.display = 'grid';
        gridContainer.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
        gridContainer.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
        gridContainer.style.gap = '3px';
        // Explicit pixel size: the parent (.puzzle-image-container) is inline-block
        // and shrink-wraps, so width:100% would collapse. Square box (500px) matches
        // the square 800x800 source so objectFit:cover does not crop and the cells
        // line up with the baked correct_patches.
        const SIDE = 500;
        gridContainer.style.width = SIDE + 'px';
        gridContainer.style.height = (SIDE * rows / cols) + 'px';
        gridContainer.style.position = 'relative';
        
        // Create image container
        const imageContainer = document.createElement('div');
        imageContainer.className = 'patch-select-image-container';
        imageContainer.style.position = 'absolute';
        imageContainer.style.top = '0';
        imageContainer.style.left = '0';
        imageContainer.style.width = '100%';
        imageContainer.style.height = '100%';
        imageContainer.style.zIndex = '0';
        
        // Add the puzzle image
        const img = document.createElement('img');
        img.src = currentPuzzle.image_path;
        img.alt = 'CAPTCHA image';
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'cover';
        imageContainer.appendChild(img);
        
        // Add image container to grid container
        gridContainer.appendChild(imageContainer);
        
        // Create grid cells for selection
        // Use the global selectedCells array directly
        
        for (let i = 0; i < rows * cols; i++) {
            const cell = document.createElement('div');
            cell.className = 'patch-select-cell';
            cell.dataset.index = i;
            cell.style.position = 'relative';
            cell.style.zIndex = '1';
            cell.style.cursor = 'pointer';
            
            // Add a checkmark icon to indicate selection
            const checkmark = document.createElement('div');
            checkmark.className = 'checkmark';
            checkmark.innerHTML = '✓';
            checkmark.style.position = 'absolute';
            checkmark.style.top = '50%';
            checkmark.style.left = '50%';
            checkmark.style.transform = 'translate(-50%, -50%)';
            checkmark.style.color = 'white';
            checkmark.style.fontSize = '32px';
            checkmark.style.fontWeight = 'bold';
            checkmark.style.opacity = '0';
            checkmark.style.transition = 'opacity 0.2s ease';
            checkmark.style.pointerEvents = 'none';
            checkmark.style.textShadow = '1px 1px 3px rgba(0, 0, 0, 0.7)';
            checkmark.style.zIndex = '3';
            cell.appendChild(checkmark);
            
            // Add click event to toggle selection
            cell.addEventListener('click', () => {
                // Toggle selection
                if (cell.classList.contains('selected')) {
                    cell.classList.remove('selected');
                    // Hide checkmark
                    checkmark.style.opacity = '0';
                    // Remove from selected array
                    const index = selectedCells.indexOf(i);
                    if (index > -1) {
                        selectedCells.splice(index, 1);
                    }
                } else {
                    cell.classList.add('selected');
                    // Show checkmark
                    checkmark.style.opacity = '1';
                    // Add to selected array
                    selectedCells.push(i);
                }
                
                // Update the answer in the UI
                userAnswerInput.value = JSON.stringify(selectedCells);
                
                // Enable the submit button when squares are selected
                submitBtn.disabled = false;
                
                // Log selected patches for debugging
                console.log('Selected patches:', selectedCells);
            });
            
            gridContainer.appendChild(cell);
        }
        
        // Add the grid to the puzzle container
        puzzleImageContainer.appendChild(gridContainer);
        
        // Update the prompt to include the target object
        puzzlePrompt.textContent = `Select all squares with ${currentPuzzle.target_object}`;
        
        // Hide the regular input and replace with verify button
        userAnswerInput.style.display = 'none';
        submitBtn.textContent = 'Verify';
        submitBtn.style.display = 'inline-block';  // Changed to inline-block
        inputGroup.style.display = 'flex';
        submitBtn.disabled = false; // Ensure the button is enabled
        
        // Clear any previous answer
        userAnswerInput.value = '[]';
    }
    
    // Function to set up Select_Animal grid
    function setupSelectAnimalGrid() {
        // Remove any existing grid first
        const existingGrid = document.querySelector('.animal-select-grid');
        if (existingGrid) {
            existingGrid.remove();
        }
        
        // Clear the puzzle image container
        puzzleImageContainer.innerHTML = '';
        
        // IMPORTANT: Reset the selectedAnimalIndex to -1 to fix the bug when encountering this puzzle multiple times
        selectedAnimalIndex = -1;
        
        // Create a simple container directly
        const container = document.createElement('div');
        container.style.width = '480px';
        container.style.maxWidth = '480px';
        container.style.margin = '0 auto';
        container.style.position = 'relative';
        
        // Display the image directly
        const img = document.createElement('img');
        img.src = currentPuzzle.image_path;
        img.alt = 'CAPTCHA image with animals';
        img.style.width = '100%';
        img.style.display = 'block';
        img.style.border = '2px solid #ccc';
        img.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.15)';
        container.appendChild(img);
        
        // Get grid dimensions from the puzzle data
        const gridSize = currentPuzzle.grid_size || [2, 3];
        const rows = gridSize[0];
        const cols = gridSize[1];
        
        // Wait for image to load to ensure dimensions are available
        img.onload = function() {
            // Create overlay grid that matches the image dimensions
            const grid = document.createElement('div');
            grid.style.position = 'absolute';
            grid.style.top = '0';
            grid.style.left = '0';
            grid.style.width = '100%';
            grid.style.height = '100%';
            grid.style.display = 'grid';
            grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
            grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
            
            // IMPORTANT: Create a fresh selectedAnimal object with -1 index to fix the bug
            // when encountering these puzzles multiple times
            const selectedAnimal = { index: -1 };
            
            for (let i = 0; i < rows * cols; i++) {
                const cell = document.createElement('div');
                cell.style.border = '1px solid rgba(255, 255, 255, 0.3)';
                cell.style.cursor = 'pointer';
                cell.style.position = 'relative';
                cell.style.transition = 'all 0.2s ease';
                
                // Add hover effect
                cell.addEventListener('mouseover', () => {
                    cell.style.backgroundColor = 'rgba(76, 175, 80, 0.2)';
                    cell.style.border = '1px solid rgba(76, 175, 80, 0.7)';
                });
                
                cell.addEventListener('mouseout', () => {
                    if (selectedAnimal.index !== i) {
                        cell.style.backgroundColor = 'transparent';
                        cell.style.border = '1px solid rgba(255, 255, 255, 0.3)';
                    }
                });
                
                // Add click event to toggle selection
                cell.addEventListener('click', () => {
                    // Clear previous selection
                    grid.querySelectorAll('div').forEach((c, index) => {
                        if (index !== i) {
                            c.style.backgroundColor = 'transparent';
                            c.style.border = '1px solid rgba(255, 255, 255, 0.3)';
                        }
                    });
                    
                    // Update selection
                    selectedAnimal.index = i;
                    selectedAnimalIndex = i; // Update the global variable
                    cell.style.backgroundColor = 'rgba(76, 175, 80, 0.3)';
                    cell.style.border = '2px solid rgba(76, 175, 80, 0.9)';
                    
                    // Update the answer in the UI
                    userAnswerInput.value = JSON.stringify([i]);
                    
                    // Enable the submit button
                    submitBtn.disabled = false;
                    
                    // Log selected animal for debugging
                    console.log('Selected animal at index:', i);
                });
                
                grid.appendChild(cell);
            }
            
            // Add the grid to the container
            container.appendChild(grid);
        };
        
        // Add the container to the puzzle container
        puzzleImageContainer.appendChild(container);
        
        // Make sure the prompt is clearly visible
        puzzlePrompt.style.fontSize = '20px';
        puzzlePrompt.style.fontWeight = 'bold';
        puzzlePrompt.style.marginBottom = '20px';
        
        // Update the prompt to include the target animal
        puzzlePrompt.textContent = `Pick a ${currentPuzzle.target_object}`;
        
        // Hide the regular input and replace with verify button
        userAnswerInput.style.display = 'none';
        submitBtn.textContent = 'Submit';
        submitBtn.style.display = 'inline-block';
        inputGroup.style.display = 'flex';
        submitBtn.disabled = true; // Disabled until selection is made
        
        // Clear any previous answer
        userAnswerInput.value = '[]';
    }

    /**
     * Setup the Object Match interface with reference image and option controls
     */
    function setupObjectMatch() {
        // Create container for the object match interface
        const matchContainer = document.createElement('div');
        matchContainer.className = 'object-match-container';
        
        // Create a horizontal layout
        const horizontalLayout = document.createElement('div');
        horizontalLayout.className = 'object-match-horizontal-layout';
        
        // Create reference image container
        const referenceContainer = document.createElement('div');
        referenceContainer.className = 'object-match-reference';
        
        // Add reference image
        const referenceImage = document.createElement('img');
        referenceImage.src = currentPuzzle.reference_image || currentPuzzle.additional_data.reference_image;
        referenceImage.alt = 'Reference Image';
        referenceImage.className = 'object-match-reference-img';
        referenceContainer.appendChild(referenceImage);
        
        // Add reference caption
        const referenceCaption = document.createElement('div');
        referenceCaption.className = 'object-match-caption';
        referenceCaption.textContent = 'Match This!';
        referenceContainer.appendChild(referenceCaption);
        
        // Create options container
        const optionsContainer = document.createElement('div');
        optionsContainer.className = 'object-match-options';
        
        // Add option image
        const optionImage = document.createElement('img');
        const optionImages = currentPuzzle.option_images || currentPuzzle.additional_data.option_images;
        optionImage.src = optionImages[0]; // Start with first option
        optionImage.alt = 'Option Image';
        optionImage.className = 'object-match-option-img';
        optionsContainer.appendChild(optionImage);
        
        // Create navigation controls
        const controlsContainer = document.createElement('div');
        controlsContainer.className = 'object-match-controls';
        
        // Left arrow
        const leftArrow = document.createElement('button');
        leftArrow.innerHTML = '&larr;';
        leftArrow.className = 'object-match-arrow left-arrow';
        leftArrow.addEventListener('click', () => updateObjectOption(-1));
        
        // Right arrow
        const rightArrow = document.createElement('button');
        rightArrow.innerHTML = '&rarr;';
        rightArrow.className = 'object-match-arrow right-arrow';
        rightArrow.addEventListener('click', () => updateObjectOption(1));
        
        // Add arrows to controls
        controlsContainer.appendChild(leftArrow);
        controlsContainer.appendChild(rightArrow);
        
        // Add controls to options container
        optionsContainer.appendChild(controlsContainer);
        
        // Add reference and options to horizontal layout
        horizontalLayout.appendChild(referenceContainer);
        horizontalLayout.appendChild(optionsContainer);
        
        // Add horizontal layout to main container
        matchContainer.appendChild(horizontalLayout);
        
        // Add option indicators (dots)
        const indicators = document.createElement('div');
        indicators.className = 'object-match-indicators';
        
        const numOptions = optionImages.length;
        for (let i = 0; i < numOptions; i++) {
            const dot = document.createElement('span');
            dot.className = 'object-match-dot';
            if (i === 0) {
                dot.classList.add('active');
            }
            indicators.appendChild(dot);
        }
        
        // Add indicators to main container
        matchContainer.appendChild(indicators);
        
        // Add submit button
        const submitBtn = document.createElement('button');
        submitBtn.textContent = 'Submit';
        submitBtn.className = 'object-match-submit';
        submitBtn.addEventListener('click', submitAnswer);
        
        // Add containers to puzzle image container
        puzzleImageContainer.appendChild(matchContainer);
        puzzleImageContainer.appendChild(submitBtn);
        
        // Store current index in data attribute
        puzzleImageContainer.dataset.currentOptionIndex = '0';
        
        // Log for debugging
        console.log('Object Match images:', {
            reference: referenceImage.src,
            options: optionImages
        });
    }
    
    /**
     * Update the displayed option image based on navigation direction
     * @param {number} direction - Direction to navigate (-1 for left, 1 for right)
     */
    function updateObjectOption(direction) {
        const container = document.querySelector('.object-match-container');
        const optionImage = document.querySelector('.object-match-option-img');
        const dots = document.querySelectorAll('.object-match-dot');
        
        // Get current index
        let currentIndex = parseInt(puzzleImageContainer.dataset.currentOptionIndex);
        const optionImages = currentPuzzle.option_images || currentPuzzle.additional_data.option_images;
        const numOptions = optionImages.length;
        
        // Calculate new index with wrap-around
        let newIndex = (currentIndex + direction + numOptions) % numOptions;
        
        // Update the option image
        optionImage.src = optionImages[newIndex];
        
        // Update dots
        dots.forEach((dot, index) => {
            if (index === newIndex) {
                dot.classList.add('active');
            } else {
                dot.classList.remove('active');
            }
        });
        
        // Store new index
        puzzleImageContainer.dataset.currentOptionIndex = newIndex.toString();
        
        // Store selected answer for submission
        userAnswerInput.value = newIndex.toString();
        
        // Log for debugging
        console.log('Updated option image:', {
            index: newIndex,
            src: optionImage.src
        });
    }

    /**
     * Setup the Place_Dot interface allowing the user to click on the image to place a dot
     */
    function setupPlaceDot() {
        // Clear the puzzle image container
        puzzleImageContainer.innerHTML = '';

        // Create a container for the image with relative positioning
        const container = document.createElement('div');
        container.style.position = 'relative';
        container.style.width = '480px';
        container.style.maxWidth = '480px';
        container.style.margin = '0 auto';
        
        // Create and add the image. Use the server-provided `image_path`
        // (it already carries `?split=<name>` when present); falling back to
        // manual URL construction would drop the split query and 404 when the
        // server's DATA_DIRS defaults differ from the requested split.
        const img = document.createElement('img');
        img.src = currentPuzzle.image_path || `/captcha_data/${currentPuzzle.puzzle_type}/${currentPuzzle.puzzle_id}`;
        img.alt = 'Car path image';
        img.style.width = '100%';
        img.style.display = 'block';
        img.style.cursor = 'crosshair';
        container.appendChild(img);
        
        // Reset any previous click coordinates
        clickCoordinates = null;
        
        // Add click handler to the image
        img.addEventListener('click', (e) => {
            // Remove any existing dot
            const existingDot = container.querySelector('.place-dot-marker');
            if (existingDot) {
                existingDot.remove();
            }

            // Get click coordinates relative to the image (CSS rect-relative
            // for the visual marker) and convert to image-natural pixels
            // (what the server compares with `target_position`). Sending
            // natural coords makes the answer layout-independent — display
            // can be 480 or 1024 wide and the same click hits the same target.
            const rect = e.target.getBoundingClientRect();
            const x = Math.round(e.clientX - rect.left);
            const y = Math.round(e.clientY - rect.top);
            const sx = e.target.naturalWidth / rect.width;
            const sy = e.target.naturalHeight / rect.height;
            const natX = Math.round(x * sx);
            const natY = Math.round(y * sy);

            // Store coordinates for submission (natural).
            clickCoordinates = [natX, natY];
            
            // Create dot marker
            const dot = document.createElement('div');
            dot.className = 'place-dot-marker';
            dot.style.position = 'absolute';
            dot.style.width = '20px';
            dot.style.height = '20px';
            dot.style.borderRadius = '50%';
            dot.style.backgroundColor = 'rgba(255, 0, 0, 0.7)';
            dot.style.border = '2px solid #ff0000';
            dot.style.left = `${x}px`;
            dot.style.top = `${y}px`;
            dot.style.transform = 'translate(-50%, -50%)';
            dot.style.pointerEvents = 'none';
            dot.style.zIndex = '10';
            
            // Add animation
            dot.style.animation = 'pulse 1s infinite alternate';
            
            // Add dot to container
            container.appendChild(dot);
            
            // Enable submit button
            submitBtn.disabled = false;
            
            // Log coordinates for debugging
            console.log('Dot placed at:', { x, y });
        });
        
        // Add the container to the puzzle container
        puzzleImageContainer.appendChild(container);
        
        // In debug mode, fetch the ground truth to show the target area
        if (DEBUG_MODE) {
            fetch('/api/get_ground_truth', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    puzzle_type: currentPuzzle.puzzle_type,
                    puzzle_id: currentPuzzle.puzzle_id
                })
            })
            .then(response => response.json())
            .then(gtData => {
                // Check if we have a target position in the answer
                if (gtData.answer && gtData.answer.target_position) {
                    const targetPosition = gtData.answer.target_position;
                    const tolerance = gtData.answer.tolerance || 15; // Default to 15px
                    showTargetDotArea(container, targetPosition, tolerance);
                }
            })
            .catch(error => {
                console.error('Error fetching ground truth for Place_Dot:', error);
            });
        }
        
        // Update prompt and input elements
        puzzlePrompt.textContent = currentPuzzle.prompt || "Click to place a Dot at the end of the car's path";
        
        // Hide the input field and adjust the submit button
        userAnswerInput.style.display = 'none';
        submitBtn.textContent = 'Submit';
        submitBtn.disabled = true; // Disabled until user places a dot
        submitBtn.style.display = 'inline-block';
        inputGroup.style.display = 'flex';
    }
    
    /**
     * Show the target area for the Place_Dot puzzle in debug mode
     * @param {HTMLElement} container - The container element
     * @param {Array} targetPosition - The target position [x, y]
     * @param {number} tolerance - The tolerance radius in pixels
     */
    function showTargetDotArea(container, targetPosition, tolerance = 15) {
        if (!DEBUG_MODE) return;
        
        // Remove any existing target visualization
        const existingTarget = container.querySelector('.target-dot-area');
        if (existingTarget) {
            existingTarget.remove();
        }
        
        // Get target coordinates
        const [targetX, targetY] = targetPosition;
        
        // Create a target element - visualized as a circle
        const targetArea = document.createElement('div');
        targetArea.className = 'target-dot-area';
        
        // Calculate diameter based on tolerance
        const diameter = tolerance * 2;
        
        // Style the target area
        targetArea.style.position = 'absolute';
        targetArea.style.left = `${targetX - tolerance}px`;
        targetArea.style.top = `${targetY - tolerance}px`;
        targetArea.style.width = `${diameter}px`;
        targetArea.style.height = `${diameter}px`;
        targetArea.style.borderRadius = '50%';
        targetArea.style.border = '2px dashed green';
        targetArea.style.backgroundColor = 'rgba(0, 255, 0, 0.2)';
        targetArea.style.zIndex = '5';
        targetArea.style.pointerEvents = 'none'; // Allow clicks to pass through
        
        // Add coordinates label
        const coordsLabel = document.createElement('div');
        coordsLabel.className = 'coords-label';
        coordsLabel.textContent = `Target: (${targetX}, ${targetY}) ±${tolerance}px`;
        coordsLabel.style.position = 'absolute';
        coordsLabel.style.top = '-25px';
        coordsLabel.style.left = '0';
        coordsLabel.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
        coordsLabel.style.color = 'white';
        coordsLabel.style.padding = '2px 5px';
        coordsLabel.style.fontSize = '10px';
        coordsLabel.style.borderRadius = '3px';
        coordsLabel.style.whiteSpace = 'nowrap';
        targetArea.appendChild(coordsLabel);
        
        // Add to the container
        container.appendChild(targetArea);
        
        // Log the target details
        console.log('Place_Dot target position:', { 
            x: targetX, 
            y: targetY,
            tolerance: tolerance
        });
    }

    // Function to set up connect icon interface
    function setupConnectIcon() {
        // Clear the puzzle image container
        puzzleImageContainer.innerHTML = '';
        
        // Create a layout container for the two-column layout
        const layoutContainer = document.createElement('div');
        layoutContainer.className = 'connect-icon-layout';
        layoutContainer.style.display = 'flex';
        layoutContainer.style.justifyContent = 'space-between';
        
        // Create container for reference image
        const refContainer = document.createElement('div');
        refContainer.className = 'reference-image-container';
        refContainer.style.flex = '1';
        refContainer.style.marginRight = '10px';
        refContainer.style.textAlign = 'center';
        
        // Add "Match This!" label above reference image
        const matchLabel = document.createElement('div');
        matchLabel.className = 'match-label';
        matchLabel.textContent = 'Match This!';
        matchLabel.style.backgroundColor = 'black';
        matchLabel.style.color = 'white';
        matchLabel.style.padding = '2px 5px';
        matchLabel.style.marginBottom = '5px';
        matchLabel.style.fontSize = '12px';
        refContainer.appendChild(matchLabel);
        
        // Add reference image
        const refImg = document.createElement('img');
        refImg.id = 'connect-reference-image';
        refImg.src = currentPuzzle.reference_image;
        refImg.alt = 'Reference image';
        refImg.style.maxWidth = '100%';
        refImg.style.border = '1px solid #ccc';
        refContainer.appendChild(refImg);
        
        // Container for option images with arrows
        const optionContainer = document.createElement('div');
        optionContainer.className = 'connect-option-container';
        optionContainer.style.flex = '1';
        optionContainer.style.position = 'relative';
        
        // Create option image display
        const optionImgContainer = document.createElement('div');
        optionImgContainer.className = 'option-image-container';
        optionImgContainer.style.textAlign = 'center';
        
        // Create option image
        const optionImg = document.createElement('img');
        optionImg.id = 'connect-option-image';
        optionImg.src = currentPuzzle.option_images[0]; // Start with the first option
        optionImg.alt = 'Option image';
        optionImg.style.maxWidth = '100%';
        optionImg.style.border = '1px solid #ccc';
        optionImgContainer.appendChild(optionImg);
        optionContainer.appendChild(optionImgContainer);
        
        // Add arrow navigation
        const arrowsContainer = document.createElement('div');
        arrowsContainer.className = 'connect-arrows-container';
        arrowsContainer.style.display = 'flex';
        arrowsContainer.style.justifyContent = 'center';
        arrowsContainer.style.marginTop = '10px';
        
        // Left arrow
        const leftArrow = document.createElement('button');
        leftArrow.className = 'arrow-btn left-arrow';
        leftArrow.innerHTML = '&#8592;'; // Left arrow character
        leftArrow.setAttribute('aria-label', 'Previous option');
        leftArrow.style.margin = '0 10px';
        leftArrow.style.padding = '5px 15px';
        leftArrow.style.fontSize = '20px';
        leftArrow.style.backgroundColor = '#f0f0f0';
        leftArrow.style.border = '1px solid #ccc';
        leftArrow.style.borderRadius = '4px';
        leftArrow.style.cursor = 'pointer';
        
        // Right arrow
        const rightArrow = document.createElement('button');
        rightArrow.className = 'arrow-btn right-arrow';
        rightArrow.innerHTML = '&#8594;'; // Right arrow character
        rightArrow.setAttribute('aria-label', 'Next option');
        rightArrow.style.margin = '0 10px';
        rightArrow.style.padding = '5px 15px';
        rightArrow.style.fontSize = '20px';
        rightArrow.style.backgroundColor = '#f0f0f0';
        rightArrow.style.border = '1px solid #ccc';
        rightArrow.style.borderRadius = '4px';
        rightArrow.style.cursor = 'pointer';
        
        arrowsContainer.appendChild(leftArrow);
        arrowsContainer.appendChild(rightArrow);
        optionContainer.appendChild(arrowsContainer);
        
        // Add pagination dots
        const dotsContainer = document.createElement('div');
        dotsContainer.className = 'pagination-dots';
        dotsContainer.style.display = 'flex';
        dotsContainer.style.justifyContent = 'center';
        dotsContainer.style.marginTop = '10px';
        
        // Create dots based on the number of options
        for (let i = 0; i < currentPuzzle.option_images.length; i++) {
            const dot = document.createElement('span');
            dot.className = 'pagination-dot';
            dot.style.height = '10px';
            dot.style.width = '10px';
            dot.style.margin = '0 5px';
            dot.style.borderRadius = '50%';
            dot.style.backgroundColor = i === 0 ? '#4CAF50' : '#ccc'; // Highlight first dot
            dotsContainer.appendChild(dot);
        }
        
        optionContainer.appendChild(dotsContainer);
        
        // Add all containers to the layout
        layoutContainer.appendChild(refContainer);
        layoutContainer.appendChild(optionContainer);
        puzzleImageContainer.appendChild(layoutContainer);
        
        // Add a submit button
        const submitSection = document.createElement('div');
        submitSection.className = 'connect-icon-submit';
        submitSection.style.textAlign = 'center';
        submitSection.style.marginTop = '15px';
        
        const submitBtn = document.createElement('button');
        submitBtn.textContent = 'Submit';
        submitBtn.className = 'submit-connect';
        submitBtn.style.padding = '10px 20px';
        submitBtn.style.backgroundColor = '#4CAF50';
        submitBtn.style.color = 'white';
        submitBtn.style.border = 'none';
        submitBtn.style.borderRadius = '4px';
        submitBtn.style.fontSize = '16px';
        submitBtn.style.cursor = 'pointer';
        submitBtn.addEventListener('click', submitAnswer);
        submitSection.appendChild(submitBtn);
        
        // Add to puzzle container
        puzzleImageContainer.appendChild(submitSection);
        
        // Set up current option tracking
        let currentOptionIndex = 0;
        
        // Initialize the answer input with the current index
        userAnswerInput.value = currentOptionIndex.toString();
        
        // Function to update the option image
        function updateConnectOptionImage() {
            const optionImg = document.getElementById('connect-option-image');
            if (optionImg) {
                optionImg.src = currentPuzzle.option_images[currentOptionIndex];
            }
            
            // Update dots to highlight current option
            const dots = document.querySelectorAll('.pagination-dot');
            dots.forEach((dot, index) => {
                dot.style.backgroundColor = index === currentOptionIndex ? '#4CAF50' : '#ccc';
            });
            
            // Update the answer input with the current index
            userAnswerInput.value = currentOptionIndex.toString();
        }
        
        // Event listeners for arrows
        leftArrow.addEventListener('click', () => {
            currentOptionIndex = (currentOptionIndex - 1 + currentPuzzle.option_images.length) % currentPuzzle.option_images.length;
            updateConnectOptionImage();
        });
        
        rightArrow.addEventListener('click', () => {
            currentOptionIndex = (currentOptionIndex + 1) % currentPuzzle.option_images.length;
            updateConnectOptionImage();
        });
    }
    
    // Function to set up Click Order interface
    function setupClickOrder() {
        // Clear the puzzle image container
        puzzleImageContainer.innerHTML = '';
        
        // Create a container for the layout
        const layoutContainer = document.createElement('div');
        layoutContainer.className = 'click-order-layout';
        layoutContainer.style.display = 'flex';
        layoutContainer.style.flexDirection = 'column';
        layoutContainer.style.alignItems = 'center';
        
        // Create a container for the main image
        const mainImageContainer = document.createElement('div');
        mainImageContainer.className = 'main-image-container';
        mainImageContainer.style.position = 'relative';
        mainImageContainer.style.marginBottom = '20px';
        mainImageContainer.style.width = '100%';
        
        // Add main image — constrain both width and height so tall images
        // (e.g. 1024×1536) fit within the fixed 1280×1080 viewport without
        // pushing content below the fold.
        const mainImg = document.createElement('img');
        mainImg.id = 'click-order-main-image';
        mainImg.src = currentPuzzle.image_path;
        mainImg.alt = 'Click the icons in order';
        mainImg.style.maxWidth = '480px';
        mainImg.style.maxHeight = '480px';
        mainImg.style.objectFit = 'contain';
        mainImg.style.border = '1px solid #ccc';
        mainImageContainer.appendChild(mainImg);
        
        // Create a container for the order reference image
        const orderImageContainer = document.createElement('div');
        orderImageContainer.className = 'order-image-container';
        orderImageContainer.style.textAlign = 'center';
        orderImageContainer.style.marginBottom = '20px';
        
        // Add "Order Reference" label
        const orderLabel = document.createElement('div');
        orderLabel.className = 'order-label';
        orderLabel.textContent = 'Click icons in this order:';
        orderLabel.style.backgroundColor = 'black';
        orderLabel.style.color = 'white';
        orderLabel.style.padding = '5px';
        orderLabel.style.marginBottom = '5px';
        orderLabel.style.fontSize = '14px';
        orderImageContainer.appendChild(orderLabel);
        
        // Add order reference image
        const orderImg = document.createElement('img');
        orderImg.id = 'click-order-reference-image';
        orderImg.src = currentPuzzle.order_image;
        orderImg.alt = 'Reference order';
        orderImg.style.maxWidth = '100%';
        orderImg.style.border = '1px solid #ccc';
        orderImageContainer.appendChild(orderImg);
        
        // Add click markers container to show user clicks
        const markersContainer = document.createElement('div');
        markersContainer.className = 'click-markers-container';
        markersContainer.style.position = 'absolute';
        markersContainer.style.top = '0';
        markersContainer.style.left = '0';
        markersContainer.style.width = '100%';
        markersContainer.style.height = '100%';
        markersContainer.style.pointerEvents = 'none'; // Don't block clicks
        mainImageContainer.appendChild(markersContainer);
        
        // Track user clicks
        let userClicks = [];
        
        // Add click indicator
        const clickIndicator = document.createElement('div');
        clickIndicator.className = 'click-indicator';
        clickIndicator.style.marginTop = '10px';
        clickIndicator.style.fontSize = '16px';
        clickIndicator.textContent = 'Clicks: 0';
        
        // Add reset button
        const resetButton = document.createElement('button');
        resetButton.textContent = 'Reset Clicks';
        resetButton.className = 'reset-clicks-btn';
        resetButton.style.padding = '8px 15px';
        resetButton.style.backgroundColor = '#f44336';
        resetButton.style.color = 'white';
        resetButton.style.border = 'none';
        resetButton.style.borderRadius = '4px';
        resetButton.style.marginRight = '10px';
        resetButton.style.cursor = 'pointer';
        
        // Add click event handler for the main image
        mainImg.addEventListener('click', function(e) {
            // Map the click from rendered (CSS) pixels back to natural-image
            // pixels — the GT was authored against the canonical canvas size,
            // and `maxWidth: 100%` may shrink the displayed image on narrow
            // viewports. Without this, click coords drift relative to the GT.
            const rect = e.target.getBoundingClientRect();
            const cssX = e.clientX - rect.left;
            const cssY = e.clientY - rect.top;
            const sx = e.target.naturalWidth / rect.width || 1;
            const sy = e.target.naturalHeight / rect.height || 1;
            const x = Math.round(cssX * sx);
            const y = Math.round(cssY * sy);

            // Submit coords go to the server in natural-image pixels...
            userClicks.push([x, y]);

            // ...but the visual marker is positioned over the rendered image,
            // so it must use CSS pixels. markersContainer spans the full-width
            // mainImageContainer while the img is centered inside it, so shift
            // by the img's offset within the container — otherwise every
            // marker lands (containerWidth-imgWidth)/2 px left of the icon.
            addClickMarker(Math.round(e.target.offsetLeft + cssX),
                           Math.round(e.target.offsetTop + cssY),
                           userClicks.length, markersContainer);
            
            // Update click indicator
            clickIndicator.textContent = `Clicks: ${userClicks.length}`;
            
            // Enable the dedicated submit button if at least one click has been made
            clickOrderSubmitBtn.disabled = false;
            
            // Log for debugging
            console.log(`Click ${userClicks.length} at:`, { x, y });
        });
        
        // Event listener for reset button
        resetButton.addEventListener('click', function() {
            // Clear user clicks
            userClicks = [];
            
            // Clear markers
            markersContainer.innerHTML = '';
            
            // Update click indicator
            clickIndicator.textContent = 'Clicks: 0';
            
            // Disable submit button
            submitBtn.disabled = true;
        });
        
        // Add components to layout
        layoutContainer.appendChild(orderImageContainer);
        layoutContainer.appendChild(mainImageContainer);
        
        // Add controls container
        const controlsContainer = document.createElement('div');
        controlsContainer.className = 'controls-container';
        controlsContainer.style.display = 'flex';
        controlsContainer.style.justifyContent = 'center';
        controlsContainer.style.alignItems = 'center';
        controlsContainer.style.marginTop = '15px';
        
        // Add controls to container
        controlsContainer.appendChild(resetButton);
        controlsContainer.appendChild(clickIndicator);
        
        // Add controls to layout
        layoutContainer.appendChild(controlsContainer);
        
        // Create a dedicated submit button for the Click Order puzzle
        const clickOrderSubmitBtn = document.createElement('button');
        clickOrderSubmitBtn.textContent = 'Submit Order';
        clickOrderSubmitBtn.className = 'click-order-submit-btn';
        clickOrderSubmitBtn.style.padding = '10px 20px';
        clickOrderSubmitBtn.style.backgroundColor = '#4CAF50';
        clickOrderSubmitBtn.style.color = 'white';
        clickOrderSubmitBtn.style.border = 'none';
        clickOrderSubmitBtn.style.borderRadius = '4px';
        clickOrderSubmitBtn.style.marginTop = '15px';
        clickOrderSubmitBtn.style.cursor = 'pointer';
        clickOrderSubmitBtn.style.fontSize = '16px';
        clickOrderSubmitBtn.disabled = true; // Disabled until clicks are made
        
        // Add submit button to layout
        layoutContainer.appendChild(clickOrderSubmitBtn);
        
        // Add layout to puzzle container
        puzzleImageContainer.appendChild(layoutContainer);
        
        // Hide the original input field and submit button
        userAnswerInput.style.display = 'none';
        submitBtn.style.display = 'none';
        inputGroup.style.display = 'none';
        
        // Enable the dedicated submit button when clicks are made
        mainImg.addEventListener('click', function() {
            if (userClicks.length > 0) {
                clickOrderSubmitBtn.disabled = false;
            }
        });
        
        // Reset button should disable submit button
        resetButton.addEventListener('click', function() {
            clickOrderSubmitBtn.disabled = true;
        });
        
        // Add event listener to the dedicated submit button
        clickOrderSubmitBtn.addEventListener('click', function() {
            // Set the clicks as the answer
            userAnswerInput.value = JSON.stringify(userClicks);
            
            // Send the data to the server
            fetch('/api/check_answer', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    puzzle_type: currentPuzzle.puzzle_type,
                    puzzle_id: currentPuzzle.puzzle_id,
                    answer: userClicks
                })
            })
            .then(response => response.json())
            .then(data => {
                // Update stats
                benchmarkStats.total++;
                if (data.correct) {
                    benchmarkStats.correct++;
                    resultMessage.textContent = 'Correct!';
                    resultMessage.className = 'result-message correct';
                } else {
                    resultMessage.textContent = 'Incorrect.';
                    resultMessage.className = 'result-message incorrect';
                }

                // The global #result-message sits below the 1080px fold on
                // this taller layout, so mirror the feedback in-viewport,
                // right under the puzzle image (same look as other tasks).
                const fb = document.createElement('div');
                fb.className = 'result-message ' + (data.correct ? 'correct' : 'incorrect');
                fb.textContent = data.correct ? 'Correct!' : 'Incorrect.';
                fb.style.textAlign = 'center';
                fb.style.fontSize = '24px';
                fb.style.fontWeight = 'bold';
                fb.style.margin = '6px 0';
                mainImageContainer.insertAdjacentElement('afterend', fb);

                updateStats();

                // Record benchmark result
                recordBenchmarkResult({
                    puzzle_type: currentPuzzle.puzzle_type,
                    puzzle_id: currentPuzzle.puzzle_id,
                    user_answer: userClicks,
                    correct_answer: data.correct_answer,
                    correct: data.correct
                });

                // Disable the submit button
                clickOrderSubmitBtn.disabled = true;

                // Load a new puzzle after a delay — kept longer than the
                // ~2s post-action screenshot so the feedback frame is what
                // the agent sees as its final observation.
                setTimeout(loadNewPuzzle, 3500);
            })
            .catch(error => {
                console.error('Error checking answer:', error);
                resultMessage.textContent = 'Error checking answer. Please try again.';
                resultMessage.className = 'result-message incorrect';
                // Re-enable the submit button on error
                clickOrderSubmitBtn.disabled = false;
            });
        });
        
        // In debug mode, show the correct click positions
        if (DEBUG_MODE) {
            showClickOrderAnswerPositions(mainImageContainer);
        }
    }
    
    // Function to add a numbered click marker
    function addClickMarker(x, y, number, container) {
        const marker = document.createElement('div');
        marker.className = 'click-marker';
        marker.style.position = 'absolute';
        // .click-marker CSS already centers via translate(-50%,-50%), so pass
        // the click point directly — subtracting half the size here would
        // double-center and shift the disc up-left by ~15px.
        marker.style.left = `${x}px`;
        marker.style.top = `${y}px`;
        marker.style.width = '30px';
        marker.style.height = '30px';
        marker.style.borderRadius = '50%';
        marker.style.backgroundColor = 'rgba(255, 0, 0, 0.6)';
        marker.style.border = '2px solid white';
        marker.style.color = 'white';
        marker.style.fontWeight = 'bold';
        marker.style.display = 'flex';
        marker.style.justifyContent = 'center';
        marker.style.alignItems = 'center';
        marker.style.fontSize = '14px';
        marker.style.zIndex = '100';
        marker.style.pointerEvents = 'none'; // Don't block future clicks
        marker.textContent = number.toString();
        
        container.appendChild(marker);
    }
    
    // Function to show correct answer positions in debug mode
    function showClickOrderAnswerPositions(container) {
        fetch('/api/get_ground_truth', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                puzzle_type: currentPuzzle.puzzle_type,
                puzzle_id: currentPuzzle.puzzle_id
            })
        })
        .then(response => response.json())
        .then(gtData => {
            if (gtData.answer && Array.isArray(gtData.answer)) {
                const correctPositions = gtData.answer;
                const tolerance = currentPuzzle.tolerance || 20;
                
                // Create a debug layer
                const debugLayer = document.createElement('div');
                debugLayer.className = 'debug-layer';
                debugLayer.style.position = 'absolute';
                debugLayer.style.top = '0';
                debugLayer.style.left = '0';
                debugLayer.style.width = '100%';
                debugLayer.style.height = '100%';
                debugLayer.style.pointerEvents = 'none';
                
                // Add correct position indicators
                correctPositions.forEach((pos, index) => {
                    const [x, y] = pos;
                    
                    // Create circle for tolerance area
                    const toleranceCircle = document.createElement('div');
                    toleranceCircle.className = 'tolerance-circle';
                    toleranceCircle.style.position = 'absolute';
                    toleranceCircle.style.left = `${x - tolerance}px`;
                    toleranceCircle.style.top = `${y - tolerance}px`;
                    toleranceCircle.style.width = `${tolerance * 2}px`;
                    toleranceCircle.style.height = `${tolerance * 2}px`;
                    toleranceCircle.style.borderRadius = '50%';
                    toleranceCircle.style.border = '2px dashed green';
                    toleranceCircle.style.backgroundColor = 'rgba(0, 255, 0, 0.1)';
                    
                    // Create label with position number
                    const posLabel = document.createElement('div');
                    posLabel.className = 'position-label';
                    posLabel.style.position = 'absolute';
                    posLabel.style.left = `${x}px`;
                    posLabel.style.top = `${y - 20}px`;
                    posLabel.style.transform = 'translate(-50%, -50%)';
                    posLabel.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
                    posLabel.style.color = 'white';
                    posLabel.style.padding = '2px 5px';
                    posLabel.style.borderRadius = '3px';
                    posLabel.style.fontSize = '10px';
                    posLabel.textContent = `${index + 1}: (${x}, ${y})`;
                    
                    debugLayer.appendChild(toleranceCircle);
                    debugLayer.appendChild(posLabel);
                });
                
                container.appendChild(debugLayer);
            }
        })
        .catch(error => {
            console.error('Error fetching ground truth for Click_Order:', error);
        });
    }
    
    // Function to setup the Hold Button CAPTCHA
    function setupHoldButton() {
        // record the start time
        puzzleStartTime = Date.now();
        // Clear the puzzle image container first
        puzzleImageContainer.innerHTML = '';
        
        // Create a container for the button
        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'hold-button-container';
        buttonContainer.style.position = 'relative';
        buttonContainer.style.width = '400px';
        buttonContainer.style.maxWidth = '400px';
        buttonContainer.style.margin = '60px auto 30px';
        buttonContainer.style.textAlign = 'center';
        
        // Image rendering intentionally removed — Hold_Button is now a
        // static, image-less single-button captcha.
        
        // Create button element
        const button = document.createElement('div');
        button.className = 'hold-button';
        button.style.position = 'relative';
        button.style.width = '100%';
        button.style.height = 'auto';
        button.style.cursor = 'pointer';
        button.style.userSelect = 'none';
        button.style.borderRadius = '50px';
        button.style.border = '3px solid #333';
        button.style.boxShadow = '0 4px 8px rgba(0, 0, 0, 0.2)';
        button.style.backgroundColor = '#f8f8f8';
        button.style.padding = '30px 0';
        button.style.fontSize = '28px';
        button.style.fontWeight = 'bold';
        button.style.color = '#333';
        button.style.textAlign = 'center';
        button.style.transition = 'background-color 0.3s';
        button.textContent = 'HOLD';
        
        // Create progress bar
        const progressBar = document.createElement('div');
        progressBar.className = 'hold-progress';
        progressBar.style.position = 'absolute';
        progressBar.style.left = '0';
        progressBar.style.bottom = '0';
        progressBar.style.height = '8px';
        progressBar.style.width = '0%';
        progressBar.style.backgroundColor = '#4CAF50';
        progressBar.style.transition = 'width 0.1s linear';
        progressBar.style.borderRadius = '0 0 50px 50px';
        
        // Get hold time from data
        const requiredHoldTime = currentPuzzle.hold_time || 3; // Default to 3 seconds
        
        // Variables to track holding
        let isHolding = false;
        let holdStartTime = 0;
        let holdTimer = null;
        let completed = false;
        let currentHoldTime = 0;
        
        // Add event listeners for hold detection
        button.addEventListener('mousedown', startHolding);
        button.addEventListener('touchstart', startHolding);
        document.addEventListener('mouseup', stopHolding);
        document.addEventListener('touchend', stopHolding);
        
        function startHolding(e) {
            if (completed) return;
            
            // Prevent default behaviors for touch
            if (e.type === 'touchstart') {
                e.preventDefault();
            }
            
            isHolding = true;
            holdStartTime = Date.now();
            button.style.backgroundColor = '#e0e0e0';
            
            // Start progress animation
            holdTimer = setInterval(() => {
                if (!isHolding) return;
                
                const elapsedTime = (Date.now() - holdStartTime) / 1000; // in seconds
                currentHoldTime = elapsedTime;
                
                // Update progress bar
                const progress = Math.min((elapsedTime / requiredHoldTime) * 100, 100);
                progressBar.style.width = `${progress}%`;
                
                // Check if hold is complete
                if (elapsedTime >= requiredHoldTime && !completed) {
                    completeHold();
                }
            }, 100); // Update every 100ms
        }
        
        function stopHolding() {
            if (!isHolding || completed) return;
            
            isHolding = false;
            button.style.backgroundColor = '#f8f8f8';
            
            // Reset progress if not completed
            if (!completed) {
                progressBar.style.width = '0%';
                clearInterval(holdTimer);
            }
        }
        
        function completeHold() {
            completed = true;
            clearInterval(holdTimer);

            button.style.backgroundColor = '#4CAF50';
            button.style.color = 'white';
            button.textContent = 'COMPLETED';

            userAnswerInput.value = currentHoldTime.toFixed(2);

            resultMessage.textContent = "Verified.";
            resultMessage.className = 'result-message correct';

            // Auto-submit so the user never sees a separate Submit button.
            // Short delay lets the COMPLETED state render first.
            setTimeout(() => { submitAnswer(); }, 400);
        }
        
        // Add the progress bar to button
        button.appendChild(progressBar);
        
        // Add button to container
        buttonContainer.appendChild(button);
        
        // Add to puzzle container
        puzzleImageContainer.appendChild(buttonContainer);
        
        // Reset and clear input field
        userAnswerInput.value = '';
        userAnswerInput.style.display = 'none';
        submitBtn.disabled = false;  // Disable submit button until hold is complete
    }

    // Function to show dotted areas in debug mode for Pick_Area
    function showPickAreaTargets(container) {
        if (!DEBUG_MODE || !currentPuzzle) return;
        
        // Fetch ground truth data to show the correct area
        fetch('/api/get_ground_truth', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                puzzle_type: currentPuzzle.puzzle_type,
                puzzle_id: currentPuzzle.puzzle_id
            })
        })
        .then(response => response.json())
        .then(gtData => {
            if (gtData.answer && gtData.answer.area) {
                // Get the area from ground truth
                const areaCoords = gtData.answer.area;
                const areaType = gtData.answer.type || 'largest region';
                
                // Create a marker for the area
                const areaMarker = document.createElement('div');
                areaMarker.className = 'area-marker debug-marker';
                areaMarker.style.position = 'absolute';
                areaMarker.style.border = '3px dashed #ff3333';
                // Use a more transparent background to show the underlying dotted lines
                areaMarker.style.backgroundColor = 'rgba(255, 51, 51, 0.15)';
                areaMarker.style.zIndex = '999';
                // Add border radius to better represent curved areas
                areaMarker.style.borderRadius = '25%';
                
                // Set position and size. New mask-based GT stores the bbox in
                // image-natural pixels; legacy rect GT (`_bbox_unit: "rect"`)
                // is already in CSS coords, so only scale the former.
                const [topLeft, bottomRight] = areaCoords;
                let [minX, minY] = topLeft;
                let [maxX, maxY] = bottomRight;
                const dbgImg = document.getElementById('puzzle-image');
                if (gtData.answer._bbox_unit !== 'rect' && dbgImg && dbgImg.naturalWidth > 0) {
                    const dbgRect = dbgImg.getBoundingClientRect();
                    const sx = dbgRect.width / dbgImg.naturalWidth;
                    const sy = dbgRect.height / dbgImg.naturalHeight;
                    minX *= sx; maxX *= sx; minY *= sy; maxY *= sy;
                }

                areaMarker.style.left = `${minX}px`;
                areaMarker.style.top = `${minY}px`;
                areaMarker.style.width = `${maxX - minX}px`;
                areaMarker.style.height = `${maxY - minY}px`;
                
                // Add a label that better explains what to do
                const label = document.createElement('div');
                label.className = 'debug-label';
                label.style.position = 'absolute';
                label.style.top = '5px';
                label.style.left = '50%';
                label.style.transform = 'translateX(-50%)';
                label.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
                label.style.color = 'white';
                label.style.padding = '5px 10px';
                label.style.fontSize = '14px';
                label.style.fontWeight = 'bold';
                label.style.borderRadius = '3px';
                label.style.whiteSpace = 'nowrap';
                label.style.textAlign = 'center';
                label.textContent = `${areaType}: (${minX},${minY}) to (${maxX},${maxY})`;
                
                areaMarker.appendChild(label);
                
                // Add a note to explain that the actual area follows the dotted lines
                const note = document.createElement('div');
                note.className = 'area-note';
                note.style.position = 'absolute';
                note.style.bottom = '10px';
                note.style.left = '50%';
                note.style.transform = 'translateX(-50%)';
                note.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
                note.style.color = 'white';
                note.style.padding = '5px 10px';
                note.style.fontSize = '12px';
                note.style.borderRadius = '3px';
                note.style.maxWidth = '90%';
                note.style.textAlign = 'center';
                note.textContent = 'Follow the dotted white lines to identify the actual area';
                
                areaMarker.appendChild(note);
                container.appendChild(areaMarker);
                
                // Create indicators to highlight the dotted lines
                // This is a simplistic approach; ideally we would trace the actual dotted lines
                highlightDottedLines(container, areaCoords);
            }
        })
        .catch(error => {
            console.error('Error fetching ground truth for Pick_Area:', error);
        });
    }
    
    // Function to highlight the dotted lines that define the area
    function highlightDottedLines(container, areaCoords) {
        const [topLeft, bottomRight] = areaCoords;
        const [minX, minY] = topLeft;
        const [maxX, maxY] = bottomRight;
        
        // Create a canvas element to draw over the image
        const canvas = document.createElement('canvas');
        canvas.className = 'dotted-line-highlight';
        canvas.style.position = 'absolute';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.style.pointerEvents = 'none'; // Don't interfere with clicks
        canvas.style.zIndex = '998'; // Just below the area marker
        
        // Wait for the image to load to get the correct dimensions
        const img = container.querySelector('img');
        if (!img) return;
        
        if (img.complete) {
            setupCanvas();
        } else {
            img.onload = setupCanvas;
        }
        
        function setupCanvas() {
            canvas.width = img.clientWidth;
            canvas.height = img.clientHeight;
            
            const ctx = canvas.getContext('2d');
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
            ctx.lineWidth = 3;
            ctx.setLineDash([5, 5]); // Create a dashed line effect
            
            // Draw a path that approximates the dotted lines
            // This is just a rough approximation - would need image processing to trace actual lines
            ctx.beginPath();
            
            // Top line
            ctx.moveTo(minX, minY);
            ctx.lineTo(maxX, minY);
            
            // Right line
            ctx.moveTo(maxX, minY);
            ctx.lineTo(maxX, maxY);
            
            // Bottom line
            ctx.moveTo(maxX, maxY);
            ctx.lineTo(minX, maxY);
            
            // Left line
            ctx.moveTo(minX, maxY);
            ctx.lineTo(minX, minY);
            
            ctx.stroke();
            
            container.appendChild(canvas);
        }
    }

    // Function to show the area to avoid for Misleading_Click puzzles
    function showMisleadingClickArea(container, avoidArea) {
        if (!DEBUG_MODE || !avoidArea) return;
        
        // Create a marker for the area to avoid
        const areaMarker = document.createElement('div');
        areaMarker.className = 'avoid-area-marker debug-marker';
        areaMarker.style.position = 'absolute';
        areaMarker.style.border = '3px dashed red';
        areaMarker.style.backgroundColor = 'rgba(255, 0, 0, 0.3)';
        areaMarker.style.zIndex = '999';
        
        // Set position and size
        const { x, y, width, height } = avoidArea;
        areaMarker.style.left = `${x}px`;
        areaMarker.style.top = `${y}px`;
        areaMarker.style.width = `${width}px`;
        areaMarker.style.height = `${height}px`;
        
        // Add a label
        const label = document.createElement('div');
        label.className = 'debug-label';
        label.style.position = 'absolute';
        label.style.top = '-20px';
        label.style.left = '0';
        label.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
        label.style.color = 'white';
        label.style.padding = '2px 5px';
        label.style.fontSize = '12px';
        label.style.borderRadius = '3px';
        label.textContent = `DO NOT CLICK IN THIS AREA: (${x},${y}) ${width}x${height}`;
        
        // Add a warning sign in the middle
        const warningSign = document.createElement('div');
        warningSign.className = 'warning-sign';
        warningSign.textContent = 'DO NOT CLICK HERE';
        warningSign.style.position = 'absolute';
        warningSign.style.top = '50%';
        warningSign.style.left = '50%';
        warningSign.style.transform = 'translate(-50%, -50%)';
        warningSign.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
        warningSign.style.color = '#ff5555';
        warningSign.style.padding = '5px 10px';
        warningSign.style.fontSize = '14px';
        warningSign.style.fontWeight = 'bold';
        warningSign.style.borderRadius = '3px';
        warningSign.style.whiteSpace = 'nowrap';
        warningSign.style.zIndex = '10';
        
        areaMarker.appendChild(label);
        areaMarker.appendChild(warningSign);
        container.appendChild(areaMarker);
        
        console.log('Misleading Click area to avoid:', avoidArea);
    }

    /**
     * Checks if a point is inside a polygon defined by an array of points
     * Uses ray-casting algorithm
     * @param {number} x - X coordinate of the point to check
     * @param {number} y - Y coordinate of the point to check
     * @param {array} polygon - Array of points defining the polygon [[x1,y1], [x2,y2], ...]
     * @returns {boolean} True if the point is inside the polygon
     */
    function pointInPolygon(x, y, polygon) {
        if (!polygon || polygon.length < 3) return false;

        let inside = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const xi = polygon[i][0], yi = polygon[i][1];
            const xj = polygon[j][0], yj = polygon[j][1];
            
            const intersect = ((yi > y) != (yj > y)) &&
                (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        
        return inside;
    }

    /**
     * Sets up the Dart Count interface with reference number and dart images
     */
    function setupDartCount() {
        // Clear the puzzle image container
        puzzleImageContainer.innerHTML = '';
        
        // Create container for the dart count interface
        const dartContainer = document.createElement('div');
        dartContainer.className = 'dart-count-container';
        
        // Create a horizontal layout
        const horizontalLayout = document.createElement('div');
        horizontalLayout.className = 'dart-count-horizontal-layout';
        
        // Create reference container (shows the target number)
        const referenceContainer = document.createElement('div');
        referenceContainer.className = 'dart-count-reference';
        
        // Add reference image - check all possible locations for data
        const referenceImage = document.createElement('img');
        if (currentPuzzle.additional_data && currentPuzzle.additional_data.reference_image) {
            referenceImage.src = currentPuzzle.additional_data.reference_image;
        } else if (currentPuzzle.reference_image) {
            referenceImage.src = currentPuzzle.reference_image;
        } else {
            console.error('Reference image not found for Dart Count puzzle');
        }
        referenceImage.alt = 'Target Number';
        referenceImage.className = 'dart-count-reference-img';
        referenceContainer.appendChild(referenceImage);
        
        // Add reference caption
        const referenceCaption = document.createElement('div');
        referenceCaption.className = 'dart-count-caption';
        referenceCaption.textContent = 'Find sum of darts equal to this';
        referenceContainer.appendChild(referenceCaption);
        
        // Create options container
        const optionsContainer = document.createElement('div');
        optionsContainer.className = 'dart-count-options';
        
        // Get option images from all possible locations
        let optionImages = [];
        if (currentPuzzle.additional_data && currentPuzzle.additional_data.option_images) {
            optionImages = currentPuzzle.additional_data.option_images;
        } else if (currentPuzzle.option_images) {
            optionImages = currentPuzzle.option_images;
        } else {
            console.error('Option images not found for Dart Count puzzle');
            optionImages = [];
        }
        
        // Add option image
        const optionImage = document.createElement('img');
        if (optionImages.length > 0) {
            optionImage.src = optionImages[0]; // Start with first option
        }
        optionImage.alt = 'Dart Option';
        optionImage.className = 'dart-count-option-img';
        optionsContainer.appendChild(optionImage);
        
        // Create navigation controls
        const controlsContainer = document.createElement('div');
        controlsContainer.className = 'dart-count-controls';
        
        // Left arrow
        const leftArrow = document.createElement('button');
        leftArrow.innerHTML = '&larr;';
        leftArrow.className = 'dart-count-arrow left-arrow';
        leftArrow.addEventListener('click', () => updateDartOption(-1));
        
        // Right arrow
        const rightArrow = document.createElement('button');
        rightArrow.innerHTML = '&rarr;';
        rightArrow.className = 'dart-count-arrow right-arrow';
        rightArrow.addEventListener('click', () => updateDartOption(1));
        
        // Add arrows to controls
        controlsContainer.appendChild(leftArrow);
        controlsContainer.appendChild(rightArrow);
        
        // Add controls to options container
        optionsContainer.appendChild(controlsContainer);
        
        // Add reference and options to horizontal layout
        horizontalLayout.appendChild(referenceContainer);
        horizontalLayout.appendChild(optionsContainer);
        
        // Add horizontal layout to main container
        dartContainer.appendChild(horizontalLayout);
        
        // Add option indicators (dots)
        const indicators = document.createElement('div');
        indicators.className = 'dart-count-indicators';
        
        const numOptions = optionImages.length;
        for (let i = 0; i < numOptions; i++) {
            const dot = document.createElement('span');
            dot.className = 'dart-count-dot';
            if (i === 0) {
                dot.classList.add('active');
            }
            indicators.appendChild(dot);
        }
        
        // Add indicators to main container
        dartContainer.appendChild(indicators);
        
        // Add submit button
        const submitBtn = document.createElement('button');
        submitBtn.textContent = 'Submit';
        submitBtn.className = 'dart-count-submit';
        submitBtn.addEventListener('click', submitAnswer);
        
        // Add containers to puzzle image container
        puzzleImageContainer.appendChild(dartContainer);
        puzzleImageContainer.appendChild(submitBtn);
        
        // Store current index in the hidden input for submission
        userAnswerInput.value = '0';
        
        // Log all available data for debugging
        console.log('Dart Count puzzle data:', currentPuzzle);
    }
    
    /**
     * Update the displayed dart option image based on navigation direction
     * @param {number} direction - Direction to navigate (-1 for left, 1 for right)
     */
    function updateDartOption(direction) {
        const optionImage = document.querySelector('.dart-count-option-img');
        const dots = document.querySelectorAll('.dart-count-dot');
        
        // Get option images from all possible locations
        let optionImages = [];
        if (currentPuzzle.additional_data && currentPuzzle.additional_data.option_images) {
            optionImages = currentPuzzle.additional_data.option_images;
        } else if (currentPuzzle.option_images) {
            optionImages = currentPuzzle.option_images;
        } else {
            console.error('Option images not found for Dart Count puzzle');
            return;
        }
        
        // Get current index from input field
        let currentIndex = parseInt(userAnswerInput.value) || 0;
        const numOptions = optionImages.length;
        
        // Calculate new index with wrap-around
        let newIndex = (currentIndex + direction + numOptions) % numOptions;
        
        // Update the option image
        optionImage.src = optionImages[newIndex];
        
        // Update dots
        dots.forEach((dot, index) => {
            if (index === newIndex) {
                dot.classList.add('active');
            } else {
                dot.classList.remove('active');
            }
        });
        
        // Store selected answer for submission
        userAnswerInput.value = newIndex.toString();
        
        // Log for debugging
        console.log('Updated dart option:', {
            index: newIndex,
            src: optionImage.src
        });
    }

    /**
     * Display difficulty stars based on CAPTCHA type
     * @param {string} puzzleType - The type of CAPTCHA puzzle
     */
    function displayDifficultyStars(puzzleType) {
        // Mean number of agent actions a puzzle of this type takes, measured over
        // the 2100-puzzle Train split of each type (ground_truth_cu answer_cu
        // tool-call counts; the first alternative is used for multi-swap types).
        const avgActionSteps = {
            'Geometry_Click': 1.00,
            'Hold_Button': 1.00,
            'Misleading_Click': 1.00,
            'Pick_Area': 1.00,
            'Place_Dot': 2.00,
            'Select_Animal': 2.00,
            'Image_Matching': 2.98,
            'Bingo': 3.00,
            'Dice_Count': 3.00,
            'Slide_Puzzle': 3.00,
            'Coordinates': 3.00,
            'Object_Match': 3.01,
            'Connect_icon': 3.55,
            'Dart_Count': 3.67,
            'Path_Finder': 3.67,
            'Unusual_Detection': 4.50,
            'Rotation_Match': 4.50,
            'Image_Recognition': 4.54,
            'Click_Order': 4.98,
            'Patch_Select': 8.49,
        };

        // Bin the mean action count into 1-5 stars.
        const avg = avgActionSteps[puzzleType];
        const difficulty = avg === undefined ? 1
            : avg <= 1.5 ? 1
            : avg <= 2.5 ? 2
            : avg <= 3.5 ? 3
            : avg <= 4.75 ? 4
            : 5;

        const starsContainer = document.getElementById('difficulty-stars');
        
        // Safety check to ensure the container exists
        if (!starsContainer) {
            console.error('Stars container not found!');
            return;
        }
        
        // Clear the container
        starsContainer.innerHTML = '';

        // Create and append stars
        for (let i = 0; i < 5; i++) {
            const star = document.createElement('span');
            star.className = 'star';
            star.innerHTML = i < difficulty ? '★' : '☆'; // Filled or empty star
            starsContainer.appendChild(star);
        }
        
        // Log for debugging
        console.log(`Displayed ${difficulty} action-step stars (avg ${avg}) for puzzle type: ${puzzleType}`);
    }

    // Function to get a new puzzle
    function getPuzzle(callback) {
        let queryParams = '';
        
        // Check if debug mode is active and add the debug_type parameter if it is
        if (DEBUG_MODE && DEBUG_TYPE) {
            queryParams = `?debug_type=${encodeURIComponent(DEBUG_TYPE)}`;
        }
        
        fetch('/api/get_puzzle' + queryParams)
            .then(response => response.json())
            .then(data => {
                currentPuzzle = data;
                window.currentPuzzle = data;
                preloadPuzzleImages(data).then(notifyReady);

                // Log the data for debugging
                console.log('Puzzle data:', data);
                
                // Set the prompt and update debug information
                const promptElement = document.getElementById('puzzle-prompt');
                promptElement.textContent = data.prompt;
                
                // Display difficulty stars based on puzzle type
                displayDifficultyStars(data.puzzle_type);
                
                // Update debug indicator if in debug mode
                const debugIndicator = document.getElementById('debug-indicator');
                const debugTypeDisplay = document.getElementById('debug-type-display');
                
                if (DEBUG_MODE && DEBUG_TYPE) {
                    debugIndicator.style.display = 'block';
                    debugTypeDisplay.textContent = DEBUG_TYPE;
                } else {
                    debugIndicator.style.display = 'none';
                }
                
                // Handle different input types
                const imageContainer = document.getElementById('puzzle-image-container');
                const userAnswerInput = document.getElementById('user-answer');
                const submitBtn = document.getElementById('submit-answer');
                
                // Reset the input field and enable submit button
                userAnswerInput.value = '';
                submitBtn.disabled = false;
                
                // Clear any previous result message
                const resultMessage = document.getElementById('result-message');
                resultMessage.textContent = '';
                resultMessage.className = 'result-message';
                
                // Clear the puzzle image container
                imageContainer.innerHTML = '';
                
                // Set up UI based on input type
                if (data.input_type === 'number') {
                    // For numeric input (e.g., Dice_Count)
                    userAnswerInput.type = 'number';
                    userAnswerInput.placeholder = 'Enter number';
                    userAnswerInput.style.display = 'block';
                    submitBtn.style.display = 'block';
                    
                    // Load the image
                    const img = document.createElement('img');
                    img.src = data.image_path;
                    img.alt = 'CAPTCHA Puzzle';
                    img.id = 'puzzle-image';
                    img.onload = function() {
                        imageContainer.appendChild(img);
                    };
                } else if (data.input_type === 'click') {
                    // For click-based puzzles (Geometry_Click, Place_Dot, etc.)
                    userAnswerInput.style.display = 'none';
                    submitBtn.style.display = 'none';
                    
                    // Load the image and set up click handler
                    const img = document.createElement('img');
                    img.src = data.image_path;
                    img.alt = 'CAPTCHA Puzzle';
                    img.id = 'puzzle-image';
                    img.onclick = handleImageClick;
                    
                    img.onload = function() {
                        imageContainer.appendChild(img);
                        
                        // For Misleading_Click, show the area to avoid in debug mode
                        if (data.puzzle_type === 'Misleading_Click' && DEBUG_MODE) {
                            showMisleadingClickArea(imageContainer, data.avoid_area);
                        }
                        
                        // For Pick_Area, show the target areas in debug mode
                        if (data.puzzle_type === 'Pick_Area' && DEBUG_MODE) {
                            showPickAreaTargets(imageContainer);
                        }
                    };
                } else if (data.input_type === 'rotation') {
                    // For rotation puzzles
                    userAnswerInput.style.display = 'none';
                    submitBtn.style.display = 'block';
                    
                    // Set up rotation controls
                    setupRotationControls();
                } else if (data.input_type === 'slide') {
                    // For slide puzzles
                    userAnswerInput.style.display = 'none';
                    submitBtn.style.display = 'block';
                    
                    // Set up slide puzzle
                    setupSlidePuzzle();
                } else if (data.input_type === 'multiselect') {
                    // For multiple selection puzzles (Unusual_Detection)
                    userAnswerInput.style.display = 'none';
                    submitBtn.style.display = 'block';
                    
                    // Set up grid for unusual detection
                    setupUnusualDetectionGrid();
                } else if (data.input_type === 'bingo_swap') {
                    // For bingo swap puzzles
                    userAnswerInput.style.display = 'none';
                    submitBtn.style.display = 'block';
                    
                    // Set up bingo swap interface
                    setupBingoSwap();
                } else if (data.input_type === 'image_grid') {
                    // For image grid puzzles (Image_Recognition)
                    userAnswerInput.style.display = 'none';
                    submitBtn.style.display = 'block';
                    
                    // Set up image recognition grid
                    setupImageRecognition();
                } else if (data.input_type === 'image_matching') {
                    // For image matching puzzles
                    userAnswerInput.style.display = 'none';
                    submitBtn.style.display = 'block';
                    
                    // Set up image matching interface
                    setupImageMatching();
                } else if (data.input_type === 'patch_select') {
                    // For patch select puzzles
                    userAnswerInput.style.display = 'none';
                    submitBtn.style.display = 'block';
                    
                    // Set up patch select grid
                    setupPatchSelectGrid();
                } else if (data.input_type === 'dart_count') {
                    // For dart count puzzles
                    userAnswerInput.style.display = 'none';
                    submitBtn.style.display = 'none';
                    
                    // Set up dart count interface
                    setupDartCount();
                } else if (data.input_type === 'object_match') {
                    // For object match puzzles
                    userAnswerInput.style.display = 'none';
                    submitBtn.style.display = 'block';
                    
                    // Set up object match interface
                    setupObjectMatch();
                } else if (data.input_type === 'select_animal') {
                    // For animal selection puzzles
                    userAnswerInput.style.display = 'none';
                    submitBtn.style.display = 'block';
                    
                    // Set up animal selection grid
                    setupSelectAnimalGrid();
                } else if (data.input_type === 'place_dot') {
                    // For place dot puzzles
                    userAnswerInput.style.display = 'none';
                    submitBtn.style.display = 'none';
                    
                    // Set up place dot interface
                    setupPlaceDot();
                } else if (data.input_type === 'connect_icon') {
                    // For connect icon puzzles
                    userAnswerInput.style.display = 'none';
                    submitBtn.style.display = 'block';
                    
                    // Set up connect icon interface
                    setupConnectIcon();
                } else if (data.input_type === 'click_order') {
                    // For click order puzzles
                    userAnswerInput.style.display = 'none';
                    submitBtn.style.display = 'block';
                    
                    // Set up click order interface
                    setupClickOrder();
                } else if (data.input_type === 'hold_button') {
                    // For hold button puzzles
                    userAnswerInput.style.display = 'none';
                    submitBtn.style.display = 'block';
                    
                    // Set up hold button interface
                    setupHoldButton();
                } else {
                    // Default to text input for other types
                    userAnswerInput.type = 'text';
                    userAnswerInput.placeholder = 'Your answer';
                    userAnswerInput.style.display = 'block';
                    submitBtn.style.display = 'block';
                    
                    // Load the image
                    const img = document.createElement('img');
                    img.src = data.image_path;
                    img.alt = 'CAPTCHA Puzzle';
                    img.id = 'puzzle-image';
                    img.onload = function() {
                        imageContainer.appendChild(img);
                    };
                }
                
                // Call the callback if provided
                if (callback && typeof callback === 'function') {
                    callback();
                }
            })
            .catch(error => {
                console.error('Error fetching puzzle:', error);
            });
    }
}); 
