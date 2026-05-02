const socket = io();

// ---- STATE ----
let charts = [];
let setlists = [];
let activeChart = null;
let activeSetlist = null;
let activeSetlistIndex = 0;

let syncMode = 'solo'; // solo, host, viewer
let chordDisplayMode = 'above';
let isDragging = false;
let draggedItem = null;

// ---- INIT ----
async function init() {
    await Promise.all([fetchCharts(), fetchSetlists()]);
    
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('mode') === 'viewer') {
        setSyncMode('viewer');
    }
    
    // Set viewer URL in settings
    document.getElementById('viewerUrlBox').textContent = window.location.origin + '?mode=viewer';
    
    switchTab('charts');
}

// ---- TABS & NAV ----
function switchTab(tabId) {
    document.querySelectorAll('.tab-panel, .lib-tab').forEach(el => el.classList.remove('active'));
    document.getElementById('tab' + tabId.charAt(0).toUpperCase() + tabId.slice(1)).classList.add('active');
    document.getElementById('panel' + tabId.charAt(0).toUpperCase() + tabId.slice(1)).classList.add('active');
    
    if (tabId === 'charts') renderLibrary();
    if (tabId === 'setlists') renderSetlists();
    if (tabId === 'show') renderShowRunner();
}

function showLibrary() {
    document.getElementById('editorView').classList.add('hidden');
    document.getElementById('setlistEditorView').classList.add('hidden');
    document.getElementById('teleprompterView').classList.add('hidden');
    document.getElementById('libraryView').classList.remove('hidden');
    teleprompter.pause();
    init();
}

// ---- API: CHARTS ----
async function fetchCharts() {
    const res = await fetch('/api/charts');
    charts = await res.json();
    populateFilters();
}

function populateFilters() {
    const genres = new Set();
    const keys = new Set();
    charts.forEach(c => {
        if (c.genre) genres.add(c.genre);
        if (c.key) keys.add(c.key);
    });
    
    const genreSelect = document.getElementById('filterGenre');
    const keySelect = document.getElementById('filterKey');
    
    // Keep first option
    genreSelect.innerHTML = '<option value="">All Genres</option>';
    keySelect.innerHTML = '<option value="">All Keys</option>';
    
    Array.from(genres).sort().forEach(g => genreSelect.add(new Option(g, g)));
    Array.from(keys).sort().forEach(k => keySelect.add(new Option(k, k)));
}

function renderLibrary() {
    const q = document.getElementById('searchInput').value.toLowerCase();
    const genreF = document.getElementById('filterGenre').value;
    const keyF = document.getElementById('filterKey').value;
    const list = document.getElementById('chartList');
    
    let filtered = charts.filter(c => {
        if (q && !(c.title||'').toLowerCase().includes(q) && !(c.artist||'').toLowerCase().includes(q)) return false;
        if (genreF && c.genre !== genreF) return false;
        if (keyF && c.key !== keyF) return false;
        return true;
    });

    if (!filtered.length) {
        list.innerHTML = '<div class="empty-state">No charts found. Create one to get started.</div>';
        return;
    }
    
    list.innerHTML = '';
    filtered.forEach((c, i) => {
        const div = document.createElement('div');
        div.className = 'chart-card';
        div.innerHTML = `
            <span class="row-num">${i+1}</span>
            <span class="row-play">▶</span>
            <h3>${c.title||'Untitled'}</h3>
            <div class="chart-artist">${c.artist||''}</div>
            <div>${c.key ? `<span class="chart-badge badge-key">${c.key}</span>` : ''}</div>
            <div>${c.bpm ? `<span class="chart-badge badge-bpm">${c.bpm} BPM</span>` : ''}</div>
            <div>${c.genre ? `<span class="chart-badge badge-genre">${c.genre}</span>` : ''}</div>
            <div class="chart-actions">
                <button class="chart-action-btn" onclick="editChart('${c.id}', event)">✏️</button>
                <button class="chart-action-btn" onclick="deleteChart('${c.id}', event)">🗑️</button>
            </div>
        `;
        div.onclick = () => loadTeleprompter(c);
        list.appendChild(div);
    });
}

// ---- API: SETLISTS ----
async function fetchSetlists() {
    const res = await fetch('/api/setlists');
    setlists = await res.json();
}

