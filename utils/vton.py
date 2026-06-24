"""
Virtual Try-On engine — v2.

NOTE: For best results, clothing photos should be flat-lay or hanger shots
on a plain background. Photos of people wearing clothes will look poor because
the whole person silhouette gets composited, not just the garment.
"""

import os
import uuid
import logging

import cv2
import numpy as np

logger = logging.getLogger(__name__)

_CATEGORY_ORDER = {
    'full_outfit': 0,
    'bottom':      1,
    'top':         2,
    'outerwear':   3,
    'shoes':       4,
    'accessory':   5,
}


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def process_try_on(person_path, clothing_items, pose_data, output_dir):
    """
    Composite one or more clothing items onto a person photo.

    Args:
        person_path:     Absolute path to the person PNG.
        clothing_items:  List of (clothing_abs_path, category_str) tuples.
        pose_data:       Dict from detect_pose(), or None.
        output_dir:      Where to save the result PNG.

    Returns:
        Absolute path to the result PNG.
    """
    os.makedirs(output_dir, exist_ok=True)

    base = _load_bgra(person_path)
    if base is None:
        raise ValueError(f"Could not load person image: {person_path}")

    ph, pw = base.shape[:2]
    clothing_items = sorted(clothing_items,
                            key=lambda x: _CATEGORY_ORDER.get(x[1], 99))

    for clothing_path, category in clothing_items:
        clothing = _load_bgra(clothing_path)
        if clothing is None:
            logger.warning(f"Skipping unreadable file: {clothing_path}")
            continue

        # Crop to actual content — removes empty transparent padding
        # so the warp only acts on the real garment pixels
        clothing = _crop_to_content(clothing)
        if clothing is None:
            logger.warning(f"Clothing appears fully transparent: {clothing_path}")
            continue

        try:
            base = _apply_one(base, clothing, category, pose_data, pw, ph)
        except Exception as exc:
            logger.error(f"Failed to apply {category}: {exc}")

    out_path = os.path.join(output_dir, f"tryon_{uuid.uuid4().hex[:12]}.png")
    cv2.imwrite(out_path, base)
    logger.info(f"Try-on result saved: {out_path}")
    return out_path


# ─────────────────────────────────────────────────────────────────────────────
# Single item pipeline
# ─────────────────────────────────────────────────────────────────────────────

def _apply_one(base_bgra, clothing_bgra, category, pose_data, pw, ph):
    region = _target_region(pose_data, category, pw, ph)
    placed = _place_clothing(clothing_bgra, region, pw, ph)
    placed = _feather_edges(placed, blur_px=18)
    placed = _match_brightness(placed, base_bgra, region)
    return _composite(base_bgra, placed)


# ─────────────────────────────────────────────────────────────────────────────
# Target region — where clothing goes on the canvas
# ─────────────────────────────────────────────────────────────────────────────

def _target_region(pose_data, category, pw, ph):
    """Return {cx, cy, w, h} describing the clothing placement area."""
    if not pose_data:
        return _default_region(category, pw, ph)

    d  = pose_data
    sx = lambda r: r * pw
    sy = lambda r: r * ph

    sc_x  = sx(d['shoulder_center']['x'])
    sc_y  = sy(d['shoulder_center']['y'])
    hc_x  = sx(d['hip_center']['x'])
    hc_y  = sy(d['hip_center']['y'])
    sw    = sx(d['shoulder_width'])
    hw    = sx(d['hip_width'])
    ank_y = sy(d['ankle_y'])
    nos_y = sy(d['nose_y'])

    cat = category.lower()

    if cat == 'top':
        # Collar area down to just below hip
        top_y    = sc_y - sw * 0.05
        bottom_y = hc_y + sw * 0.15
        cx, w    = sc_x, sw * 1.45

    elif cat == 'bottom':
        # Waistband down to ankle
        top_y    = hc_y - hw * 0.10
        bottom_y = ank_y + hw * 0.08
        cx, w    = hc_x, hw * 1.65

    elif cat == 'outerwear':
        # Slightly wider and longer than a top
        top_y    = sc_y - sw * 0.10
        bottom_y = hc_y + sw * 0.38
        cx, w    = sc_x, sw * 1.80

    elif cat == 'full_outfit':
        top_y    = sc_y - sw * 0.05
        bottom_y = ank_y + hw * 0.06
        cx, w    = sc_x, sw * 1.50

    elif cat == 'shoes':
        fw       = sw * 0.55
        top_y    = ank_y - fw * 0.3
        bottom_y = ank_y + fw * 0.65
        cx, w    = hc_x, fw * 2.0

    elif cat == 'accessory':
        aw       = sw * 0.45
        top_y    = nos_y - aw * 2.0
        bottom_y = nos_y - aw * 0.1
        cx, w    = sc_x, aw * 2.0

    else:
        return _default_region(category, pw, ph)

    h  = bottom_y - top_y
    cy = (top_y + bottom_y) / 2.0
    return {'cx': cx, 'cy': cy, 'w': max(float(w), 10.0), 'h': max(float(h), 10.0)}


