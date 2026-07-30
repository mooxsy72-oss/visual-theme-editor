// modules/codeEditor.js
// Панель кода: подсветка синтаксиса CSS, номера строк, проверка ошибок,
// поиск. На больших темах тяжёлые слои отключаются автоматически.

let onCodeChange = null;
let onValidate = null;

let panel = null;
let ta = null;
let hl = null;
let searchLayer = null;
let gutter = null;
let statusEl = null;
let problemsEl = null;
let minimapEl = null;

let readOnly = false;
let wrapLines = false;
let currentValue = '';
let syncScheduled = false;
let changeTimer = null;
let renderTimer = null;
let plainMode = false;

/* --- Локальная история панели кода --- */
let undoStack = [];
let redoStack = [];
let lastSnapshot = '';
let lastSnapPos = 0;     // где была каретка в момент прошлого снимка
let caretPos = 0;        // текущая позиция каретки
let snapTimer = null;
let undoBtn = null;
let redoBtn = null;
const HISTORY_MAX = 150;
const SNAP_DEBOUNCE = 400;

const TAB = '    ';
const CHANGE_DEBOUNCE = 500;

// Пороги облегчённого режима (в символах)
const HIGHLIGHT_LIMIT = 40000;
const MINIMAP_LIMIT = 25000;
const DIAG_LIMIT = 60000;

// Слой подсветки совпадений строится из DOM-узлов,
// на огромных темах его отключаем, а сам поиск продолжает работать
const SEARCH_OVERLAY_LIMIT = 200000;

const AUTO_START = 'VTE:AUTO START';
const AUTO_END = 'VTE:AUTO END';

/* --- Состояние поиска и замены --- */
let searchHits = [];      // [{ start, end }]
let searchIndex = -1;     // какое совпадение активно
let searchCase = false;   // учитывать регистр
let searchRegex = false;  // режим регулярного выражения


/* ============================================================
   МИНИ-ХЕЛПЕР DOM
============================================================ */
function h(tagSpec, attrs, children) {
    const idMatch = tagSpec.match(/#([\w-]+)/);
    const clsList = (tagSpec.match(/\.[\w-]+/g) || []).map(s => s.slice(1));
    const tag = (tagSpec.match(/^[\w-]+/) || ['div'])[0];

    const el = document.createElement(tag);
    if (idMatch) el.id = idMatch[1];
    if (clsList.length) el.className = clsList.join(' ');

    if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
            if (v == null || v === false) continue;
            if (k === 'text') { el.textContent = v; continue; }
            if (k === 'style') { el.style.cssText = v; continue; }
            if (k === 'dataset') { Object.assign(el.dataset, v); continue; }
            if (k === 'on') {
                for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
                continue;
            }
            if (k in el && typeof el[k] !== 'object' && k !== 'list') {
                try { el[k] = v; continue; } catch {}
            }
            el.setAttribute(k, v === true ? '' : v);
        }
    }
    for (const c of [].concat(children || [])) {
        if (c == null || c === false) continue;
        el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
}

function icon(name) {
    return h('i', { className: `fa-solid ${name}` });
}

function iconBtn(faName, title, onClick, extraClass) {
    return h(`button.vte-code-btn${extraClass ? '.' + extraClass : ''}`, {
        type: 'button',
        title,
        on: { click: onClick },
    }, [icon(faName)]);
}

/* ============================================================
   ИНИЦИАЛИЗАЦИЯ
============================================================ */
export function init(options = {}) {
    onCodeChange = options.onCodeChange || (() => {});
    onValidate = options.onValidate || (() => []);
}