function renderSetlists() {
    const q = document.getElementById('setlistSearch').value.toLowerCase();
    const grid = document.getElementById('setlistGrid');
    
    let filtered = setlists.filter(s => (s.name||'').toLowerCase().includes(q) || (s.venue||'').toLowerCase().includes(q));
    
    if (!filtered.length) {
        grid.innerHTML = '<div class="empty-state">No setlists match your search.</div>';
        return;
    }
    
    grid.innerHTML = '';
    filtered.forEach(s => {
        const div = document.createElement('div');
        div.className = 'setlist-card';
        div.innerHTML = `
            <div class="sl-card-name">${s.name || 'Unnamed Setlist'}</div>
            <div class="sl-card-venue">📍 ${s.venue || 'No Venue'}</div>
            <div class="sl-card-meta">
                <span class="sl-card-count">${(s.items||[]).length} items</span>
            </div>
            <div class="sl-card-actions">
                <button class="btn btn-ghost btn-sm" onclick="editSetlist('${s.id}', event)">Edit</button>
                <button class="btn btn-accent btn-sm" onclick="selectSetlistForShow('${s.id}', event)">Select</button>
                <button class="btn btn-ghost btn-sm" onclick="deleteSetlist('${s.id}', event)" style="margin-left:auto;color:var(--danger)">🗑️</button>
            </div>
        `;
        // clicking card selects it for show
        div.onclick = () => selectSetlistForShow(s.id);
        grid.appendChild(div);
    });
}

async function createSetlist() {
    const name = document.getElementById('newSetlistName').value;
    if (!name) return alert('Enter a name');
    
    const res = await fetch('/api/setlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, items: [] })
    });
    const data = await res.json();
    document.getElementById('newSetlistName').value = '';
    await fetchSetlists();
    editSetlist(data.id);
}

async function deleteSetlist(id, e) {
    if (e) e.stopPropagation();
    if (!confirm('Delete this setlist?')) return;
    await fetch('/api/setlists/' + id, { method: 'DELETE' });
    if (activeSetlist && activeSetlist.id === id) activeSetlist = null;
    await fetchSetlists();
    renderSetlists();
}

// ---- SETLIST EDITOR ----
let currentEditingSetlist = null;

function editSetlist(id, e) {
    if (e) e.stopPropagation();
    currentEditingSetlist = setlists.find(s => s.id === id);
    if (!currentEditingSetlist) return;
    
    document.getElementById('libraryView').classList.add('hidden');
    document.getElementById('setlistEditorView').classList.remove('hidden');
    
    document.getElementById('slEditId').value = currentEditingSetlist.id;
    document.getElementById('slEditName').value = currentEditingSetlist.name || '';
    document.getElementById('slEditVenue').value = currentEditingSetlist.venue || '';
    
    renderSlItems();
    renderSlLibrary();
}

function renderSlItems() {
    const list = document.getElementById('slItemsList');
    list.innerHTML = '';
    const items = currentEditingSetlist.items || [];
    
    items.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = 'sl-item';
        div.draggable = true;
        div.dataset.index = index;
        
        let icon = '📄';
        let title = 'Unknown';
        let sub = '';
        
        if (item.type === 'chart') {
            const chart = charts.find(c => c.id === item.chartId);
            icon = '🎵';
            title = chart ? chart.title : 'Deleted Chart';
            sub = chart ? chart.artist : '';
        } else if (item.type === 'break') {
            icon = '☕';
            title = item.title || 'Break';
            sub = item.duration ? `${item.duration} min` : '';
        } else if (item.type === 'filler') {
            icon = '📻';
            title = item.title || 'Filler Music';
            sub = item.url ? 'URL attached' : '';
        } else if (item.type === 'note') {
            icon = '📌';
            title = item.title || 'Stage Note';
        }
        
        div.innerHTML = `
            <div class="sl-item-icon">${icon}</div>
            <div class="sl-item-info">
                <div class="sl-item-title">${title}</div>
                <div class="sl-item-sub">${sub}</div>
            </div>
            <div class="sl-item-actions">
                <button class="sl-item-btn" onclick="removeSlItem(${index})">✕</button>
            </div>
        `;
        
        // Drag events
        div.addEventListener('dragstart', handleDragStart);
        div.addEventListener('dragover', handleDragOver);
        div.addEventListener('drop', handleDrop);
        div.addEventListener('dragenter', e => e.preventDefault());
        
        list.appendChild(div);
    });
    
    document.getElementById('slDuration').textContent = `${items.length} items`;
}

// Drag & Drop
function handleDragStart(e) {
    draggedItem = e.target.closest('.sl-item');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', draggedItem.dataset.index);
    setTimeout(() => draggedItem.classList.add('dragging'), 0);
}