def _default_region(category, pw, ph):
    """Fallback when no pose data is available."""
    presets = {
        'top':         (0.50, 0.37, 0.50, 0.38),
        'bottom':      (0.50, 0.72, 0.42, 0.48),
        'full_outfit': (0.50, 0.57, 0.50, 0.80),
        'outerwear':   (0.50, 0.40, 0.56, 0.48),
        'shoes':       (0.50, 0.92, 0.40, 0.10),
        'accessory':   (0.50, 0.08, 0.28, 0.14),
    }
    cx, cy, rw, rh = presets.get(category, (0.5, 0.5, 0.5, 0.5))
    return {'cx': cx*pw, 'cy': cy*ph, 'w': rw*pw, 'h': rh*ph}


# ─────────────────────────────────────────────────────────────────────────────
# Placement — aspect-ratio preserving, no extreme distortion
# ─────────────────────────────────────────────────────────────────────────────

def _place_clothing(clothing_bgra, region, pw, ph):
    """
    Scale clothing to fill the target region height (maintaining aspect ratio),
    center it horizontally, then apply a very subtle taper for depth.
    This replaces the old full-perspective warp which caused cone/triangle shapes.
    """
    ch, cw = clothing_bgra.shape[:2]
    tw = max(int(region['w']), 10)
    th = max(int(region['h']), 10)

    # Primary: scale to fit height
    scale = th / ch
    nw    = int(cw * scale)
    nh    = int(ch * scale)

    # If too wide, scale to fit width instead
    if nw > tw:
        scale = tw / cw
        nw    = int(cw * scale)
        nh    = int(ch * scale)

    nw = max(nw, 1)
    nh = max(nh, 1)

    resized = cv2.resize(clothing_bgra, (nw, nh), interpolation=cv2.INTER_LANCZOS4)

    # Subtle taper: top is 4% narrower — gives a hint of the garment
    # sitting on a body without causing distortion
    resized = _taper(resized, amount=0.04)

    # Paste onto blank canvas, centered on (cx, cy)
    canvas = np.zeros((ph, pw, 4), dtype=np.uint8)
    cx = int(region['cx'])
    cy = int(region['cy'])
    x1 = cx - nw // 2
    y1 = cy - nh // 2

    sx1 = max(0, -x1);  dx1 = max(0, x1)
    sy1 = max(0, -y1);  dy1 = max(0, y1)
    cw2 = min(nw - sx1, pw - dx1)
    ch2 = min(nh - sy1, ph - dy1)

    if cw2 > 0 and ch2 > 0:
        canvas[dy1:dy1+ch2, dx1:dx1+cw2] = resized[sy1:sy1+ch2, sx1:sx1+cw2]

    return canvas


def _taper(img, amount=0.04):
    """Make the top slightly narrower than the bottom to simulate depth."""
    h, w = img.shape[:2]
    shrink = int(w * amount)
    if shrink < 1:
        return img
    src = np.float32([[0,0], [w,0], [0,h], [w,h]])
    dst = np.float32([[shrink,0], [w-shrink,0], [0,h], [w,h]])
    M   = cv2.getPerspectiveTransform(src, dst)
    return cv2.warpPerspective(img, M, (w, h),
                               flags=cv2.INTER_LINEAR,
                               borderMode=cv2.BORDER_CONSTANT,
                               borderValue=(0, 0, 0, 0))


# ─────────────────────────────────────────────────────────────────────────────
# Crop to content
# ─────────────────────────────────────────────────────────────────────────────

