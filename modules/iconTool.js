// modules/iconTool.js
// Замена иконок и вставка картинок одним полем: ссылка, код SVG или data-URI.
//
// ── ТРИ РОЛИ РАЗМЕЩЕНИЯ ─────────────────────────────────────────────
// background  Картинка ложится на сам элемент (без псевдоэлемента).
//             Пишутся только background-*. Ничего не сдвигает.
//             Так делают фон заголовка, панели, кнопки.
//
// icon        Картинка лежит в отдельном слое ::before/::after и ведёт себя
//             как символ: content + width + height + vertical-align.
//             Так заменяют иконку шрифта Font Awesome.
//
// overlay     Картинка лежит в отдельном слое и растянута по всему элементу
//             через position:absolute + top/right/bottom/left:0.
//             Из потока вынута, поэтому вёрстку не двигает вообще.
//             Уровень «под содержимым» = z-index:-1 + isolation:isolate
//             на самом элементе: картинка над фоном, но под текстом.
//
// ── ДВА РЕЖИМА ЦВЕТА ────────────────────────────────────────────────
// Картинка  background-image. Сохраняет исходные цвета. Для гифок и фото.
// Силуэт    mask-image + background-color. Цвет становится обычным CSS-
//           свойством, поэтому его можно крутить ползунком.

let onApply = null;
let onRequestLayer = null;
let picker = null;

let root = null;
let els = {};

let mode = 'image';        // 'image' | 'mask'
let tint = '#d1912b';
let sourceKind = 'none';   // 'none' | 'url' | 'svg' | 'data'
let ctxInfo = { selector: '', pseudo: '', computed: null, element: null };

// Роль размещения
let role = 'background';   // 'background' | 'icon' | 'overlay'
let roleLocked = false;    // человек выбрал роль руками — не переопределять
let lastElement = null;    // сменился элемент → роль снова определяется сама
let overlayLevel = 'under';// 'under' | 'over'

// Иконка из шрифта рисуется не картинкой, а символом из приватной зоны Unicode
// в content. В background-image при этом пусто, поэтому распознаём отдельно.
let glyph = null;          // { char, code, family, weight, size, color, pseudo }
let glyphElsewhere = null; // глиф в соседнем слое: '::before' | '::after'

// Эффекты, которые действуют ТОЛЬКО на слой с картинкой
let fx = {
    opacity: 100, blur: 0, brightness: 100,
    saturate: 100, contrast: 100, hue: 0, grayscale: 0,
};
let fxDirty = false;

let targetKey = null;
let dirty = false;
let stash = null;


/* ============================================================
   МИНИ-ХЕЛПЕР DOM
============================================================ */
function h(tagSpec, attrs, children) {
    const idMatch = tagSpec.match(/#([\w-]+)/);
    const clsList = (tagSpec.match(/\.[\w-]+/g) || []).map(s => s.slice(1));
    const tag = (tagSpec.match(/^[\w-]+/) || ['div'])[0];

    const node = document.createElement(tag);
    if (idMatch) node.id = idMatch[1];
    if (clsList.length) node.className = clsList.join(' ');

    if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
            if (v == null || v === false) continue;
            if (k === 'text') { node.textContent = v; continue; }
            if (k === 'style') { node.style.cssText = v; continue; }
            if (k === 'dataset') { Object.assign(node.dataset, v); continue; }
            if (k === 'on') {
                for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
                continue;
            }
            if (k in node && typeof node[k] !== 'object' && k !== 'list') {
                try { node[k] = v; continue; } catch {}
            }
            node.setAttribute(k, v === true ? '' : v);
        }
    }
    for (const c of [].concat(children || [])) {
        if (c == null || c === false) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
}

function icon(name) {
    return h('i', { className: `fa-solid ${name}` });
}

/* ============================================================
   ИНИЦИАЛИЗАЦИЯ
============================================================ */
export function init(options = {}) {
    onApply = options.onApply || (() => {});
    onRequestLayer = options.onRequestLayer || null;
    picker = options.picker || null;
}