function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('.sl-item');
    if (target && target !== draggedItem) {
        // simple reorder visual cue
        target.style.borderTop = '2px solid var(--accent)';
    }
}

function handleDrop(e) {
    e.preventDefault();
    const listItems = document.querySelectorAll('.sl-item');
    listItems.forEach(i => i.style.borderTop = '');
    
    const fromIndex = parseInt(e.dataTransfer.getData('text/plain'));
    const targetEl = e.target.closest('.sl-item');
    if (!targetEl) return;
    
    const toIndex = parseInt(targetEl.dataset.index);
    
    if (fromIndex !== toIndex) {
        const items = currentEditingSetlist.items;
        const [moved] = items.splice(fromIndex, 1);
        items.splice(toIndex, 0, moved);
        renderSlItems();
    }
}

function removeSlItem(index) {
    currentEditingSetlist.items.splice(index, 1);
    renderSlItems();
}

function renderSlLibrary() {
    const q = document.getElementById('slLibSearch').value.toLowerCase();
    const list = document.getElementById('slLibraryList');
    list.innerHTML = '';
    
    charts.filter(c => (c.title||'').toLowerCase().includes(q) || (c.artist||'').toLowerCase().includes(q)).forEach(c => {
        const div = document.createElement('div');
        div.className = 'sl-library-item';
        div.innerHTML = `
            <div class="sl-lib-title">${c.title}</div>
            <div class="sl-lib-sub">${c.artist || 'Unknown Artist'} • ${c.key||'-'}</div>
        `;
        div.onclick = () => {
            if (!currentEditingSetlist.items) currentEditingSetlist.items = [];
            currentEditingSetlist.items.push({ type: 'chart', chartId: c.id });
            renderSlItems();
        };
        list.appendChild(div);
    });
}

function slAddBreak() {
    const title = prompt('Break Title (e.g. 15 min Break)');
    if (title) {
        currentEditingSetlist.items.push({ type: 'break', title });
        renderSlItems();
    }
}

function slAddFiller() {
    const title = prompt('Title (e.g. Walk-in Playlist)');
    if (!title) return;
    const url = prompt('URL to play (YouTube, Spotify, etc) - optional');
    currentEditingSetlist.items.push({ type: 'filler', title, url });
    renderSlItems();
}

function slAddNote() {
    const title = prompt('Note (e.g. Band intros, tuning)');
    if (title) {
        currentEditingSetlist.items.push({ type: 'note', title });
        renderSlItems();
    }
}

async function saveSetlist() {
    currentEditingSetlist.name = document.getElementById('slEditName').value;
    currentEditingSetlist.venue = document.getElementById('slEditVenue').value;
    
    await fetch('/api/setlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentEditingSetlist)
    });
    await fetchSetlists();
    showLibrary();
    switchTab('setlists');
}

// ---- SHOW RUNNER TAB ----
function selectSetlistForShow(id, e) {
    if (e) e.stopPropagation();
    activeSetlist = setlists.find(s => s.id === id);
    activeSetlistIndex = 0;
    switchTab('show');
}

function renderShowRunner() {
    const container = document.getElementById('showRunnerContent');
    if (!activeSetlist) {
        container.innerHTML = `
            <div class="empty-state show-no-setlist">
                <div style="font-size:3rem">🎪</div>
                <p>Select a setlist to run a show</p>
                <button class="btn btn-primary" onclick="switchTab('setlists')">Browse Setlists</button>
            </div>
        `;
        return;
    }
    
    let html = `
        <div style="margin-bottom:20px;">
            <h2 style="font-size:1.5rem;font-weight:800">${activeSetlist.name}</h2>
            <div style="color:var(--muted);font-size:0.85rem">📍 ${activeSetlist.venue || 'No Venue'}</div>
        </div>
        <button class="btn btn-play" onclick="launchShow()" style="width:100%;margin-bottom:20px">▶ LAUNCH SHOW</button>
        <div class="sl-items-list" style="background:rgba(0,0,0,0.2);border-radius:12px;padding:12px">
    `;
    
    const items = activeSetlist.items || [];
    items.forEach((item, i) => {
        let icon = '📄';
        let title = 'Unknown';
        if (item.type === 'chart') {
            const chart = charts.find(c => c.id === item.chartId);
            icon = '🎵'; title = chart ? chart.title : 'Deleted Chart';
        } else if (item.type === 'break') { icon = '☕'; title = item.title; }
        else if (item.type === 'filler') { icon = '📻'; title = item.title; }
        else if (item.type === 'note') { icon = '📌'; title = item.title; }
        
        html += `
            <div class="sl-item" onclick="launchShowAt(${i})" style="cursor:pointer">
                <div class="sl-item-icon">${icon}</div>
                <div class="sl-item-title">${i+1}. ${title}</div>
            </div>
        `;
    });
    
    html += `</div>`;
    container.innerHTML = html;
}