def _crop_to_content(img_bgra, padding=8):
    """
    Crop image to the bounding box of non-transparent pixels.
    This is critical — without it, empty transparent borders get included
    in the scale calculation and the clothing lands in the wrong position.
    Returns None if the image is fully transparent.
    """
    if img_bgra.shape[2] < 4:
        return img_bgra

    alpha = img_bgra[:, :, 3]
    rows  = np.any(alpha > 10, axis=1)
    cols  = np.any(alpha > 10, axis=0)

    if not rows.any() or not cols.any():
        return None

    y0, y1 = np.where(rows)[0][[0, -1]]
    x0, x1 = np.where(cols)[0][[0, -1]]

    H, W = img_bgra.shape[:2]
    y0 = max(0, y0 - padding);  y1 = min(H - 1, y1 + padding)
    x0 = max(0, x0 - padding);  x1 = min(W - 1, x1 + padding)

    return img_bgra[y0:y1+1, x0:x1+1]


# ─────────────────────────────────────────────────────────────────────────────
# Edge feathering
# ─────────────────────────────────────────────────────────────────────────────

def _feather_edges(img_bgra, blur_px=18):
    if img_bgra.shape[2] < 4:
        return img_bgra
    alpha  = img_bgra[:, :, 3].astype(np.float32)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    alpha  = cv2.erode(alpha, kernel, iterations=1)
    k      = blur_px * 2 + 1
    alpha  = cv2.GaussianBlur(alpha, (k, k), blur_px * 0.45)
    result = img_bgra.copy()
    result[:, :, 3] = np.clip(alpha, 0, 255).astype(np.uint8)
    return result


# ─────────────────────────────────────────────────────────────────────────────
# Brightness matching
# ─────────────────────────────────────────────────────────────────────────────

def _match_brightness(clothing_bgra, base_bgra, region):
    try:
        ph, pw = base_bgra.shape[:2]
        cx, cy = int(region['cx']), int(region['cy'])
        hw, hh = int(region['w'] / 2), int(region['h'] / 2)

        x1 = max(0, cx - hw);  x2 = min(pw, cx + hw)
        y1 = max(0, cy - hh);  y2 = min(ph, cy + hh)

        region_mask = np.zeros((ph, pw), dtype=np.uint8)
        region_mask[y1:y2, x1:x2] = 255

        base_gray = cv2.cvtColor(base_bgra[:, :, :3], cv2.COLOR_BGR2GRAY)
        base_mean = cv2.mean(base_gray, mask=region_mask)[0]

        c_mask = (clothing_bgra[:, :, 3] > 30).astype(np.uint8) * 255
        c_gray = cv2.cvtColor(clothing_bgra[:, :, :3], cv2.COLOR_BGR2GRAY)
        c_mean = cv2.mean(c_gray, mask=c_mask)[0]

        if c_mean < 1:
            return clothing_bgra

        factor = float(np.clip(base_mean / c_mean, 0.75, 1.25))
        result = clothing_bgra.astype(np.float32)
        result[:, :, :3] *= factor
        result = np.clip(result, 0, 255).astype(np.uint8)
        result[:, :, 3] = clothing_bgra[:, :, 3]
        return result

    except Exception as exc:
        logger.warning(f"Brightness match skipped: {exc}")
        return clothing_bgra


# ─────────────────────────────────────────────────────────────────────────────
# Alpha compositing
# ─────────────────────────────────────────────────────────────────────────────

def _composite(base_bgra, overlay_bgra):
    base    = base_bgra.astype(np.float32)    / 255.0
    overlay = overlay_bgra.astype(np.float32) / 255.0
    a_o     = overlay[:, :, 3:4]
    a_b     = base[:, :, 3:4]
    a_out   = a_o + a_b * (1.0 - a_o)
    safe_a  = np.where(a_out > 0, a_out, 1.0)
    rgb_out = (overlay[:, :, :3] * a_o
               + base[:, :, :3] * a_b * (1.0 - a_o)) / safe_a
    out = np.empty_like(base)
    out[:, :, :3] = rgb_out
    out[:, :, 3]  = a_out[:, :, 0]
    return np.clip(out * 255, 0, 255).astype(np.uint8)


# ─────────────────────────────────────────────────────────────────────────────
# Image loading
# ─────────────────────────────────────────────────────────────────────────────

def _load_bgra(path):
    try:
        img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
        if img is None:
            return None
        if img.ndim == 2:
            img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGRA)
        elif img.shape[2] == 3:
            alpha = np.full(img.shape[:2], 255, dtype=np.uint8)
            img   = np.dstack([img, alpha])
        return img
    except Exception as exc:
        logger.error(f"Image load error ({path}): {exc}")
        return None