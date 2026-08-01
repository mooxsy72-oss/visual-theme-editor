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
let hintTimer = null;


// Цель выбрана вручную через Alt+колесо. Пока флаг поднят, клик берёт
// именно её, а не самый глубокий элемент под курсором: иначе прокрутка
// к родителю не имела смысла — клик возвращал прежний узкий селектор.
let manual = false;
let manualAt = null;         // где стоял курсор в момент прокрутки
const MANUAL_RELEASE = 8;    // px: насколько надо увести мышь, чтобы отпустить

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
    clearManual();

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
    clearManual();

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

/* ---------- Ручной выбор через Alt+колесо ---------- */
function markManual(target, e) {
    manual = true;
    manualAt = e ? { x: e.clientX, y: e.clientY } : manualAt;
    hovered = target;
    draw(target, false);
    box?.classList.add('vte-pick-manual');
    // Подписываем, что цель зафиксирована — иначе непонятно,
    // почему подсветка не бегает за курсором
    if (label) label.textContent = describe(target) + ' · зафиксирован';
    onHover(target);
}

function clearManual() {
    manual = false;
    manualAt = null;
    box?.classList.remove('vte-pick-manual');
}

/** Мышь уехала достаточно далеко, чтобы отпустить ручную цель */
function movedAway(e) {
    if (!manualAt) return true;
    return Math.abs(e.clientX - manualAt.x) > MANUAL_RELEASE
        || Math.abs(e.clientY - manualAt.y) > MANUAL_RELEASE;
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
        ['Клик', 'выбрать подсвеченное'],
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
    if (!hint) return;
    clearTimeout(hintTimer);
    hintTimer = null;
    hint.style.transition = '';
    hint.style.opacity = '1';
    if (v) {
        hint.style.display = 'flex';
        hintTimer = setTimeout(() => {
            hint.style.transition = 'opacity 0.7s ease';
            hint.style.opacity = '0';
            hintTimer = setTimeout(() => {
                hint.style.display = 'none';
                hint.style.transition = '';
                hint.style.opacity = '1';
            }, 700);
        }, 5000);
    } else {
        hint.style.display = 'none';
    }
}


/**
 * Курсор над панелями самого редактора. Пока он там, прицел молчит:
 * иначе клик по вкладке или ползунку глотался, и заново выбирался
 * прошлый элемент — из-за этого сбрасывалась незаписанная иконка.
 */
function overOurUI(node) {
    if (!node) return false;
    if (node.nodeType === 3) node = node.parentElement;
    if (!node || node.nodeType !== 1) return false;
    return isOurs(node);
}

function onMove(e) {
    if (!active) return;

    if (overOurUI(e.target)) {
        hide();
        hovered = null;
        clearManual();
        return;
    }

    lastEvent = e;

    if (manual) {
        if (!movedAway(e)) return;
        clearManual();
    }

    // Угловая зона: курсор в верхнем левом или правом углу → body
    const cornerTarget = getCornerTarget(e.clientX, e.clientY);
    if (cornerTarget) {
        if (hovered === cornerTarget && box.style.display !== 'none') return;
        hovered = cornerTarget;
        draw(cornerTarget, false);
        onHover(cornerTarget);
        return;
    }

    const target = pickAt(e.clientX, e.clientY, e.target);
    if (!target) { hide(); hovered = null; return; }

    if (target === hovered && box.style.display !== 'none') return;
    hovered = target;
    draw(target, false);
    onHover(target);
}

function onClick(e) {
    if (!active) return;

    if (overOurUI(e.target)) return;

    // Угловая зона имеет приоритет над обычным деревом
    const cornerTarget = getCornerTarget(e.clientX, e.clientY);
    const target = cornerTarget
        || (manual && hovered
            ? hovered
            : (pickAt(e.clientX, e.clientY, e.target) || hovered));
    if (!target) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    clearManual();
    locked = target;
    draw(target, true);
    onElementSelected(target);
}