// ---- CHART EDITOR ----
function handleNewBtn() {
    document.getElementById('editId').value = '';
    document.getElementById('editTitle').value = '';
    document.getElementById('editArtist').value = '';
    document.getElementById('editKey').value = '';
    document.getElementById('editBpm').value = '';
    document.getElementById('editGenre').value = '';
    document.getElementById('editCapo').value = '';
    document.getElementById('editContent').value = '';
    
    document.getElementById('libraryView').classList.add('hidden');
    document.getElementById('editorView').classList.remove('hidden');
}

function editChart(id, e) {
    if (e) e.stopPropagation();
    const c = charts.find(ch => ch.id === id);
    if (!c) return;
    
    document.getElementById('editId').value = c.id;
    document.getElementById('editTitle').value = c.title || '';
    document.getElementById('editArtist').value = c.artist || '';
    document.getElementById('editKey').value = c.key || '';
    document.getElementById('editBpm').value = c.bpm || '';
    document.getElementById('editGenre').value = c.genre || '';
    document.getElementById('editCapo').value = c.capo || '';
    document.getElementById('editContent').value = c.content || c.rawText || '';
    
    document.getElementById('libraryView').classList.add('hidden');
    document.getElementById('editorView').classList.remove('hidden');
}

async function saveChart() {
    const id = document.getElementById('editId').value;
    const title = document.getElementById('editTitle').value;
    if (!title) return alert('Title required');
    
    const chart = {
        title,
        artist: document.getElementById('editArtist').value,
        key: document.getElementById('editKey').value,
        bpm: document.getElementById('editBpm').value,
        genre: document.getElementById('editGenre').value,
        capo: document.getElementById('editCapo').value,
        content: document.getElementById('editContent').value
    };
    if (id) chart.id = id;
    
    const res = await fetch('/api/charts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chart)
    });
    const saved = await res.json();
    await fetchCharts();
    return saved;
}

async function saveAndLaunch() {
    const c = await saveChart();
    if (c) loadTeleprompter(c);
}

async function deleteChart(id, e) {
    if (e) e.stopPropagation();
    if (!confirm('Delete this chart?')) return;
    await fetch('/api/charts/' + id, { method: 'DELETE' });
    await fetchCharts();
    renderLibrary();
}

// Editor Tools
function insertChordPro() {
    const ta = document.getElementById('editContent');
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const val = ta.value;
    ta.value = val.substring(0, start) + '[G]' + val.substring(end);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = start + 3;
}

