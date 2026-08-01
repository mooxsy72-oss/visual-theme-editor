// modules/colorPicker.js
// Всплывающий color picker: HSV-поле, ползунки оттенка и прозрачности,
// ввод HEX/RGBA, пипетка, палитра переменных темы, редактор градиентов.
// Один экземпляр на страницу, открывается рядом с полем-триггером.

let pop = null;              // корневой элемент попапа
let target = null;           // { onChange, onCommit, anchor }
let hsv = { h: 0, s: 1, v: 1 };
let alpha = 1;
let mode = 'solid';          // solid | linear | radial
let stops = [];              // [{ color: 'rgba(...)', pos: 0 }]
let activeStop = 0;
let gradAngle = 135;
let swatches = [];           // палитра из переменных темы
let recent = [];
let suppress = false;        // не эмитить во время программного обновления
let allowGrad = true;        // разрешены ли градиенты для текущей цели

const RECENT_MAX = 12;

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

/* ============================================================
   ПУБЛИЧНОЕ API
============================================================ */
export function init(options = {}) {
    swatches = options.swatches || [];
    build();
}

/** Обновить палитру переменных темы: [{name, value}] */
export function setSwatches(list) {
    swatches = Array.isArray(list) ? list.filter(s => isColorLike(s.value)) : [];
    if (pop) renderSwatches();
}

/**
 * Открыть пикер.
 * opts = {
 *   anchor: HTMLElement,        // рядом с чем показать
 *   value: 'rgba(...)' | 'linear-gradient(...)',
 *   allowGradient: boolean,
 *   onChange: (cssValue) => void,   // на каждое движение
 *   onCommit: (cssValue) => void,   // при закрытии/подтверждении
 * }
 */
export function open(opts = {}) {
    if (!pop) build();
    target = opts;
    allowGrad = opts.allowGradient !== false;

    parseIncoming(opts.value, allowGrad);
    setModeTabs(allowGrad);
    syncUI();
    renderSwatches();
    renderRecent();

    pop.style.display = 'flex';
    position(opts.anchor);

    setTimeout(() => {
        document.addEventListener('pointerdown', outsideClose, true);
    }, 0);
}

export function close(commit = true) {
    if (!pop || pop.style.display === 'none') return;

    // Ссылку забираем заранее: обработчик может открыть палитру снова
    const t = target;
    const value = currentValue();

    pop.style.display = 'none';
    document.removeEventListener('pointerdown', outsideClose, true);
    target = null;

    if (commit) {
        t?.onCommit?.(value);
        pushRecent(value);
        return;
    }

    // Отмена. В CSS ничего не записано, но слой предпросмотра всё ещё
    // показывает выбранный цвет, поэтому вызывающая сторона обязана
    // вернуть исходное значение сама.
    t?.onCancel?.();
}


export function isOpen() {
    return !!pop && pop.style.display !== 'none';
}

/* ============================================================
   ПОСТРОЕНИЕ ПОПАПА
============================================================ */
let els = {};