export function mount(container) {
    if (root && root.isConnected) return root;

    /* ---------- Источник ---------- */
    els.source = h('textarea.vte-icon-source', {
        rows: 4,
        spellcheck: false,
        placeholder: 'Ссылка на картинку, код <svg>…</svg> или data:image/svg+xml,…',
        on: { input: onSourceInput },
    });

    els.kind = h('div.vte-icon-kind');

    /* ---------- Предпросмотр ---------- */
    els.preview = h('div.vte-icon-preview');
    els.previewNote = h('small.vte-note', { text: 'Предпросмотр на шахматке' });

    /* ---------- Роль размещения ---------- */
    els.roleSeg = h('div.vte-seg.vte-icon-roleseg', {}, [
        roleBtn('background', 'Фон элемента', 'fa-fill',
            'Картинка ложится на сам элемент, под текст. Вёрстку не двигает'),
        roleBtn('icon', 'Иконка', 'fa-icons',
            'Отдельный слой размером как символ. Для замены иконок шрифта'),
        roleBtn('overlay', 'Наклейка', 'fa-clone',
            'Отдельный слой, растянутый по элементу. Из потока вынут, ничего не сдвигает'),
    ]);

    els.roleNote = h('small.vte-note.vte-icon-rolenote', { text: '' });

    /* ---------- Слой (только для icon / overlay) ---------- */
    els.layerSeg = h('div.vte-seg.vte-icon-layerseg', {}, [
        layerBtn('::after', 'после текста'),
        layerBtn('::before', 'перед текстом'),
    ]);

    els.layerRow = h('div.vte-field', { style: 'display:none' }, [
        h('label.vte-field-label', { text: 'Слой' }),
        h('div.vte-field-body', {}, [els.layerSeg]),
    ]);

    els.layerNote = h('small.vte-note', {
        style: 'display:none',
        text: 'Слой — невидимая пустышка, которую браузер дорисовывает к элементу. '
            + 'Картинка в нём не мешает собственному фону и тексту элемента. '
            + 'Разницы почти нет, ::after безопаснее.',
    });

    /* ---------- Уровень наклейки ---------- */
    els.levelSeg = h('div.vte-seg.vte-icon-levelseg', {}, [
        levelBtn('under', 'Под текстом', 'Над фоном элемента, но под его текстом'),
        levelBtn('over', 'Над текстом', 'Поверх всего. Для рамок и полупрозрачного декора'),
    ]);

    els.levelRow = h('div.vte-field', { style: 'display:none' }, [
        h('label.vte-field-label', { text: 'Уровень' }),
        h('div.vte-field-body', {}, [els.levelSeg]),
    ]);

    /* ---------- Режим (Картинка / Силуэт) ---------- */
    els.modeSeg = h('div.vte-seg.vte-icon-modeseg', {}, [
        modeBtn('image', 'Картинка', 'Оставить исходные цвета. Для гифок и фото'),
        modeBtn('mask', 'Силуэт', 'Перекрасить в любой цвет через «Фон» во вкладке «Цвет»'),
    ]);

    els.maskWarn = h('small.vte-icon-warn', { style: 'display:none', text: '' });

    /* ---------- Размер иконки (только role = icon) ---------- */
    els.iconBox = h('select.vte-select', {}, [
        h('option', { value: 'em', text: 'как текст (1em) — следует за font-size' }),
        h('option', { value: 'px', text: 'точный размер в px' }),
    ]);
    els.iconBox.value = 'em';
    els.iconBox.addEventListener('change', () => {
        els.iconBoxPx.style.display = els.iconBox.value === 'px' ? '' : 'none';
        renderPreview();
    });

    els.iconBoxPx = h('input.vte-num-inline', {
        type: 'number', min: 4, max: 512, step: 1, value: '20',
        style: 'display:none',
        on: { change: renderPreview },
    });

    els.iconBoxRow = h('div.vte-field', { style: 'display:none' }, [
        h('label.vte-field-label', { text: 'Размер иконки' }),
        h('div.vte-field-body', {}, [els.iconBox, els.iconBoxPx]),
    ]);

    /* ---------- Вписывание ---------- */
    els.fit = h('select.vte-select', {}, [
        h('option', { value: 'contain', text: 'contain — влезает целиком' }),
        h('option', { value: 'cover', text: 'cover — заполняет с обрезкой' }),
        h('option', { value: '100% 100%', text: '100% 100% — растянуть' }),
        h('option', { value: 'auto', text: 'auto — исходный размер' }),
        h('option', { value: 'px', text: 'точный размер рисунка в px' }),
    ]);
    els.fit.value = 'contain';
    els.fit.addEventListener('change', () => {
        els.pxRow.style.display = els.fit.value === 'px' ? 'flex' : 'none';
        renderPreview();
    });

    els.px = h('input.vte-num-inline', {
        type: 'number', min: 4, max: 2048, step: 1, value: '24',
        on: { change: renderPreview },
    });

    els.pxRow = h('div.vte-field', { style: 'display:none' }, [
        h('label.vte-field-label', { text: 'Рисунок, px' }),
        h('div.vte-field-body', {}, [els.px, h('span.vte-muted', { text: 'ширина и высота' })]),
    ]);

    els.fitRow = h('div.vte-field', {}, [
        h('label.vte-field-label', { text: 'Вписывание' }),
        h('div.vte-field-body', {}, [els.fit]),
    ]);

    /* ---------- Повтор ---------- */
    els.repeat = h('select.vte-select', {}, [
        h('option', { value: 'no-repeat', text: 'no-repeat — одна картинка' }),
        h('option', { value: 'repeat', text: 'repeat — плитка' }),
        h('option', { value: 'repeat-x', text: 'repeat-x — по горизонтали' }),
        h('option', { value: 'repeat-y', text: 'repeat-y — по вертикали' }),
    ]);
    els.repeat.value = 'no-repeat';
    els.repeat.addEventListener('change', renderPreview);

    els.repeatRow = h('div.vte-field', {}, [
        h('label.vte-field-label', { text: 'Повтор' }),
        h('div.vte-field-body', {}, [els.repeat]),
    ]);

    /* ---------- Позиция ---------- */
    els.position = h('input.vte-input', {
        type: 'text', spellcheck: false, value: 'center',
        placeholder: 'center · left top · 50% 20% · 4px 0',
        on: { change: renderPreview },
    });

    els.positionRow = h('div.vte-field', {}, [
        h('label.vte-field-label', { text: 'Позиция' }),
        h('div.vte-field-body', {}, [els.position]),
    ]);

    /* ---------- Наложение ---------- */
    els.blend = h('select.vte-select', {}, [
        'normal', 'multiply', 'screen', 'overlay', 'soft-light',
        'hard-light', 'color-dodge', 'difference', 'luminosity',
    ].map(v => h('option', { value: v, text: v })));
    els.blend.value = 'normal';
    els.blend.addEventListener('change', renderPreview);

    els.blendRow = h('div.vte-field', {}, [
        h('label.vte-field-label', { text: 'Наложение' }),
        h('div.vte-field-body', {}, [els.blend]),
    ]);

    /* ---------- Эффекты слоя картинки ---------- */
    els.fxNote = h('small.vte-note', { text: '' });

    els.fxResetBtn = h('button.vte-btn.vte-btn-ghost', {
        type: 'button',
        on: { click: resetFx },
    }, [icon('fa-rotate-left'), h('span', { text: ' Сбросить эффекты' })]);

    /* ---------- Кнопки ---------- */
    els.applyBtn = h('button.vte-btn.vte-btn-primary', {
        type: 'button',
        on: { click: apply },
    }, [icon('fa-check'), h('span', { text: ' Применить' })]);

    els.convertBtn = h('button.vte-btn', {
        type: 'button',
        title: 'Взять иконку, которая уже стоит, и сделать её перекрашиваемой',
        on: { click: convertCurrent },
    }, [icon('fa-wand-sparkles'), h('span', { text: ' Сделать перекрашиваемой' })]);

    els.clearBtn = h('button.vte-btn.vte-btn-ghost', {
        type: 'button',
        title: 'Убрать картинку, маску, размеры и эффекты, добавленные редактором',
        on: { click: clearIcon },
    }, [icon('fa-eraser'), h('span', { text: ' Убрать' })]);

    root = h('div.vte-icon-tool', {}, [
        /* 1. Источник */
        h('div.vte-icon-block', {}, [
            h('div.vte-icon-head', {}, [
                h('span', { text: 'Источник' }),
                els.kind,
            ]),
            els.source,
            h('small.vte-note', {
                text: 'url(), кавычки и экранирование расширение добавит само.',
            }),
        ]),

        /* 2. Предпросмотр */
        h('div.vte-icon-block', {}, [
            h('div.vte-icon-head', {}, [h('span', { text: 'Предпросмотр' })]),
            els.preview,
            els.previewNote,
        ]),

        /* 3. Куда положить */
        h('div.vte-icon-block', {}, [
            h('div.vte-icon-head', {}, [h('span', { text: 'Куда положить' })]),
            h('div.vte-field', {}, [
                h('label.vte-field-label', { text: 'Роль' }),
                h('div.vte-field-body', {}, [els.roleSeg]),
            ]),
            els.roleNote,
            els.layerRow,
            els.layerNote,
            els.levelRow,
            els.iconBoxRow,
        ]),

        /* 4. Как отображать */
        h('div.vte-icon-block', {}, [
            h('div.vte-icon-head', {}, [h('span', { text: 'Как отображать' })]),
            h('div.vte-field', {}, [
                h('label.vte-field-label', { text: 'Цвет' }),
                h('div.vte-field-body', {}, [els.modeSeg]),
            ]),
            els.maskWarn,
            h('small.vte-note', {
                text: 'Силуэт — картинка перекрашивается в выбранный цвет. Это же значение попадёт в background-color.',
            }),
            els.fitRow,
            els.pxRow,
            els.repeatRow,
            els.positionRow,
            els.blendRow,
        ]),

        /* 5. Эффекты слоя */
        h('div.vte-icon-block', {}, [
            h('div.vte-icon-head', {}, [h('span', { text: 'Эффекты картинки' })]),
            fxSlider('Прозрачность', 'opacity', 0, 100, '%'),
            fxSlider('Размытие', 'blur', 0, 30, 'px'),
            fxSlider('Яркость', 'brightness', 0, 250, '%'),
            fxSlider('Насыщенность', 'saturate', 0, 300, '%'),
            fxSlider('Контраст', 'contrast', 0, 250, '%'),
            fxSlider('Оттенок', 'hue', 0, 360, '°'),
            fxSlider('Ч/б', 'grayscale', 0, 100, '%'),
            els.fxNote,
            h('div.vte-icon-actions', {}, [els.fxResetBtn]),
        ]),

        /* 6. Кнопки */
        h('div.vte-icon-actions', {}, [els.applyBtn]),
        h('div.vte-icon-actions', {}, [els.convertBtn, els.clearBtn]),
    ]);

    container.appendChild(root);
    setMode('image', true);
    renderRoleUI();
    return root;
}


