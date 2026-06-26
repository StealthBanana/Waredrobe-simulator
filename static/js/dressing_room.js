'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────
const _d          = document.getElementById('dr-data');
const PERSON_ID   = parseInt(_d.dataset.personId);
const PERSON_URL  = _d.dataset.personUrl;

let canvas         = null;   // Fabric.js instance
let personImgW     = 0;      // original person photo pixel dimensions
let personImgH     = 0;
let personScaleX   = 1;      // scale applied to person photo on canvas
let personScaleY   = 1;
let personOffsetX  = 0;      // top-left corner of person photo on canvas
let personOffsetY  = 0;
let selectedIds    = [];
let currentOutfitId = null;

// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Use rAF so the flexbox layout has settled before we measure dimensions
  requestAnimationFrame(() => {
    _initCanvas();
    _setupSidebarFilter();
    _setupTryOnButton();
    _setupToolbarButtons();
    _setupSaveModal();
    _setupKeyboard();
    document.querySelectorAll('.dr-modal-backdrop').forEach(b => {
      b.addEventListener('click', e => { if (e.target === b) b.hidden = true; });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Canvas initialisation
// ─────────────────────────────────────────────────────────────────────────────
function _initCanvas() {
  const outer = document.querySelector('.dr-canvas-outer');
  const W     = Math.max(outer.clientWidth  - 16, 280);
  const H     = Math.max(outer.clientHeight - 16, 380);

  canvas = new fabric.Canvas('dressingCanvas', {
    width:                  W,
    height:                 H,
    backgroundColor:        '#1c1510',
    preserveObjectStacking: true,
    selection:              true,
  });

  _loadPersonPhoto();
  window.addEventListener('resize', _debounce(_resizeCanvas, 300));
}

function _loadPersonPhoto() {
  fabric.Image.fromURL(PERSON_URL, img => {
    personImgW = img.width;
    personImgH = img.height;

    const scale   = Math.min(canvas.width / img.width, canvas.height / img.height) * 0.95;
    personScaleX  = scale;
    personScaleY  = scale;
    personOffsetX = (canvas.width  - img.width  * scale) / 2;
    personOffsetY = (canvas.height - img.height * scale) / 2;

    img.set({
      left:        personOffsetX + (img.width  * scale) / 2,
      top:         personOffsetY + (img.height * scale) / 2,
      scaleX:      scale,
      scaleY:      scale,
      originX:     'center',
      originY:     'center',
      selectable:  false,
      evented:     false,
      hoverCursor: 'default',
      data:        { type: 'person' },
    });

    canvas.add(img);
    canvas.renderAll();
  });
}

function _resizeCanvas() {
  const outer = document.querySelector('.dr-canvas-outer');
  const W     = Math.max(outer.clientWidth  - 16, 280);
  const H     = Math.max(outer.clientHeight - 16, 380);
  const sx    = W / canvas.width;
  const sy    = H / canvas.height;

  canvas.setWidth(W);
  canvas.setHeight(H);

  canvas.getObjects().forEach(obj => {
    if (obj.data?.type === 'person') {
      const scale   = Math.min(W / personImgW, H / personImgH) * 0.95;
      personScaleX  = scale;
      personScaleY  = scale;
      personOffsetX = (W - personImgW * scale) / 2;
      personOffsetY = (H - personImgH * scale) / 2;
      obj.set({
        left:   personOffsetX + (personImgW * scale) / 2,
        top:    personOffsetY + (personImgH * scale) / 2,
        scaleX: scale,
        scaleY: scale,
      });
    } else {
      obj.set({ left: obj.left * sx, top: obj.top * sy,
                scaleX: obj.scaleX * sx, scaleY: obj.scaleY * sy });
    }
    obj.setCoords();
  });

  canvas.renderAll();
}

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar item selection
// ─────────────────────────────────────────────────────────────────────────────
function toggleItem(id, name, category) {
  const el  = document.querySelector(`.sidebar-item[data-id="${id}"]`);
  const idx = selectedIds.indexOf(id);
  if (idx === -1) { selectedIds.push(id);     el?.classList.add('selected'); }
  else            { selectedIds.splice(idx,1); el?.classList.remove('selected'); }
  _updateSelectionUI();
}

function _updateSelectionUI() {
  const summary = document.getElementById('selectedSummary');
  const tryBtn  = document.getElementById('btnTryOn');
  if (!selectedIds.length) {
    summary.textContent = 'No items selected';
    tryBtn.disabled     = true;
  } else {
    const names = selectedIds.map(id =>
      document.querySelector(`.sidebar-item[data-id="${id}"]`)?.dataset.name || `#${id}`
    );
    summary.textContent = names.join(', ');
    tryBtn.disabled     = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar category filter
// ─────────────────────────────────────────────────────────────────────────────
function _setupSidebarFilter() {
  document.querySelectorAll('.sf-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.sf-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      const cat = pill.dataset.cat;
      document.querySelectorAll('.sidebar-item').forEach(item => {
        item.classList.toggle('hidden-by-filter',
          cat !== 'all' && item.dataset.cat !== cat);
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Try On — fetch positions and place on canvas
// ─────────────────────────────────────────────────────────────────────────────
function _setupTryOnButton() {
  document.getElementById('btnTryOn')?.addEventListener('click', _runTryOn);
}

async function _runTryOn() {
  if (!selectedIds.length) return;
  _showLoading(true, 'Calculating clothing positions…');

  try {
    const res  = await fetch('/api/try-on-layout', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ person_photo_id: PERSON_ID, clothing_ids: selectedIds }),
    });
    const data = await res.json();

    if (!data.success) { showToast(data.error || 'Failed.', 'error'); return; }

    // Remove any existing clothing layers
    _clearClothing();

    // Update person dimensions in case they changed
    personImgW = data.person_width;
    personImgH = data.person_height;

    // Place each item on the canvas
    await Promise.all(data.items.map(_addClothingItem));
    canvas.renderAll();

    // Show controls
    _setPostTryOnButtons(true);
    showToast('Drag items to adjust · corner handles to resize', 'success');

  } catch (err) {
    console.error(err);
    showToast('Network error — is the server running?', 'error');
  } finally {
    _showLoading(false);
  }
}

function _addClothingItem(item) {
  return new Promise(resolve => {
    fabric.Image.fromURL(item.url, img => {
      // Convert from person-image coordinates to canvas coordinates
      const x = personOffsetX + item.x      * personScaleX;
      const y = personOffsetY + item.y      * personScaleY;
      const w = item.width  * personScaleX;
      const h = item.height * personScaleY;

      img.set({
        left:               x + w / 2,
        top:                y + h / 2,
        originX:            'center',
        originY:            'center',
        scaleX:             w / img.width,
        scaleY:             h / img.height,
        hasControls:        true,
        hasBorders:         true,
        borderColor:        '#b8763e',
        cornerColor:        '#b8763e',
        cornerStyle:        'circle',
        cornerSize:         10,
        transparentCorners: false,
        data: { type: 'clothing', id: item.id, name: item.name },
      });

      canvas.add(img);
      resolve();
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Toolbar buttons
// ─────────────────────────────────────────────────────────────────────────────
function _setupToolbarButtons() {

  // Delete selected clothing item
  document.getElementById('btnDeleteSelected')?.addEventListener('click', () => {
    const obj = canvas.getActiveObject();
    if (obj?.data?.type === 'clothing') { canvas.remove(obj); canvas.renderAll(); }
  });

  // Bring forward
  document.getElementById('btnBringFwd')?.addEventListener('click', () => {
    const obj = canvas.getActiveObject();
    if (obj) { canvas.bringForward(obj); canvas.renderAll(); }
  });

  // Send backward (never below the person photo)
  document.getElementById('btnSendBack')?.addEventListener('click', () => {
    const obj = canvas.getActiveObject();
    if (obj?.data?.type === 'clothing') {
      canvas.sendBackwards(obj);
      const person = canvas.getObjects().find(o => o.data?.type === 'person');
      if (person) canvas.sendToBack(person);
      canvas.renderAll();
    }
  });

  // Clear all clothing
  document.getElementById('btnClearClothing')?.addEventListener('click', () => {
    if (!confirm('Remove all clothing from the canvas?')) return;
    _clearClothing();
  });

  // Download as PNG
  document.getElementById('btnDownload')?.addEventListener('click', _downloadCanvas);

  // Reset everything
  document.getElementById('btnReset')?.addEventListener('click', () => {
    _clearClothing();
    selectedIds = [];
    document.querySelectorAll('.sidebar-item.selected')
      .forEach(el => el.classList.remove('selected'));
    _updateSelectionUI();
    currentOutfitId = null;
    _setPostTryOnButtons(false);
  });
}

function _clearClothing() {
  canvas.getObjects()
    .filter(o => o.data?.type === 'clothing')
    .forEach(o => canvas.remove(o));
  canvas.renderAll();
}

// Show or hide all the buttons that only make sense after a try-on
function _setPostTryOnButtons(show) {
  const ids = [
    'btnDeleteSelected', 'divLayer', 'btnBringFwd', 'btnSendBack',
    'btnClearClothing', 'btnSaveOutfit', 'btnDownload', 'btnReset',
  ];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = show ? '' : 'none';
  });
  const hint = document.getElementById('drCanvasHint');
  if (hint) hint.style.display = show ? '' : 'none';
}

// ─────────────────────────────────────────────────────────────────────────────
// Download — export canvas as PNG with white background
// ─────────────────────────────────────────────────────────────────────────────
function _downloadCanvas() {
  const prevBg = canvas.backgroundColor;
  canvas.backgroundColor = '#ffffff';
  canvas.renderAll();

  const dataURL = canvas.toDataURL({ format: 'png', quality: 1, multiplier: 2 });

  canvas.backgroundColor = prevBg;
  canvas.renderAll();

  const link    = document.createElement('a');
  link.download = 'dressroom_result.png';
  link.href     = dataURL;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyboard shortcuts
// ─────────────────────────────────────────────────────────────────────────────
function _setupKeyboard() {
  document.addEventListener('keydown', e => {
    if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const obj = canvas.getActiveObject();
      if (obj?.data?.type === 'clothing') { canvas.remove(obj); canvas.renderAll(); }
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading overlay
// ─────────────────────────────────────────────────────────────────────────────
function _showLoading(show, msg) {
  const el = document.getElementById('viewerLoading');
  if (msg) document.getElementById('loadingMsg').textContent = msg;
  el.hidden = !show;
}

// ─────────────────────────────────────────────────────────────────────────────
// Save / load / delete outfits
// ─────────────────────────────────────────────────────────────────────────────
function _setupSaveModal() {
  document.getElementById('btnSaveOutfit')?.addEventListener('click', () => {
    document.getElementById('outfitNameInput').value = '';
    document.getElementById('modalSaveOutfit').hidden = false;
    setTimeout(() => document.getElementById('outfitNameInput').focus(), 60);
  });
  const go = async () => {
    const name = document.getElementById('outfitNameInput').value.trim();
    if (!name) return;
    closeModal('modalSaveOutfit');
    await _saveOutfit(name);
  };
  document.getElementById('btnConfirmSave')?.addEventListener('click', go);
  document.getElementById('outfitNameInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') go();
  });
}

async function _saveOutfit(name) {
  try {
    const canvasJSON = canvas.toJSON(['data']);
    const res = await fetch('/api/outfits', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: currentOutfitId, name, person_photo_id: PERSON_ID,
        outfit_data: {
          clothing_ids:   selectedIds,
          canvas_json:    canvasJSON,
          person_offset_x: personOffsetX,
          person_offset_y: personOffsetY,
          person_scale_x:  personScaleX,
          person_scale_y:  personScaleY,
        },
      }),
    });
    const saved = await res.json();
    currentOutfitId = saved.id;
    showToast(`Outfit "${saved.name}" saved!`, 'success');
    _refreshOutfitList();
  } catch { showToast('Could not save outfit.', 'error'); }
}

async function loadOutfit(outfitId) {
  try {
    const res    = await fetch(`/api/outfits/${outfitId}`);
    const outfit = await res.json();
    const od     = outfit.outfit_data || {};

    if (od.canvas_json) {
      canvas.loadFromJSON(od.canvas_json, () => {
        canvas.getObjects().forEach(obj => {
          if (obj.data?.type === 'person') {
            obj.selectable  = false;
            obj.evented     = false;
            obj.hoverCursor = 'default';
          }
        });
        canvas.renderAll();
      });
    }

    selectedIds = (od.clothing_ids || []).map(Number);
    document.querySelectorAll('.sidebar-item').forEach(el => {
      el.classList.toggle('selected', selectedIds.includes(parseInt(el.dataset.id)));
    });
    _updateSelectionUI();

    currentOutfitId = outfit.id;
    _setPostTryOnButtons(true);
    showToast(`Loaded: ${outfit.name}`, 'success');
  } catch { showToast('Could not load outfit.', 'error'); }
}

async function deleteOutfit(outfitId) {
  if (!confirm('Delete this saved outfit?')) return;
  try {
    await fetch(`/api/outfits/${outfitId}`, { method: 'DELETE' });
    if (currentOutfitId === outfitId) currentOutfitId = null;
    showToast('Outfit deleted.', 'success');
    _refreshOutfitList();
  } catch { showToast('Could not delete outfit.', 'error'); }
}

async function _refreshOutfitList() {
  try {
    const res     = await fetch(`/api/outfits?person_photo_id=${PERSON_ID}`);
    const outfits = await res.json();
    const el      = document.getElementById('outfitList');
    if (!el) return;
    if (!outfits.length) {
      el.innerHTML = '<p class="outfit-empty">Style something and hit Save to keep it here.</p>';
      return;
    }
    el.innerHTML = outfits.map(o => `
      <div class="outfit-row" id="outfit-${o.id}">
        <button class="outfit-load-btn" onclick="loadOutfit(${o.id})">${_esc(o.name)}</button>
        <button class="outfit-del-btn" onclick="deleteOutfit(${o.id})" title="Delete">
          <i class="bi bi-trash"></i></button>
      </div>`).join('');
  } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────
function _debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function _esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
                  .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}