function build() {
    if (pop) return;

    /* ---- Табы режима ---- */
    els.tabSolid = modeTab('solid', 'Цвет', 'fa-droplet');
    els.tabLinear = modeTab('linear', 'Линейный', 'fa-arrow-right-long');
    els.tabRadial = modeTab('radial', 'Радиальный', 'fa-circle-dot');
    els.tabs = h('div.vte-cp-tabs', {}, [els.tabSolid, els.tabLinear, els.tabRadial]);

    /* ---- HSV-поле ---- */
    els.satCursor = h('div.vte-cp-cursor');
    els.satField = h('div.vte-cp-sat', {}, [
        h('div.vte-cp-sat-white'),
        h('div.vte-cp-sat-black'),
        els.satCursor,
    ]);
    dragArea(els.satField, (x, y) => {
        hsv.s = clamp01(x);
        hsv.v = clamp01(1 - y);
        syncUI();
        emit();
    });

    /* ---- Ползунок оттенка ---- */
    els.hueThumb = h('div.vte-cp-thumb');
    els.hueTrack = h('div.vte-cp-hue', {}, [els.hueThumb]);
    dragArea(els.hueTrack, (x) => {
        hsv.h = clamp01(x) * 360;
        syncUI();
        emit();
    });

    /* ---- Ползунок прозрачности ---- */
    els.alphaThumb = h('div.vte-cp-thumb');
    els.alphaFill = h('div.vte-cp-alpha-fill');
    els.alphaTrack = h('div.vte-cp-alpha', {}, [els.alphaFill, els.alphaThumb]);
    dragArea(els.alphaTrack, (x) => {
        alpha = Math.round(clamp01(x) * 1000) / 1000;
        syncUI();
        emit();
    });

    /* ---- Превью + пипетка ---- */
    els.preview = h('div.vte-cp-preview');
    els.eyedrop = h('button.vte-cp-icon-btn', {
        type: 'button',
        title: 'Пипетка (взять цвет с экрана)',
        on: { click: pickFromScreen },
    }, [icon('fa-eye-dropper')]);

    if (!window.EyeDropper) {
        els.eyedrop.disabled = true;
        els.eyedrop.title = 'Пипетка не поддерживается этим браузером';
    }

    /* ---- Поля ввода ---- */
    els.hex = h('input.vte-cp-hex', {
        type: 'text',
        spellcheck: false,
        title: 'HEX: #rrggbb или #rrggbbaa',
        on: {
            change: () => applyHexInput(),
            keydown: (e) => { if (e.key === 'Enter') applyHexInput(); },
        },
    });

    els.alphaNum = h('input.vte-cp-num', {
        type: 'number', min: 0, max: 100, step: 1,
        title: 'Прозрачность, %',
        on: { change: () => { alpha = clamp01((Number(els.alphaNum.value) || 0) / 100); syncUI(); emit(); } },
    });

    const inputsRow = h('div.vte-cp-inputs', {}, [
        els.preview,
        els.eyedrop,
        els.hex,
        h('div.vte-cp-alpha-num', {}, [els.alphaNum, h('span.vte-cp-unit', { text: '%' })]),
    ]);

    els.rgbaOut = h('div.vte-cp-out', {
        title: 'Кликните, чтобы скопировать',
        on: { click: copyValue },
    });

    /* ---- Градиент: полоса со стопами ---- */
    els.gradBar = h('div.vte-cp-grad-bar', {
        on: { pointerdown: onGradBarDown },
    });
    els.gradStops = h('div.vte-cp-grad-stops');
    els.gradWrap = h('div.vte-cp-grad', {}, [els.gradBar, els.gradStops]);

    els.angleInput = h('input.vte-cp-range', {
        type: 'range', min: 0, max: 360, step: 1, value: String(gradAngle),
        on: {
            input: () => {
                gradAngle = Number(els.angleInput.value);
                els.angleVal.textContent = `${gradAngle}°`;
                renderGradPreview();
                emit();
            },
        },
    });
    els.angleVal = h('span.vte-cp-range-val', { text: `${gradAngle}°` });

    els.angleRow = h('div.vte-cp-row', {}, [
        h('span.vte-cp-label', { text: 'Угол' }),
        els.angleInput,
        els.angleVal,
    ]);

    els.stopPos = h('input.vte-cp-range', {
        type: 'range', min: 0, max: 100, step: 1, value: '0',
        on: {
            input: () => {
                if (!stops[activeStop]) return;
                stops[activeStop].pos = Number(els.stopPos.value);
                els.stopPosVal.textContent = `${stops[activeStop].pos}%`;
                renderGradStops();
                renderGradPreview();
                emit();
            },
        },
    });
    els.stopPosVal = h('span.vte-cp-range-val', { text: '0%' });

    els.stopRow = h('div.vte-cp-row', {}, [
        h('span.vte-cp-label', { text: 'Позиция' }),
        els.stopPos,
        els.stopPosVal,
    ]);

    els.addStop = h('button.vte-cp-mini-btn', {
        type: 'button', title: 'Добавить точку',
        on: { click: addStop },
    }, [icon('fa-plus'), h('span', { text: ' Точка' })]);

    els.delStop = h('button.vte-cp-mini-btn', {
        type: 'button', title: 'Удалить точку',
        on: { click: removeStop },
    }, [icon('fa-minus'), h('span', { text: ' Убрать' })]);

    els.flipStops = h('button.vte-cp-mini-btn', {
        type: 'button', title: 'Развернуть градиент',
        on: { click: flipStops },
    }, [icon('fa-right-left'), h('span', { text: ' Развернуть' })]);

    els.gradActions = h('div.vte-cp-grad-actions', {}, [els.addStop, els.delStop, els.flipStops]);

    els.gradBox = h('div.vte-cp-grad-box', { style: 'display:none' }, [
        els.gradWrap, els.angleRow, els.stopRow, els.gradActions,
    ]);

    /* ---- Палитры ---- */
    els.swatches = h('div.vte-cp-swatches');
    els.swatchesBox = h('div.vte-cp-section', {}, [
        h('div.vte-cp-section-head', {}, [
            icon('fa-palette'),
            h('span', { text: ' Переменные темы' }),
        ]),
        els.swatches,
    ]);

    els.recent = h('div.vte-cp-swatches');
    els.recentBox = h('div.vte-cp-section', { style: 'display:none' }, [
        h('div.vte-cp-section-head', {}, [
            icon('fa-clock-rotate-left'),
            h('span', { text: ' Недавние' }),
        ]),
        els.recent,
    ]);

    /* ---- Низ ---- */
    const footer = h('div.vte-cp-footer', {}, [
        h('button.vte-cp-btn', {
            type: 'button',
            on: { click: () => close(false) },
        }, [h('span', { text: 'Отмена' })]),
        h('button.vte-cp-btn.vte-cp-btn-primary', {
            type: 'button',
            on: { click: () => close(true) },
        }, [icon('fa-check'), h('span', { text: ' Готово' })]),
    ]);

    /* ---- Сборка ---- */
    els.solidBox = h('div.vte-cp-solid', {}, [
        els.satField, els.hueTrack, els.alphaTrack, inputsRow, els.rgbaOut,
    ]);

    pop = h('div#vte-colorpicker.vte-cp', { style: 'display:none' }, [
        els.tabs,
        els.gradBox,
        els.solidBox,
        els.swatchesBox,
        els.recentBox,
        footer,
    ]);

    document.body.appendChild(pop);

    // ST закрывает свои панели по клику вне них — гасим всплытие
    ['pointerdown', 'mousedown', 'touchstart', 'click'].forEach(t =>
        pop.addEventListener(t, (e) => e.stopPropagation()));

    document.addEventListener('keydown', (e) => {
        if (!isOpen()) return;
        if (e.key === 'Escape') { e.preventDefault(); close(false); }
        if (e.key === 'Enter' && e.target === pop) { e.preventDefault(); close(true); }
    });
}