function detectKey() {
    const content = document.getElementById('editContent').value;
    const firstChordMatch = content.match(/\[([A-G][#b]?(m|min|maj)?)\]/);
    if (firstChordMatch) {
        document.getElementById('editKey').value = firstChordMatch[1];
    } else {
        const lineMatch = content.match(/^([A-G][#b]?(m|min|maj)?)\s/m);
        if (lineMatch) document.getElementById('editKey').value = lineMatch[1];
        else alert('Could not detect key automatically');
    }
}

function formatChart() {
    // Basic cleanup: trim lines, replace multiple spaces with single if not a pure chord line
    alert('Auto-format coming soon (chord pro converter)');
}

function toggleChordHighlight() {
    // future enhancement
}


// ---- STAGE / TELEPROMPTER ----
function launchShow() {
    if (!activeSetlist || !activeSetlist.items || !activeSetlist.items.length) return alert('Setlist is empty');
    activeSetlistIndex = 0;
    if (syncMode === 'host') {
        socket.emit('hostAdvanceShow', { 
            chartId: null, 
            itemIndex: 0, 
            mode: 'playing',
            setlistId: activeSetlist.id
        });
    }
    loadShowItem(0);
}

function launchShowAt(index) {
    activeSetlistIndex = index;
    if (syncMode === 'host') {
        socket.emit('hostAdvanceShow', { 
            chartId: null, 
            itemIndex: index, 
            mode: 'playing',
            setlistId: activeSetlist.id
        });
    }
    loadShowItem(index);
}

function showAdvance(dir) {
    if (!activeSetlist) return;
    const newIdx = activeSetlistIndex + dir;
    if (newIdx >= 0 && newIdx < activeSetlist.items.length) {
        activeSetlistIndex = newIdx;
        if (syncMode === 'host') {
            socket.emit('hostAdvanceShow', { chartId: null, itemIndex: newIdx, mode: 'playing' });
        }
        loadShowItem(newIdx);
    }
}

function loadShowItem(index) {
    const item = activeSetlist.items[index];
    if (!item) return;
    
    // UI prep
    document.getElementById('editorView').classList.add('hidden');
    document.getElementById('setlistEditorView').classList.add('hidden');
    document.getElementById('libraryView').classList.add('hidden');
    document.getElementById('teleprompterView').classList.remove('hidden');
    document.getElementById('fillerOverlay').style.display = 'none';
    
    // Nav controls visibility
    document.getElementById('showNavControls').style.display = activeSetlist ? 'flex' : 'none';
    document.getElementById('showNavControlsNext').style.display = activeSetlist ? 'flex' : 'none';
    
    // Progress bar
    if (document.getElementById('settingShowProgress')?.checked && activeSetlist) {
        renderProgressBar(index);
    } else {
        document.getElementById('showProgressBar').style.display = 'none';
    }
    
    if (item.type === 'chart') {
        const chart = charts.find(c => c.id === item.chartId);
        if (chart) loadTeleprompter(chart, false); // false = don't reset setlist state
    } else if (item.type === 'filler') {
        showFillerMode(item);
    } else if (item.type === 'break' || item.type === 'note') {
        // Render as a simple centered text chart
        const dummyChart = {
            title: item.title,
            artist: item.type === 'break' ? 'Break' : 'Stage Note',
            content: `\n\n\n\n\n[ ${item.title.toUpperCase()} ]`
        };
        loadTeleprompter(dummyChart, false);
    }
}

function renderProgressBar(currentIndex) {
    const bar = document.getElementById('showProgressBar');
    const container = document.getElementById('showProgressItems');
    bar.style.display = 'flex';
    container.innerHTML = '';
    
    activeSetlist.items.forEach((item, i) => {
        const div = document.createElement('div');
        div.className = `sp-item ${i === currentIndex ? 'active' : ''} ${i < currentIndex ? 'done' : ''}`;
        
        let label = '';
        if (item.type === 'chart') {
            const chart = charts.find(c => c.id === item.chartId);
            label = chart ? chart.title : 'Chart';
        } else {
            label = item.title || item.type;
        }
        
        div.textContent = label;
        div.onclick = () => launchShowAt(i);
        container.appendChild(div);
    });
}

function showFillerMode(item) {
    teleprompter.pause();
    document.getElementById('prompterContent').innerHTML = '';
    document.getElementById('songInfoBadge').style.display = 'none';
    
    const overlay = document.getElementById('fillerOverlay');
    overlay.style.display = 'flex';
    document.getElementById('fillerTitle').textContent = item.title;
    
    if (item.url && item.url.includes('youtube.com')) {
        // attempt auto embed
        const ytBox = document.getElementById('fillerYtContainer');
        const iframe = document.getElementById('fillerYtFrame');
        const videoId = new URL(item.url).searchParams.get('v');
        if (videoId) {
            ytBox.style.display = 'block';
            iframe.src = `https://www.youtube.com/embed/${videoId}?autoplay=1`;
        }
    }
}

function endFiller() {
    document.getElementById('fillerOverlay').style.display = 'none';
    const ytBox = document.getElementById('fillerYtContainer');
    const iframe = document.getElementById('fillerYtFrame');
    ytBox.style.display = 'none';
    iframe.src = '';
    showAdvance(1); // go to next
}

function exitStage() {
    activeSetlist = null;
    teleprompter.pause();
    showLibrary();
}

function editCurrentChart() {
    if (activeChart && activeChart.id) editChart(activeChart.id);
}

function loadTeleprompter(chart, standalone = true) {
    activeChart = chart;
    if (standalone) {
        activeSetlist = null;
        document.getElementById('showNavControls').style.display = 'none';
        document.getElementById('showNavControlsNext').style.display = 'none';
        document.getElementById('showProgressBar').style.display = 'none';
    }
    
    document.getElementById('libraryView').classList.add('hidden');
    document.getElementById('editorView').classList.add('hidden');
    document.getElementById('setlistEditorView').classList.add('hidden');
    document.getElementById('teleprompterView').classList.remove('hidden');
    
    // Badge
    document.getElementById('songInfoBadge').style.display = 'flex';
    document.getElementById('sib-title').textContent = chart.title || 'Untitled';
    document.getElementById('sib-artist').textContent = chart.artist || 'Unknown';
    document.getElementById('sib-key').textContent = chart.key || 'Orig';
    
    const chartText = chart.content || chart.rawText || '';
    renderPrompter(chartText);
    
    const scrollArea = document.getElementById('prompterScrollArea');
    if (scrollArea) scrollArea.scrollTop = 0;
    teleprompter.pause();
    
    // Capo & Transpose
    chordEngine.resetTranspose();
    if (chart.capo) {
        document.getElementById('capoSelect').value = chart.capo;
        chordEngine.setCapo(chart.capo);
    }
    
    if (syncMode === 'host' && standalone) {
        socket.emit('hostChangeChart', { chartId: chart.id });
    }
}

// ---- CHORD PARSER & RENDERER ----
function toggleChordMode() {
    chordDisplayMode = (chordDisplayMode === 'inline') ? 'above' : 'inline';
    const btn = document.getElementById('btnChordMode');
    if (btn) btn.innerHTML = (chordDisplayMode === 'above') ? '🎼 ABOVE' : '🎵 INLINE';
    if (activeChart) renderPrompter(activeChart.content || activeChart.rawText || '');
}

function renderPrompter(rawText) {
    const root = document.getElementById('prompterContent');
    if (!rawText) { root.innerHTML = ''; return; }
    
    if (chordDisplayMode === 'above') {
        root.innerHTML = parseChordsAbove(rawText);
    } else {
        root.innerHTML = parseChordsInline(rawText);
    }
    applyFontSettings(); // ensure styles apply to new elements
}

function isChordLine(line) {
    if (!line.trim()) return false;
    const tokens = line.trim().split(/\s+/);
    let valid = 0;
    const chordRegex = /^([CDEFGAB][b#]?(m|min|maj|dim|aug|sus\d?)?\d?(add\d)?(\/[CDEFGAB][b#]?)?)$/i;
    for (let t of tokens) {
        if (chordRegex.test(t)) valid++;
        else return false;
    }
    return valid > 0;
}

function parseChordsInline(rawText) {
    const lines = rawText.split('\n');
    let html = '';
    lines.forEach(line => {
        if (line.includes('[') && line.includes(']')) {
            const p = line.replace(/\[(.*?)\]/g, (m, c) => `<span class="chord" data-original="${c}">${c}</span>`);
            html += `<div>${p}</div>`;
        } else if (isChordLine(line)) {
            const p = line.replace(/\S+/g, m => `<span class="chord" data-original="${m}">${m}</span>`);
            html += `<div>${p}</div>`;
        } else {
            html += `<div>${line || '<br>'}</div>`;
        }
    });
    return html;
}

function parseChordsAbove(rawText) {
    const lines = rawText.split('\n');
    let html = '';
    lines.forEach(line => {
        if (!line.includes('[')) {
            if (isChordLine(line)) {
                const p = line.replace(/\S+/g, m => `<span class="chord" data-original="${m}">${m}</span>`);
                html += `<div class="chord-line">${p}</div>`;
            } else {
                html += `<div class="lyric-line">${line || '&nbsp;'}</div>`;
            }
            return;
        }
        
        const parts = line.split(/\[([^\]]+)\]/);
        let chordHtml = '';
        let lyricHtml = '';
        
        for (let i = 0; i < parts.length; i+=2) {
            const text = parts[i];
            const chord = parts[i+1] || '';
            
            if (i === 0 && text) {
                lyricHtml += `<span class="lyric-seg">${text}</span>`;
                chordHtml += `<span class="chord-seg-empty">${'&nbsp;'.repeat(text.length)}</span>`;
            } else if (text) {
                lyricHtml += `<span class="lyric-seg">${text}</span>`;
            }
            
            if (chord) {
                // look ahead at next text to determine spacing block width
                const nextText = parts[i+2] || '';
                const len = Math.max(chord.length + 1, nextText.length);
                chordHtml += `<span class="chord-seg chord" data-original="${chord}" style="min-width:${len}ch">${chord}</span>`;
            }
        }
        html += `<div class="chord-above-block"><div class="chord-row">${chordHtml}</div><div class="lyric-row">${lyricHtml}</div></div>`;
    });
    return html;
}

// ---- ENGINE: MATH ----
const chordEngine = {
    KEYS: ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'],
    currentStep: 0,
    capoStep: 0,
    nnsMode: false,
    
    idx(n) {
        const m = {'Cb':'B','C':'C','C#':'C#','Db':'C#','D':'D','D#':'D#','Eb':'D#','E':'E','E#':'F','F':'F','F#':'F#','Gb':'F#','G':'G','G#':'G#','Ab':'G#','A':'A','A#':'A#','Bb':'A#','B':'B'};
        return this.KEYS.indexOf(m[n.charAt(0).toUpperCase() + n.slice(1)]);
    },
    
    shift(note, steps) {
        let i = this.idx(note);
        if (i === -1) return note;
        return this.KEYS[(i + steps + 120) % 12];
    },
    
    toNNS(note, key) {
        if (!key) return note;
        let ni = this.idx(note), ki = this.idx(key);
        if (ni === -1 || ki === -1) return note;
        const diff = (ni - ki + 12) % 12;
        const m = {0:'1',1:'b2',2:'2',3:'b3',4:'3',5:'4',6:'b5',7:'5',8:'b6',9:'6',10:'b7',11:'7'};
        return m[diff];
    },
    
    redraw() {
        const total = this.currentStep - this.capoStep;
        document.getElementById('currentKeyDisplay').textContent = this.currentStep === 0 ? 'Orig' : (this.currentStep > 0 ? '+' : '') + this.currentStep;
        
        let songKey = activeChart?.key;
        if (!songKey) {
            const f = document.querySelector('.chord');
            if (f) songKey = (f.getAttribute('data-original').match(/^([A-G][b#]?)/i) || [])[1];
        }
        
        document.querySelectorAll('.chord').forEach(span => {
            const orig = span.getAttribute('data-original');
            const m = orig.match(/^([A-G][b#]?)(.*)$/i);
            if (m) {
                let root = m[1], suf = m[2];
                let nRoot = this.shift(root, total);
                
                if (suf.includes('/')) {
                    const parts = suf.split('/');
                    const bm = parts[1].match(/^([A-G][b#]?)(.*)$/i);
                    if (bm) {
                        let nBass = this.shift(bm[1], total);
                        if (this.nnsMode && songKey) nBass = this.toNNS(bm[1], songKey);
                        suf = parts[0] + '/' + nBass + bm[2];
                    }
                }
                
                if (this.nnsMode && songKey) nRoot = this.toNNS(root, songKey);
                span.textContent = nRoot + suf;
            }
        });
    },
    
    transpose(d) { this.currentStep += d; this.redraw(); },
    setCapo(f) { this.capoStep = parseInt(f); this.redraw(); },
    toggleNNS() { 
        this.nnsMode = !this.nnsMode; 
        document.getElementById('btnNNS').style.background = this.nnsMode ? 'var(--accent)' : '';
        document.getElementById('btnNNS').style.color = this.nnsMode ? '#000' : '';
        this.redraw(); 
    },
    resetTranspose() {
        this.currentStep = 0; this.capoStep = 0; this.nnsMode = false;
        document.getElementById('btnNNS').style.background = '';
        document.getElementById('btnNNS').style.color = '';
        document.getElementById('capoSelect').value = '0';
        this.redraw();
    }
};

// ---- TELEPROMPTER AUTO-SCROLL ----
const teleprompter = {
    isPlaying: false,
    speed: 50,
    lastTime: 0,
    frame: null,
    
    togglePlay() {
        this.isPlaying = !this.isPlaying;
        const btn = document.getElementById('btnPlayPause');
        btn.innerHTML = this.isPlaying ? '⏸ PAUSE' : '▶ PLAY';
        btn.style.background = this.isPlaying ? '#f59e0b' : '';
        
        if (this.isPlaying) {
            this.lastTime = performance.now();
            this.frame = requestAnimationFrame(t => this.loop(t));
        } else {
            cancelAnimationFrame(this.frame);
        }
        
        if (syncMode === 'host') socket.emit('hostTogglePlayback', this.isPlaying);
    },
    
    pause() { if (this.isPlaying) this.togglePlay(); },
    
    loop(t) {
        if (!this.isPlaying) return;
        const dt = (t - this.lastTime) / 1000;
        this.lastTime = t;
        
        const area = document.getElementById('prompterScrollArea');
        area.scrollTop += this.speed * dt;
        
        if (syncMode === 'host') socket.emit('hostUpdateScroll', area.scrollTop);
        this.frame = requestAnimationFrame(t => this.loop(t));
    },
    
    setSpeed(v) {
        this.speed = parseInt(v);
        document.getElementById('speedVal').textContent = v;
        if (syncMode === 'host') socket.emit('hostChangeSpeed', this.speed);
    }
};

// ---- SOCKET SYNC ----
function setSyncMode(mode) {
    syncMode = mode;
    document.getElementById('syncStatus').className = `status-dot ${mode}`;
    
    if (mode === 'host') {
        socket.emit('becomeHost');
    } else if (mode === 'viewer') {
        document.getElementById('libraryView').classList.add('hidden');
        document.getElementById('teleprompterView').classList.remove('hidden');
        document.querySelectorAll('.hud-center, .hud-right, .btn-hud:not(#btnChordMode)').forEach(el => {
            if (el.id !== 'syncModeSelect') el.style.pointerEvents = 'none';
            if (el.id !== 'syncModeSelect') el.style.opacity = '0.5';
        });
    }
}

socket.on('syncState', state => {
    if (syncMode === 'viewer') {
        if (state.mode === 'filler') {
            showFillerMode({ title: state.fillerTitle, url: state.fillerUrl });
            return;
        } else {
            document.getElementById('fillerOverlay').style.display = 'none';
        }
        
        if (state.activeChartId && (!activeChart || activeChart.id !== state.activeChartId)) {
            const c = charts.find(x => x.id === state.activeChartId);
            if (c) loadTeleprompter(c, false);
        }
        teleprompter.speed = state.speed;
        if (teleprompter.isPlaying !== state.isPlaying) teleprompter.togglePlay();
    }
});

socket.on('viewerUpdateScroll', pos => {
    if (syncMode === 'viewer') document.getElementById('prompterScrollArea').scrollTop = pos;
});

socket.on('viewerCount', count => {
    const lbl = document.getElementById('viewerCountLabel');
    const pill = document.getElementById('viewerPill');
    const hud = document.getElementById('hudViewerCount');
    if (lbl) lbl.textContent = `${count} viewer${count!==1?'s':''}`;
    if (pill) pill.style.display = count > 1 ? 'flex' : 'none';
    if (hud) hud.textContent = count > 1 ? `(${count})` : '';
});

// ---- SETTINGS & PREFS ----
function toggleFontSettings() {
    document.getElementById('fontSettingsPanel').classList.toggle('open');
}

function toggleStyle(id) {
    document.getElementById(id).classList.toggle('active');
    applyFontSettings();
}

function changeTheme(btn) {
    document.querySelectorAll('.theme-swatch').forEach(el => el.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('teleprompterView').className = `view ${btn.dataset.theme}`;
}

function applyFontSettings() {
    const root = document.getElementById('prompterContent');
    if (!root) return;
    
    const px = id => document.getElementById(id).value + 'px';
    const val = id => document.getElementById(id).value;
    const isAct = id => document.getElementById(id).classList.contains('active');
    const isChk = id => document.getElementById(id).checked;
    
    // UI Update
    document.getElementById('lyricSizeVal').textContent = px('lyricSize');
    document.getElementById('chordSizeVal').textContent = px('chordSize');
    document.getElementById('lyricLineHVal').textContent = val('lyricLineH');
    document.getElementById('displayPaddingVal').textContent = val('displayPadding') + '%';
    
    // Apply Lyrics
    root.style.fontSize = px('lyricSize');
    root.style.lineHeight = val('lyricLineH');
    root.style.color = val('lyricColor');
    root.style.background = isChk('lyricBgOn') ? val('lyricBg') : 'transparent';
    root.style.fontWeight = isAct('lyricBold') ? '700' : '400';
    root.style.fontStyle = isAct('lyricItalic') ? 'italic' : 'normal';
    root.style.textDecoration = isAct('lyricUnderline') ? 'underline' : 'none';
    root.style.fontFamily = val('lyricFont');
    
    // Apply Chords (via CSS vars)
    root.style.setProperty('--chord-fs', px('chordSize'));
    root.style.setProperty('--chord-color', val('chordColor'));
    root.style.setProperty('--chord-bg', isChk('chordBgOn') ? val('chordBg') : 'transparent');
    root.style.setProperty('--chord-fw', isAct('chordBold') ? '800' : '400');
    root.style.setProperty('--chord-fi', isAct('chordItalic') ? 'italic' : 'normal');
    root.style.setProperty('--chord-td', isAct('chordUnderline') ? 'underline' : 'none');
    root.style.setProperty('--chord-ff', val('chordFont'));
    
    // Layout
    document.getElementById('prompterScrollArea').style.padding = `60px ${val('displayPadding')}%`;
}

function openSettings() { document.getElementById('settingsModal').style.display = 'flex'; }
function closeSettings(e) { if (!e || e.target.id === 'settingsModal') document.getElementById('settingsModal').style.display = 'none'; }
function copyViewerUrl() { navigator.clipboard.writeText(document.getElementById('viewerUrlBox').textContent); alert('Copied!'); }

init();