function modeBtn(id, label, title) {
    return h('button.vte-seg-btn', {
        type: 'button', text: label, title,
        dataset: { mode: id },
        on: { click: () => setMode(id) },
    });
}

function roleBtn(id, label, faName, title) {
    return h('button.vte-seg-btn', {
        type: 'button', title,
        dataset: { role: id },
        on: { click: () => setRole(id, { manual: true }) },
    }, [icon(faName), h('span', { text: ' ' + label })]);
}

function layerBtn(id, hint) {
    return h('button.vte-seg-btn', {
        type: 'button', text: id, title: `Слой ${id} — ${hint}`,
        dataset: { layer: id },
        on: { click: () => onRequestLayer?.(id) },
    });
}

function levelBtn(id, label, title) {
    return h('button.vte-seg-btn', {
        type: 'button', text: label, title,
        dataset: { level: id },
        on: {
            click: () => {
                overlayLevel = id;
                renderRoleUI();
            },
        },
    });
}

/* ============================================================
   РОЛЬ РАЗМЕЩЕНИЯ
============================================================ */
/** Роль по текущей цели: угадываем то, что человек скорее всего хотел */
function autoRole() {
    if (glyph || glyphElsewhere) return 'icon';
    if (!ctxInfo.pseudo) return 'background';

    const cs = ctxInfo.computed;
    if (cs && String(cs.position || '') === 'absolute') return 'overlay';

    // Слой уже используется как символ — значит это иконка
    if (cs) {
        const w = parseFloat(cs.width) || 0;
        const fs = parseFloat(cs.fontSize) || 16;
        if (w > 0 && w <= fs * 2.2) return 'icon';
    }
    return 'overlay';
}

function setRole(next, opts = {}) {
    const prev = role;
    role = ['background', 'icon', 'overlay'].includes(next) ? next : 'background';
    if (opts.manual) roleLocked = true;

    if (opts.manual && prev !== role) {
        // Разумные значения по умолчанию для новой роли
        els.fit.value = role === 'icon' ? 'contain' : 'cover';
        els.pxRow.style.display = 'none';
        els.repeat.value = 'no-repeat';
        els.position.value = 'center';
    }

    renderRoleUI();
    renderPreview();

    if (!opts.manual) return;

    // Синхронизируем слой: роли нужен свой тип цели
    if (role === 'background' && ctxInfo.pseudo) {
        onRequestLayer?.('');
    } else if (role !== 'background' && !ctxInfo.pseudo) {
        onRequestLayer?.(glyphElsewhere || '::after');
    }
}

const ROLE_NOTES = {
    background:
        'Картинка ложится на сам элемент, под его текст. Ничего не сдвигает, '
        + 'псевдоэлементы не нужны. Так делают фон заголовка или панели.',
    icon:
        'Картинка живёт в отдельном слое и занимает место как один символ: '
        + 'пишутся content, width, height и выравнивание по центру строки. '
        + 'Так заменяют иконки шрифта.',
    overlay:
        'Картинка растягивается по всему элементу в отдельном слое и вынута из потока '
        + '(position: absolute), поэтому вёрстка не сдвигается вообще.',
};