function modeTab(id, label, faName) {
    return h('button.vte-cp-tab', {
        type: 'button',
        dataset: { mode: id },
        on: { click: () => switchMode(id) },
    }, [icon(faName), h('span', { text: ' ' + label })]);
}

/* ============================================================
   РЕЖИМЫ
============================================================ */
function setModeTabs(allowGradient) {
    els.tabLinear.style.display = allowGradient ? 'inline-flex' : 'none';
    els.tabRadial.style.display = allowGradient ? 'inline-flex' : 'none';
    els.tabs.style.display = allowGradient ? 'flex' : 'none';
}

/** Две точки градиента от текущего цвета: светлая и притемнённая */
function stopsFromCurrent() {
    return [
        { color: hsvaToRgba(hsv, alpha), pos: 0 },
        { color: hsvaToRgba({ ...hsv, v: Math.max(0.1, hsv.v * 0.45) }, alpha), pos: 100 },
    ];
}

function switchMode(next) {
    if (mode === next) return;

    // solid → градиент: точки строим заново от текущего цвета ВСЕГДА.
    // Раньше стоял guard `stops.length < 2`, и переключение подсовывало
    // точки от прошлого элемента — вместо своего цвета вылезал чужой градиент.
    if (mode === 'solid' && next !== 'solid') {
        stops = stopsFromCurrent();
        activeStop = 0;
    }
    // Переход градиент → solid: берём цвет активной точки
    if (mode !== 'solid' && next === 'solid' && stops[activeStop]) {
        loadColorIntoHsv(stops[activeStop].color);
    }

    mode = next;
    syncUI();
    emit();
}

