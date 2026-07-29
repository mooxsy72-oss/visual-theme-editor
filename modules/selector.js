// modules/selector.js
// Режим выбора элемента: подсветка под курсором, метка с тегом/классами,
// визуализация padding/margin, клик — выбор, колесо с Alt — переход по родителям.

let onElementSelected = null;
let onHover = null;
let onStateChange = null;   // сообщает наружу: выбор включён / выключен

let active = false;
let box = null;              // рамка подсветки
let padBox = null;           // область padding
let marginBox = null;        // область margin
let label = null;            // метка с описанием элемента
let sizeTag = null;          // размеры в px
let hint = null;             // подсказка внизу экрана

let hovered = null;
let locked = null;           // выбранный элемент (остаётся подсвечен)
let highlightColor = '#4ea1ff';
let raf = null;
let lastEvent = null;

/* ============================================================
   ИНИЦИАЛИЗАЦИЯ
============================================================ */
export function init(options = {}) {
    onElementSelected = options.onElementSelected || (() => {});
    onHover = options.onHover || (() => {});
    onStateChange = options.onStateChange || (() => {});
    if (options.highlightColor) highlightColor = options.highlightColor;
    build();
}

export function setHighlightColor(color) {
    if (!color) return;
    highlightColor = color;
    if (!box) return;
    box.style.borderColor = color;
    box.style.boxShadow = `0 0 0 1px ${withAlpha(color, 0.35)}, 0 0 14px ${withAlpha(color, 0.45)}`;
    box.style.background = withAlpha(color, 0.08);
    label.style.background = color;
    label.style.color = pickTextColor(color);
}

export function activate() {
    if (active) return;
    active = true;

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('wheel', onWheel, { capture: true, passive: false });
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', scheduleRefresh, true);
    window.addEventListener('resize', scheduleRefresh);

    document.body.classList.add('vte-picking');
    showHint(true);
    onStateChange(true);
}

export function deactivate() {
    if (!active) return;
    active = false;

    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('wheel', onWheel, { capture: true });
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', scheduleRefresh, true);
    window.removeEventListener('resize', scheduleRefresh);

    document.body.classList.remove('vte-picking');
    hide();
    showHint(false);
    hovered = null;
    onStateChange(false);
}

export function isActive() {
    return active;
}


/** Подсветить элемент программно (например при выборе через хлебные крошки) */
export function lock(element) {
    locked = element || null;
    if (locked) {
        draw(locked, true);
    } else {
        hide();
    }
}

export function getHovered() {
    return hovered;
}

/* ============================================================
   ПОСТРОЕНИЕ ОВЕРЛЕЕВ
============================================================ */
function build() {
    if (box) return;

    marginBox = mkLayer('vte-pick-margin');
    padBox = mkLayer('vte-pick-padding');
    box = mkLayer('vte-pick-box');

    label = mkLayer('vte-pick-label');
    sizeTag = mkLayer('vte-pick-size');

    hint = mkLayer('vte-pick-hint');
    hint.appendChild(document.createTextNode(''));
    renderHint();

    for (const node of [marginBox, padBox, box, label, sizeTag, hint]) {
        node.style.display = 'none';
        document.body.appendChild(node);
    }

    setHighlightColor(highlightColor);
}

function mkLayer(className) {
    const node = document.createElement('div');
    node.className = className;
    node.style.position = 'absolute';
    node.style.pointerEvents = 'none';
    node.style.zIndex = className === 'vte-pick-hint' ? '2147483646' : '2147483640';
    return node;
}

function renderHint() {
    hint.textContent = '';
    const rows = [
        ['Клик', 'выбрать элемент'],
        ['Alt + колесо', 'родитель / потомок'],
        ['Esc', 'выйти из режима'],
    ];
    for (const [key, text] of rows) {
        const row = document.createElement('span');
        row.className = 'vte-pick-hint-row';

        const kbd = document.createElement('kbd');
        kbd.textContent = key;

        const desc = document.createElement('span');
        desc.textContent = text;

        row.append(kbd, desc);
        hint.appendChild(row);
    }
}

function showHint(v) {
    if (hint) hint.style.display = v ? 'flex' : 'none';
}