export function createPanel() {
    if (panel) {
        panel.style.display = 'flex';
        return panel;
    }

    panel = h('div#vte-code-panel.vte-code-panel');

    const title = h('div.vte-code-title', {}, [
        h('span.vte-code-logo', {}, [icon('fa-code')]),
        h('span', { text: 'custom.css' }),
        h('span#vte-code-dirty.vte-code-dirty', { text: '' }),
    ]);

    undoBtn = iconBtn('fa-rotate-left', 'Отменить (Ctrl+Z)', localUndo);
    redoBtn = iconBtn('fa-rotate-right', 'Вернуть (Ctrl+Shift+Z)', localRedo);
    undoBtn.disabled = true;
    redoBtn.disabled = true;

    const controls = h('div.vte-code-controls', {}, [
        undoBtn,
        redoBtn,
        h('span.vte-code-sep'),
        iconBtn('fa-arrow-down', 'К моим правкам (авто-блок)', () => revealAutoBlock({ focus: true })),
        iconBtn('fa-magnifying-glass', 'Поиск и замена (Ctrl+F)', toggleSearch),
        iconBtn('fa-indent', 'Форматировать', format),
        iconBtn('fa-text-width', 'Перенос строк', toggleWrap),
        iconBtn('fa-copy', 'Скопировать всё', copyAll),
        iconBtn('fa-window-minimize', 'Свернуть', toggleCollapse),
        iconBtn('fa-xmark', 'Закрыть', hidePanel, 'vte-code-btn-close'),
    ]);

    const header = h('div#vte-code-header.vte-code-header', {}, [title, controls]);

    /* ---- Поиск и замена ---- */
    const fieldKeys = (e, isFind) => {
        if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            if (isFind) runSearch(e.shiftKey ? -1 : 1);
            else e.shiftKey ? replaceAll() : replaceCurrent();
            return;
        }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            // Ctrl+Enter — перенос строки: так ищем по нескольким строкам
            e.preventDefault();
            const el = e.target;
            const s = el.selectionStart, en = el.selectionEnd;
            el.value = el.value.slice(0, s) + '\n' + el.value.slice(en);
            el.setSelectionRange(s + 1, s + 1);
            autoGrow(el);
            if (isFind) runSearch(0);
            return;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            toggleSearch(false);
        }
    };

    const searchInput = h('textarea#vte-code-find.vte-code-find-input', {
        rows: 1,
        wrap: 'off',
        spellcheck: false,
        placeholder: 'Найти… (Ctrl+Enter — новая строка)',
        on: {
            input: (e) => { autoGrow(e.target); runSearch(0); },
            keydown: (e) => fieldKeys(e, true),
        },
    });

    const replaceInput = h('textarea#vte-code-replace.vte-code-find-input', {
        rows: 1,
        wrap: 'off',
        spellcheck: false,
        placeholder: 'Заменить на…',
        on: {
            input: (e) => autoGrow(e.target),
            keydown: (e) => fieldKeys(e, false),
        },
    });

    const searchCount = h('span#vte-code-find-count.vte-code-find-count', { text: '0/0' });

    const caseBtn = h('button#vte-code-case.vte-code-btn.vte-code-toggle', {
        type: 'button',
        title: 'Учитывать регистр',
        text: 'Aa',
        on: {
            click: (e) => {
                searchCase = !searchCase;
                e.currentTarget.classList.toggle('active', searchCase);
                runSearch(0);
            },
        },
    });

    const regexBtn = h('button#vte-code-regex.vte-code-btn.vte-code-toggle', {
        type: 'button',
        title: 'Регулярное выражение',
        text: '.*',
        on: {
            click: (e) => {
                searchRegex = !searchRegex;
                e.currentTarget.classList.toggle('active', searchRegex);
                runSearch(0);
            },
        },
    });

    const findRow = h('div.vte-code-search-row', {}, [
        h('span.vte-code-find-ic', {}, [icon('fa-magnifying-glass')]),
        searchInput,
        searchCount,
        caseBtn,
        regexBtn,
        iconBtn('fa-chevron-up', 'Предыдущее (Shift+Enter)', () => runSearch(-1)),
        iconBtn('fa-chevron-down', 'Следующее (Enter)', () => runSearch(1)),
        iconBtn('fa-xmark', 'Закрыть поиск (Esc)', () => toggleSearch(false), 'vte-code-btn-close'),
    ]);

    const replaceRow = h('div.vte-code-search-row', {}, [
        h('span.vte-code-find-ic', {}, [icon('fa-arrow-right-arrow-left')]),
        replaceInput,
        h('button.vte-code-btn.vte-code-btn-text', {
            type: 'button', title: 'Заменить текущее (Enter)',
            text: 'Заменить',
            on: { click: replaceCurrent },
        }),
        h('button.vte-code-btn.vte-code-btn-text', {
            type: 'button', title: 'Заменить все (Shift+Enter)',
            text: 'Все',
            on: { click: replaceAll },
        }),
    ]);

    const searchBar = h('div#vte-code-search.vte-code-search', { style: 'display:none' }, [
        findRow, replaceRow,
    ]);


    /* ---- Область редактора ---- */
    gutter = h('div#vte-code-gutter.vte-code-gutter');
    hl = h('pre#vte-code-highlight.vte-code-highlight', { 'aria-hidden': 'true' });

    ta = h('textarea#vte-code-input.vte-code-input', {
        spellcheck: false,
        autocapitalize: 'off',
        autocomplete: 'off',
        wrap: 'off',
        on: {
            input: handleInput,
            scroll: scheduleSync,
            keydown: handleKeydown,
            click: updateCursor,
            keyup: updateCursor,
            select: updateCursor,
        },
    });

    searchLayer = h('div#vte-code-hits.vte-code-hits', { 'aria-hidden': 'true' });
    const surface = h('div.vte-code-surface', {}, [searchLayer, hl, ta]);


    minimapEl = h('div#vte-code-minimap.vte-code-minimap', {
        on: { click: jumpFromMinimap },
    });

    const body = h('div.vte-code-body', {}, [gutter, surface, minimapEl]);

    problemsEl = h('div#vte-code-problems.vte-code-problems', { style: 'display:none' });

    statusEl = h('div.vte-code-status', {}, [
        h('span#vte-code-pos.vte-code-status-item', { text: 'Стр 1, Кол 1' }),
        h('span#vte-code-stats.vte-code-status-item', { text: '0 строк' }),
        h('span#vte-code-lite.vte-code-lite', { style: 'display:none' }, [
            icon('fa-bolt'),
            h('span', { text: ' облегчённый режим' }),
        ]),
        h('span.vte-code-status-spacer'),
        h('span#vte-code-diag.vte-code-status-item.vte-code-diag', {}, [
            icon('fa-circle-check'),
            h('span', { text: ' Ошибок нет' }),
        ]),
        h('span.vte-code-status-item', { text: 'CSS' }),
    ]);

    panel.append(header, searchBar, body, problemsEl, statusEl);
    document.body.appendChild(panel);

    makeDraggable(panel, header);
    makeResizable(panel);
    shield(panel);

    return panel;
}

export function hidePanel() {
    if (panel) panel.style.display = 'none';
}

export function showPanel() {
    if (!panel) createPanel();
    panel.style.display = 'flex';
}