function parseIncoming(value, allowGradient) {
    const raw = String(value ?? '').trim();

    if (allowGradient && /gradient\(/i.test(raw)) {
        const parsed = parseGradient(raw);
        if (parsed) {
            mode = parsed.type;
            gradAngle = parsed.angle;
            stops = parsed.stops;
            activeStop = 0;
            loadColorIntoHsv(stops[0].color);
            return;
        }
    }

    mode = 'solid';
    loadColorIntoHsv(raw || 'rgba(0,0,0,1)');
    stops = stopsFromCurrent();
    activeStop = 0;
}

/* ============================================================
   СИНХРОНИЗАЦИЯ UI
============================================================ */
function syncUI() {
    suppress = true;

    for (const tab of [els.tabSolid, els.tabLinear, els.tabRadial]) {
        tab.classList.toggle('active', tab.dataset.mode === mode);
    }

    const isGrad = mode !== 'solid';
    els.gradBox.style.display = isGrad ? 'flex' : 'none';
    els.angleRow.style.display = mode === 'linear' ? 'flex' : 'none';

    // HSV-поле
    const hueColor = hsvaToRgba({ h: hsv.h, s: 1, v: 1 }, 1);
    els.satField.style.background = hueColor;
    els.satCursor.style.left = `${hsv.s * 100}%`;
    els.satCursor.style.top = `${(1 - hsv.v) * 100}%`;
    els.satCursor.style.background = hsvaToRgba(hsv, 1);

    els.hueThumb.style.left = `${(hsv.h / 360) * 100}%`;
    els.hueThumb.style.background = hueColor;

    const solid = hsvaToRgba(hsv, 1);
    els.alphaFill.style.background = `linear-gradient(90deg, transparent, ${solid})`;
    els.alphaThumb.style.left = `${alpha * 100}%`;
    els.alphaThumb.style.background = hsvaToRgba(hsv, alpha);

    const value = currentValue();
    els.preview.style.background = value;
    els.hex.value = hsvaToHex(hsv, alpha);
    els.alphaNum.value = String(Math.round(alpha * 100));
    els.rgbaOut.textContent = value;

    if (isGrad) {
        els.angleInput.value = String(gradAngle);
        els.angleVal.textContent = `${gradAngle}°`;
        const st = stops[activeStop];
        if (st) {
            els.stopPos.value = String(st.pos);
            els.stopPosVal.textContent = `${st.pos}%`;
        }
        els.delStop.disabled = stops.length <= 2;
        renderGradStops();
        renderGradPreview();
    }

    suppress = false;
}

/* ============================================================
   ГРАДИЕНТ
============================================================ */
function renderGradPreview() {
    els.gradBar.style.background = buildGradient('linear', 90);
}

function renderGradStops() {
    els.gradStops.textContent = '';
    stops.forEach((st, i) => {
        const handle = h('div.vte-cp-stop', {
            style: `left:${st.pos}%; background:${st.color}`,
            dataset: { index: String(i) },
            title: `${st.color} · ${st.pos}%`,
            on: {
                pointerdown: (e) => {
                    e.stopPropagation();
                    selectStop(i);
                    dragStop(e, i);
                },
            },
        });
        if (i === activeStop) handle.classList.add('active');
        els.gradStops.appendChild(handle);
    });
}

function selectStop(i) {
    activeStop = i;
    if (stops[i]) loadColorIntoHsv(stops[i].color);
    syncUI();
}

function dragStop(e, i) {
    const rect = els.gradBar.getBoundingClientRect();
    const ref = stops[i];        // держим сам объект, а не его индекс
    if (!ref) return;

    const move = (ev) => {
        const x = clamp01((ev.clientX - rect.left) / rect.width);
        ref.pos = Math.round(x * 100);
        activeStop = Math.max(0, stops.indexOf(ref));
        renderGradStops();
        renderGradPreview();
        els.stopPos.value = String(ref.pos);
        els.stopPosVal.textContent = `${ref.pos}%`;
        emit();
    };

    const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        stops.sort((a, b) => a.pos - b.pos);
        // После сортировки индекс меняется. Старый код искал stops[i],
        // то есть уже другую точку, и выделение перескакивало на чужую —
        // дальше правка цвета уходила не в ту точку.
        activeStop = Math.max(0, stops.indexOf(ref));
        syncUI();
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
}

function onGradBarDown(e) {
    if (e.target !== els.gradBar) return;
    const rect = els.gradBar.getBoundingClientRect();
    const pos = Math.round(clamp01((e.clientX - rect.left) / rect.width) * 100);

    const st = { color: sampleGradientAt(pos), pos };
    stops.push(st);
    stops.sort((a, b) => a.pos - b.pos);
    // Поиск по объекту, а не по pos: у двух точек позиция может совпасть
    activeStop = Math.max(0, stops.indexOf(st));
    selectStop(activeStop);
    emit();
}

function addStop() {
    const pos = stops.length
        ? Math.min(100, Math.round((stops[stops.length - 1].pos + 100) / 2))
        : 50;

    const st = { color: hsvaToRgba(hsv, alpha), pos };
    stops.push(st);
    stops.sort((a, b) => a.pos - b.pos);
    activeStop = Math.max(0, stops.indexOf(st));
    syncUI();
    emit();
}

function removeStop() {
    if (stops.length <= 2) return;
    stops.splice(activeStop, 1);
    activeStop = Math.max(0, activeStop - 1);
    selectStop(activeStop);
    emit();
}

function flipStops() {
    stops = stops.map(s => ({ color: s.color, pos: 100 - s.pos })).sort((a, b) => a.pos - b.pos);
    gradAngle = (gradAngle + 180) % 360;
    syncUI();
    emit();
}

function sampleGradientAt(pos) {
    if (!stops.length) return hsvaToRgba(hsv, alpha);
    const sorted = [...stops].sort((a, b) => a.pos - b.pos);
    if (pos <= sorted[0].pos) return sorted[0].color;
    if (pos >= sorted[sorted.length - 1].pos) return sorted[sorted.length - 1].color;

    for (let i = 0; i < sorted.length - 1; i++) {
        const a = sorted[i], b = sorted[i + 1];
        if (pos >= a.pos && pos <= b.pos) {
            const t = (pos - a.pos) / Math.max(1, b.pos - a.pos);
            return mixRgba(a.color, b.color, t);
        }
    }
    return sorted[0].color;
}

function buildGradient(forceType, forceAngle) {
    const type = forceType || (mode === 'radial' ? 'radial' : 'linear');
    const list = [...stops].sort((a, b) => a.pos - b.pos)
        .map(s => `${s.color} ${s.pos}%`).join(', ');
    if (type === 'radial') return `radial-gradient(circle at center, ${list})`;
    const ang = forceAngle != null ? forceAngle : gradAngle;
    return `linear-gradient(${ang}deg, ${list})`;
}

/* ============================================================
   ЗНАЧЕНИЕ
============================================================ */
function currentValue() {
    if (mode === 'solid') return hsvaToRgba(hsv, alpha);
    return buildGradient();
}

function emit() {
    if (suppress) return;
    // Живое обновление цвета активной точки градиента
    if (mode !== 'solid' && stops[activeStop]) {
        stops[activeStop].color = hsvaToRgba(hsv, alpha);
    }
    const v = currentValue();
    els.preview.style.background = v;
    els.rgbaOut.textContent = v;
    target?.onChange?.(v);
}


function parseGradient(raw) {
    const isRadial = /radial-gradient/i.test(raw);
    const inner = raw.slice(raw.indexOf('(') + 1, raw.lastIndexOf(')'));
    const parts = splitTop(inner);
    if (!parts.length) return null;

    let angle = isRadial ? 135 : 180;
    let start = 0;

    const first = parts[0].trim();
    const angMatch = first.match(/^(-?[\d.]+)deg$/i);
    if (angMatch) { angle = Number(angMatch[1]); start = 1; }
    else if (/^(to\s|circle|ellipse|at\s)/i.test(first)) {
        angle = dirToAngle(first);
        start = 1;
    }

    const parsedStops = [];
    for (let i = start; i < parts.length; i++) {
        const chunk = parts[i].trim();
        const m = chunk.match(/^(.*?)(?:\s+(-?[\d.]+)%)?$/);
        if (!m || !m[1]) continue;
        const color = normalizeColor(m[1].trim());
        if (!color) continue;
        const pos = m[2] != null
            ? Number(m[2])
            : Math.round(((i - start) / Math.max(1, parts.length - start - 1)) * 100);
        parsedStops.push({ color, pos: Math.max(0, Math.min(100, pos)) });
    }

    if (parsedStops.length < 2) return null;
    return {
        type: isRadial ? 'radial' : 'linear',
        angle,
        stops: parsedStops.sort((a, b) => a.pos - b.pos),
    };
}

function dirToAngle(dir) {
    const d = dir.toLowerCase();
    if (d.includes('to top') && d.includes('right')) return 45;
    if (d.includes('to bottom') && d.includes('right')) return 135;
    if (d.includes('to bottom') && d.includes('left')) return 225;
    if (d.includes('to top') && d.includes('left')) return 315;
    if (d.includes('to top')) return 0;
    if (d.includes('to right')) return 90;
    if (d.includes('to bottom')) return 180;
    if (d.includes('to left')) return 270;
    return 135;
}

/** Делит строку по запятым верхнего уровня (не внутри скобок) */
function splitTop(str) {
    const out = [];
    let depth = 0, buf = '';
    for (const ch of str) {
        if (ch === '(') depth++;
        if (ch === ')') depth = Math.max(0, depth - 1);
        if (ch === ',' && depth === 0) { out.push(buf); buf = ''; continue; }
        buf += ch;
    }
    if (buf.trim()) out.push(buf);
    return out;
}

/* ============================================================
   ПАЛИТРЫ
============================================================ */
function renderSwatches() {
    els.swatches.textContent = '';
    const list = swatches.slice(0, 48);
    els.swatchesBox.style.display = list.length ? 'flex' : 'none';

    for (const s of list) {
        els.swatches.appendChild(h('button.vte-cp-swatch', {
            type: 'button',
            style: `background:${s.value}`,
            title: `${s.name}\n${s.value}`,
            on: {
                click: () => {
                    loadColorIntoHsv(s.value);
                    if (mode !== 'solid' && stops[activeStop]) {
                        stops[activeStop].color = normalizeColor(s.value) || s.value;
                    }
                    syncUI();
                    emit();
                },
            },
        }));
    }
}

function renderRecent() {
    els.recent.textContent = '';

    // Для цели без градиентов градиентные плашки не показываем: клик по ним
    // подставлял linear-gradient() в color или border-color, и правило
    // молча отбрасывалось браузером.
    const list = allowGrad
        ? recent
        : recent.filter(v => !/gradient\(/i.test(String(v)));

    els.recentBox.style.display = list.length ? 'flex' : 'none';

    for (const v of list) {
        els.recent.appendChild(h('button.vte-cp-swatch', {
            type: 'button',
            style: `background:${v}`,
            title: v,
            on: {
                click: () => {
                    parseIncoming(v, allowGrad);
                    setModeTabs(allowGrad);
                    syncUI();
                    emit();
                },
            },
        }));
    }
}


function pushRecent(v) {
    if (!v) return;
    recent = [v, ...recent.filter(x => x !== v)].slice(0, RECENT_MAX);
}

/* ============================================================
   ПИПЕТКА И БУФЕР
============================================================ */
async function pickFromScreen() {
    if (!window.EyeDropper) return;
    try {
        const result = await new window.EyeDropper().open();
        loadColorIntoHsv(result.sRGBHex);
        if (mode !== 'solid' && stops[activeStop]) {
            stops[activeStop].color = hsvaToRgba(hsv, alpha);
        }
        syncUI();
        emit();
    } catch { /* пользователь отменил */ }
}

function copyValue() {
    navigator.clipboard?.writeText(currentValue());
    els.rgbaOut.classList.add('vte-cp-copied');
    setTimeout(() => els.rgbaOut.classList.remove('vte-cp-copied'), 800);
}

function applyHexInput() {
    const parsed = normalizeColor(els.hex.value);
    if (!parsed) { syncUI(); return; }
    loadColorIntoHsv(parsed);
    if (mode !== 'solid' && stops[activeStop]) {
        stops[activeStop].color = hsvaToRgba(hsv, alpha);
    }
    syncUI();
    emit();
}

/* ============================================================
   ПОЗИЦИЯ И ЗАКРЫТИЕ
============================================================ */
function position(anchor) {
    const r = anchor?.getBoundingClientRect?.();
    const box = pop.getBoundingClientRect();
    const pad = 8;

    let left = r ? r.left : (window.innerWidth - box.width) / 2;
    let top = r ? r.bottom + pad : 80;

    if (left + box.width > window.innerWidth - pad) left = window.innerWidth - box.width - pad;
    if (left < pad) left = pad;
    if (top + box.height > window.innerHeight - pad) {
        top = r ? Math.max(pad, r.top - box.height - pad) : pad;
    }

    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
}

function outsideClose(e) {
    if (pop.contains(e.target)) return;
    if (target?.anchor && target.anchor.contains(e.target)) return;
    close(true);
}

/* ============================================================
   ПЕРЕТАСКИВАНИЕ ОБЛАСТЕЙ
============================================================ */
function dragArea(el, onMove) {
    const handle = (e) => {
        const rect = el.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width;
        const y = (e.clientY - rect.top) / rect.height;
        onMove(x, y);
    };

    el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        handle(e);

        const move = (ev) => handle(ev);
        const up = () => {
            el.removeEventListener('pointermove', move);
            el.removeEventListener('pointerup', up);
            el.removeEventListener('pointercancel', up);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
    });
}

/* ============================================================
   ЦВЕТОВЫЕ ПРЕОБРАЗОВАНИЯ
============================================================ */
function loadColorIntoHsv(value) {
    const rgba = toRgbaParts(value);
    if (!rgba) return;
    const conv = rgbToHsv(rgba.r, rgba.g, rgba.b);
    // Сохраняем оттенок, если цвет серый (иначе ползунок оттенка прыгает на 0)
    hsv = { h: conv.s === 0 ? hsv.h : conv.h, s: conv.s, v: conv.v };
    alpha = rgba.a;
}

function toRgbaParts(value) {
    const v = String(value ?? '').trim();
    if (!v) return null;

    let m = v.match(/^#([0-9a-f]{3,8})$/i);
    if (m) {
        let hex = m[1];
        if (hex.length === 3 || hex.length === 4) {
            hex = hex.split('').map(c => c + c).join('');
        }
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        const a = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
        return { r, g, b, a };
    }

    m = v.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
        const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
        return { r: p[0] || 0, g: p[1] || 0, b: p[2] || 0, a: p[3] == null ? 1 : p[3] };
    }

    m = v.match(/^hsla?\(([^)]+)\)$/i);
    if (m) {
        const p = m[1].split(/[,\s/%]+/).filter(Boolean).map(Number);
        const rgb = hslToRgb(p[0] || 0, (p[1] || 0) / 100, (p[2] || 0) / 100);
        return { ...rgb, a: p[3] == null ? 1 : p[3] };
    }

    // Именованные цвета — отдаём браузеру
    try {
        const probe = document.createElement('span');
        probe.style.color = v;
        document.body.appendChild(probe);
        const computed = getComputedStyle(probe).color;
        probe.remove();
        if (computed && computed !== v) return toRgbaParts(computed);
    } catch {}
    return null;
}