/* ============================================================
   СОБЫТИЯ
============================================================ */
function onMove(e) {
    if (!active) return;
    lastEvent = e;

    const target = resolveTarget(e.target);
    if (!target) { hide(); hovered = null; return; }

    if (target === hovered) return;
    hovered = target;
    draw(target, false);
    onHover(target);
}

function onClick(e) {
    if (!active) return;
    const target = resolveTarget(e.target);
    if (!target) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    locked = target;
    draw(target, true);
    onElementSelected(target);
}

function onWheel(e) {
    if (!active || !e.altKey) return;
    e.preventDefault();
    e.stopPropagation();

    const base = hovered || locked;
    if (!base) return;

    if (e.deltaY < 0) {
        // Вверх по дереву
        const parent = base.parentElement;
        if (parent && parent !== document.documentElement && !isOurs(parent)) {
            hovered = parent;
            draw(parent, false);
            onHover(parent);
        }
    } else {
        // Вниз: первый подходящий потомок под курсором
        const child = childUnderCursor(base);
        if (child) {
            hovered = child;
            draw(child, false);
            onHover(child);
        }
    }
}

function onKey(e) {
    if (!active) return;
    if (e.key === 'Escape') {
        e.preventDefault();
        deactivate();
    }
}

function childUnderCursor(parent) {
    if (!lastEvent) return parent.firstElementChild;
    const { clientX: x, clientY: y } = lastEvent;
    for (const child of parent.children) {
        if (isOurs(child)) continue;
        const r = child.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return child;
    }
    return Array.from(parent.children).find(c => !isOurs(c)) || null;
}

/* ============================================================
   ОТРИСОВКА
============================================================ */
function scheduleRefresh() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
        raf = null;
        const t = locked && !active ? locked : hovered || locked;
        if (t && document.contains(t)) draw(t, t === locked);
        else hide();
    });
}

function draw(target, isLocked) {
    const rect = target.getBoundingClientRect();
    if (!rect.width && !rect.height) { hide(); return; }

    const cs = getComputedStyle(target);
    const sx = window.scrollX;
    const sy = window.scrollY;

    /* --- Margin --- */
    const mt = parseFloat(cs.marginTop) || 0;
    const mr = parseFloat(cs.marginRight) || 0;
    const mb = parseFloat(cs.marginBottom) || 0;
    const ml = parseFloat(cs.marginLeft) || 0;

    if (mt || mr || mb || ml) {
        place(marginBox, {
            left: rect.left + sx - ml,
            top: rect.top + sy - mt,
            width: rect.width + ml + mr,
            height: rect.height + mt + mb,
        });
        marginBox.style.display = 'block';
    } else {
        marginBox.style.display = 'none';
    }

    /* --- Основная рамка --- */
    place(box, {
        left: rect.left + sx,
        top: rect.top + sy,
        width: rect.width,
        height: rect.height,
    });
    box.style.display = 'block';
    box.style.borderStyle = isLocked ? 'solid' : 'dashed';
    box.style.borderWidth = isLocked ? '2px' : '1px';

    /* --- Padding --- */
    const pt = parseFloat(cs.paddingTop) || 0;
    const pr = parseFloat(cs.paddingRight) || 0;
    const pb = parseFloat(cs.paddingBottom) || 0;
    const pl = parseFloat(cs.paddingLeft) || 0;

    if (pt || pr || pb || pl) {
        place(padBox, {
            left: rect.left + sx + pl,
            top: rect.top + sy + pt,
            width: Math.max(0, rect.width - pl - pr),
            height: Math.max(0, rect.height - pt - pb),
        });
        padBox.style.display = 'block';
    } else {
        padBox.style.display = 'none';
    }

    /* --- Метка --- */
    label.textContent = describe(target);
    label.style.display = 'block';

    const labelRect = label.getBoundingClientRect();
    let labelTop = rect.top + sy - labelRect.height - 4;
    let labelLeft = rect.left + sx;

    if (labelTop < sy + 2) labelTop = rect.bottom + sy + 4;
    if (labelLeft + labelRect.width > sx + window.innerWidth - 4) {
        labelLeft = Math.max(sx + 4, sx + window.innerWidth - labelRect.width - 4);
    }
    label.style.left = `${Math.round(labelLeft)}px`;
    label.style.top = `${Math.round(labelTop)}px`;

    /* --- Размеры --- */
    sizeTag.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
    sizeTag.style.display = 'block';
    const sizeRect = sizeTag.getBoundingClientRect();
    sizeTag.style.left = `${Math.round(rect.right + sx - sizeRect.width - 4)}px`;
    sizeTag.style.top = `${Math.round(rect.bottom + sy + 4)}px`;
}