function renderRoleUI() {
    if (!els.roleSeg) return;

    els.roleSeg.querySelectorAll('.vte-seg-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.role === role));

    els.layerSeg.querySelectorAll('.vte-seg-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.layer === ctxInfo.pseudo));

    els.levelSeg.querySelectorAll('.vte-seg-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.level === overlayLevel));

    els.roleNote.textContent = ROLE_NOTES[role] || '';

    const needsLayer = role !== 'background';
    els.layerRow.style.display = needsLayer ? 'flex' : 'none';
    els.layerNote.style.display = needsLayer ? '' : 'none';
    els.levelRow.style.display = role === 'overlay' ? 'flex' : 'none';
    els.iconBoxRow.style.display = role === 'icon' ? 'flex' : 'none';
    els.pxRow.style.display = els.fit.value === 'px' ? 'flex' : 'none';

    // Силуэт на самом элементе обрежет и текст — предупреждаем
    const risky = role === 'background' && mode === 'mask';
    els.maskWarn.style.display = risky ? '' : 'none';
    els.maskWarn.textContent = risky
        ? 'Силуэт на самом элементе вырежет по маске и текст. Для перекрашиваемого '
          + 'рисунка выберите роль «Иконка» или «Наклейка».'
        : '';

    els.fxNote.textContent = needsLayer
        ? `Пишутся в filter и opacity правила ${ctxInfo.pseudo || '::after'} — `
          + 'содержимое элемента не задето.'
        : 'Эффекты попадут на весь элемент вместе с текстом. Чтобы затронуть только '
          + 'картинку — выберите роль «Наклейка».';
}

/* ============================================================
   ЭФФЕКТЫ ТОЛЬКО ДЛЯ СЛОЯ КАРТИНКИ
============================================================ */
function fxSlider(label, key, min, max, unit) {
    const range = h('input.vte-range', {
        type: 'range', min, max, step: 1, value: String(fx[key]),
    });
    const out = h('span.vte-range-val', { text: `${fx[key]}${unit}` });

    range.addEventListener('input', () => {
        fx[key] = Number(range.value);
        fxDirty = true;
        out.textContent = `${fx[key]}${unit}`;
        renderPreview();
    });
    range.addEventListener('change', () => {
        fx[key] = Number(range.value);
        fxDirty = true;
        out.textContent = `${fx[key]}${unit}`;
        pushFx();
    });

    els[`fx_${key}`] = { range, out, unit };

    return h('div.vte-field', {}, [
        h('label.vte-field-label', { text: label }),
        h('div.vte-field-body', {}, [range, out]),
    ]);
}

function syncFxInputs() {
    for (const key of Object.keys(fx)) {
        const ref = els[`fx_${key}`];
        if (!ref) continue;
        ref.range.value = String(fx[key]);
        ref.out.textContent = `${fx[key]}${ref.unit}`;
    }
}

function fxFilterValue() {
    const parts = [];
    if (fx.blur) parts.push(`blur(${fx.blur}px)`);
    if (fx.brightness !== 100) parts.push(`brightness(${fx.brightness}%)`);
    if (fx.saturate !== 100) parts.push(`saturate(${fx.saturate}%)`);
    if (fx.contrast !== 100) parts.push(`contrast(${fx.contrast}%)`);
    if (fx.hue) parts.push(`hue-rotate(${fx.hue}deg)`);
    if (fx.grayscale) parts.push(`grayscale(${fx.grayscale}%)`);
    return parts.length ? parts.join(' ') : '';
}

function fxOpacityValue() {
    return fx.opacity >= 100 ? '' : (fx.opacity / 100).toFixed(2);
}

function pushFx() {
    onApply({
        'filter': fxFilterValue(),
        'opacity': fxOpacityValue(),
    }, { message: 'Эффекты картинки обновлены' });
}

function defaultFx() {
    return {
        opacity: 100, blur: 0, brightness: 100,
        saturate: 100, contrast: 100, hue: 0, grayscale: 0,
    };
}

function resetFx() {
    fx = defaultFx();
    fxDirty = true;
    syncFxInputs();
    renderPreview();
    pushFx();
}

function readFxFromComputed(cs) {
    const next = defaultFx();
    next.opacity = Math.round((parseFloat(cs.opacity) || 1) * 100);

    const v = String(cs.filter || '');
    if (v && v !== 'none') {
        // Браузер отдаёт то процент, то множитель: grayscale(50%) и
        // grayscale(0.5) — одно и то же. Раньше множитель переводился
        // только для brightness/saturate/contrast, поэтому «Ч/б» и
        // «Оттенок» сбрасывались в ноль.
        const pick = (name) => {
            const m = v.match(new RegExp(`${name}\\(\\s*([\\d.]+)(%?)`));
            if (!m) return null;
            return { n: Number(m[1]), pct: m[2] === '%' };
        };
        const pct = (raw, fallback) => {
            if (!raw) return fallback;
            return Math.round(raw.pct ? raw.n : raw.n * 100);
        };

        next.blur       = pick('blur')?.n ?? 0;
        next.hue        = pick('hue-rotate')?.n ?? 0;
        next.grayscale  = pct(pick('grayscale'), 0);
        next.brightness = pct(pick('brightness'), 100);
        next.saturate   = pct(pick('saturate'), 100);
        next.contrast   = pct(pick('contrast'), 100);
    }

    fx = next;
    syncFxInputs();
}

/* ============================================================
   ОБНОВЛЕНИЕ ПОД ВЫБРАННУЮ ЦЕЛЬ
============================================================ */
export function update(info = {}) {
    const prevElement = ctxInfo.element;

    ctxInfo = {
        selector: info.selector || '',
        pseudo: info.pseudo || '',
        computed: info.computed || null,
        element: info.element || null,
    };
    if (!root) return;

    // Новый элемент — роль снова определяется автоматически
    if (ctxInfo.element !== lastElement) {
        lastElement = ctxInfo.element;
        roleLocked = false;
    }

    const key = `${ctxInfo.selector}|${ctxInfo.pseudo}`;
    const targetChanged = key !== targetKey;

    if (targetChanged) {
        stash = (dirty && els.source.value.trim())
            ? { key: targetKey, text: els.source.value }
            : null;
        dirty = false;
        fxDirty = false;
        targetKey = key;
    }

    detectGlyph();
    renderGlyphBar();

    const cs = ctxInfo.computed;

    if (!roleLocked) setRole(autoRole(), { auto: true });
    renderRoleUI();

    if (!cs) { renderStash(); renderPreview(); return; }

    const maskRaw = firstUrl(cs.maskImage) || firstUrl(cs.webkitMaskImage);
    const bgRaw = firstUrl(cs.backgroundImage);
    const current = maskRaw || bgRaw;

    if (targetChanged) {
        els.source.value = current ? prettifySource(current) : '';
    } else if (current && !dirty && !els.source.value.trim()) {
        els.source.value = prettifySource(current);
    }

    setMode(maskRaw ? 'mask' : 'image', true);

    if (maskRaw) {
        const c = toHex(cs.backgroundColor);
        if (c) setTint(c, true);
    }

    if (targetChanged && !current && glyph) {
        const gc = toHex(glyph.color);
        if (gc) setTint(gc, true);
    }

    if (targetChanged && !current) {
        // Картинки нет — браузер вернёт свои значения по умолчанию,
        // они бессмысленны. Ставим то, что нужно для выбранной роли.
        els.fit.value = role === 'icon' ? 'contain' : 'cover';
        els.pxRow.style.display = 'none';
        els.repeat.value = 'no-repeat';
        els.position.value = 'center';
        els.blend.value = 'normal';
    } else if (current) {
        /* --- Размер рисунка --- */
        const size = (maskRaw ? cs.maskSize : cs.backgroundSize) || 'contain';
        const px = String(size).match(/^(\d+(?:\.\d+)?)px/);
        if (px) {
            els.fit.value = 'px';
            els.px.value = String(Math.round(Number(px[1])));
            els.pxRow.style.display = 'flex';
        } else if (['contain', 'cover', 'auto', '100% 100%'].includes(String(size).trim())) {
            els.fit.value = String(size).trim();
            els.pxRow.style.display = 'none';
        }

        /* --- Повтор --- */
        const rep = String((maskRaw ? cs.maskRepeat : cs.backgroundRepeat) || '')
            .split(',')[0].trim();
        if (['no-repeat', 'repeat', 'repeat-x', 'repeat-y'].includes(rep)) {
            els.repeat.value = rep;
        }

        /* --- Позиция --- */
        const pos = String((maskRaw ? cs.maskPosition : cs.backgroundPosition) || '')
            .split(',')[0].trim();
        if (pos) els.position.value = pos;

        /* --- Наложение --- */
        const blend = String(cs.backgroundBlendMode || 'normal').split(',')[0].trim();
        els.blend.value = blend || 'normal';
    }

    /* --- Размер слоя-иконки --- */
    if (targetChanged && role === 'icon' && cs) {
        const w = String(cs.width || '');
        const fs = parseFloat(cs.fontSize) || 16;
        const wpx = parseFloat(w) || 0;
        // Ширина примерно равна кеглю — значит стоит 1em
        if (wpx && Math.abs(wpx - fs) > 1.5) {
            els.iconBox.value = 'px';
            els.iconBoxPx.value = String(Math.round(wpx));
            els.iconBoxPx.style.display = '';
        } else {
            els.iconBox.value = 'em';
            els.iconBoxPx.style.display = 'none';
        }
    }

    /* --- Уровень наклейки --- */
    if (targetChanged && role === 'overlay' && cs) {
        const z = parseInt(cs.zIndex, 10);
        overlayLevel = Number.isFinite(z) && z < 0 ? 'under' : (Number.isFinite(z) && z > 0 ? 'over' : overlayLevel);
    }

    /* --- Эффекты слоя --- */
    if (targetChanged && !fxDirty) {
        if (current) readFxFromComputed(cs);
        else { fx = defaultFx(); syncFxInputs(); }
    }

    els.convertBtn.disabled = !bgRaw || !!maskRaw;
    renderRoleUI();
    renderStash();
    detectKind();
    renderPreview();
}

/* ---------- Карман для несохранённого ручного ввода ---------- */
function ensureStashBar() {
    if (els.stashBar && els.stashBar.isConnected) return els.stashBar;

    els.stashText = h('span.vte-icon-stash-text', { text: '' });

    els.stashBtn = h('button.vte-icon-stash-btn', {
        type: 'button',
        title: 'Вставить обратно текст, который был в поле до смены элемента',
        on: { click: restoreStash },
    }, [icon('fa-rotate-left'), h('span', { text: ' Вернуть текст' })]);

    els.stashDrop = h('button.vte-icon-stash-close', {
        type: 'button',
        title: 'Забыть',
        on: { click: () => { stash = null; renderStash(); } },
    }, [icon('fa-xmark')]);

    els.stashBar = h('div.vte-icon-stash', { style: 'display:none' }, [
        h('span.vte-icon-stash-ic', {}, [icon('fa-triangle-exclamation')]),
        els.stashText,
        els.stashBtn,
        els.stashDrop,
    ]);

    els.source.insertAdjacentElement('afterend', els.stashBar);
    return els.stashBar;
}

function renderStash() {
    const bar = ensureStashBar();
    if (!stash || !stash.text) {
        bar.style.display = 'none';
        return;
    }
    const preview = stash.text.replace(/\s+/g, ' ').trim().slice(0, 40);
    els.stashText.textContent = `Не применённый текст сохранён: ${preview}…`;
    els.stashText.title = stash.text;
    bar.style.display = 'flex';
}

function restoreStash() {
    if (!stash) return;
    els.source.value = stash.text;
    stash = null;
    dirty = true;
    renderStash();
    detectKind();
    renderPreview();
}

/* ============================================================
   ЦВЕТ СИЛУЭТА

   Поле цвета создаётся по требованию и подставляется сразу под
   предупреждение о маске. Раньше setMode и setTint обращались к
   элементам, которых не существовало: контрол не появлялся вообще,
   а в CSS всё равно уходил жёстко заданный #d1912b.
============================================================ */
function ensureTintRow() {
    if (els.tintRow && els.tintRow.isConnected) return els.tintRow;

    els.tintSwatch = h('button.vte-swatch', {
        type: 'button',
        title: 'Цвет силуэта',
        style: `background:${tint}`,
        on: {
            click: () => {
                if (!picker) return;
                picker.open({
                    anchor: els.tintSwatch,
                    value: tint,
                    allowGradient: false,
                    onChange: (v) => setTint(v),
                    onCommit: (v) => setTint(v),
                });
            },
        },
    });

    els.tintHex = h('input.vte-hex', {
        type: 'text', spellcheck: false, value: tint,
        title: 'HEX-код цвета силуэта',
        on: {
            change: () => {
                const hx = normalizeHex(els.tintHex.value);
                if (hx) setTint(hx);
                else els.tintHex.value = tint;
            },
        },
    });

    els.tintRow = h('div.vte-field', { style: 'display:none' }, [
        h('label.vte-field-label', { text: 'Цвет силуэта' }),
        h('div.vte-field-body', {}, [els.tintSwatch, els.tintHex]),
    ]);

    els.maskWarn.insertAdjacentElement('afterend', els.tintRow);
    return els.tintRow;
}

function setMode(next, quiet) {
    mode = next === 'mask' ? 'mask' : 'image';
    if (els.modeSeg) {
        els.modeSeg.querySelectorAll('.vte-seg-btn').forEach(b =>
            b.classList.toggle('active', b.dataset.mode === mode));
    }
    if (els.maskWarn) {
        ensureTintRow().style.display = mode === 'mask' ? 'flex' : 'none';
    }
    if (!quiet) renderRoleUI();
    renderPreview();
}

function setTint(v, quiet) {
    const hx = normalizeHex(v) || v;
    tint = hx;
    if (els.tintSwatch) els.tintSwatch.style.background = hx;
    if (els.tintHex) els.tintHex.value = hx;
    if (!quiet) renderPreview();
}

/* ============================================================
   РАЗБОР ИСТОЧНИКА
============================================================ */
function onSourceInput() {
    dirty = true;
    detectKind();
    renderPreview();
}

function rawSource() {
    return els.source.value.trim();
}

function detectKind() {
    const s = rawSource();
    els.kind.textContent = '';

    if (!s) { sourceKind = 'none'; return; }

    if (/^<svg[\s>]/i.test(s)) sourceKind = 'svg';
    else if (/^data:/i.test(s)) sourceKind = 'data';
    else if (/^(https?:)?\/\//i.test(s) || /^\/|^\.{1,2}\//.test(s)) sourceKind = 'url';
    else if (/^url\(/i.test(s)) sourceKind = 'data';
    else sourceKind = 'url';

    const labels = {
        svg:  ['fa-code', 'код SVG'],
        data: ['fa-database', 'data-URI'],
        url:  ['fa-link', 'ссылка'],
    };
    const [ic, text] = labels[sourceKind] || ['fa-question', ''];
    els.kind.append(icon(ic), h('span', { text: ' ' + text }));

    // Растровую картинку силуэтом делать бессмысленно
    const raster = sourceKind === 'url' && /\.(png|jpe?g|gif|webp|avif|bmp)(\?|#|$)/i.test(s);
    if (raster && mode === 'mask') {
        setMode('image', true);
        els.kind.append(h('span.vte-icon-warn', { text: ' — растровая, только «Картинка»' }));
    }
}

/** Готовое CSS-значение вида url("...") */
function buildUrlValue() {
    const s = rawSource();
    if (!s) return '';

    if (sourceKind === 'svg') return svgToUrl(s);

    let inner = s;
    const m = s.match(/^url\(\s*(['"]?)([\s\S]*?)\1\s*\)$/i);
    if (m) inner = m[2].trim();

    if (/^data:image\/svg\+xml/i.test(inner)) {
        const body = inner.replace(/^data:image\/svg\+xml,?/i, '');
        if (/[<>#]/.test(body)) return svgToUrl(decodeSafe(body));
        return `url("${inner}")`;
    }

    return `url("${inner.replace(/"/g, '%22')}")`;
}

/** SVG → data-URI, пригодный для CSS */
function svgToUrl(svg) {
    let clean = String(svg)
        .replace(/<\?xml[\s\S]*?\?>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\s+/g, ' ')
        .replace(/"/g, "'")
        .trim();

    if (!/xmlns=/i.test(clean)) {
        clean = clean.replace(/^<svg/i, "<svg xmlns='http://www.w3.org/2000/svg'");
    }

    const enc = clean
        .replace(/%/g, '%25')
        .replace(/#/g, '%23')
        .replace(/&/g, '%26')
        .replace(/</g, '%3C')
        .replace(/>/g, '%3E')
        .replace(/{/g, '%7B')
        .replace(/}/g, '%7D')
        .replace(/\|/g, '%7C')
        .replace(/\^/g, '%5E')
        .replace(/`/g, '%60');

    return `url("data:image/svg+xml,${enc}")`;
}

/** Обратно в читаемый вид, чтобы можно было поправить руками */
function prettifySource(urlValue) {
    const m = String(urlValue).match(/^url\(\s*(['"]?)([\s\S]*?)\1\s*\)$/i);
    const inner = m ? m[2].trim() : String(urlValue).trim();

    if (/^data:image\/svg\+xml/i.test(inner)) {
        const body = inner.replace(/^data:image\/svg\+xml,?/i, '');
        const svg = decodeSafe(body);
        if (/^<svg[\s>]/i.test(svg)) {
            return svg.replace(/></g, '>\n<');
        }
    }
    return inner;
}

function decodeSafe(v) {
    let s = String(v);
    if (/^base64,/i.test(s)) {
        try { return atob(s.replace(/^base64,/i, '')); } catch { return s; }
    }
    try { return decodeURIComponent(s); } catch { return s; }
}

function firstUrl(v) {
    const s = String(v || '');
    if (!s || s === 'none') return '';
    const m = s.match(/url\(\s*(['"]?)([\s\S]*?)\1\s*\)/i);
    return m ? `url("${m[2]}")` : '';
}

/* ============================================================
   ПРЕДПРОСМОТР
============================================================ */
function sizeValue() {
    return els.fit.value === 'px'
        ? `${Number(els.px.value) || 24}px ${Number(els.px.value) || 24}px`
        : els.fit.value;
}

function repeatValue() {
    return els.repeat ? els.repeat.value : 'no-repeat';
}

function positionValue() {
    const v = els.position ? els.position.value.trim() : '';
    return v || 'center';
}

function blendValue() {
    return els.blend ? els.blend.value : 'normal';
}

/** Размер слоя для роли «Иконка»: 1em или точные px */
function iconBoxValue() {
    if (!els.iconBox || els.iconBox.value === 'em') return '1em';
    const n = Number(els.iconBoxPx.value) || 20;
    return `${n}px`;
}

function renderPreview() {
    if (!els.preview) return;
    const url = buildUrlValue();
    const box = els.preview;

    box.style.cssText = '';
    box.style.mask = '';
    box.style.webkitMask = '';

    if (!url) {
        if (glyph) {
            box.classList.remove('vte-icon-preview-empty');
            box.textContent = '';
            box.appendChild(h('span.vte-icon-glyph-sample', {
                text: glyph.char,
                title: `U+${glyph.code.toUpperCase()} · ${glyph.family}`,
                style: `font-family:${glyph.family} !important;`
                    + `font-weight:${glyph.weight} !important;`
                    + `font-style:normal !important;`
                    + `color:${glyph.color};font-size:54px;line-height:1;`,
            }));
            els.applyBtn.disabled = true;
            return;
        }

        box.classList.add('vte-icon-preview-empty');
        box.textContent = 'Вставьте ссылку или код SVG выше';
        els.applyBtn.disabled = true;
        return;
    }

    box.classList.remove('vte-icon-preview-empty');
    box.textContent = '';
    els.applyBtn.disabled = false;

    const size = sizeValue();
    const repeat = repeatValue();
    const pos = positionValue();

    if (mode === 'mask') {
        box.style.backgroundColor = tint;
        box.style.maskImage = url;
        box.style.webkitMaskImage = url;
        box.style.maskRepeat = repeat;
        box.style.webkitMaskRepeat = repeat;
        box.style.maskPosition = pos;
        box.style.webkitMaskPosition = pos;
        box.style.maskSize = size;
        box.style.webkitMaskSize = size;
    } else {
        box.style.backgroundImage = url;
        box.style.backgroundRepeat = repeat;
        box.style.backgroundPosition = pos;
        box.style.backgroundSize = size;
        box.style.backgroundBlendMode = blendValue();
    }

    box.style.filter = fxFilterValue();
    box.style.opacity = fxOpacityValue() || '1';
}

/* ============================================================
   ПРИМЕНЕНИЕ
============================================================ */
/** Нужно ли ставить элементу position:relative под наклейку */
function hostNeedsRelative() {
    const el = ctxInfo.element;
    if (!el || el.nodeType !== 1) return true;
    try {
        const p = String(getComputedStyle(el).position || 'static');
        return p === 'static';
    } catch {
        return true;
    }
}

function apply() {
    const url = buildUrlValue();
    if (!url) return;

    const size = sizeValue();
    const repeat = repeatValue();
    const pos = positionValue();
    const decls = {};

    /* ---- Сам рисунок ---- */
    if (mode === 'mask') {
        decls['mask-image'] = url;
        decls['-webkit-mask-image'] = url;
        decls['mask-repeat'] = repeat;
        decls['-webkit-mask-repeat'] = repeat;
        decls['mask-position'] = pos;
        decls['-webkit-mask-position'] = pos;
        decls['mask-size'] = size;
        decls['-webkit-mask-size'] = size;
        decls['background-color'] = tint;
        decls['background-image'] = 'none';
        decls['background-blend-mode'] = '';
    } else {
        decls['background-image'] = url;
        decls['background-repeat'] = repeat;
        decls['background-position'] = pos;
        decls['background-size'] = size;
        decls['background-blend-mode'] = blendValue() === 'normal' ? '' : blendValue();
        decls['mask-image'] = 'none';
        decls['-webkit-mask-image'] = 'none';
    }

    decls['filter'] = fxFilterValue();
    decls['opacity'] = fxOpacityValue();

    /* ---- Каркас слоя: главное исправление ----
       Раньше псевдоэлемент получал content и картинку, но не получал размеров.
       Блок 0×0 не показывает фон вообще, поэтому картинка «не вставлялась». */
    let hostDecls = null;

    if (role === 'icon') {
        const box = iconBoxValue();
        decls['content'] = '""';
        decls['display'] = 'inline-block';
        decls['width'] = box;
        decls['height'] = box;
        decls['min-width'] = box;
        decls['min-height'] = box;
        decls['flex-shrink'] = '0';
        decls['vertical-align'] = 'middle';
        // Остатки роли «Наклейка», если переключились с неё
        decls['position'] = '';
        decls['top'] = '';
        decls['right'] = '';
        decls['bottom'] = '';
        decls['left'] = '';
        decls['pointer-events'] = '';
        decls['z-index'] = '';
    } else if (role === 'overlay') {
        decls['content'] = '""';
        decls['display'] = 'block';
        decls['position'] = 'absolute';
        decls['top'] = '0';
        decls['right'] = '0';
        decls['bottom'] = '0';
        decls['left'] = '0';
        decls['pointer-events'] = 'none';
        decls['z-index'] = overlayLevel === 'under' ? '-1' : '2';
        // Слой растянут по элементу — фиксированные габариты не нужны
        decls['width'] = '';
        decls['height'] = '';
        decls['min-width'] = '';
        decls['min-height'] = '';
        decls['flex-shrink'] = '';
        decls['vertical-align'] = '';

        // Абсолютный слой считает координаты от ближайшего позиционированного
        // предка. Без relative он уедет к краю окна.
        // isolation:isolate замыкает z-index:-1 внутри элемента: картинка
        // остаётся над его фоном и под его текстом.
        hostDecls = {};
        if (hostNeedsRelative()) hostDecls['position'] = 'relative';
        if (overlayLevel === 'under') hostDecls['isolation'] = 'isolate';
        if (!Object.keys(hostDecls).length) hostDecls = null;
    } else {
        // Фон самого элемента: структурные свойства не трогаем вообще
        decls['content'] = '';
    }

    dirty = false;
    stash = null;
    renderStash();

    const hoverDecls = mode === 'mask'
        ? { ...decls, 'background-color': lighten(tint, 0.2) }
        : null;

    const messages = {
        background: 'Картинка положена на фон элемента',
        icon: glyph
            ? 'Иконка шрифта скрыта, на её месте ваша картинка'
            : 'Картинка поставлена как иконка',
        overlay: overlayLevel === 'under'
            ? 'Наклейка положена под текст, вёрстка не сдвинута'
            : 'Наклейка положена поверх содержимого',
    };

    onApply(decls, {
        hoverDecls,
        hostDecls,
        // В каком соседнем слое лежит неубранный глиф: inspector.js погасит его,
        // иначе старая иконка шрифта рисуется поверх новой картинки.
        glyphElsewhere: (role !== 'background' && glyphElsewhere) ? glyphElsewhere : null,
        message: messages[role] || 'Применено',
    });
}

/** Осветлить цвет: нужно для состояния наведения */
function lighten(color, amount) {
    const hx = toHex(color) || '#ffffff';
    const n = parseInt(hx.slice(1), 16);
    const up = (c) => Math.round(c + (255 - c) * amount);
    const r = up((n >> 16) & 255);
    const g = up((n >> 8) & 255);
    const b = up(n & 255);
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

/** Переносит уже стоящую background-image в маску, ничего не перекодируя */
function convertCurrent() {
    const cs = ctxInfo.computed;
    const bg = firstUrl(cs?.backgroundImage);
    if (!bg) return;

    els.source.value = prettifySource(bg);
    detectKind();

    const guess = guessSvgColor(prettifySource(bg));
    if (guess) setTint(guess, true);

    setMode('mask', true);
    renderPreview();
    apply();
}

/** Достаёт цвет из stroke или fill, чтобы силуэт получился того же оттенка */
function guessSvgColor(svg) {
    const m = String(svg).match(/(?:stroke|fill)\s*=\s*['"]?(#[0-9a-f]{3,8})/i);
    if (m) return normalizeHex(m[1]);
    return null;
}

function clearIcon() {
    const empty = {
        'mask-image': '',
        '-webkit-mask-image': '',
        'mask-repeat': '',
        '-webkit-mask-repeat': '',
        'mask-position': '',
        '-webkit-mask-position': '',
        'mask-size': '',
        '-webkit-mask-size': '',
        'background-image': '',
        'background-repeat': '',
        'background-position': '',
        'background-size': '',
        'background-blend-mode': '',
        'background-color': '',
        'filter': '',
        'opacity': '',
        // Каркас слоя, который расширение добавляло само
        'content': '',
        'display': '',
        'width': '',
        'height': '',
        'min-width': '',
        'min-height': '',
        'flex-shrink': '',
        'vertical-align': '',
        'position': '',
        'top': '',
        'right': '',
        'bottom': '',
        'left': '',
        'pointer-events': '',
        'z-index': '',
    };
    fx = defaultFx();
    fxDirty = false;
    syncFxInputs();
    els.source.value = '';
    dirty = false;
    detectKind();
    renderPreview();

    onApply(empty, {
        hoverDecls: { ...empty },
        // Снимаем и то, что дописывали самому элементу под наклейку
        hostDecls: { 'position': '', 'isolation': '' },
        message: 'Картинка и её каркас убраны',
    });
}

/* ============================================================
   ЦВЕТОВЫЕ УТИЛИТЫ
============================================================ */
function normalizeHex(v) {
    if (!v) return null;
    let s = String(v).trim();
    if (!s.startsWith('#')) s = '#' + s;
    if (/^#[0-9a-f]{3}$/i.test(s)) {
        return '#' + s.slice(1).split('').map(c => c + c).join('').toLowerCase();
    }
    if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
    if (/^#[0-9a-f]{8}$/i.test(s)) return s.slice(0, 7).toLowerCase();
    return null;
}

function toHex(value) {
    const v = String(value || '').trim();
    if (!v || /transparent|rgba\(0, 0, 0, 0\)/i.test(v)) return null;
    const hx = normalizeHex(v);
    if (hx) return hx;
    const m = v.match(/^rgba?\(([^)]+)\)$/i);
    if (!m) return null;
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return '#' + [p[0], p[1], p[2]]
        .map(n => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, '0'))
        .join('');
}

/* ============================================================
   ИКОНКИ ИЗ ШРИФТА (Font Awesome и подобные)
============================================================ */
const FA_FAMILY_RE = /font\s*awesome|fontawesome|glyphicon|material|icomoon|feather/i;

function decodeContent(raw) {
    let s = String(raw ?? '').trim();
    if (!s || s === 'none' || s === 'normal') return '';
    const q = s.match(/^(['"])([\s\S]*)\1$/);
    if (q) s = q[2];
    return s.replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex) => {
        try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ''; }
    });
}

function isGlyphChar(s) {
    if (!s) return false;
    const chars = Array.from(s);
    if (chars.length !== 1) return false;
    const cp = chars[0].codePointAt(0);
    return cp >= 0xe000 && cp <= 0xf8ff;
}

function readGlyph(element, p) {
    if (!element || element.nodeType !== 1) return null;
    let cs;
    try { cs = p ? getComputedStyle(element, p) : getComputedStyle(element); }
    catch { return null; }
    if (!cs) return null;

    const ch = decodeContent(cs.content);
    if (!isGlyphChar(ch)) return null;

    let family = String(cs.fontFamily || '').trim();
    if (!family || !FA_FAMILY_RE.test(family)) {
        family = `'Font Awesome 6 Free', 'Font Awesome 6 Pro', `
            + `'Font Awesome 5 Free', 'FontAwesome', ${family || 'sans-serif'}`;
    }

    return {
        char: ch,
        code: ch.codePointAt(0).toString(16),
        family,
        weight: String(cs.fontWeight || '900'),
        size: cs.fontSize || '16px',
        color: cs.color || '#ffffff',
        pseudo: p || '',
    };
}

function detectGlyph() {
    const element = ctxInfo.element;
    glyph = readGlyph(element, ctxInfo.pseudo);
    glyphElsewhere = null;
    if (glyph) return;

    for (const p of ['::before', '::after']) {
        if (p === ctxInfo.pseudo) continue;
        if (readGlyph(element, p)) { glyphElsewhere = p; break; }
    }
}

/* ---------- Полоска-подсказка про глиф ---------- */
function ensureGlyphBar() {
    if (els.glyphBar && els.glyphBar.isConnected) return els.glyphBar;

    els.glyphIc = h('span.vte-icon-stash-ic', {}, [icon('fa-icons')]);
    els.glyphText = h('span.vte-icon-stash-text', { text: '' });

    els.glyphImgBtn = h('button.vte-icon-stash-btn', {
        type: 'button',
        title: 'Превратить глиф в PNG-картинку в исходном цвете',
        on: { click: () => useGlyphAsImage(false) },
    }, [icon('fa-image'), h('span', { text: ' Как картинку' })]);

    els.glyphMaskBtn = h('button.vte-icon-stash-btn', {
        type: 'button',
        title: 'Превратить глиф в силуэт: цвет станет обычным CSS-свойством',
        on: { click: () => useGlyphAsImage(true) },
    }, [icon('fa-fill-drip'), h('span', { text: ' Как силуэт' })]);

    els.glyphGoBtn = h('button.vte-icon-stash-btn', {
        type: 'button',
        title: 'Переключиться на слой, в котором лежит иконка шрифта',
        on: { click: () => onRequestLayer?.(glyphElsewhere) },
    }, [icon('fa-layer-group'), h('span', { text: ' Перейти' })]);

    els.glyphBar = h('div.vte-icon-stash.vte-icon-glyph', { style: 'display:none' }, [
        els.glyphIc, els.glyphText, els.glyphImgBtn, els.glyphMaskBtn, els.glyphGoBtn,
    ]);

    els.source.insertAdjacentElement('beforebegin', els.glyphBar);
    return els.glyphBar;
}

function renderGlyphBar() {
    const bar = ensureGlyphBar();

    if (glyph) {
        els.glyphText.textContent =
            `В этом слое стоит иконка шрифта ${glyph.char} (U+${glyph.code.toUpperCase()}). `
            + 'Вставьте своё изображение и нажмите «Применить» — глиф скроется сам.';
        els.glyphText.title = glyph.family;
        els.glyphImgBtn.style.display = 'inline-flex';
        els.glyphMaskBtn.style.display = 'inline-flex';
        els.glyphGoBtn.style.display = 'none';
        bar.style.display = 'flex';
        return;
    }

    if (glyphElsewhere && onRequestLayer) {
        els.glyphText.textContent =
            `Иконка шрифта нарисована в слое ${glyphElsewhere}. `
            + 'Чтобы заменить именно её — перейдите туда.';
        els.glyphText.title = '';
        els.glyphImgBtn.style.display = 'none';
        els.glyphMaskBtn.style.display = 'none';
        els.glyphGoBtn.style.display = 'inline-flex';
        bar.style.display = 'flex';
        return;
    }

    bar.style.display = 'none';
}

/* ---------- Глиф → картинка ---------- */
function glyphToDataUrl(g, px, color) {
    const size = Math.max(32, Math.min(512, Number(px) || 160));
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = color || '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${g.weight || 900} ${Math.round(size * 0.8)}px ${g.family}`;
    ctx.fillText(g.char, size / 2, size / 2);

    try { return canvas.toDataURL('image/png'); } catch { return null; }
}

async function useGlyphAsImage(asMask) {
    if (!glyph) return;
    const g = glyph;

    try { await document.fonts.load(`${g.weight} 160px ${g.family}`, g.char); } catch {}

    const color = asMask ? '#ffffff' : (toHex(g.color) || '#ffffff');
    const url = glyphToDataUrl(g, 160, color);

    if (!url) {
        els.glyphText.textContent = 'Не удалось превратить глиф в картинку. '
            + 'Вставьте изображение вручную.';
        return;
    }

    els.source.value = url;
    dirty = true;
    detectKind();
    setMode(asMask ? 'mask' : 'image', true);
    setRole('icon', { manual: true });
    if (asMask) setTint(toHex(g.color) || '#ffffff', true);
    renderPreview();

    els.glyphText.textContent = asMask
        ? 'Глиф превращён в силуэт. Выберите цвет и нажмите «Применить».'
        : 'Глиф превращён в картинку. Нажмите «Применить».';
}
