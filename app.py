import os
import re
import json
import random
from flask import Flask, render_template, request, jsonify, send_from_directory, g


def _base_type(pt: str) -> str:
    """Strip a trailing `_<digits>` size suffix used for generated train/eval
    variants (e.g. ``Image_Recognition_2100`` → ``Image_Recognition``,
    ``Bingo_500`` → ``Bingo``). Use this for behaviour branching only — folder
    lookups must keep the original ``puzzle_type`` so the data is found in the
    right subdirectory."""
    return re.sub(r'_\d+$', '', pt)

# Set random seed for reproducible puzzle selection across runs
random.seed(0)

app = Flask(__name__, static_folder='static', template_folder='templates')

# Data directories. Default keeps legacy behaviour (captcha_data_gen takes priority,
# captcha_data is the fallback). Set CAPTCHA_DATA_DIRS to a comma-separated path list
# to redirect — e.g. CAPTCHA_DATA_DIRS=data/Train when verifying generated splits.
DATA_DIRS = [
    p.strip()
    for p in os.environ.get('CAPTCHA_DATA_DIRS', 'captcha_data_gen,captcha_data').split(',')
    if p.strip()
]

# Root that holds named dataset splits (Train / Val / Test / Validation / ...).
# When a request carries `?split=<name>`, resolve_data_dir() and load_ground_truth()
# scope to `<DATASET_ROOT>/<name>/` exclusively, ignoring DATA_DIRS for that request.
# This lets the web viewer's modal iframe inspect any split without needing a
# separate Flask process per split.
DATASET_ROOT = os.environ.get('CAPTCHA_DATASET_ROOT', 'data')


@app.after_request
def _cache_static(resp):
    # Skip the conditional-GET roundtrip for css/js across the SSH tunnel.
    if request.path.startswith('/static/'):
        resp.headers['Cache-Control'] = 'public, max-age=3600'
    return resp


@app.before_request
def _read_split():
    """Stash the `split` query param on flask.g for use during this request."""
    s = request.args.get('split') or None
    if s:
        # Avoid filesystem escapes (`split=../etc`); accept only simple names.
        if any(c in s for c in ('/', '\\', '..')) or not s.replace('_', '').replace('-', '').isalnum():
            s = None
    g.split = s


def _split_qs():
    """Return the URL suffix to forward the current split to subsequent calls."""
    s = getattr(g, 'split', None)
    return f'?split={s}' if s else ''


