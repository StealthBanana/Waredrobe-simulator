'use strict';

const _d          = document.getElementById('dr-data');
const PERSON_ID   = parseInt(_d.dataset.personId);

let selectedIds     = [];
let currentResult   = null;
let currentOutfitId = null;
let compareMode     = false;

document.addEventListener('DOMContentLoaded', () => {
  _setupSidebarFilter();
  _setupTryOnButton();
  _setupResetButton();
  _setupCompareButton();
  _setupSaveModal();
  document.querySelectorAll('.dr-modal-backdrop').forEach(b => {
    b.addEventListener('click', e => { if (e.target === b) b.hidden = true; });
  });
});

// ── Item selection ────────────────────────────────────────────────────────────
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

// ── Sidebar category filter ───────────────────────────────────────────────────
function _setupSidebarFilter() {
  document.querySelectorAll('.sf-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.sf-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      const cat = pill.dataset.cat;
      document.querySelectorAll('.sidebar-item').forEach(item => {
        item.classList.toggle('hidden-by-filter', cat !== 'all' && item.dataset.cat !== cat);
      });
    });
  });
}

// ── Try On ────────────────────────────────────────────────────────────────────
function _setupTryOnButton() {
  document.getElementById('btnTryOn')?.addEventListener('click', _runTryOn);
}

async function _runTryOn() {
  if (!selectedIds.length) return;
  _showLoading(true, 'Warping clothing to your body shape…');
  try {
    const res  = await fetch('/api/try-on', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ person_photo_id: PERSON_ID, clothing_ids: selectedIds }),
    });
    const data = await res.json();
    if (!data.success) { showToast(data.error || 'Processing failed.', 'error'); return; }
    currentResult = data.result_url + '?t=' + Date.now();
    _showResult(currentResult);
  } catch (err) {
    console.error(err);
    showToast('Network error — is the server running?', 'error');
  } finally {
    _showLoading(false);
  }
}

// ── Result display ────────────────────────────────────────────────────────────
function _showResult(url) {
  const imgResult = document.getElementById('imgResult');
  imgResult.onload = () => {
    document.getElementById('imgOriginal').style.display = 'none';
    imgResult.style.display = 'block';
    document.getElementById('btnToggleCompare').style.display = '';
    document.getElementById('btnSaveOutfit').style.display    = '';
    document.getElementById('btnReset').style.display         = '';
    const dl = document.getElementById('btnDownload');
    dl.style.display = '';
    dl.href = '/api/download-result?path=' + encodeURIComponent(currentResult.split('?')[0]);
    compareMode = false;
    document.getElementById('drViewer').classList.remove('compare-mode');
    _updateCompareBadges();
  };
  imgResult.src = url;
}

function _setupResetButton() {
  document.getElementById('btnReset')?.addEventListener('click', () => {
    currentResult = null; compareMode = false;
    document.getElementById('imgResult').style.display   = 'none';
    document.getElementById('imgOriginal').style.display = 'block';
    ['btnToggleCompare','btnSaveOutfit','btnDownload','btnReset'].forEach(id => {
      document.getElementById(id).style.display = 'none';
    });
    document.getElementById('drViewer').classList.remove('compare-mode');
    _updateCompareBadges();
    selectedIds = [];
    document.querySelectorAll('.sidebar-item.selected').forEach(el => el.classList.remove('selected'));
    _updateSelectionUI();
    currentOutfitId = null;
  });
}

// ── Before / after compare ────────────────────────────────────────────────────
function _setupCompareButton() {
  document.getElementById('btnToggleCompare')?.addEventListener('click', () => {
    if (!currentResult) return;
    compareMode = !compareMode;
    const orig   = document.getElementById('imgOriginal');
    const result = document.getElementById('imgResult');
    const viewer = document.getElementById('drViewer');
    if (compareMode) {
      orig.style.display = 'block'; result.style.display = 'block';
      viewer.classList.add('compare-mode');
    } else {
      orig.style.display = 'none'; result.style.display = 'block';
      viewer.classList.remove('compare-mode');
    }
    _updateCompareBadges();
  });
}

function _updateCompareBadges() {
  const show = compareMode && !!currentResult;
  document.getElementById('badgeBefore').style.display = show ? '' : 'none';
  document.getElementById('badgeAfter').style.display  = show ? '' : 'none';
}

// ── Loading overlay ───────────────────────────────────────────────────────────
function _showLoading(show, msg) {
  const el = document.getElementById('viewerLoading');
  if (msg) document.getElementById('loadingMsg').textContent = msg;
  el.hidden = !show;
}

// ── Save / load / delete outfits ──────────────────────────────────────────────
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
    const res  = await fetch('/api/outfits', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: currentOutfitId, name, person_photo_id: PERSON_ID,
        outfit_data: { clothing_ids: selectedIds, result_url: currentResult },
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
    selectedIds  = (od.clothing_ids || []).map(Number);
    document.querySelectorAll('.sidebar-item').forEach(el => {
      el.classList.toggle('selected', selectedIds.includes(parseInt(el.dataset.id)));
    });
    _updateSelectionUI();
    if (od.result_url) _showResult(od.result_url);
    currentOutfitId = outfit.id;
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

function _esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
                  .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}