/* ============================================================
   ПОИСК ЭЛЕМЕНТА ПОД КУРСОРОМ

   Порядок строгий и важен:
   1. Точное попадание в точку курсора — самый глубокий элемент,
      который реально принимает клики. Это и есть узкая цель.
   2. Только если точного попадания нет, щупаем точки вокруг:
      кромки, отступы, схлопнутые элементы.

   Ключевая тонкость: elementsFromPoint отдаёт ВСЕ слои под точкой,
   включая декоративные с pointer-events: none. Кликнуть по ним
   нельзя, целью они быть не могут — иначе вместо иконки выделяется
   полупрозрачная подложка во весь блок.
============================================================ */

// Кольцо проб: используется ТОЛЬКО когда в самой точке ничего нет
const PROBE_OFFSETS = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [2, 2], [-2, 2], [2, -2], [-2, -2],
    [4, 0], [-4, 0], [0, 4], [0, -4],
    [6, 6], [-6, 6], [6, -6], [-6, -6],
];

function pickAt(x, y, fallbackNode) {
    // 1. Точное попадание — приоритет всегда за ним
    const exact = exactAt(x, y);
    if (exact) return exact;

    // 2. То, что назвал сам браузер
    const fb = resolveTarget(fallbackNode);
    if (fb) return fb;

    // 3. Щупаем вокруг: кромки и нулевые элементы
    for (const [dx, dy] of PROBE_OFFSETS) {
        const hit = exactAt(x + dx, y + dy);
        if (hit) return hit;
    }
    return null;
}

/** Самый глубокий элемент в точке, который может быть целью клика */
function exactAt(x, y) {
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return null;

    for (const node of stackAt(x, y)) {
        if (isClickThrough(node)) continue;   // декоративный слой, не цель
        return node;
    }
    return null;
}

/** Стопка элементов под точкой, сверху вниз, без наших оверлеев */
function stackAt(x, y) {
    let list = [];
    if (typeof document.elementsFromPoint === 'function') {
        list = document.elementsFromPoint(x, y) || [];
    } else {
        const one = document.elementFromPoint(x, y);
        if (one) list = [one];
    }

    const out = [];
    for (const node of list) {
        const ok = resolveTarget(node);
        if (ok && !out.includes(ok)) out.push(ok);
    }
    return out;
}

/**
 * Слой, сквозь который проходят клики. Браузер такой элемент целью
 * не считает, значит и нам он не нужен: под ним лежит то, что видит
 * и во что тычет человек.
 */
function isClickThrough(node) {
    try {
        return getComputedStyle(node).pointerEvents === 'none';
    } catch {
        return false;
    }
}

function onWheel(e) {
    if (!active || !e.altKey) return;

    // Внутри панели колесо должно прокручивать список свойств
    if (overOurUI(e.target)) return;

    e.preventDefault();
    e.stopPropagation();

    const base = hovered || locked;
    if (!base) return;

    if (e.deltaY < 0) {
        // Вверх по дереву
        const parent = base.parentElement;
        if (parent && parent !== document.documentElement && !isOurs(parent)) {
            markManual(parent, e);
        }
    } else {
        // Вниз: первый подходящий потомок под курсором
        const child = childUnderCursor(base);
        if (child) markManual(child, e);
    }
}