def _annotate_split_in_payload(value):
    """Recursively append `?split=<name>` to all `/captcha_data/...` URLs in the
    response so the browser propagates the split to subsequent asset fetches.

    No-op when no split is in scope. Skips URLs that already carry a `?` since
    they have their own query string semantics."""
    qs = _split_qs()
    if not qs:
        return value
    if isinstance(value, dict):
        return {k: _annotate_split_in_payload(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_annotate_split_in_payload(v) for v in value]
    if isinstance(value, str) and value.startswith('/captcha_data/') and '?' not in value:
        return value + qs
    return value


def resolve_data_dir(captcha_type):
    """Return the first data directory that contains this captcha_type.

    When the request carries `?split=<name>`, restrict the lookup to
    `<DATASET_ROOT>/<name>/` and do not fall back — that way `Train/Bingo` and
    `Validation/Bingo` (same id, different content) never get confused."""
    split = getattr(g, 'split', None) if g else None
    if split:
        d = os.path.join(DATASET_ROOT, split)
        p = os.path.join(d, captcha_type)
        if os.path.isdir(p) and os.path.exists(os.path.join(p, 'ground_truth.json')):
            return d
        return None  # caller must handle the miss; do NOT silently fall back
    for d in DATA_DIRS:
        p = os.path.join(d, captcha_type)
        if os.path.isdir(p) and os.path.exists(os.path.join(p, 'ground_truth.json')):
            return d
    return DATA_DIRS[0]  # fallback

def _pick_area_mask_hit(mask_path, user_x, user_y):
    """Pick_Area mask judging: map the (image-natural) click to the mask and
    return True when the pixel is white (>127). Tiny LRU keeps repeat checks
    of the same puzzle cheap without holding thousands of 1254^2 masks."""
    from PIL import Image
    try:
        mask = _PICK_AREA_MASK_CACHE.get(mask_path)
        if mask is None:
            with Image.open(mask_path) as im:
                mask = im.convert('L').copy()
            if len(_PICK_AREA_MASK_CACHE) >= 32:
                _PICK_AREA_MASK_CACHE.pop(next(iter(_PICK_AREA_MASK_CACHE)))
            _PICK_AREA_MASK_CACHE[mask_path] = mask
        ix, iy = int(round(float(user_x))), int(round(float(user_y)))
        w, h = mask.size
        return 0 <= ix < w and 0 <= iy < h and mask.getpixel((ix, iy)) > 127
    except (FileNotFoundError, OSError, ValueError):
        return False

_PICK_AREA_MASK_CACHE: dict = {}

# Pre-generate puzzle sequences at startup
PUZZLE_SEQUENCES = {}  # {type: [puzzle1, puzzle2, ...]}
PUZZLE_INDEX = {}      # {type: current_index}
PUZZLE_DATA_DIR = {}   # {type: which data dir it lives in}

def pregenerate_sequences():
    for base_dir in DATA_DIRS:
        if not os.path.exists(base_dir):
            continue

        for ctype in os.listdir(base_dir):
            if ctype in PUZZLE_SEQUENCES:
                continue  # already loaded from a higher-priority dir
            if ctype.endswith('_deprecated'):
                continue  # retired datasets kept on disk for reference only
            if not os.path.isdir(os.path.join(base_dir, ctype)):
                continue

            path = os.path.join(base_dir, ctype, 'ground_truth.json')
            try:
                with open(path, 'r') as f:
                    gt = json.load(f)
            except:
                continue

            # Generate sequence with fresh seed per type
            rng = random.Random(0)
            puzzle_files = list(gt.keys())
            sequence = []
            seen = set()

            for _ in range(len(puzzle_files)):
                unseen = [p for p in puzzle_files if p not in seen]
                if not unseen:
                    break
                selected = rng.choice(unseen)
                seen.add(selected)
                sequence.append(selected)

            PUZZLE_SEQUENCES[ctype] = sequence
            PUZZLE_INDEX[ctype] = 0
            PUZZLE_DATA_DIR[ctype] = base_dir

pregenerate_sequences()

# Legacy tracking (kept for compatibility)
seen_puzzles = {}
# List to track recently used CAPTCHA types to avoid repetition
recent_types = []
# How many types to remember before allowing repetition
MAX_RECENT_TYPES = 5

PUZZLE_TYPE_SEQUENCE = [
    'Dice_Count',
     'Geometry_Click',
    'Rotation_Match',
    'Slide_Puzzle',
    'Unusual_Detection',
    'Image_Recognition',
    'Bingo',
    'Image_Matching',
    'Patch_Select',
    'Dart_Count',
    'Object_Match',
    'Select_Animal',
    'Coordinates',
    'Path_Finder',
    'Place_Dot',
    'Connect_icon',
    'Click_Order',
    'Hold_Button',
    'Misleading_Click',
    'Pick_Area',
    'OCR'
]
sequential_index = 0

# In-memory cache keyed by absolute GT path, so (captcha_type, split) variations
# are naturally distinct. Restart the server after modifying any ground_truth.json.
_GT_CACHE: dict[str, dict] = {}

# Load ground truth data for a specific type
def load_ground_truth(captcha_type):
    base = resolve_data_dir(captcha_type)
    if not base:
        return {}
    path = os.path.join(base, captcha_type, 'ground_truth.json')
    cached = _GT_CACHE.get(path)
    if cached is not None:
        return cached
    try:
        with open(path, 'r') as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    _GT_CACHE[path] = data
    return data

# Get available CAPTCHA types
def get_captcha_types():
    types = set()
    for base_dir in DATA_DIRS:
        if not os.path.exists(base_dir):
            continue
        for d in os.listdir(base_dir):
            if d.endswith('_deprecated'):
                continue  # retired datasets kept on disk for reference only
            if os.path.isdir(os.path.join(base_dir, d)):
                types.add(d)
    return sorted(types)

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/captcha_data/<captcha_type>/<filename>')
def serve_captcha(captcha_type, filename):
    base = resolve_data_dir(captcha_type)
    if not base:
        return jsonify({'error': f'puzzle data not found for {captcha_type} in this split'}), 404
    resp = send_from_directory(os.path.join(base, captcha_type), filename)
    resp.headers['Cache-Control'] = 'public, max-age=86400, immutable'
    return resp

@app.route('/captcha_data/<captcha_type>/<subdir>/<filename>')
def serve_captcha_subdir(captcha_type, subdir, filename):
    base = resolve_data_dir(captcha_type)
    if not base:
        return jsonify({'error': f'puzzle data not found for {captcha_type} in this split'}), 404
    resp = send_from_directory(os.path.join(base, captcha_type, subdir), filename)
    resp.headers['Cache-Control'] = 'public, max-age=86400, immutable'
    return resp

@app.route('/api/get_puzzle', methods=['GET'])
def get_puzzle():
    global recent_types
    
    # Check if we should return a random puzzle from any type
    is_random = request.args.get('random', 'false').lower() == 'true'
    
    # Get all available CAPTCHA types
    captcha_types = get_captcha_types()
    if not captcha_types:
        return jsonify({'error': 'No CAPTCHA types found'}), 404
    
    # Check if we're in debug mode for a specific type
    debug_type = request.args.get('debug_type')

    mode = request.args.get('mode', '').lower()

    if debug_type and debug_type in captcha_types:
        puzzle_type = debug_type
    elif not is_random and mode == 'sequential':
        global sequential_index
        # Restrict to types actually loaded (handles CAPTCHA_DATA_DIRS-scoped
        # Flasks where only one or two types exist). Falls back to the full
        # hardcoded sequence when everything is loaded.
        active_seq = [t for t in PUZZLE_TYPE_SEQUENCE if t in captcha_types]
        if not active_seq:
            active_seq = sorted(captcha_types) if captcha_types else PUZZLE_TYPE_SEQUENCE
        puzzle_type = active_seq[sequential_index % len(active_seq)]
        sequential_index += 1
    elif is_random:
        # Select a random CAPTCHA type, avoiding recently used types if possible
        available_types = [t for t in captcha_types if t not in recent_types]
        
        # If all types have been used recently, reset the tracking
        if not available_types:
            recent_types = []
            available_types = captcha_types
        
        puzzle_type = random.choice(available_types)
        
        # Add to recent types and maintain maximum length
        recent_types.append(puzzle_type)
        if len(recent_types) > MAX_RECENT_TYPES:
            recent_types.pop(0)
    else:
        # Get puzzle type from query parameter
        puzzle_type = request.args.get('type', 'Dice_Count')
        # Check if puzzle type exists
        if puzzle_type not in captcha_types:
            return jsonify({'error': f'Invalid puzzle type: {puzzle_type}'}), 400
    
    # Load ground truth for the selected type
    ground_truth = load_ground_truth(puzzle_type)
    if not ground_truth:
        return jsonify({'error': f'No puzzles found for type: {puzzle_type}'}), 404
    
    # Use predetermined sequence
    idx = PUZZLE_INDEX.get(puzzle_type, 0)
    sequence = PUZZLE_SEQUENCES.get(puzzle_type, list(ground_truth.keys()))
    selected_puzzle = sequence[idx % len(sequence)]
    PUZZLE_INDEX[puzzle_type] = idx + 1

    # Print to terminal
    print(f"[{puzzle_type}] idx={idx} puzzle={selected_puzzle}")

    # `base_type` collapses generated-size variants (e.g. Image_Recognition_2100
    # → Image_Recognition) for the behaviour switches below. Folder/path
    # construction still uses the original `puzzle_type`.
    base_type = _base_type(puzzle_type)

    # Get the appropriate question prompt based on puzzle type
    if base_type == "Dice_Count":
        prompt = ground_truth[selected_puzzle].get('prompt', "Sum up the numbers on all the dice")
    elif base_type == "Geometry_Click":
        prompt = ground_truth[selected_puzzle].get("question", "Click on the geometric shape")
    elif base_type == "Rotation_Match":
        prompt = ground_truth[selected_puzzle].get("prompt", "Use the arrows to rotate the object to match the reference direction")
    elif base_type == "Slide_Puzzle":
        prompt = ground_truth[selected_puzzle].get("prompt", "Drag the slider component to the correct position")
    elif base_type == "Unusual_Detection":
        prompt = ground_truth[selected_puzzle].get("prompt", "Select the unusual items in the image")
    elif base_type == "Image_Recognition":
        prompt = ground_truth[selected_puzzle].get("prompt", "Select all images matching the description")
    elif base_type == "Bingo":
        prompt = ground_truth[selected_puzzle].get("prompt", "Please click two images to exchange their position to line up the same images to a line")
    elif base_type == "Image_Matching":
        prompt = ground_truth[selected_puzzle].get("prompt", "Using the arrows, match the animal in the left and right image.")
    elif base_type == "Patch_Select":
        prompt = ground_truth[selected_puzzle].get("prompt", "Select all squares with the specified objects")
    elif base_type == "Dart_Count":
        prompt = ground_truth[selected_puzzle].get("prompt", "Use the arrows to pick the image where all the darts add up to the number in the left image.")
    elif base_type == "Object_Match":
        prompt = ground_truth[selected_puzzle].get("prompt", "Use the arrows to change the number of objects until it matches the left image.")
    elif base_type == "Select_Animal":
        prompt = ground_truth[selected_puzzle].get("prompt", "Pick a fox")
    elif base_type == "Coordinates":
        prompt = ground_truth[selected_puzzle].get("prompt", "Using the arrows, move Jerry to the indicated seat")
    elif base_type == "Path_Finder":
        prompt = ground_truth[selected_puzzle].get("prompt", "Use the arrows to move the duck to the spot indicated by the cross")
    elif base_type == "Place_Dot":
        prompt = ground_truth[selected_puzzle].get("prompt", "Click to place a Dot at the end of the car's path")
    elif base_type == "Connect_icon":
        prompt = ground_truth[selected_puzzle].get("prompt", "Using the arrows, connect the same two icons with the dotted line as shown on the left.")
    elif base_type == "Click_Order":
        prompt = ground_truth[selected_puzzle].get("prompt", "Click the icons in order as shown in the reference image.")
    elif base_type == "Hold_Button":
        prompt = ground_truth[selected_puzzle].get("prompt", "Hold the button until it finishes loading.")
    elif base_type == "Misleading_Click":
        prompt = ground_truth[selected_puzzle].get("prompt", "Click the image to continue.")
    elif base_type == "Pick_Area":
        prompt = ground_truth[selected_puzzle].get("prompt", "Click on the largest area outlined by the dotted line")
    elif base_type == "OCR":
        prompt = ground_truth[selected_puzzle].get("prompt", "Type the characters shown in the image.")
    else:
        prompt = ground_truth[selected_puzzle].get("prompt", "Solve the CAPTCHA puzzle")
    
    # Add input_type to tell the frontend what kind of input to show
    input_type = "text"
    if base_type == "Dice_Count":
        input_type = "number"
    elif base_type == "Geometry_Click":
        input_type = "click"
    elif base_type == "Rotation_Match":
        input_type = "rotation"
    elif base_type == "Slide_Puzzle":
        input_type = "slide"
    elif base_type == "Unusual_Detection":
        input_type = "multiselect"
    elif base_type == "Image_Recognition":
        input_type = "image_grid"
    elif base_type == "Bingo":
        input_type = "bingo_swap"
    elif base_type == "Image_Matching":
        input_type = "image_matching"
    elif base_type == "Patch_Select":
        input_type = "patch_select"
    elif base_type == "Dart_Count":
        input_type = "dart_count"
    elif base_type == "Object_Match":
        input_type = "object_match"
    elif base_type == "Select_Animal":
        input_type = "select_animal"
    elif base_type == "Coordinates":
        input_type = "image_matching"
    elif base_type == "Path_Finder":
        input_type = "image_matching"
    elif base_type == "Place_Dot":
        input_type = "place_dot"
    elif base_type == "Connect_icon":
        input_type = "connect_icon"
    elif base_type == "Click_Order":
        input_type = "click_order"
    elif base_type == "Hold_Button":
        input_type = "hold_button"
    elif base_type == "Misleading_Click":
        input_type = "click"
    elif base_type == "Pick_Area":
        input_type = "click"
    
    # For Rotation_Match, include additional data needed for the interface
    additional_data = {}
    if base_type == "Rotation_Match":
        # Get reference image and object base name
        reference_image = ground_truth[selected_puzzle].get("reference_image")
        object_base_image = ground_truth[selected_puzzle].get("object_base_image")
        
        if not reference_image or not object_base_image:
            # If missing required fields, try another puzzle or fall back
            return jsonify({'error': f'Invalid rotation puzzle data: {selected_puzzle}'}), 500
        
        # Format paths for these images
        ref_path = f'/captcha_data/{puzzle_type}/{reference_image}'
        
        # Get object base name without extension to construct rotated image paths
        object_base = os.path.splitext(object_base_image)[0]
        
        # Construct the initial object image path (0 degrees rotation)
        object_path = f'/captcha_data/{puzzle_type}/{object_base}_0.png'
        
        additional_data = {
            "reference_image": ref_path,
            "object_image": object_path,
            "object_base": object_base,
            "current_angle": 0
        }
    # For Slide_Puzzle, include the component image path and target position data
    elif base_type == "Slide_Puzzle":
        # Get component image name
        component_image = ground_truth[selected_puzzle].get("component_image")
        
        if not component_image:
            # If missing required fields, try another puzzle or fall back
            return jsonify({'error': f'Invalid slide puzzle data: {selected_puzzle}'}), 500
        
        # Format path for the component image
        component_path = f'/captcha_data/{puzzle_type}/{component_image}'
        
        additional_data = {
            "component_image": component_path,
            "background_image": f'/captcha_data/{puzzle_type}/{selected_puzzle}',
            # Reveal only the y component of the target so the page can place
            # the slider on the correct horizontal track. The x is still the
            # puzzle (the user/agent must figure that out by dragging).
            "slider_track_y": ground_truth[selected_puzzle].get("target_position", [0, 0])[1],
        }
        # When the component PNG was upsized (oversized-validation fix), the
        # piece is bigger than the bg hole. Expose hole_size so the frontend
        # can Y-center the piece on the hole (otherwise piece would overflow).
        hole_size = ground_truth[selected_puzzle].get("hole_size")
        if hole_size:
            additional_data["hole_size"] = hole_size
    # For Unusual_Detection, include the grid size
    elif base_type == "Unusual_Detection":
        # Get grid size from ground truth
        grid_size = ground_truth[selected_puzzle].get("grid_size", [2, 3])  # Default to 2x3 grid if not specified
        
        additional_data = {
            "grid_size": grid_size
        }
    # For Image_Recognition, include the grid images
    elif base_type == "Image_Recognition":
        # Get images array from ground truth
        images = ground_truth[selected_puzzle].get("images", [])
        grid_size = [3, 3]  # Default grid size for image recognition (3x3)
        
        # Get the subfolder name from the puzzle_id or use a specific subfolder field
        subfolder = ground_truth[selected_puzzle].get("subfolder", selected_puzzle)
        
        # Include image paths in response - dynamically use the subfolder
        image_paths = [f'/captcha_data/{puzzle_type}/{subfolder}/{img}' for img in images]
        
        additional_data = {
            "images": image_paths,
            "grid_size": grid_size,
            "question": ground_truth[selected_puzzle].get("question", "Select matching images")
        }
    # For Bingo, include the grid size
    elif base_type == "Bingo":
        # Get grid size from ground truth
        grid_size = ground_truth[selected_puzzle].get("grid_size", [3, 3])  # Default to 3x3 grid if not specified
        
        additional_data = {
            "grid_size": grid_size,
            "solution_line": ground_truth[selected_puzzle].get("solution_line", {}),
            "answer": ground_truth[selected_puzzle].get("answer", [])
        }
    # For Image_Matching, include the reference image and options
    elif base_type == "Image_Matching":
        # Get the reference image and option images
        reference_image = ground_truth[selected_puzzle].get("reference_image")
        option_images = ground_truth[selected_puzzle].get("option_images", [])
        correct_option_index = ground_truth[selected_puzzle].get("correct_option_index", 0)
        
        if not reference_image or not option_images:
            return jsonify({'error': f'Invalid image matching data: {selected_puzzle}'}), 500
        
        # Format paths for these images
        ref_path = f'/captcha_data/{puzzle_type}/{reference_image}'
        option_paths = [f'/captcha_data/{puzzle_type}/{img}' for img in option_images]
        
        additional_data = {
            "reference_image": ref_path,
            "option_images": option_paths,
            "current_option_index": 0,
            "correct_option_index": correct_option_index
        }
    # For Patch_Select, include the grid size and target object
    elif base_type == "Patch_Select":
        # Get grid size from ground truth, default to 6x6 grid
        grid_size = ground_truth[selected_puzzle].get("grid_size", [5, 5])
        target_object = ground_truth[selected_puzzle].get("target_object", "moon")
        correct_patches = ground_truth[selected_puzzle].get("correct_patches", [])
        
        additional_data = {
            "grid_size": grid_size,
            "target_object": target_object,
            "correct_patches": correct_patches
        }
    # For Dart_Count, include the reference image and options
    elif base_type == "Dart_Count":
        # Get the reference image and option images
        reference_image = ground_truth[selected_puzzle].get("reference_image")
        option_images = ground_truth[selected_puzzle].get("option_images", [])
        correct_option_index = ground_truth[selected_puzzle].get("correct_option_index", 0)
        reference_number = ground_truth[selected_puzzle].get("reference_number", 0)
        
        if not reference_image or not option_images:
            return jsonify({'error': f'Invalid dart count data: {selected_puzzle}'}), 500
        
        # Format paths for these images
        ref_path = f'/captcha_data/{puzzle_type}/{reference_image}'
        option_paths = [f'/captcha_data/{puzzle_type}/{img}' for img in option_images]
        
        additional_data = {
            "reference_image": ref_path,
            "option_images": option_paths,
            "current_option_index": 0,
            "correct_option_index": correct_option_index,
            "reference_number": reference_number
        }
    # For Object_Match, include the reference image and options
    elif base_type == "Object_Match":
        # Get the reference image and option images
        reference_image = ground_truth[selected_puzzle].get("reference_image")
        option_images = ground_truth[selected_puzzle].get("option_images", [])
        correct_option_index = ground_truth[selected_puzzle].get("correct_option_index", 0)
        
        if not reference_image or not option_images:
            return jsonify({'error': f'Invalid object match data: {selected_puzzle}'}), 500
        
        # Format paths for these images
        ref_path = f'/captcha_data/{puzzle_type}/{reference_image}'
        option_paths = [f'/captcha_data/{puzzle_type}/{img}' for img in option_images]
        
        additional_data = {
            "reference_image": ref_path,
            "option_images": option_paths,
            "current_option_index": 0,
            "correct_option_index": correct_option_index
        }
    # For Select_Animal, include the grid size and target object
    elif base_type == "Select_Animal":
        # Get grid size from ground truth, default to 2x3 grid
        grid_size = ground_truth[selected_puzzle].get("grid_size", [2, 3])
        target_object = ground_truth[selected_puzzle].get("target_object", "fox")
        correct_patches = ground_truth[selected_puzzle].get("correct_patches", [])
        
        additional_data = {
            "grid_size": grid_size,
            "target_object": target_object,
            "correct_patches": correct_patches
        }
    # For Coordinates, include the reference image and options
    elif base_type == "Coordinates":
        # Get the reference image and option images
        reference_image = ground_truth[selected_puzzle].get("reference_image")
        option_images = ground_truth[selected_puzzle].get("option_images", [])
        correct_option_index = ground_truth[selected_puzzle].get("correct_option_index", 0)
        
        if not reference_image or not option_images:
            return jsonify({'error': f'Invalid coordinates data: {selected_puzzle}'}), 500
        
        # Format paths for these images
        ref_path = f'/captcha_data/{puzzle_type}/{reference_image}'
        option_paths = [f'/captcha_data/{puzzle_type}/{img}' for img in option_images]
        
        additional_data = {
            "reference_image": ref_path,
            "option_images": option_paths,
            "current_option_index": 0,
            "correct_option_index": correct_option_index
        }
    # For Path_Finder, include the reference image and options
    elif base_type == "Path_Finder":
        # Get the reference image and option images
        reference_image = ground_truth[selected_puzzle].get("reference_image")
        options = ground_truth[selected_puzzle].get("options", [])
        correct_option = ground_truth[selected_puzzle].get("correct_option", 0)
        
        if not reference_image or not options:
            return jsonify({'error': f'Invalid path finder data: {selected_puzzle}'}), 500
        
        # Format paths for these images
        ref_path = f'/captcha_data/{puzzle_type}/{reference_image}'
        option_paths = [f'/captcha_data/{puzzle_type}/{img}' for img in options]
        
        additional_data = {
            "reference_image": ref_path,
            "option_images": option_paths,
            "current_option_index": 0,
            "correct_option_index": correct_option
        }
    # For Connect_icon, include the reference image and options
    elif base_type == "Connect_icon":
        # Get the reference image and option images
        reference_image = ground_truth[selected_puzzle].get("reference_image")
        options = ground_truth[selected_puzzle].get("options", [])
        correct_option = ground_truth[selected_puzzle].get("correct_option", 0)
        
        if not reference_image or not options:
            return jsonify({'error': f'Invalid connect icons data: {selected_puzzle}'}), 500
        
        # Format paths for these images
        ref_path = f'/captcha_data/{puzzle_type}/{reference_image}'
        option_paths = [f'/captcha_data/{puzzle_type}/{img}' for img in options]
        
        additional_data = {
            "reference_image": ref_path,
            "option_images": option_paths,
            "current_option_index": 0,
            "correct_option_index": correct_option
        }
    # For Click_Order, include the order image path
    elif base_type == "Click_Order":
        # Get the order image from ground truth
        order_image = ground_truth[selected_puzzle].get("order_image")
        
        if not order_image:
            return jsonify({'error': f'Invalid click order data: {selected_puzzle}'}), 500
        
        # Format path for the order image
        order_path = f'/captcha_data/{puzzle_type}/{order_image}'
        
        additional_data = {
            "order_image": order_path,
            "tolerance": ground_truth[selected_puzzle].get("tolerance", 20)
        }
    # For Hold_Button, include the hold time
    elif base_type == "Hold_Button":
        # Get the required hold time from ground truth
        hold_time = ground_truth[selected_puzzle].get("hold_time", 3)  # Default to 3 seconds if not specified
        
        additional_data = {
            "hold_time": hold_time
        }
    # For Misleading_Click, include the area to avoid
    elif base_type == "Misleading_Click":
        # Get the area to avoid from ground truth
        _mc = ground_truth[selected_puzzle]
        avoid_area = _mc.get("avoid_area", {"x": 0, "y": 0, "width": 0, "height": 0})

        additional_data = {
            "avoid_area": avoid_area
        }
        # Mask-mode puzzles (new pipeline) are judged pixel-accurately against the
        # character mask in image-natural pixels; signal the frontend to submit
        # natural coords (like Pick_Area/Geometry_Click) instead of rect coords.
        if _mc.get("mask_path"):
            additional_data["mask_mode"] = True
    else:
        prompt = ground_truth[selected_puzzle].get("prompt", "Solve the CAPTCHA puzzle")
    
    response_data = {
        'puzzle_type': puzzle_type,
        'image_path': f'/captcha_data/{puzzle_type}/{selected_puzzle}' if puzzle_type != "Rotation_Match" else None,
        'puzzle_id': selected_puzzle,
        'prompt': prompt,
        'input_type': input_type,
        'debug_info': f"Type: {puzzle_type}, Input: {input_type}, Puzzle: {selected_puzzle}"
    }
    
    # Add any additional data for specific puzzle types
    if additional_data:
        response_data.update(additional_data)

    return jsonify(_annotate_split_in_payload(response_data))

@app.route('/api/get_ground_truth', methods=['POST'])
def get_ground_truth():
    """Return ground truth data for debugging purposes"""
    data = request.json
    puzzle_type = data.get('puzzle_type')
    puzzle_id = data.get('puzzle_id')

    if not puzzle_type or not puzzle_id:
        return jsonify({'error': 'Missing puzzle_type or puzzle_id'}), 400

    base_type = _base_type(puzzle_type)
    ground_truth = load_ground_truth(puzzle_type)
    
    if puzzle_id not in ground_truth:
        return jsonify({'error': 'Invalid puzzle ID'}), 400
    
    # Return the ground truth for the specified puzzle
    puzzle_data = ground_truth[puzzle_id]
    
    # For Place_Dot puzzles, include the target_position and tolerance in the answer
    if base_type == 'Place_Dot':
        return jsonify({
            'answer': {
                'target_position': puzzle_data.get('target_position'),
                'tolerance': puzzle_data.get('tolerance', 15)
            },
            'question': puzzle_data.get('question'),
            'description': puzzle_data.get('description')
        })
    # For Misleading_Click puzzles, ensure avoid_area is included in the answer
    elif base_type == 'Misleading_Click':
        return jsonify({
            'answer': {
                'avoid_area': puzzle_data.get('avoid_area', {"x": 0, "y": 0, "width": 0, "height": 0})
            },
            'prompt': puzzle_data.get('prompt'),
            'description': puzzle_data.get('description')
        })
    
    return jsonify({
        'answer': puzzle_data.get('answer'),
        'question': puzzle_data.get('question'),
        'description': puzzle_data.get('description')
    })

@app.route('/api/check_answer', methods=['POST'])
def check_answer():
    data = request.json
    puzzle_type = data.get('puzzle_type', 'Dice_Count')
    base_type = _base_type(puzzle_type)
    puzzle_id = data.get('puzzle_id')
    user_answer = data.get('answer')
    elapsed_time = float(data.get('elapsed_time', 0))

    
    # Validate input
    if not puzzle_id or user_answer is None:
        return jsonify({'error': 'Missing puzzle_id or answer'}), 400
    
    ground_truth = load_ground_truth(puzzle_type)
    
    if puzzle_id not in ground_truth:
        return jsonify({'error': 'Invalid puzzle ID'}), 400
    
    # Get correct answer based on puzzle type
    is_correct = False
    
    if base_type == 'Dice_Count':
        # For dice count, ensure we're comparing numbers
        try:
            correct_answer = ground_truth[puzzle_id].get('sum')
            is_correct = int(user_answer) == int(correct_answer)
        except ValueError:
            return jsonify({'error': 'Invalid answer format'}), 400
            
    elif base_type == 'Geometry_Click':
        # For geometry click, check if click is within the correct area
        try:
            # Get the area boundaries from ground truth
            correct_answer = ground_truth[puzzle_id].get('answer')

            # Extract coordinates
            user_x, user_y = user_answer

            # New mask-based GT: `answer.valid_area.mask_path` points at a binary
            # mask (white = the target shape, dilated by a tolerance) in
            # image-natural pixels. The frontend scale-corrects Geometry_Click
            # clicks to the natural frame, so the click is checked directly
            # against the mask pixel (>127 = on the target = correct).
            if isinstance(correct_answer, dict) and isinstance(correct_answer.get('valid_area'), dict):
                va = correct_answer['valid_area']
                base = resolve_data_dir(puzzle_type)
                mask_path = os.path.join(base or '', puzzle_type, va.get('mask_path', ''))
                is_correct = _pick_area_mask_hit(mask_path, user_x, user_y)
                correct_answer_info = {
                    'type': correct_answer.get('type', 'shape'),
                    'valid_area': {'mask_path': va.get('mask_path'),
                                   'rule': va.get('rule', 'click pixel must be white (>127) in the mask')},
                }
            # Legacy rect-bbox GT
            elif isinstance(correct_answer, dict) and 'area' in correct_answer:
                # Get area coordinates (top-left and bottom-right corners)
                top_left, bottom_right = correct_answer['area']
                min_x, min_y = top_left
                max_x, max_y = bottom_right
                
                # Check if click is within the defined area
                is_correct = (min_x <= user_x <= max_x) and (min_y <= user_y <= max_y)
                
                # Return the shape type as part of the correct answer
                shape_type = correct_answer.get('type', 'shape')
                correct_answer_info = {
                    'type': shape_type,
                    'area': correct_answer['area']
                }
            else:
                # Fall back to the old format with distance calculation
                correct_x, correct_y = correct_answer
                
                # Calculate distance and check if within tolerance (25 pixels)
                tolerance = 25
                distance = ((user_x - correct_x) ** 2 + (user_y - correct_y) ** 2) ** 0.5
                is_correct = distance <= tolerance
                correct_answer_info = correct_answer
        except (ValueError, TypeError, KeyError):
            return jsonify({'error': 'Invalid answer format for Geometry_Click'}), 400
    
    elif base_type == 'Rotation_Match':
        # For rotation match, check if the angle matches the correct answer
        try:
            # Get the correct angle from ground truth
            correct_angle = ground_truth[puzzle_id].get('correct_angle')
            
            # User answer should be the current rotation angle
            user_angle = int(user_answer)
            
            # Check if angles match (using modulo to handle full rotations)
            is_correct = user_angle % 360 == correct_angle % 360
            correct_answer_info = correct_angle
        except (ValueError, TypeError):
            return jsonify({'error': 'Invalid answer format for Rotation_Match'}), 400
    
    elif base_type == 'Slide_Puzzle':
        # For slide puzzle, check if the component is positioned correctly
        try:
            # Get the target position from ground truth
            target_position = ground_truth[puzzle_id].get('target_position')
            tolerance = ground_truth[puzzle_id].get('tolerance', 10)
            
            # User answer should be the final position coordinates [x, y]
            user_x, user_y = user_answer
            target_x, target_y = target_position
            
            # Calculate distance from target position
            distance = ((user_x - target_x) ** 2 + (user_y - target_y) ** 2) ** 0.5
            
            # Check if within tolerance
            is_correct = distance <= tolerance
            correct_answer_info = target_position
        except (ValueError, TypeError):
            return jsonify({'error': 'Invalid answer format for Slide_Puzzle'}), 400
    
    elif base_type == 'Unusual_Detection':
        # For unusual detection, check if the selected grid cells match the unusual ones
        try:
            # Get the expected unusual cells from ground truth
            correct_cells = ground_truth[puzzle_id].get('answer', [])
            
            # User answer should be a list of selected grid cell indices
            user_cells = user_answer
            
            # Check if the selected cells match exactly
            is_correct = set(user_cells) == set(correct_cells)
            correct_answer_info = correct_cells
        except (ValueError, TypeError):
            return jsonify({'error': 'Invalid answer format for Unusual_Detection'}), 400
    
    elif base_type == 'Image_Recognition':
        # For image recognition, check if the selected images match the expected ones
        try:
            # Get the expected correct image indices from ground truth
            correct_selections = ground_truth[puzzle_id].get('correct_selections', [])
            
            # User answer should be a list of selected image indices
            user_selections = user_answer
            
            # Check if the selected images match exactly
            is_correct = set(user_selections) == set(correct_selections)
            correct_answer_info = correct_selections
        except (ValueError, TypeError):
            return jsonify({'error': 'Invalid answer format for Image_Recognition'}), 400
    
    elif base_type == 'Bingo':
        # For Bingo, check if the swapped positions would create a line of matching images
        try:
            # Get the expected correct swap options from ground truth
            correct_swaps = ground_truth[puzzle_id].get('answer', [])
            
            # User answer should be a list of two indices to swap
            user_swaps = user_answer
            
            # Check if the swaps match any of the possible correct swaps
            # For this puzzle, there can be multiple correct solutions
            is_correct = False
            
            # Go through each possible solution
            for correct_swap in correct_swaps:
                # Check if user's swap matches this solution (order doesn't matter)
                if (set(user_swaps) == set(correct_swap) or 
                    (set(user_swaps) == set(correct_swap[::-1]) if len(correct_swap) == 2 else False)):
                    is_correct = True
                    break
                    
            correct_answer_info = correct_swaps
        except (ValueError, TypeError):
            return jsonify({'error': 'Invalid answer format for Bingo'}), 400
    
    elif base_type == 'Image_Matching':
        # For Image Matching, check if the selected option index matches the correct one
        try:
            # Get the correct option index from ground truth
            correct_index = ground_truth[puzzle_id].get('correct_option_index')
            
            # User answer should be the selected option index
            user_index = int(user_answer)
            
            # Check if indices match
            is_correct = user_index == correct_index
            correct_answer_info = correct_index
        except (ValueError, TypeError):
            return jsonify({'error': 'Invalid answer format for Image_Matching'}), 400
    
    elif base_type == 'Patch_Select':
        # For Patch_Select, check if the selected patches match the correct ones
        try:
            # Get the correct patches from ground truth
            correct_patches = ground_truth[puzzle_id].get('correct_patches', [])
            
            # User answer should be a list of selected patch indices
            user_patches = user_answer
            
            # Check if the selected patches match exactly
            is_correct = set(user_patches) == set(correct_patches)
            correct_answer_info = correct_patches
        except (ValueError, TypeError):
            return jsonify({'error': 'Invalid answer format for Patch_Select'}), 400
    
    elif base_type == 'Dart_Count':
        # For Dart_Count, check if the selected option index matches the correct one
        try:
            # Get the correct option index from ground truth
            correct_index = ground_truth[puzzle_id].get('correct_option_index')
            
            # User answer should be the selected option index
            user_index = int(user_answer)
            
            # Check if indices match
            is_correct = user_index == correct_index
            correct_answer_info = correct_index
        except (ValueError, TypeError):
            return jsonify({'error': 'Invalid answer format for Dart_Count'}), 400
    
    elif base_type == 'Place_Dot':
        # For Place_Dot, check if the dot is placed at the end of the car's path
        try:
            # Get the target position from ground truth
            target_position = ground_truth[puzzle_id].get('target_position')
            tolerance = ground_truth[puzzle_id].get('tolerance', 15)  # Default tolerance of 15 pixels
            
            # Extract coordinates from user's answer (click position)
            user_x, user_y = user_answer
            target_x, target_y = target_position
            
            # Calculate distance from target position
            distance = ((user_x - target_x) ** 2 + (user_y - target_y) ** 2) ** 0.5
            
            # Check if within tolerance
            is_correct = distance <= tolerance
            correct_answer_info = target_position
        except (ValueError, TypeError, KeyError):
            return jsonify({'error': 'Invalid answer format for Place_Dot'}), 400
    
    elif base_type == 'Object_Match':
        # For Object_Match, check if the selected option index matches the correct one
        try:
            # Get the correct option index from ground truth
            correct_index = ground_truth[puzzle_id].get('correct_option_index')
            
            # User answer should be the selected option index
            user_index = int(user_answer)
            
            # Check if indices match
            is_correct = user_index == correct_index
            correct_answer_info = correct_index
        except (ValueError, TypeError):
            return jsonify({'error': 'Invalid answer format for Object_Match'}), 400
    
    elif base_type == 'Select_Animal':
        # For Select_Animal, check if the selected patches match the correct ones
        try:
            # Get the correct patches from ground truth
            correct_patches = ground_truth[puzzle_id].get('correct_patches', [])
            
            # User answer should be a list of selected patch indices
            user_patches = user_answer
            
            # Check if the selected patches match exactly
            is_correct = set(user_patches) == set(correct_patches)
            correct_answer_info = correct_patches
        except (ValueError, TypeError):
            return jsonify({'error': 'Invalid answer format for Select_Animal'}), 400
    
    elif base_type == 'Coordinates':
        # For Coordinates, check if the selected option index matches the correct one
        try:
            # Get the correct option index from ground truth
            correct_index = ground_truth[puzzle_id].get('correct_option_index')
            
            # User answer should be the selected option index
            user_index = int(user_answer)
            
            # Check if indices match
            is_correct = user_index == correct_index
            correct_answer_info = correct_index
        except (ValueError, TypeError):
            return jsonify({'error': 'Invalid answer format for Coordinates'}), 400
    
    elif base_type == 'Path_Finder':
        # For Path_Finder, check if the selected option index matches the correct one
        try:
            # Get the correct option index from ground truth
            correct_index = ground_truth[puzzle_id].get('correct_option')
            
            # User answer should be the selected option index
            user_index = int(user_answer)
            
            # Check if indices match
            is_correct = user_index == correct_index
            correct_answer_info = correct_index
        except (ValueError, TypeError):
            return jsonify({'error': 'Invalid answer format for Path_Finder'}), 400
    
    elif base_type == 'Connect_icon':
        # For Connect_icon, check if the selected option index matches the correct one
        try:
            # Get the correct option index from ground truth
            correct_index = ground_truth[puzzle_id].get('correct_option')
            
            # User answer should be the selected option index
            user_index = int(user_answer)
            
            # Check if indices match
            is_correct = user_index == correct_index
            correct_answer_info = correct_index
        except (ValueError, TypeError):
            return jsonify({'error': 'Invalid answer format for Connect_icon'}), 400
    
    elif base_type == 'Click_Order':
        # For Click_Order, check if the clicked positions match the expected order
        try:
            # Get the correct coordinates and tolerance from ground truth
            correct_positions = ground_truth[puzzle_id].get('answer', [])
            tolerance = ground_truth[puzzle_id].get('tolerance', 20)  # Default tolerance of 20 pixels
            
            # User answer should be a list of clicked positions in order
            user_positions = user_answer
            
            # Check if the number of clicks matches
            if len(user_positions) != len(correct_positions):
                is_correct = False
            else:
                # Check each position with tolerance
                is_correct = True
                for i, (user_pos, correct_pos) in enumerate(zip(user_positions, correct_positions)):
                    user_x, user_y = user_pos
                    correct_x, correct_y = correct_pos
                    
                    # Calculate distance
                    distance = ((user_x - correct_x) ** 2 + (user_y - correct_y) ** 2) ** 0.5
                    
                    # If any position is outside tolerance, the answer is incorrect
                    if distance > tolerance:
                        is_correct = False
                        break
            
            correct_answer_info = correct_positions
        except (ValueError, TypeError, KeyError):
            return jsonify({'error': 'Invalid answer format for Click_Order'}), 400
    
    elif base_type == 'Hold_Button':
        # For Hold_Button, check if the hold time is within the allowed range
        try:
            # Get the required hold time from ground truth
            hold_time = ground_truth[puzzle_id].get("hold_time", 3)  # Default to 3 seconds if not specified
            
            # User answer should be a number representing the hold time in seconds
            user_hold_time = float(user_answer)
            
            if elapsed_time > 8 and user_hold_time < hold_time:
                is_correct = False
                correct_answer_info = f"Timeout ({elapsed_time:.2f}s)"
            else:
                is_correct = hold_time >= user_hold_time >= 0
                correct_answer_info = hold_time

        except (ValueError, TypeError):
            return jsonify({'error': 'Invalid answer format for Hold_Button'}), 400
    
    elif base_type == 'Misleading_Click':
        # For Misleading_Click, the click is correct as long as it is NOT on the
        # "DON'T CLICK ME" character.
        try:
            gt_entry = ground_truth[puzzle_id]
            user_x, user_y = user_answer
            mask_rel = gt_entry.get("mask_path")
            if mask_rel:
                # Mask-based judging (image-natural pixels): the mask is white on
                # the character, black on the background. The frontend submits the
                # click in natural pixels (mask_mode), so a click that lands on a
                # white mask pixel is ON the character -> incorrect. This is the
                # exact, pixel-accurate version of "don't click the character"
                # (a rectangular avoid_area wrongly forbids the empty corners of
                # the character's bounding box).
                base = resolve_data_dir(puzzle_type)
                mask_path = os.path.join(base or '', puzzle_type, mask_rel)
                on_character = _pick_area_mask_hit(mask_path, user_x, user_y)
                is_correct = not on_character
                correct_answer_info = "Click anywhere except the 'DON'T CLICK ME' character"
            else:
                # Legacy rectangular avoid_area judging (old datasets).
                avoid_area = gt_entry.get("avoid_area", {"x": 0, "y": 0, "width": 0, "height": 0})
                area_x = avoid_area["x"]
                area_y = avoid_area["y"]
                area_width = avoid_area["width"]
                area_height = avoid_area["height"]
                is_inside_avoid_area = (
                    area_x <= user_x <= area_x + area_width and
                    area_y <= user_y <= area_y + area_height
                )
                is_correct = not is_inside_avoid_area
                correct_answer_info = "Click outside the avoid area"
        except (ValueError, TypeError, KeyError):
            return jsonify({'error': 'Invalid answer format for Misleading_Click'}), 400
    
    elif base_type == 'Pick_Area':
        # For Pick_Area, check if click is within the correct area
        try:
            # Get the area boundaries from ground truth
            correct_answer = ground_truth[puzzle_id].get('answer')

            # Extract coordinates
            user_x, user_y = user_answer

            # New mask-based GT: `answer.valid_area.mask_path` points at a binary
            # mask (white = valid click) in image-natural pixels. The frontend
            # scale-corrects Pick_Area clicks to the natural frame, so the click
            # can be checked directly against the mask pixel (>127 = correct).
            if isinstance(correct_answer, dict) and isinstance(correct_answer.get('valid_area'), dict):
                va = correct_answer['valid_area']
                base = resolve_data_dir(puzzle_type)
                mask_path = os.path.join(base or '', puzzle_type, va.get('mask_path', ''))
                is_correct = _pick_area_mask_hit(mask_path, user_x, user_y)
                correct_answer_info = {
                    'type': correct_answer.get('type', 'largest region'),
                    'area': correct_answer.get('area') or va.get('bbox'),
                    'valid_area': {'mask_path': va.get('mask_path'),
                                   'rule': va.get('rule', 'click pixel must be white (>127) in the mask')},
                }
            # Legacy rect-bbox GT
            elif isinstance(correct_answer, dict) and 'area' in correct_answer:
                # Get area coordinates (top-left and bottom-right corners)
                top_left, bottom_right = correct_answer['area']
                min_x, min_y = top_left
                max_x, max_y = bottom_right
                
                # Check if click is within the defined area
                is_correct = (min_x <= user_x <= max_x) and (min_y <= user_y <= max_y)
                
                # Return the area type as part of the correct answer
                area_type = correct_answer.get('type', 'largest region')
                correct_answer_info = {
                    'type': area_type,
                    'area': correct_answer['area']
                }
            else:
                # Fall back if area is not properly defined
                is_correct = False
                correct_answer_info = correct_answer
        except (ValueError, TypeError, KeyError):
            return jsonify({'error': 'Invalid answer format for Pick_Area'}), 400

    elif base_type == 'OCR':
        try:
            correct_answer = ground_truth[puzzle_id].get('answer', '')
            is_correct = (
                str(user_answer).strip().lower()
                == str(correct_answer).strip().lower()
            )
            correct_answer_info = correct_answer
        except (ValueError, TypeError):
            return jsonify({'error': 'Invalid answer format for OCR'}), 400

    else:
        # For other types, compare as strings (case insensitive)
        correct_answer = ground_truth[puzzle_id].get('answer')
        is_correct = str(user_answer).lower() == str(correct_answer).lower()
        correct_answer_info = correct_answer
    
    # Get the appropriate answer field based on puzzle type
    if base_type == 'Dice_Count':
        answer_key = 'sum'
    elif base_type == 'Patch_Select':
        answer_key = 'correct_patches'
    elif base_type == 'Select_Animal':
        answer_key = 'correct_patches'
    elif base_type == 'Coordinates':
        answer_key = 'correct_option_index'
    elif base_type == 'Path_Finder':
        answer_key = 'correct_option'
    elif base_type == 'Connect_icon':
        answer_key = 'correct_option'
    elif base_type == 'Click_Order':
        answer_key = 'answer'
    elif base_type == 'Hold_Button':
        answer_key = 'hold_time'
    elif base_type == 'Misleading_Click':
        answer_key = 'answer'
    elif base_type == 'Pick_Area':
        answer_key = 'answer'
    else:
        answer_key = 'answer'
    
    return jsonify({
        'correct': is_correct,
        'user_answer': user_answer,
        'correct_answer': ground_truth[puzzle_id].get(answer_key)
    })

@app.route('/api/benchmark_results', methods=['POST'])
def record_benchmark():
    data = request.json
    
    # Add timestamp if not provided
    if 'timestamp' not in data:
        from datetime import datetime
        data['timestamp'] = datetime.now().isoformat()
    
    # In a real system, you would save this data to a database
    # For this example, we'll just print it to the console
    print(f"Benchmark results: {data}")
    
    # You could store this in a log file as well
    with open('benchmark_results.json', 'a') as f:
        f.write(json.dumps(data) + '\n')
        f.flush()  # Ensure data is written immediately

    return jsonify({'status': 'success'})

@app.route('/api/types', methods=['GET'])
def get_types():
    """Get available CAPTCHA types"""
    return jsonify({
        'types': get_captcha_types()
    })

@app.route('/api/list_puzzles', methods=['GET'])
def list_puzzles():
    """Return all (type, id) pairs available in the benchmark."""
    result = {}
    for ptype, seq in PUZZLE_SEQUENCES.items():
        result[ptype] = list(seq)
    return jsonify(result)

@app.route('/api/get_puzzle_by_id', methods=['GET'])
def get_puzzle_by_id():
    """Return a specific puzzle by type and id, without advancing the global index."""
    puzzle_type = request.args.get('type')
    puzzle_id = request.args.get('id')

    if not puzzle_type or not puzzle_id:
        return jsonify({'error': 'Missing type or id parameter'}), 400

    base_type = _base_type(puzzle_type)
    ground_truth = load_ground_truth(puzzle_type)
    if not ground_truth or puzzle_id not in ground_truth:
        return jsonify({'error': f'Puzzle not found: {puzzle_type}/{puzzle_id}'}), 404

    # Reuse the same response-building logic as get_puzzle
    selected_puzzle = puzzle_id
    print(f"[get_puzzle_by_id] {puzzle_type}/{selected_puzzle}")

    # --- prompt ---
    prompt_defaults = {
        "Dice_Count": ("prompt", "Sum up the numbers on all the dice"),
        "Geometry_Click": ("question", "Click on the geometric shape"),
        "Rotation_Match": ("prompt", "Use the arrows to rotate the object to match the reference direction"),
        "Slide_Puzzle": ("prompt", "Drag the slider component to the correct position"),
        "Unusual_Detection": ("prompt", "Select the unusual items in the image"),
        "Image_Recognition": ("prompt", "Select all images matching the description"),
        "Bingo": ("prompt", "Please click two images to exchange their position to line up the same images to a line"),
        "Image_Matching": ("prompt", "Using the arrows, match the animal in the left and right image."),
        "Patch_Select": ("prompt", "Select all squares with the specified objects"),
        "Dart_Count": ("prompt", "Use the arrows to pick the image where all the darts add up to the number in the left image."),
        "Object_Match": ("prompt", "Use the arrows to change the number of objects until it matches the left image."),
        "Select_Animal": ("prompt", "Pick a fox"),
        "Coordinates": ("prompt", "Using the arrows, move Jerry to the indicated seat"),
        "Path_Finder": ("prompt", "Use the arrows to move the duck to the spot indicated by the cross"),
        "Place_Dot": ("prompt", "Click to place a Dot at the end of the car's path"),
        "Connect_icon": ("prompt", "Using the arrows, connect the same two icons with the dotted line as shown on the left."),
        "Click_Order": ("prompt", "Click the icons in order as shown in the reference image."),
        "Hold_Button": ("prompt", "Hold the button until it finishes loading."),
        "Misleading_Click": ("prompt", "Click the image to continue."),
        "Pick_Area": ("prompt", "Click on the largest area outlined by the dotted line"),
        "OCR": ("prompt", "Type the characters shown in the image."),
    }
    key, default = prompt_defaults.get(base_type, ("prompt", "Solve the CAPTCHA puzzle"))
    prompt = ground_truth[selected_puzzle].get(key, default)

    # --- input_type ---
    input_type_map = {
        "Dice_Count": "number", "Geometry_Click": "click", "Rotation_Match": "rotation",
        "Slide_Puzzle": "slide", "Unusual_Detection": "multiselect", "Image_Recognition": "image_grid",
        "Bingo": "bingo_swap", "Image_Matching": "image_matching", "Patch_Select": "patch_select",
        "Dart_Count": "dart_count", "Object_Match": "object_match", "Select_Animal": "select_animal",
        "Coordinates": "image_matching", "Path_Finder": "image_matching", "Place_Dot": "place_dot",
        "Connect_icon": "connect_icon", "Click_Order": "click_order", "Hold_Button": "hold_button",
        "Misleading_Click": "click", "Pick_Area": "click",
    }
    input_type = input_type_map.get(base_type, "text")

    # --- additional_data (same logic as get_puzzle) ---
    additional_data = {}
    if base_type == "Rotation_Match":
        reference_image = ground_truth[selected_puzzle].get("reference_image")
        object_base_image = ground_truth[selected_puzzle].get("object_base_image")
        if not reference_image or not object_base_image:
            return jsonify({'error': f'Invalid rotation puzzle data: {selected_puzzle}'}), 500
        ref_path = f'/captcha_data/{puzzle_type}/{reference_image}'
        object_base = os.path.splitext(object_base_image)[0]
        object_path = f'/captcha_data/{puzzle_type}/{object_base}_0.png'
        additional_data = {"reference_image": ref_path, "object_image": object_path, "object_base": object_base, "current_angle": 0}
    elif base_type == "Slide_Puzzle":
        component_image = ground_truth[selected_puzzle].get("component_image")
        if not component_image:
            return jsonify({'error': f'Invalid slide puzzle data: {selected_puzzle}'}), 500
        additional_data = {
            "component_image": f'/captcha_data/{puzzle_type}/{component_image}',
            "background_image": f'/captcha_data/{puzzle_type}/{selected_puzzle}',
            "slider_track_y": ground_truth[selected_puzzle].get("target_position", [0, 0])[1],
        }
        hole_size = ground_truth[selected_puzzle].get("hole_size")
        if hole_size:
            additional_data["hole_size"] = hole_size
    elif base_type == "Unusual_Detection":
        additional_data = {"grid_size": ground_truth[selected_puzzle].get("grid_size", [2, 3])}
    elif base_type == "Image_Recognition":
        images = ground_truth[selected_puzzle].get("images", [])
        subfolder = ground_truth[selected_puzzle].get("subfolder", selected_puzzle)
        image_paths = [f'/captcha_data/{puzzle_type}/{subfolder}/{img}' for img in images]
        additional_data = {"images": image_paths, "grid_size": [3, 3], "question": ground_truth[selected_puzzle].get("question", "Select matching images")}
    elif base_type == "Bingo":
        additional_data = {"grid_size": ground_truth[selected_puzzle].get("grid_size", [3, 3]), "solution_line": ground_truth[selected_puzzle].get("solution_line", {}), "answer": ground_truth[selected_puzzle].get("answer", [])}
    elif base_type in ("Image_Matching", "Coordinates"):
        reference_image = ground_truth[selected_puzzle].get("reference_image")
        option_images = ground_truth[selected_puzzle].get("option_images", [])
        correct_option_index = ground_truth[selected_puzzle].get("correct_option_index", 0)
        if not reference_image or not option_images:
            return jsonify({'error': f'Invalid {puzzle_type} data: {selected_puzzle}'}), 500
        additional_data = {"reference_image": f'/captcha_data/{puzzle_type}/{reference_image}', "option_images": [f'/captcha_data/{puzzle_type}/{img}' for img in option_images], "current_option_index": 0, "correct_option_index": correct_option_index}
    elif base_type == "Patch_Select":
        additional_data = {"grid_size": ground_truth[selected_puzzle].get("grid_size", [5, 5]), "target_object": ground_truth[selected_puzzle].get("target_object", "moon"), "correct_patches": ground_truth[selected_puzzle].get("correct_patches", [])}
    elif base_type == "Dart_Count":
        reference_image = ground_truth[selected_puzzle].get("reference_image")
        option_images = ground_truth[selected_puzzle].get("option_images", [])
        if not reference_image or not option_images:
            return jsonify({'error': f'Invalid dart count data: {selected_puzzle}'}), 500
        additional_data = {"reference_image": f'/captcha_data/{puzzle_type}/{reference_image}', "option_images": [f'/captcha_data/{puzzle_type}/{img}' for img in option_images], "current_option_index": 0, "correct_option_index": ground_truth[selected_puzzle].get("correct_option_index", 0), "reference_number": ground_truth[selected_puzzle].get("reference_number", 0)}
    elif base_type == "Object_Match":
        reference_image = ground_truth[selected_puzzle].get("reference_image")
        option_images = ground_truth[selected_puzzle].get("option_images", [])
        if not reference_image or not option_images:
            return jsonify({'error': f'Invalid object match data: {selected_puzzle}'}), 500
        additional_data = {"reference_image": f'/captcha_data/{puzzle_type}/{reference_image}', "option_images": [f'/captcha_data/{puzzle_type}/{img}' for img in option_images], "current_option_index": 0, "correct_option_index": ground_truth[selected_puzzle].get("correct_option_index", 0)}
    elif base_type == "Select_Animal":
        additional_data = {"grid_size": ground_truth[selected_puzzle].get("grid_size", [2, 3]), "target_object": ground_truth[selected_puzzle].get("target_object", "fox"), "correct_patches": ground_truth[selected_puzzle].get("correct_patches", [])}
    elif base_type == "Path_Finder":
        reference_image = ground_truth[selected_puzzle].get("reference_image")
        options = ground_truth[selected_puzzle].get("options", [])
        if not reference_image or not options:
            return jsonify({'error': f'Invalid path finder data: {selected_puzzle}'}), 500
        additional_data = {"reference_image": f'/captcha_data/{puzzle_type}/{reference_image}', "option_images": [f'/captcha_data/{puzzle_type}/{img}' for img in options], "current_option_index": 0, "correct_option_index": ground_truth[selected_puzzle].get("correct_option", 0)}
    elif base_type == "Connect_icon":
        reference_image = ground_truth[selected_puzzle].get("reference_image")
        options = ground_truth[selected_puzzle].get("options", [])
        if not reference_image or not options:
            return jsonify({'error': f'Invalid connect icons data: {selected_puzzle}'}), 500
        additional_data = {"reference_image": f'/captcha_data/{puzzle_type}/{reference_image}', "option_images": [f'/captcha_data/{puzzle_type}/{img}' for img in options], "current_option_index": 0, "correct_option_index": ground_truth[selected_puzzle].get("correct_option", 0)}
    elif base_type == "Click_Order":
        order_image = ground_truth[selected_puzzle].get("order_image")
        if not order_image:
            return jsonify({'error': f'Invalid click order data: {selected_puzzle}'}), 500
        additional_data = {"order_image": f'/captcha_data/{puzzle_type}/{order_image}', "tolerance": ground_truth[selected_puzzle].get("tolerance", 20)}
    elif base_type == "Hold_Button":
        additional_data = {"hold_time": ground_truth[selected_puzzle].get("hold_time", 3)}
    elif base_type == "Misleading_Click":
        _mc = ground_truth[selected_puzzle]
        additional_data = {"avoid_area": _mc.get("avoid_area", {"x": 0, "y": 0, "width": 0, "height": 0})}
        if _mc.get("mask_path"):
            additional_data["mask_mode"] = True

    response_data = {
        'puzzle_type': puzzle_type,
        'image_path': f'/captcha_data/{puzzle_type}/{selected_puzzle}' if puzzle_type != "Rotation_Match" else None,
        'puzzle_id': selected_puzzle,
        'prompt': prompt,
        'input_type': input_type,
        'debug_info': f"Type: {puzzle_type}, Input: {input_type}, Puzzle: {selected_puzzle}",
    }
    if additional_data:
        response_data.update(additional_data)

    return jsonify(_annotate_split_in_payload(response_data))

import base64, time

# Directory for human trajectory data
HUMAN_TRAJECTORY_DIR = 'runs/human'

@app.route('/api/save_trajectory', methods=['POST'])
def save_trajectory():
    """Save step-level human trajectory for one puzzle."""
    data = request.json
    puzzle_type = data.get('puzzle_type', 'unknown')
    puzzle_id = data.get('puzzle_id', 'unknown')
    steps = data.get('steps', [])
    correct = data.get('correct', False)
    submitted = data.get('submitted', False)
    user_answer = data.get('user_answer')
    prompt = data.get('prompt', '')

    # Sanitize puzzle_id for filesystem
    puzzle_id_clean = os.path.splitext(puzzle_id)[0].replace('/', '_').replace(' ', '_')[:60]
    puzzle_dir = os.path.join(HUMAN_TRAJECTORY_DIR, f"{puzzle_type}_{puzzle_id_clean}")
    ss_dir = os.path.join(puzzle_dir, 'screenshots')
    os.makedirs(ss_dir, exist_ok=True)

    # Save screenshots from base64 and build clean steps
    clean_steps = []
    for i, step in enumerate(steps):
        ss_path = None
        if step.get('screenshot'):
            ss_filename = f"step_{i:03d}_{step.get('action', 'unknown')}.png"
            ss_path = os.path.join(ss_dir, ss_filename)
            try:
                img_data = step['screenshot']
                # Strip data URL prefix if present
                if ',' in img_data:
                    img_data = img_data.split(',', 1)[1]
                with open(ss_path, 'wb') as f:
                    f.write(base64.b64decode(img_data))
                ss_path = f"screenshots/{ss_filename}"
            except Exception:
                ss_path = None

        clean_steps.append({
            'step': i,
            'timestamp': step.get('timestamp'),
            'action': step.get('action', ''),
            'params': step.get('params', {}),
            'screenshot_path': ss_path,
        })

    # trajectory.jsonl — one line per step
    trajectory_path = os.path.join(puzzle_dir, 'trajectory.jsonl')
    with open(trajectory_path, 'w') as f:
        for s in clean_steps:
            f.write(json.dumps(s, ensure_ascii=False) + '\n')

    # summary.json
    summary = {
        'puzzle_type': puzzle_type,
        'puzzle_id': puzzle_id,
        'prompt': prompt,
        'submitted': submitted,
        'correct': correct,
        'reward': 1.0 if (submitted and correct) else 0.0,
        'agent': 'human',
        'total_steps': len(clean_steps),
        'user_answer': user_answer,
        'transitions': clean_steps,
    }
    with open(os.path.join(puzzle_dir, 'summary.json'), 'w') as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    print(f"[human] {puzzle_type}/{puzzle_id}: {len(clean_steps)} steps, correct={correct}")
    return jsonify({'status': 'success', 'output_dir': puzzle_dir})


# ===== Human Study (isolated per-person benchmark run) =====
# Two independent app.py instances (STUDY_STORE=A|B on different CAPTCHA_PORT) let
# two people each solve the FULL Test split (200 x 20 = 4000) with per-puzzle
# logging (steps / correct / time). All of this is gated on STUDY_STORE — a normal
# or eval instance leaves it unset and these routes 404, building nothing at start.
# The puzzles are served exactly like captcha-live via ?split=Test on the iframe;
# the study only adds a shell page + a small append-only JSONL store per person.
STUDY_STORE = os.environ.get('STUDY_STORE')                       # "A" / "B"
STUDY_SPLIT = os.environ.get('STUDY_SPLIT', 'Test')
STUDY_ROOT = os.environ.get('STUDY_ROOT', os.path.join('data', 'HumanStudy'))
_STUDY_ORDER = None       # cached [{idx, puzzle_type, puzzle_id}, ...] (len 4000)
_STUDY_RECORDED = None    # cached {idx: record} for THIS store


def _study_now_iso():
    import datetime
    return datetime.datetime.now().astimezone().isoformat(timespec='seconds')


def _study_order():
    """Deterministic order over the Test split — identical for A and B so both
    testers see the same 4000 puzzles in the same sequence and resume is stable.
    For each type dir under data/<split>/ (sorted), take ground_truth_cu.json keys
    in file order. Cached."""
    global _STUDY_ORDER
    if _STUDY_ORDER is not None:
        return _STUDY_ORDER
    order = []
    split_dir = os.path.join(DATASET_ROOT, STUDY_SPLIT)
    types = sorted(
        d for d in os.listdir(split_dir)
        if os.path.isdir(os.path.join(split_dir, d)) and not d.endswith('_deprecated')
    ) if os.path.isdir(split_dir) else []
    for t in types:
        gt_path = os.path.join(split_dir, t, 'ground_truth_cu.json')
        if not os.path.isfile(gt_path):
            continue
        try:
            with open(gt_path) as f:
                ids = list(json.load(f).keys())
        except (OSError, json.JSONDecodeError):
            ids = []
        for pid in ids:
            order.append({'idx': len(order), 'puzzle_type': t, 'puzzle_id': pid})
    _STUDY_ORDER = order
    return order


def _study_store_dir():
    return os.path.join(STUDY_ROOT, STUDY_STORE or '_none')


def _study_results_path():
    return os.path.join(_study_store_dir(), 'results.jsonl')


def _study_recorded():
    """{idx: record} already logged in this store. Lazy, cached, kept in sync on
    append (single tester per instance → no write race)."""
    global _STUDY_RECORDED
    if _STUDY_RECORDED is not None:
        return _STUDY_RECORDED
    rec = {}
    path = _study_results_path()
    if os.path.isfile(path):
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    o = json.loads(line)
                    rec[int(o['idx'])] = o
                except (ValueError, KeyError, json.JSONDecodeError):
                    continue
    _STUDY_RECORDED = rec
    return rec


def _study_next(recorded=None):
    recorded = recorded if recorded is not None else _study_recorded()
    for item in _study_order():
        if item['idx'] not in recorded:
            return item
    return None


def _study_progress(recorded):
    done = len(recorded)
    correct = sum(1 for r in recorded.values() if r.get('correct'))
    return done, correct


@app.route('/study')
def study_page():
    if not STUDY_STORE:
        return "This is not a study instance (STUDY_STORE not set).", 404
    return render_template('study_shell.html', store=STUDY_STORE,
                           split=STUDY_SPLIT, total=len(_study_order()))


@app.route('/api/study/state')
def study_state():
    if not STUDY_STORE:
        return jsonify({'error': 'not a study instance'}), 404
    recorded = _study_recorded()
    done, correct = _study_progress(recorded)
    return jsonify({
        'store': STUDY_STORE, 'split': STUDY_SPLIT,
        'total': len(_study_order()), 'done': done, 'correct': correct,
        'next': _study_next(recorded),
    })


@app.route('/api/study/record', methods=['POST'])
def study_record():
    if not STUDY_STORE:
        return jsonify({'error': 'not a study instance'}), 404
    data = request.json or {}
    try:
        idx = int(data['idx'])
    except (KeyError, ValueError, TypeError):
        return jsonify({'error': 'missing/invalid idx'}), 400
    recorded = _study_recorded()
    if idx not in recorded:                      # idempotent on idx
        rec = {
            'idx': idx,
            'puzzle_type': data.get('puzzle_type'),
            'puzzle_id': data.get('puzzle_id'),
            'correct': bool(data.get('correct')),
            'steps': int(data.get('steps') or 0),
            'time_ms': int(data.get('time_ms') or 0),
            'actions': data.get('actions') or [],
            'store': STUDY_STORE,
            'submitted_at': data.get('submitted_at') or _study_now_iso(),
        }
        os.makedirs(_study_store_dir(), exist_ok=True)
        with open(_study_results_path(), 'a') as f:
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')
        recorded[idx] = rec
    done, correct = _study_progress(recorded)
    return jsonify({'ok': True, 'done': done, 'correct': correct,
                    'total': len(_study_order()), 'next': _study_next(recorded)})


@app.route('/api/study/stats')
def study_stats():
    if not STUDY_STORE:
        return jsonify({'error': 'not a study instance'}), 404
    per = {}
    for r in _study_recorded().values():
        t = _base_type(r.get('puzzle_type') or 'unknown')
        d = per.setdefault(t, {'n': 0, 'correct': 0, 'steps': 0, 'time_ms': 0})
        d['n'] += 1
        d['correct'] += 1 if r.get('correct') else 0
        d['steps'] += int(r.get('steps') or 0)
        d['time_ms'] += int(r.get('time_ms') or 0)
    out = {}
    for t, d in per.items():
        n = d['n'] or 1
        out[t] = {'n': d['n'], 'correct': d['correct'], 'acc': round(d['correct'] / n, 4),
                  'avg_steps': round(d['steps'] / n, 2), 'avg_time_s': round(d['time_ms'] / n / 1000, 1)}
    return jsonify(out)


if __name__ == '__main__':
    # For local development
    if os.environ.get('DEVELOPMENT'):
        app.run(debug=True)
    else:
        # For production on Hugging Face Spaces
        app.run(host='0.0.0.0', port=int(os.environ.get('CAPTCHA_PORT', '7860')), threaded=True)