/* ============================================================
   ЗНАЧЕНИЕ
============================================================ */
export function setContent(css, opts = {}) {
    if (!panel) createPanel();
    if (currentValue === css) return;

    // Позицию храним всегда, а не только когда поле в фокусе:
    // правки из инспектора приходят, пока фокус на ползунке.
    const pos = document.activeElement === ta ? ta.selectionStart : caretPos;
    const scroll = ta.scrollTop;
    const hadFocus = document.activeElement === ta;

    noteExternalChange(css || '');

    currentValue = css || '';
    ta.value = currentValue;

    const p = Math.min(pos || 0, currentValue.length);
    caretPos = p;
    lastSnapPos = p;
    if (hadFocus) ta.setSelectionRange(p, p);

    ta.scrollTop = scroll;
    requestAnimationFrame(() => {
        ta.scrollTop = scroll;
        syncScroll();
    });

    scheduleRender(0);
    if (!opts.silent) markDirty(false);
}

export function getContent() {
    return ta ? ta.value : currentValue;
}

export function isOpen() {
    return !!panel && panel.style.display !== 'none';
}

export function setReadOnly(v) {
    readOnly = !!v;
    if (ta) ta.readOnly = readOnly;
}

/** Прокрутить к строке. focus=false — не забирать фокус у ползунков */
export function revealLine(line, opts = {}) {
    if (!ta) return;
    const lines = ta.value.split('\n');
    const idx = Math.max(0, Math.min(lines.length - 1, line - 1));

    const lh = lineHeight();
    ta.scrollTop = Math.max(0, idx * lh - ta.clientHeight / 2);

    if (opts.focus !== false) {
        let offset = 0;
        for (let i = 0; i < idx; i++) offset += lines[i].length + 1;
        ta.focus();
        ta.setSelectionRange(offset, offset + lines[idx].length);
        updateCursor();
    }
    scheduleSync();
}

/** Прыгнуть к авто-блоку расширения */
export function revealAutoBlock(opts = {}) {
    if (!ta) return false;
    const i = ta.value.indexOf(AUTO_START);
    if (i === -1) {
        flashStatus('Авто-блок пока пуст');
        return false;
    }
    const line = ta.value.slice(0, i).split('\n').length;
    revealLine(line, { focus: opts.focus === true });
    return true;
}

/* ============================================================
   ВВОД
============================================================ */
function handleInput() {
    currentValue = ta.value;
    caretPos = ta.selectionStart;
    scheduleRender();
    markDirty(true);
    scheduleSnapshot();

    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
        onCodeChange(currentValue);
        markDirty(false);
    }, CHANGE_DEBOUNCE);
}

function handleKeydown(e) {
    const mod = e.ctrlKey || e.metaKey;

    // Своя отмена: браузерная не работает, потому что код меняет value напрямую
    if (mod && (e.code === 'KeyZ' || e.key.toLowerCase() === 'z')) {
        e.preventDefault();
        e.stopPropagation();
        e.shiftKey ? localRedo() : localUndo();
        return;
    }
    if (mod && (e.code === 'KeyY' || e.key.toLowerCase() === 'y')) {
        e.preventDefault();
        e.stopPropagation();
        localRedo();
        return;
    }
    if (mod && (e.code === 'KeyH' || e.key.toLowerCase() === 'h')) {
        e.preventDefault();
        toggleSearch(true);
        return;
    }
    if (mod && (e.code === 'KeyF' || e.key.toLowerCase() === 'f')) {
        e.preventDefault();
        toggleSearch(true);
        return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        clearTimeout(changeTimer);
        onCodeChange(ta.value);
        markDirty(false);
        flashStatus('Применено');
        return;
    }
    if (e.shiftKey && e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        format();
        return;
    }
    if (readOnly) return;

    if (e.key === 'Tab') {
        e.preventDefault();
        e.shiftKey ? outdent() : indent();
        return;
    }
    if (e.key === 'Enter') {
        e.preventDefault();
        smartEnter();
        return;
    }
    const pairs = { '{': '}', '(': ')', '[': ']', '"': '"', "'": "'" };
    if (pairs[e.key] && ta.selectionStart === ta.selectionEnd) {
        e.preventDefault();
        insert(e.key + pairs[e.key], -1);
        return;
    }
    if ([')', ']', '}', '"', "'"].includes(e.key)) {
        const next = ta.value[ta.selectionStart];
        if (next === e.key && ta.selectionStart === ta.selectionEnd) {
            e.preventDefault();
            ta.setSelectionRange(ta.selectionStart + 1, ta.selectionStart + 1);
            updateCursor();
        }
    }
}

function insert(text, cursorShift = 0) {
    const s = ta.selectionStart, e = ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    const p = s + text.length + cursorShift;
    ta.setSelectionRange(p, p);
    handleInput();
}

function indent() {
    const s = ta.selectionStart, e = ta.selectionEnd;
    if (s === e) { insert(TAB); return; }

    const startLine = ta.value.lastIndexOf('\n', s - 1) + 1;
    const block = ta.value.slice(startLine, e);
    const shifted = block.replace(/^/gm, TAB);
    ta.value = ta.value.slice(0, startLine) + shifted + ta.value.slice(e);
    ta.setSelectionRange(startLine, startLine + shifted.length);
    handleInput();
}

function outdent() {
    const s = ta.selectionStart, e = ta.selectionEnd;
    const startLine = ta.value.lastIndexOf('\n', s - 1) + 1;
    const block = ta.value.slice(startLine, e || s);
    const shifted = block.replace(new RegExp(`^(${TAB}|\\t| {1,4})`, 'gm'), '');
    ta.value = ta.value.slice(0, startLine) + shifted + ta.value.slice(e || s);
    ta.setSelectionRange(startLine, startLine + shifted.length);
    handleInput();
}