function onKey(e) {
    if (!active) return;
    if (e.key === 'Escape') {
        // Курсор в полях панели: Esc там закрывает пикер цвета,
        // а не режим выбора целиком
        if (overOurUI(document.activeElement)) return;
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
   УГЛОВЫЕ ЗОНЫ — ВЫБОР ОБЩЕГО ФОНА (body)

   Верхние углы экрана (top × side px) → возвращают document.body.
   Ширину и высоту зон меняй здесь:
============================================================ */
const BODY_ZONE = { top: 72, side: 140 };

function getCornerTarget(x, y) {
    if (y > BODY_ZONE.top) return null;
    if (x <= BODY_ZONE.side || x >= window.innerWidth - BODY_ZONE.side) {
        return document.body;
    }
    return null;
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
    const raw = target.getBoundingClientRect();
    const cs = getComputedStyle(target);
    const sx = window.scrollX;
    const sy = window.scrollY;

    // Элемент может быть схлопнут в нуль — например пустой ::after-контейнер.
    // Такой всё равно нужно уметь выбрать, поэтому рисуем метку минимального
    // размера в его позиции, а размеры честно показываем как есть.
    const ghost = raw.width < 1 || raw.height < 1;
    let base = raw;

    if (ghost) {
        let left = raw.left;
        let top = raw.top;

        // Совсем нет позиции — берём точку от родителя, иначе рамка уедет в угол
        if (!raw.left && !raw.top && !raw.width && !raw.height) {
            const host = target.parentElement?.getBoundingClientRect();
            if (!host || (!host.width && !host.height)) { hide(); return; }
            left = host.left;
            top = host.top;
        }

        const w = Math.max(raw.width, 10);
        const h = Math.max(raw.height, 10);
        base = { left, top, width: w, height: h, right: left + w, bottom: top + h };
    }

    /* --- Margin --- */
    const mt = parseFloat(cs.marginTop) || 0;
    const mr = parseFloat(cs.marginRight) || 0;
    const mb = parseFloat(cs.marginBottom) || 0;
    const ml = parseFloat(cs.marginLeft) || 0;

    if (!ghost && (mt || mr || mb || ml)) {
        place(marginBox, {
            left: base.left + sx - ml,
            top: base.top + sy - mt,
            width: base.width + ml + mr,
            height: base.height + mt + mb,
        });
        marginBox.style.display = 'block';
    } else {
        marginBox.style.display = 'none';
    }

    /* --- Основная рамка --- */
    place(box, {
        left: base.left + sx,
        top: base.top + sy,
        width: base.width,
        height: base.height,
    });
    box.style.display = 'block';
    box.style.borderStyle = ghost ? 'dotted' : (isLocked ? 'solid' : 'dashed');
    box.style.borderWidth = isLocked ? '2px' : '1px';
    box.classList.toggle('vte-pick-ghost', ghost);

    /* --- Padding --- */
    const pt = parseFloat(cs.paddingTop) || 0;
    const pr = parseFloat(cs.paddingRight) || 0;
    const pb = parseFloat(cs.paddingBottom) || 0;
    const pl = parseFloat(cs.paddingLeft) || 0;

    if (!ghost && (pt || pr || pb || pl)) {
        place(padBox, {
            left: base.left + sx + pl,
            top: base.top + sy + pt,
            width: Math.max(0, base.width - pl - pr),
            height: Math.max(0, base.height - pt - pb),
        });
        padBox.style.display = 'block';
    } else {
        padBox.style.display = 'none';
    }

    /* --- Метка --- */
    label.textContent = describe(target) + (ghost ? ' · нулевой размер' : '');
    label.style.display = 'block';

    const labelRect = label.getBoundingClientRect();
    let labelTop = base.top + sy - labelRect.height - 4;
    let labelLeft = base.left + sx;

    if (labelTop < sy + 2) labelTop = base.bottom + sy + 4;
    if (labelLeft + labelRect.width > sx + window.innerWidth - 4) {
        labelLeft = Math.max(sx + 4, sx + window.innerWidth - labelRect.width - 4);
    }
    label.style.left = `${Math.round(labelLeft)}px`;
    label.style.top = `${Math.round(labelTop)}px`;

    /* --- Размеры --- */
    sizeTag.textContent = `${Math.round(raw.width)} × ${Math.round(raw.height)}`;
    sizeTag.style.display = 'block';
    const sizeRect = sizeTag.getBoundingClientRect();
    sizeTag.style.left = `${Math.round(base.right + sx - sizeRect.width - 4)}px`;
    sizeTag.style.top = `${Math.round(base.bottom + sy + 4)}px`;
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
    // Специальные метки для корневых элементов
    if (node === document.body) return 'body — общий фон страницы';
    if (node === document.documentElement) return 'html — корневой элемент';

    let out = node.tagName.toLowerCase();
    if (node.id) out += `#${node.id}`;

    const classes = Array.from(node.classList)
        .filter(c => !c.startsWith('vte-'))
        .slice(0, 3);
    if (classes.length) out += '.' + classes.join('.');

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
    if (!isPickable(node)) return null;
    return node;
}

/**
 * Элемент годится для правки, даже если он схлопнут в нуль:
 * иконки на псевдоэлементах часто имеют нулевой собственный размер.
 * Отсекаем только то, что вообще не участвует в отрисовке.
 */
function isPickable(node) {
    try {
        const cs = getComputedStyle(node);
        if (cs.display === 'none') return false;
        if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
        return true;
    } catch {
        return true;
    }
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