function normalizeColor(v) {
    const p = toRgbaParts(v);
    if (!p) return null;
    return p.a >= 1
        ? `rgb(${p.r}, ${p.g}, ${p.b})`
        : `rgba(${p.r}, ${p.g}, ${p.b}, ${round3(p.a)})`;
}

function isColorLike(v) {
    return !!toRgbaParts(v);
}

function hsvaToRgba(c, a) {
    const { r, g, b } = hsvToRgb(c.h, c.s, c.v);
    return a >= 1
        ? `rgb(${r}, ${g}, ${b})`
        : `rgba(${r}, ${g}, ${b}, ${round3(a)})`;
}

function hsvaToHex(c, a) {
    const { r, g, b } = hsvToRgb(c.h, c.s, c.v);
    const hex = [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
    if (a >= 1) return `#${hex}`;
    return `#${hex}${Math.round(a * 255).toString(16).padStart(2, '0')}`;
}

function hsvToRgb(h, s, v) {
    const hh = ((h % 360) + 360) % 360 / 60;
    const c = v * s;
    const x = c * (1 - Math.abs((hh % 2) - 1));
    const m = v - c;
    let r = 0, g = 0, b = 0;
    if (hh < 1) { r = c; g = x; }
    else if (hh < 2) { r = x; g = c; }
    else if (hh < 3) { g = c; b = x; }
    else if (hh < 4) { g = x; b = c; }
    else if (hh < 5) { r = x; b = c; }
    else { r = c; b = x; }
    return {
        r: Math.round((r + m) * 255),
        g: Math.round((g + m) * 255),
        b: Math.round((b + m) * 255),
    };
}

function rgbToHsv(r, g, b) {
    const rr = r / 255, gg = g / 255, bb = b / 255;
    const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
    const d = max - min;
    let hue = 0;
    if (d !== 0) {
        if (max === rr) hue = 60 * (((gg - bb) / d) % 6);
        else if (max === gg) hue = 60 * ((bb - rr) / d + 2);
        else hue = 60 * ((rr - gg) / d + 4);
    }
    if (hue < 0) hue += 360;
    return { h: hue, s: max === 0 ? 0 : d / max, v: max };
}

function hslToRgb(hDeg, s, l) {
    const h = ((hDeg % 360) + 360) % 360 / 360;
    if (s === 0) {
        const v = Math.round(l * 255);
        return { r: v, g: v, b: v };
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue2rgb = (t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    return {
        r: Math.round(hue2rgb(h + 1 / 3) * 255),
        g: Math.round(hue2rgb(h) * 255),
        b: Math.round(hue2rgb(h - 1 / 3) * 255),
    };
}

function mixRgba(a, b, t) {
    const A = toRgbaParts(a) || { r: 0, g: 0, b: 0, a: 1 };
    const B = toRgbaParts(b) || { r: 0, g: 0, b: 0, a: 1 };
    const lerp = (x, y) => Math.round(x + (y - x) * t);
    const alphaMix = round3(A.a + (B.a - A.a) * t);
    return alphaMix >= 1
        ? `rgb(${lerp(A.r, B.r)}, ${lerp(A.g, B.g)}, ${lerp(A.b, B.b)})`
        : `rgba(${lerp(A.r, B.r)}, ${lerp(A.g, B.g)}, ${lerp(A.b, B.b)}, ${alphaMix})`;
}

function clamp01(v) {
    return Math.max(0, Math.min(1, v));
}

function round3(v) {
    return Math.round(v * 1000) / 1000;
}

/* ============================================================
   ЭКСПОРТ УТИЛИТ (нужны инспектору)
============================================================ */
export const utils = {
    toRgbaParts,
    normalizeColor,
    isColorLike,
    hsvaToHex,
    rgbToHsv,
    hsvToRgb,
    mixRgba,
    parseGradient,
    buildGradientFrom(type, angle, stopList) {
        const list = [...stopList].sort((a, b) => a.pos - b.pos)
            .map(s => `${s.color} ${s.pos}%`).join(', ');
        return type === 'radial'
            ? `radial-gradient(circle at center, ${list})`
            : `linear-gradient(${angle}deg, ${list})`;
    },
};