function smartEnter() {
    const s = ta.selectionStart;
    const before = ta.value.slice(0, s);
    const after = ta.value.slice(ta.selectionEnd);
    const lineStart = before.lastIndexOf('\n') + 1;
    const currentLine = before.slice(lineStart);
    const baseIndent = (currentLine.match(/^[ \t]*/) || [''])[0];

    const opensBlock = /{\s*$/.test(currentLine);
    const closesNext = after.trimStart().startsWith('}');

    if (opensBlock && closesNext) {
        const inner = baseIndent + TAB;
        const text = '\n' + inner + '\n' + baseIndent;
        ta.value = before + text + after;
        const p = s + 1 + inner.length;
        ta.setSelectionRange(p, p);
    } else {
        const indentStr = opensBlock ? baseIndent + TAB : baseIndent;
        const text = '\n' + indentStr;
        ta.value = before + text + after;
        const p = s + text.length;
        ta.setSelectionRange(p, p);
    }
    handleInput();
}

/* ============================================================
   ОТРИСОВКА (отложенная, с облегчённым режимом)
============================================================ */
function scheduleRender(delay) {
    clearTimeout(renderTimer);
    const big = (ta?.value.length || 0) > HIGHLIGHT_LIMIT;
    renderTimer = setTimeout(render, delay != null ? delay : (big ? 260 : 70));
}

function render() {
    if (!ta) return;
    const len = ta.value.length;

    const nextPlain = len > HIGHLIGHT_LIMIT;
    if (nextPlain !== plainMode) {
        plainMode = nextPlain;
        panel.classList.toggle('vte-code-plain', plainMode);
        const badge = statusEl.querySelector('#vte-code-lite');
        if (badge) badge.style.display = plainMode ? 'inline-flex' : 'none';
        if (plainMode) hl.textContent = '';
    }

    if (!plainMode) renderHighlight();

    renderGutter();

    if (!plainMode && len <= MINIMAP_LIMIT) renderMinimap();
    else minimapEl.textContent = '';

    runDiagnostics();
    updateStats();

    // После правки текста позиции совпадений сдвигаются
    if (searchHits.length) {
        searchHits = collectHits(findTerm());
        if (searchIndex >= searchHits.length) searchIndex = searchHits.length - 1;
        const counter = statusEl && panel.querySelector('#vte-code-find-count');
        if (counter) {
            counter.textContent = searchHits.length
                ? `${Math.max(0, searchIndex) + 1}/${searchHits.length}`
                : '0/0';
        }
    }
    renderSearchOverlay();
    scheduleSync();
}


function renderHighlight() {
    hl.textContent = '';
    const frag = document.createDocumentFragment();
    for (const token of tokenize(ta.value)) {
        if (token.type === 'plain') {
            frag.appendChild(document.createTextNode(token.text));
        } else {
            frag.appendChild(h('span', { className: `vte-tk-${token.type}`, text: token.text }));
        }
    }
    frag.appendChild(document.createTextNode('\n'));
    hl.appendChild(frag);
}

function tokenize(src) {
    const rules = [
        ['comment',  /\/\*[\s\S]*?(?:\*\/|$)/y],
        ['string',   /"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?/y],
        ['atrule',   /@[\w-]+/y],
        ['variable', /--[\w-]+/y],
        ['function', /\b[\w-]+(?=\s*\()/y],
        ['important',/!important\b/y],
        ['color',    /#[0-9a-fA-F]{3,8}\b/y],
        ['number',   /-?\d*\.?\d+(?:px|em|rem|vw|vh|vmin|vmax|%|s|ms|deg|fr|ch|ex|pt)?\b/y],
        ['pseudo',   /::?[a-zA-Z][\w-]*/y],
        ['selectorid', /#[\w-]+/y],
        ['class',    /\.[\w-]+/y],
        ['attr',     /\[[^\]\n]*\]/y],
        ['punct',    /[{}();,>~+*]/y],
        ['operator', /[:=]/y],
        ['word',     /[\w-]+/y],
        ['space',    /\s+/y],
    ];

    const out = [];
    let i = 0;
    let inBlock = false;
    let afterColon = false;

    while (i < src.length) {
        let matched = false;

        for (const [type, re] of rules) {
            re.lastIndex = i;
            const m = re.exec(src);
            if (!m || m.index !== i) continue;

            const text = m[0];
            let kind = type;

            if (type === 'punct') {
                if (text === '{') { inBlock = true; afterColon = false; }
                if (text === '}') { inBlock = false; afterColon = false; }
                if (text === ';') afterColon = false;
            }
            if (type === 'operator' && text === ':' && inBlock) afterColon = true;
            if (type === 'word') kind = !inBlock ? 'tag' : (afterColon ? 'value' : 'property');
            if (type === 'space') kind = 'plain';

            out.push({ type: kind, text });
            i += text.length;
            matched = true;
            break;
        }

        if (!matched) {
            out.push({ type: 'plain', text: src[i] });
            i++;
        }
    }
    return out;
}

/* ============================================================
   НОМЕРА СТРОК
============================================================ */
function renderGutter() {
    const total = ta.value.split('\n').length;
    const existing = gutter.childElementCount;

    if (existing < total) {
        const frag = document.createDocumentFragment();
        for (let n = existing + 1; n <= total; n++) {
            frag.appendChild(h('div.vte-code-ln', {
                dataset: { line: String(n) },
                text: String(n),
                on: { click: () => revealLine(n) },
            }));
        }
        gutter.appendChild(frag);
    } else if (existing > total) {
        while (gutter.childElementCount > total) gutter.lastElementChild.remove();
    }

    markAutoBlockLines();
}

/** Подсветить синим номера строк авто-блока расширения */
function markAutoBlockLines() {
    gutter.querySelectorAll('.vte-code-ln-auto').forEach(el =>
        el.classList.remove('vte-code-ln-auto'));

    const src = ta.value;
    const s = src.indexOf(AUTO_START);
    if (s === -1) return;
    const e = src.indexOf(AUTO_END, s);

    const from = src.slice(0, s).split('\n').length;
    const to = e === -1
        ? src.split('\n').length
        : src.slice(0, e).split('\n').length;

    for (let n = from; n <= to; n++) {
        gutter.querySelector(`[data-line="${n}"]`)?.classList.add('vte-code-ln-auto');
    }
}

/* ============================================================
   МИНИКАРТА
============================================================ */
function renderMinimap() {
    const lines = ta.value.split('\n');
    minimapEl.textContent = '';
    const frag = document.createDocumentFragment();
    const step = Math.max(1, Math.ceil(lines.length / 300));

    for (let i = 0; i < lines.length; i += step) {
        const line = lines[i].trim();
        if (!line) { frag.appendChild(h('div.vte-mm-row')); continue; }

        let cls = 'vte-mm-row';
        if (line.startsWith('/*') || line.startsWith('*')) cls += ' vte-mm-comment';
        else if (line.startsWith('@')) cls += ' vte-mm-at';
        else if (line.startsWith('--')) cls += ' vte-mm-var';
        else if (line.includes('{')) cls += ' vte-mm-sel';
        else if (line.includes(':')) cls += ' vte-mm-decl';

        frag.appendChild(h(`div.${cls.split(' ').join('.')}`, {
            style: `width:${Math.min(100, 12 + line.length * 1.4)}%`,
            dataset: { line: String(i + 1) },
        }));
    }
    minimapEl.appendChild(frag);
}

function jumpFromMinimap(e) {
    const row = e.target.closest('[data-line]');
    if (row) revealLine(Number(row.dataset.line));
}

/* ============================================================
   ДИАГНОСТИКА
============================================================ */
function runDiagnostics() {
    const diag = statusEl.querySelector('#vte-code-diag');
    diag.textContent = '';

    if (ta.value.length > DIAG_LIMIT) {
        diag.classList.remove('vte-code-diag-bad');
        diag.append(icon('fa-circle-minus'), h('span', { text: ' Проверка отключена' }));
        problemsEl.style.display = 'none';
        problemsEl.textContent = '';
        return;
    }

    let errors = [];
    try { errors = onValidate(ta.value) || []; } catch { errors = []; }

    if (!errors.length) {
        diag.classList.remove('vte-code-diag-bad');
        diag.append(icon('fa-circle-check'), h('span', { text: ' Ошибок нет' }));
        problemsEl.style.display = 'none';
        problemsEl.textContent = '';
        highlightErrorLines([]);
        return;
    }

    diag.classList.add('vte-code-diag-bad');
    diag.append(
        icon('fa-triangle-exclamation'),
        h('span', { text: ` ${errors.length} ${plural(errors.length, 'проблема', 'проблемы', 'проблем')}` })
    );

    problemsEl.textContent = '';
    problemsEl.style.display = 'block';
    for (const err of errors.slice(0, 30)) {
        problemsEl.appendChild(h('div.vte-code-problem', {
            on: { click: () => err.line && revealLine(err.line) },
        }, [
            h('span.vte-code-problem-ic', {}, [icon('fa-triangle-exclamation')]),
            err.line ? h('span.vte-code-problem-line', { text: `стр. ${err.line}` }) : null,
            h('span.vte-code-problem-msg', { text: err.message }),
        ]));
    }
    highlightErrorLines(errors.map(e => e.line).filter(Boolean));
}

function highlightErrorLines(lines) {
    gutter.querySelectorAll('.vte-code-ln-error').forEach(el =>
        el.classList.remove('vte-code-ln-error'));
    for (const n of lines) {
        gutter.querySelector(`[data-line="${n}"]`)?.classList.add('vte-code-ln-error');
    }
}

/* ============================================================
   ПОИСК И ЗАМЕНА
============================================================ */
function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = `${Math.min(120, el.scrollHeight)}px`;
}

function toggleSearch(force) {
    const bar = panel.querySelector('#vte-code-search');
    const show = force === undefined ? bar.style.display === 'none' : !!force;
    bar.style.display = show ? 'flex' : 'none';

    if (show) {
        const input = bar.querySelector('#vte-code-find');
        const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
        if (sel) input.value = sel;
        autoGrow(input);
        autoGrow(bar.querySelector('#vte-code-replace'));
        input.focus();
        input.select();
        runSearch(0);
    } else {
        searchHits = [];
        searchIndex = -1;
        renderSearchOverlay();
        ta.focus();
    }
}

function findTerm() {
    const input = panel?.querySelector('#vte-code-find');
    return input ? input.value : '';
}

function replaceTerm() {
    const input = panel?.querySelector('#vte-code-replace');
    return input ? input.value : '';
}

/** Экранирует символы, чтобы строку можно было вставить в регулярное выражение */
function escapeRe(v) {
    return String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Собирает все совпадения: [{ start, end }] */
function collectHits(term) {
    const hits = [];
    if (!term) return hits;
    const hay = ta.value;

    const push = (re) => {
        let m;
        while ((m = re.exec(hay)) !== null) {
            if (m[0] === '') { re.lastIndex++; continue; }
            hits.push({ start: m.index, end: m.index + m[0].length });
            if (hits.length > 5000) break;
        }
    };

    // Запрос из нескольких строк: отступы в начале и конце строк
    // почти всегда отличаются от исходника, поэтому сравниваем без них
    if (!searchRegex && /\r?\n/.test(term)) {
        const lines = term.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '');
        if (!lines.length) return hits;
        try {
            push(new RegExp(
                lines.map(escapeRe).join('[ \\t]*\\r?\\n[ \\t]*'),
                searchCase ? 'g' : 'gi'
            ));
        } catch {}
        return hits;
    }

    if (searchRegex) {
        try { push(new RegExp(term, searchCase ? 'gm' : 'gim')); } catch {}
        return hits;
    }

    const source = searchCase ? hay : hay.toLowerCase();
    const needle = searchCase ? term : term.toLowerCase();
    let from = 0;
    while (true) {
        const idx = source.indexOf(needle, from);
        if (idx === -1) break;
        hits.push({ start: idx, end: idx + needle.length });
        from = idx + Math.max(1, needle.length);
        if (hits.length > 5000) break;
    }
    return hits;
}


function runSearch(direction) {
    const counter = panel.querySelector('#vte-code-find-count');
    const term = findTerm();

    searchHits = collectHits(term);

    if (!searchHits.length) {
        searchIndex = -1;
        counter.textContent = term ? '0/0' : '0/0';
        counter.classList.toggle('vte-code-find-none', !!term);
        renderSearchOverlay();
        return;
    }
    counter.classList.remove('vte-code-find-none');

    if (direction === 0) {
        const caret = ta.selectionStart;
        searchIndex = searchHits.findIndex(hh => hh.start >= caret);
        if (searchIndex === -1) searchIndex = 0;
    } else {
        searchIndex = (searchIndex + direction + searchHits.length) % searchHits.length;
    }

    counter.textContent = `${searchIndex + 1}/${searchHits.length}`;
    focusHit(searchIndex, direction !== 0);
    renderSearchOverlay();
}

/** Показать совпадение. keepFocus=false — фокус остаётся в поле поиска */
function focusHit(i, moveCaret) {
    const hit = searchHits[i];
    if (!hit) return;

    ta.setSelectionRange(hit.start, hit.end);
    caretPos = hit.start;

    const line = ta.value.slice(0, hit.start).split('\n').length;
    ta.scrollTop = Math.max(0, (line - 1) * lineHeight() - ta.clientHeight / 2);

    if (moveCaret) {
        // Выделение в textarea видно только при фокусе, поэтому
        // возвращаем фокус в поле поиска сразу после прокрутки
        const input = panel.querySelector('#vte-code-find');
        requestAnimationFrame(() => input?.focus());
    }
    scheduleSync();
    updateCursor();
}

function replaceCurrent() {
    if (readOnly) return;
    if (!searchHits.length || searchIndex < 0) { runSearch(0); return; }

    flushSnapshot();

    const hit = searchHits[searchIndex];
    let insert = replaceTerm();

    if (searchRegex) {
        // Поддержка $1, $2 в замене
        try {
            const re = new RegExp(findTerm(), searchCase ? '' : 'i');
            const chunk = ta.value.slice(hit.start, hit.end);
            insert = chunk.replace(re, replaceTerm());
        } catch {}
    }

    ta.value = ta.value.slice(0, hit.start) + insert + ta.value.slice(hit.end);
    const after = hit.start + insert.length;
    ta.setSelectionRange(after, after);
    caretPos = after;

    handleInput();
    flushSnapshot();

    const keep = searchIndex;
    runSearch(0);
    if (searchHits.length) {
        searchIndex = Math.min(keep, searchHits.length - 1);
        panel.querySelector('#vte-code-find-count').textContent =
            `${searchIndex + 1}/${searchHits.length}`;
        renderSearchOverlay();
    }
    flashStatus('Заменено');
}

function replaceAll() {
    if (readOnly) return;
    const term = findTerm();
    if (!term) return;

    const hits = collectHits(term);
    if (!hits.length) { flashStatus('Совпадений нет'); return; }

    flushSnapshot();

    const insert = replaceTerm();
    let out = '';
    let last = 0;

    for (const hit of hits) {
        out += ta.value.slice(last, hit.start);
        if (searchRegex) {
            try {
                const re = new RegExp(term, searchCase ? '' : 'i');
                out += ta.value.slice(hit.start, hit.end).replace(re, insert);
            } catch {
                out += insert;
            }
        } else {
            out += insert;
        }
        last = hit.end;
    }
    out += ta.value.slice(last);

    const scroll = ta.scrollTop;
    ta.value = out;
    ta.scrollTop = scroll;

    handleInput();
    flushSnapshot();
    runSearch(0);
    flashStatus(`Заменено: ${hits.length}`);
}

/** Подсветка всех совпадений слоем под текстом */
function renderSearchOverlay() {
    if (!searchLayer) return;
    searchLayer.textContent = '';

    if (!searchHits.length || ta.value.length > SEARCH_OVERLAY_LIMIT) return;

    const frag = document.createDocumentFragment();
    let last = 0;

    searchHits.forEach((hit, i) => {
        if (hit.start > last) {
            frag.appendChild(document.createTextNode(ta.value.slice(last, hit.start)));
        }
        const mark = h('span.vte-code-hit', { text: ta.value.slice(hit.start, hit.end) });
        if (i === searchIndex) mark.classList.add('vte-code-hit-current');
        frag.appendChild(mark);
        last = hit.end;
    });

    if (last < ta.value.length) {
        frag.appendChild(document.createTextNode(ta.value.slice(last)));
    }
    frag.appendChild(document.createTextNode('\n'));
    searchLayer.appendChild(frag);
    syncScroll();
}


/* ============================================================
   ФОРМАТИРОВАНИЕ
============================================================ */
function format() {
    if (readOnly) return;
    flushSnapshot();
    const src = ta.value;
    const out = [];
    let depth = 0;
    let i = 0;
    let buf = '';

    const flush = () => {
        const t = buf.trim();
        buf = '';
        if (t) out.push(TAB.repeat(Math.max(0, depth)) + t);
    };

    while (i < src.length) {
        const ch = src[i];

        if (ch === '/' && src[i + 1] === '*') {
            const end = src.indexOf('*/', i + 2);
            const stop = end === -1 ? src.length : end + 2;
            flush();
            out.push(TAB.repeat(Math.max(0, depth)) + src.slice(i, stop).trim());
            i = stop;
            while (src[i] === '\n' || src[i] === '\r') i++;
            continue;
        }
        if (ch === '"' || ch === "'") {
            const quote = ch;
            buf += ch;
            i++;
            while (i < src.length) {
                buf += src[i];
                if (src[i] === '\\') { buf += src[i + 1] || ''; i += 2; continue; }
                if (src[i] === quote) { i++; break; }
                i++;
            }
            continue;
        }
        if (ch === '{') { buf += ' {'; flush(); depth++; i++; continue; }
        if (ch === '}') {
            flush();
            depth = Math.max(0, depth - 1);
            out.push(TAB.repeat(depth) + '}');
            if (depth === 0) out.push('');
            i++;
            continue;
        }
        if (ch === ';') { buf += ';'; flush(); i++; continue; }
        if (ch === '\n' || ch === '\r') { if (!buf.trim()) buf = ''; i++; continue; }
        buf += ch;
        i++;
    }
    flush();

    ta.value = out
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\s+;/g, ';')
        .replace(/:\s+/g, ': ')
        .trimEnd() + '\n';

    handleInput();
    flashStatus('Отформатировано');
}
/* ============================================================
   ЛОКАЛЬНАЯ ИСТОРИЯ ПАНЕЛИ КОДА
============================================================ */
function scheduleSnapshot() {
    clearTimeout(snapTimer);
    snapTimer = setTimeout(flushSnapshot, SNAP_DEBOUNCE);
}

/** Сохранить предыдущее устойчивое состояние как шаг истории */
function flushSnapshot() {
    clearTimeout(snapTimer);
    if (!ta) return;
    if (ta.value === lastSnapshot) return;

    if (lastSnapshot !== '') {
        undoStack.push({ value: lastSnapshot, pos: lastSnapPos, scroll: ta.scrollTop });
        if (undoStack.length > HISTORY_MAX) undoStack.shift();
        redoStack.length = 0;
    }
    lastSnapshot = ta.value;
    lastSnapPos = ta.selectionStart;
    updateHistoryBtns();
}

/** Изменение пришло не из textarea, а извне */
function noteExternalChange(next) {
    clearTimeout(snapTimer);
    if (next === lastSnapshot) return;

    if (lastSnapshot !== '') {
        undoStack.push({ value: lastSnapshot, pos: lastSnapPos, scroll: ta ? ta.scrollTop : 0 });
        if (undoStack.length > HISTORY_MAX) undoStack.shift();
        redoStack.length = 0;
    }
    lastSnapshot = next;
    lastSnapPos = ta ? Math.min(caretPos, next.length) : 0;
    updateHistoryBtns();
}

function localUndo() {
    if (!ta) return;
    flushSnapshot();
    if (!undoStack.length) {
        flashStatus('Отменять больше нечего');
        return;
    }
    redoStack.push({ value: ta.value, pos: ta.selectionStart, scroll: ta.scrollTop });
    applyHistoryEntry(undoStack.pop());
    flashStatus('Отменено');
}

function localRedo() {
    if (!ta) return;
    if (!redoStack.length) {
        flashStatus('Возвращать нечего');
        return;
    }
    undoStack.push({ value: ta.value, pos: ta.selectionStart, scroll: ta.scrollTop });
    applyHistoryEntry(redoStack.pop());
    flashStatus('Возвращено');
}

function applyHistoryEntry(entry) {
    const prevScroll = ta.scrollTop;

    ta.value = entry.value;
    currentValue = entry.value;
    lastSnapshot = entry.value;

    const p = Math.min(entry.pos || 0, entry.value.length);
    lastSnapPos = p;
    caretPos = p;

    ta.focus();
    ta.setSelectionRange(p, p);

    // Прокрутку возвращаем дважды: сразу и после пересчёта высоты браузером,
    // иначе значение сбрасывается и текст прыгает в начало.
    const wanted = entry.scroll != null ? entry.scroll : prevScroll;
    ta.scrollTop = wanted;
    requestAnimationFrame(() => {
        ta.scrollTop = wanted;
        ensureCaretVisible();
        syncScroll();
    });

    scheduleRender(0);
    updateCursor();
    updateHistoryBtns();

    clearTimeout(changeTimer);
    onCodeChange(currentValue);
    markDirty(false);
}

/** Подкрутить вид, только если каретка ушла за границы окна */
function ensureCaretVisible() {
    if (!ta) return;
    const lh = lineHeight();
    const line = ta.value.slice(0, ta.selectionStart).split('\n').length - 1;
    const top = line * lh;
    const viewTop = ta.scrollTop;
    const viewBottom = viewTop + ta.clientHeight;

    if (top < viewTop + lh) {
        ta.scrollTop = Math.max(0, top - lh * 2);
    } else if (top > viewBottom - lh * 2) {
        ta.scrollTop = top - ta.clientHeight + lh * 3;
    }
}

function updateHistoryBtns() {
    if (undoBtn) undoBtn.disabled = undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = redoStack.length === 0;
}

/** Сбросить историю: нужно при полной перезагрузке темы */
export function resetHistory() {
    undoStack = [];
    redoStack = [];
    lastSnapshot = ta ? ta.value : '';
    updateHistoryBtns();
}

/* ============================================================
   ПРОЧИЕ ДЕЙСТВИЯ
============================================================ */
function copyAll() {
    navigator.clipboard?.writeText(ta.value)
        .then(() => flashStatus('Скопировано в буфер'))
        .catch(() => flashStatus('Не удалось скопировать'));
}

function toggleWrap() {
    wrapLines = !wrapLines;
    panel.classList.toggle('vte-code-wrap', wrapLines);
    ta.wrap = wrapLines ? 'soft' : 'off';
    renderSearchOverlay();
    flashStatus(wrapLines ? 'Перенос строк включён' : 'Перенос строк выключен');
    scheduleSync();
}

function toggleCollapse() {
    panel.classList.toggle('vte-code-collapsed');
}

function markDirty(v) {
    const dot = panel?.querySelector('#vte-code-dirty');
    if (dot) dot.textContent = v ? '●' : '';
}

function flashStatus(text) {
    const el = statusEl?.querySelector('#vte-code-stats');
    if (!el) return;
    el.textContent = text;
    el.classList.add('vte-code-flash');
    clearTimeout(flashStatus._t);
    flashStatus._t = setTimeout(() => {
        el.classList.remove('vte-code-flash');
        updateStats();
    }, 1600);
}

function updateStats() {
    const el = statusEl?.querySelector('#vte-code-stats');
    if (!el || el.classList.contains('vte-code-flash')) return;
    const lines = ta.value.split('\n').length;
    const kb = (ta.value.length / 1024).toFixed(1);
    el.textContent = `${lines} ${plural(lines, 'строка', 'строки', 'строк')} · ${kb} КБ`;
}

function updateCursor() {
    if (ta) caretPos = ta.selectionStart;
    const el = statusEl?.querySelector('#vte-code-pos');
    if (!el) return;
    const upto = ta.value.slice(0, ta.selectionStart);
    const line = upto.split('\n').length;
    const col = ta.selectionStart - (upto.lastIndexOf('\n') + 1) + 1;
    const selLen = ta.selectionEnd - ta.selectionStart;
    el.textContent = selLen
        ? `Стр ${line}, Кол ${col} (выделено ${selLen})`
        : `Стр ${line}, Кол ${col}`;

    gutter.querySelectorAll('.vte-code-ln-active').forEach(n =>
        n.classList.remove('vte-code-ln-active'));
    gutter.querySelector(`[data-line="${line}"]`)?.classList.add('vte-code-ln-active');
}

/* ============================================================
   СИНХРОНИЗАЦИЯ СКРОЛЛА
============================================================ */
function scheduleSync() {
    if (syncScheduled) return;
    syncScheduled = true;
    requestAnimationFrame(() => {
        syncScheduled = false;
        syncScroll();
    });
}

function syncScroll() {
    if (!ta) return;
    if (!plainMode) {
        hl.scrollTop = ta.scrollTop;
        hl.scrollLeft = ta.scrollLeft;
    }
    if (searchLayer) {
        searchLayer.scrollTop = ta.scrollTop;
        searchLayer.scrollLeft = ta.scrollLeft;
    }
    gutter.scrollTop = ta.scrollTop;

    const ratio = ta.scrollHeight > ta.clientHeight
        ? ta.scrollTop / (ta.scrollHeight - ta.clientHeight)
        : 0;
    const maxShift = Math.max(0, minimapEl.scrollHeight - minimapEl.clientHeight);
    minimapEl.scrollTop = ratio * maxShift;
}

function lineHeight() {
    const v = parseFloat(getComputedStyle(ta).lineHeight);
    return Number.isFinite(v) ? v : 18;
}

/* ============================================================
   ПЕРЕТАСКИВАНИЕ И РАЗМЕР
============================================================ */
function makeDraggable(box, handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, active = false;

    handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.vte-code-btn')) return;
        active = true;
        const r = box.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
        box.style.right = 'auto';
        box.style.bottom = 'auto';
        box.style.left = `${ox}px`;
        box.style.top = `${oy}px`;
        handle.setPointerCapture(e.pointerId);
        box.classList.add('vte-dragging');
    });

    handle.addEventListener('pointermove', (e) => {
        if (!active) return;
        const nx = Math.max(0, Math.min(window.innerWidth - 80, ox + e.clientX - sx));
        const ny = Math.max(0, Math.min(window.innerHeight - 40, oy + e.clientY - sy));
        box.style.left = `${nx}px`;
        box.style.top = `${ny}px`;
    });

    const stop = () => { active = false; box.classList.remove('vte-dragging'); };
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
}

function makeResizable(box) {
    const grip = h('div.vte-code-resize', {}, [icon('fa-grip-lines-vertical')]);
    box.appendChild(grip);

    let sw = 0, sh = 0, sx = 0, sy = 0, active = false;

    grip.addEventListener('pointerdown', (e) => {
        active = true;
        const r = box.getBoundingClientRect();
        sw = r.width; sh = r.height; sx = e.clientX; sy = e.clientY;
        grip.setPointerCapture(e.pointerId);
        e.preventDefault();
    });

    grip.addEventListener('pointermove', (e) => {
        if (!active) return;
        box.style.width = `${Math.max(340, sw + e.clientX - sx)}px`;
        box.style.height = `${Math.max(220, sh + e.clientY - sy)}px`;
        scheduleSync();
    });

    const stop = () => { active = false; };
    grip.addEventListener('pointerup', stop);
    grip.addEventListener('pointercancel', stop);
}

function shield(el) {
    ['mousedown', 'touchstart', 'pointerdown', 'click'].forEach(type =>
        el.addEventListener(type, (e) => e.stopPropagation()));
}

/* ============================================================
   УТИЛИТЫ
============================================================ */
function plural(n, one, few, many) {
    const mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
}