function place(node, r) {
    node.style.left = `${Math.round(r.left)}px`;
    node.style.top = `${Math.round(r.top)}px`;
    node.style.width = `${Math.round(r.width)}px`;
    node.style.height = `${Math.round(r.height)}px`;
}

function hide() {
    for (const node of [box, padBox, marginBox, label, sizeTag]) {
        if (node) node.style.display = 'none';
    }
}

/* ============================================================
   ОПИСАНИЕ ЭЛЕМЕНТА
============================================================ */
function describe(node) {
    let out = node.tagName.toLowerCase();
    if (node.id) out += `#${node.id}`;

    const classes = Array.from(node.classList)
        .filter(c => !c.startsWith('vte-'))
        .slice(0, 3);
    if (classes.length) out += '.' + classes.join('.');

    // Полезные атрибуты SillyTavern
    const isUser = node.getAttribute?.('is_user');
    if (isUser != null) out += `[is_user="${isUser}"]`;

    const chName = node.getAttribute?.('ch_name');
    if (chName) out += ` (${chName})`;

    return out;
}

/* ============================================================
   ФИЛЬТРАЦИЯ ЦЕЛЕЙ
============================================================ */
function resolveTarget(node) {
    if (!node) return null;
    if (node.nodeType === 3) node = node.parentElement;
    if (!node || node.nodeType !== 1) return null;
    if (node === document.documentElement) return null;
    if (isOurs(node)) return null;
    return node;
}

/** Элементы самого редактора и знакомых оверлеев выбирать нельзя */
function isOurs(node) {
    if (!node || node.nodeType !== 1) return false;
    if (typeof node.closest !== 'function') return false;

    const ownSelectors = [
        '#vte-inspector-panel',
        '#vte-code-panel',
        '#vte-colorpicker',
        '#vte-settings',
        '.vte-pick-box',
        '.vte-pick-label',
        '.vte-pick-size',
        '.vte-pick-hint',
        '.vte-pick-padding',
        '.vte-pick-margin',
    ];

    for (const s of ownSelectors) {
        if (node.closest(s)) return true;
    }
    // toastr-уведомления и сам класс-маркер
    if (node.closest('#toast-container')) return true;
    if ((node.className || '').toString().includes('vte-')) return true;
    return false;
}

/* ============================================================
   ЦВЕТОВЫЕ УТИЛИТЫ
============================================================ */
function withAlpha(color, a) {
    const p = parseColor(color);
    if (!p) return `rgba(78, 161, 255, ${a})`;
    return `rgba(${p.r}, ${p.g}, ${p.b}, ${a})`;
}

function pickTextColor(color) {
    const p = parseColor(color);
    if (!p) return '#ffffff';
    // Относительная яркость: тёмный текст на светлой рамке и наоборот
    const lum = (0.299 * p.r + 0.587 * p.g + 0.114 * p.b) / 255;
    return lum > 0.6 ? '#101214' : '#ffffff';
}

function parseColor(v) {
    const s = String(v || '').trim();

    let m = s.match(/^#([0-9a-f]{3,8})$/i);
    if (m) {
        let hex = m[1];
        if (hex.length === 3 || hex.length === 4) hex = hex.split('').map(c => c + c).join('');
        return {
            r: parseInt(hex.slice(0, 2), 16),
            g: parseInt(hex.slice(2, 4), 16),
            b: parseInt(hex.slice(4, 6), 16),
        };
    }

    m = s.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
        const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
        return { r: p[0] || 0, g: p[1] || 0, b: p[2] || 0 };
    }
    return null;
}
