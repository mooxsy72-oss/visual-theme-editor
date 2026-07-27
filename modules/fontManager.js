// modules/fontManager.js
// Менеджер Google Fonts: список, фильтр по алфавитам (кириллица и др.),
// живой предпросмотр интерфейса, автоматический @import + font-family.

let onFontSelected = null;
let onPreviewStart = null;
let onPreviewEnd = null;

let container = null;
let loadedFonts = new Set();
let previewFont = null;
let previewStyleEl = null;

// Куда применять шрифт
const TARGETS = [
    { id: 'ui',      label: 'Весь интерфейс',      selector: 'body, button, input, select, textarea, .drawer-content, .popup' },
    { id: 'chat',    label: 'Текст сообщений',     selector: '.mes_text, .mes_text p' },
    { id: 'names',   label: 'Имена персонажей',    selector: '.mes .ch_name .name_text' },
    { id: 'italics', label: 'Курсив в сообщениях', selector: '.mes_text em, .mes_text i' },
    { id: 'quotes',  label: 'Речь в кавычках',     selector: '.mes_text q' },
    { id: 'headers', label: 'Заголовки панелей',   selector: '.standoutHeader, .inline-drawer-header, .drawer-content h4' },
    { id: 'input',   label: 'Поле ввода',          selector: '#send_textarea' },
    { id: 'custom',  label: 'Свой селектор',       selector: '' },
];

const CATEGORIES = [
    ['all', 'Все'],
    ['sans', 'Sans'],
    ['serif', 'Serif'],
    ['display', 'Декор'],
    ['handwriting', 'Рукопис.'],
    ['monospace', 'Mono'],
];

const CATEGORY_LABELS = {
    sans: 'sans',
    serif: 'serif',
    display: 'декор',
    handwriting: 'рукопис.',
    monospace: 'mono',
};

/* ============================================================
   БИБЛИОТЕКА ШРИФТОВ
   c = категория, s = алфавиты, w = веса
============================================================ */
const FONTS = [
    // ── Кириллица: sans-serif ──
    { n: 'Roboto',            c: 'sans', s: ['cyrillic','latin'], w: [100,300,400,500,700,900] },
    { n: 'Open Sans',         c: 'sans', s: ['cyrillic','latin'], w: [300,400,600,700,800] },
    { n: 'Montserrat',        c: 'sans', s: ['cyrillic','latin'], w: [100,300,400,500,600,700,800,900] },
    { n: 'Inter',             c: 'sans', s: ['cyrillic','latin'], w: [100,300,400,500,600,700,800,900] },
    { n: 'Nunito',            c: 'sans', s: ['cyrillic','latin'], w: [200,300,400,600,700,800,900] },
    { n: 'Nunito Sans',       c: 'sans', s: ['cyrillic','latin'], w: [200,300,400,600,700,800] },
    { n: 'Rubik',             c: 'sans', s: ['cyrillic','latin'], w: [300,400,500,600,700,800,900] },
    { n: 'Manrope',           c: 'sans', s: ['cyrillic','latin'], w: [200,300,400,500,600,700,800] },
    { n: 'Raleway',           c: 'sans', s: ['cyrillic','latin'], w: [100,300,400,500,600,700,800,900] },
    { n: 'Fira Sans',         c: 'sans', s: ['cyrillic','latin'], w: [100,300,400,500,700,900] },
    { n: 'PT Sans',           c: 'sans', s: ['cyrillic','latin'], w: [400,700] },
    { n: 'PT Sans Narrow',    c: 'sans', s: ['cyrillic','latin'], w: [400,700] },
    { n: 'Ubuntu',            c: 'sans', s: ['cyrillic','latin'], w: [300,400,500,700] },
    { n: 'Oswald',            c: 'sans', s: ['cyrillic','latin'], w: [200,300,400,500,600,700] },
    { n: 'Exo 2',             c: 'sans', s: ['cyrillic','latin'], w: [100,300,400,500,600,700,800,900] },
    { n: 'Jost',              c: 'sans', s: ['cyrillic','latin'], w: [100,300,400,500,600,700,800,900] },
    { n: 'Comfortaa',         c: 'sans', s: ['cyrillic','latin'], w: [300,400,500,600,700] },
    { n: 'Golos Text',        c: 'sans', s: ['cyrillic','latin'], w: [400,500,600,700,800,900] },
    { n: 'Onest',             c: 'sans', s: ['cyrillic','latin'], w: [100,300,400,500,600,700,800,900] },
    { n: 'Unbounded',         c: 'sans', s: ['cyrillic','latin'], w: [200,300,400,500,600,700,800,900] },
    { n: 'Commissioner',      c: 'sans', s: ['cyrillic','latin'], w: [100,300,400,500,600,700,800,900] },
    { n: 'Alegreya Sans',     c: 'sans', s: ['cyrillic','latin'], w: [100,300,400,500,700,800,900] },
    { n: 'Anonymous Pro',     c: 'sans', s: ['cyrillic','latin'], w: [400,700] },

    // ── Кириллица: serif ──
    { n: 'Playfair Display',  c: 'serif', s: ['cyrillic','latin'], w: [400,500,600,700,800,900] },
    { n: 'Merriweather',      c: 'serif', s: ['cyrillic','latin'], w: [300,400,700,900] },
    { n: 'PT Serif',          c: 'serif', s: ['cyrillic','latin'], w: [400,700] },
    { n: 'Lora',              c: 'serif', s: ['cyrillic','latin'], w: [400,500,600,700] },
    { n: 'EB Garamond',       c: 'serif', s: ['cyrillic','latin'], w: [400,500,600,700,800] },
    { n: 'Cormorant',         c: 'serif', s: ['cyrillic','latin'], w: [300,400,500,600,700] },
    { n: 'Cormorant Garamond',c: 'serif', s: ['cyrillic','latin'], w: [300,400,500,600,700] },
    { n: 'Alice',             c: 'serif', s: ['cyrillic','latin'], w: [400] },
    { n: 'Vollkorn',          c: 'serif', s: ['cyrillic','latin'], w: [400,500,600,700,800,900] },
    { n: 'Spectral',          c: 'serif', s: ['cyrillic','latin'], w: [200,300,400,500,600,700,800] },
    { n: 'Literata',          c: 'serif', s: ['cyrillic','latin'], w: [200,300,400,500,600,700,800,900] },
    { n: 'Noto Serif',        c: 'serif', s: ['cyrillic','latin'], w: [100,300,400,500,600,700,800,900] },
    { n: 'Alegreya',          c: 'serif', s: ['cyrillic','latin'], w: [400,500,600,700,800,900] },
    { n: 'Prata',             c: 'serif', s: ['cyrillic','latin'], w: [400] },
    { n: 'Ledger',            c: 'serif', s: ['cyrillic','latin'], w: [400] },
    { n: 'Bitter',            c: 'serif', s: ['cyrillic','latin'], w: [100,300,400,500,600,700,800,900] },

    // ── Кириллица: рукописные и декоративные ──
    { n: 'Caveat',            c: 'handwriting', s: ['cyrillic','latin'], w: [400,500,600,700] },
    { n: 'Bad Script',        c: 'handwriting', s: ['cyrillic','latin'], w: [400] },
    { n: 'Marck Script',      c: 'handwriting', s: ['cyrillic','latin'], w: [400] },
    { n: 'Pacifico',          c: 'handwriting', s: ['cyrillic','latin'], w: [400] },
    { n: 'Neucha',            c: 'handwriting', s: ['cyrillic','latin'], w: [400] },
    { n: 'Playball',          c: 'handwriting', s: ['latin'], w: [400] },
    { n: 'Yeseva One',        c: 'display', s: ['cyrillic','latin'], w: [400] },
    { n: 'Ruslan Display',    c: 'display', s: ['cyrillic','latin'], w: [400] },
    { n: 'Underdog',          c: 'display', s: ['cyrillic','latin'], w: [400] },
    { n: 'Kelly Slab',        c: 'display', s: ['cyrillic','latin'], w: [400] },
    { n: 'Russo One',         c: 'display', s: ['cyrillic','latin'], w: [400] },
    { n: 'Press Start 2P',    c: 'display', s: ['cyrillic','latin'], w: [400] },

    // ── Кириллица: monospace ──
    { n: 'JetBrains Mono',    c: 'monospace', s: ['cyrillic','latin'], w: [100,300,400,500,600,700,800] },
    { n: 'IBM Plex Mono',     c: 'monospace', s: ['cyrillic','latin'], w: [100,300,400,500,600,700] },
    { n: 'Roboto Mono',       c: 'monospace', s: ['cyrillic','latin'], w: [100,300,400,500,600,700] },
    { n: 'Source Code Pro',   c: 'monospace', s: ['cyrillic','latin'], w: [200,300,400,500,600,700,800,900] },
    { n: 'Fira Code',         c: 'monospace', s: ['cyrillic','latin'], w: [300,400,500,600,700] },

    // ── Только латиница ──
    { n: 'Cinzel',            c: 'serif', s: ['latin'], w: [400,500,600,700,800,900] },
    { n: 'Cinzel Decorative', c: 'display', s: ['latin'], w: [400,700,900] },
    { n: 'Great Vibes',       c: 'handwriting', s: ['latin'], w: [400] },
    { n: 'Dancing Script',    c: 'handwriting', s: ['latin'], w: [400,500,600,700] },
    { n: 'Parisienne',        c: 'handwriting', s: ['latin'], w: [400] },
    { n: 'Sacramento',        c: 'handwriting', s: ['latin'], w: [400] },
    { n: 'Tangerine',         c: 'handwriting', s: ['latin'], w: [400,700] },
    { n: 'Cormorant Unicase', c: 'serif', s: ['latin'], w: [300,400,500,600,700] },
    { n: 'Marcellus',         c: 'serif', s: ['latin'], w: [400] },
    { n: 'Italiana',          c: 'serif', s: ['latin'], w: [400] },
    { n: 'Bodoni Moda',       c: 'serif', s: ['latin'], w: [400,500,600,700,800,900] },
    { n: 'Libre Baskerville', c: 'serif', s: ['latin'], w: [400,700] },
    { n: 'Crimson Text',      c: 'serif', s: ['latin'], w: [400,600,700] },
    { n: 'Josefin Sans',      c: 'sans', s: ['latin'], w: [100,200,300,400,500,600,700] },
    { n: 'Poppins',           c: 'sans', s: ['latin'], w: [100,200,300,400,500,600,700,800,900] },
    { n: 'Quicksand',         c: 'sans', s: ['latin'], w: [300,400,500,600,700] },
    { n: 'Lexend',            c: 'sans', s: ['latin'], w: [100,200,300,400,500,600,700,800,900] },
    { n: 'Outfit',            c: 'sans', s: ['latin'], w: [100,200,300,400,500,600,700,800,900] },
    { n: 'Space Grotesk',     c: 'sans', s: ['latin'], w: [300,400,500,600,700] },
    { n: 'Orbitron',          c: 'display', s: ['latin'], w: [400,500,600,700,800,900] },
    { n: 'Audiowide',         c: 'display', s: ['latin'], w: [400] },
    { n: 'Creepster',         c: 'display', s: ['latin'], w: [400] },
    { n: 'Nosifer',           c: 'display', s: ['latin'], w: [400] },
    { n: 'Special Elite',     c: 'display', s: ['latin'], w: [400] },
    { n: 'Silkscreen',        c: 'display', s: ['latin'], w: [400,700] },
    { n: 'VT323',             c: 'monospace', s: ['latin'], w: [400] },
    { n: 'Share Tech Mono',   c: 'monospace', s: ['latin'], w: [400] },
];

const SAMPLE_CYR = 'Съешь ещё этих мягких булок';
const SAMPLE_LAT = 'The quick brown fox jumps';

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

function checkbox(id, label, checked, onChange) {
    const input = h('input', { type: 'checkbox', id, checked: !!checked });
    if (typeof onChange === 'function') input.addEventListener('change', onChange);
    return h('label.vte-check', {}, [input, h('span', { text: label })]);
}

/* ============================================================
   ИНИЦИАЛИЗАЦИЯ
============================================================ */
export function init(options = {}) {
    onFontSelected = options.onFontSelected || (() => {});
    onPreviewStart = options.onPreviewStart || (() => {});
    onPreviewEnd = options.onPreviewEnd || (() => {});
    ensurePreviewStyle();
}

export function mount(el) {
    if (!el) return;
    container = el;
    renderShell();
    bindControls();
    renderList();
}

function ensurePreviewStyle() {
    if (previewStyleEl && previewStyleEl.isConnected) return;
    previewStyleEl = document.createElement('style');
    previewStyleEl.id = 'vte-font-preview';
    document.head.appendChild(previewStyleEl);
}

/* ============================================================
   РАЗМЕТКА ВКЛАДКИ
============================================================ */
function renderShell() {
    container.textContent = '';
    container.classList.add('vte-fonts');

    const search = h('input#vte-font-search.vte-input', {
        type: 'text', placeholder: 'Название шрифта…', spellcheck: false,
    });
    const clearBtn = h('button#vte-font-clear.vte-icon-btn', {
        type: 'button', title: 'Очистить поиск',
    }, [icon('fa-xmark')]);

    const searchRow = h('div.vte-fonts-search', {}, [
        h('span.vte-search-ic', {}, [icon('fa-magnifying-glass')]),
        search,
        clearBtn,
    ]);

    const toggles = h('div.vte-fonts-toggles', {}, [
        checkbox('vte-font-cyrillic', 'Только кириллица', true),
        checkbox('vte-font-live', 'Живой предпросмотр', true),
        checkbox('vte-font-extra-weights', 'Импорт 300/400/700', false),
    ]);

    const cats = h('div.vte-fonts-cats', {}, CATEGORIES.map(([id, label], i) => {
        const btn = h('button.vte-font-cat', {
            type: 'button', dataset: { cat: id }, text: label,
        });
        if (i === 0) btn.classList.add('active');
        return btn;
    }));

    const targetSelect = h('select#vte-font-target.vte-select', {},
        TARGETS.map(t => h('option', { value: t.id, text: t.label })));

    const customInput = h('input#vte-font-custom.vte-input', {
        type: 'text', spellcheck: false, placeholder: '.mes_text, #send_textarea',
    });

    const customRow = h('div#vte-font-custom-row.vte-row', { style: 'display:none' }, [
        h('span.vte-label', { text: 'Селектор' }),
        customInput,
    ]);

    const weightSelect = h('select#vte-font-weight.vte-select', {}, [
        h('option', { value: '400', text: '400 (обычный)' }),
    ]);

    const options = h('div.vte-fonts-options', {}, [
        h('div.vte-row', {}, [
            h('span.vte-label', { text: 'Применить к' }),
            targetSelect,
        ]),
        customRow,
        h('div.vte-row', {}, [
            h('span.vte-label', { text: 'Насыщенность' }),
            weightSelect,
        ]),
    ]);

    const counter = h('div.vte-fonts-counter', {}, [
        h('span#vte-font-count', { text: '0' }),
        h('span', { text: ' из ' }),
        h('span#vte-font-total', { text: String(FONTS.length) }),
    ]);

    const list = h('div#vte-font-list.vte-fonts-list');

    const current = h('div#vte-font-current.vte-fonts-current', {}, [
        h('span.vte-font-current-ic', {}, [icon('fa-font')]),
        h('strong', { text: 'шрифт не выбран' }),
    ]);

    const applyBtn = h('button#vte-font-apply.vte-btn.vte-btn-primary', {
        type: 'button', disabled: true,
    }, [icon('fa-check'), h('span', { text: ' Применить' })]);

    const footer = h('div.vte-fonts-footer', {}, [current, applyBtn]);

    container.append(searchRow, toggles, cats, options, counter, list, footer);
}

/* ============================================================
   ОБРАБОТЧИКИ УПРАВЛЕНИЯ
============================================================ */
function bindControls() {
    const q = (sel) => container.querySelector(sel);

    q('#vte-font-search').addEventListener('input', renderList);
    q('#vte-font-clear').addEventListener('click', () => {
        q('#vte-font-search').value = '';
        renderList();
    });
    q('#vte-font-cyrillic').addEventListener('change', renderList);

    q('#vte-font-live').addEventListener('change', (e) => {
        if (!e.target.checked) clearPreview();
        else if (previewFont) applyPreview(previewFont);
    });

    container.querySelectorAll('.vte-font-cat').forEach(btn => {
        btn.addEventListener('click', () => {
            container.querySelectorAll('.vte-font-cat').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderList();
        });
    });

    q('#vte-font-target').addEventListener('change', (e) => {
        const isCustom = e.target.value === 'custom';
        q('#vte-font-custom-row').style.display = isCustom ? 'flex' : 'none';
        if (previewFont) applyPreview(previewFont);
    });

    q('#vte-font-custom').addEventListener('change', () => {
        if (previewFont) applyPreview(previewFont);
    });

    q('#vte-font-weight').addEventListener('change', () => {
        if (previewFont) applyPreview(previewFont);
    });

    q('#vte-font-apply').addEventListener('click', commit);
}

/* ============================================================
   СПИСОК ШРИФТОВ
============================================================ */
function renderList() {
    const q = (sel) => container.querySelector(sel);
    const list = q('#vte-font-list');
    if (!list) return;

    const term = q('#vte-font-search').value.trim().toLowerCase();
    const cyrOnly = q('#vte-font-cyrillic').checked;
    const cat = container.querySelector('.vte-font-cat.active')?.dataset.cat || 'all';

    const items = FONTS.filter(f => {
        if (cyrOnly && !f.s.includes('cyrillic')) return false;
        if (cat !== 'all' && f.c !== cat) return false;
        if (term && !f.n.toLowerCase().includes(term)) return false;
        return true;
    });

    q('#vte-font-count').textContent = String(items.length);
    q('#vte-font-total').textContent = String(FONTS.length);

    list.textContent = '';

    if (!items.length) {
        list.appendChild(h('div.vte-fonts-empty', {}, [
            h('span.vte-empty-ic', {}, [icon('fa-font')]),
            h('div', { text: 'Ничего не найдено' }),
            h('small', { text: 'Снимите фильтр кириллицы или очистите поиск' }),
        ]));
        return;
    }

    const frag = document.createDocumentFragment();
    for (const font of items) frag.appendChild(fontCard(font));
    list.appendChild(frag);

    observeCards(list);
}

function fontCard(font) {
    const hasCyr = font.s.includes('cyrillic');
    const sample = hasCyr ? SAMPLE_CYR : SAMPLE_LAT;
    const stack = buildStack(font);

    const badges = h('div.vte-font-badges', {}, [
        hasCyr ? h('span.vte-badge.vte-badge-cyr', { text: 'АБВ', title: 'Поддерживает кириллицу' }) : null,
        h('span.vte-badge', { text: CATEGORY_LABELS[font.c] || font.c }),
        h('span.vte-badge.vte-badge-dim', { text: `${font.w.length} вес.` }),
    ]);

    const head = h('div.vte-font-card-head', {}, [
        h('span.vte-font-name', { text: font.n }),
        badges,
    ]);

    const preview = h('div.vte-font-sample', {
        style: `font-family:${stack}`,
        text: sample,
    });

    const glyphs = h('div.vte-font-glyphs', {
        style: `font-family:${stack}`,
        text: hasCyr ? 'Aa Бб Вв Гг 123 — ,.!?' : 'Aa Bb Cc Dd 123 — ,.!?',
    });

    const card = h('div.vte-font-card', {
        dataset: { font: font.n },
        on: {
            click: () => selectFont(font, card),
            mouseenter: () => loadFont(font),
        },
    }, [head, preview, glyphs]);

    if (previewFont?.n === font.n) card.classList.add('selected');
    return card;
}

function observeCards(list) {
    if (!('IntersectionObserver' in window)) {
        list.querySelectorAll('.vte-font-card').forEach(c => {
            loadFont(FONTS.find(f => f.n === c.dataset.font));
        });
        return;
    }
    const io = new IntersectionObserver((entries, obs) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            loadFont(FONTS.find(f => f.n === entry.target.dataset.font));
            obs.unobserve(entry.target);
        }
    }, { root: list, rootMargin: '160px' });

    list.querySelectorAll('.vte-font-card').forEach(c => io.observe(c));
}

/* ============================================================
   ЗАГРУЗКА ШРИФТА В СТРАНИЦУ
============================================================ */
function loadFont(font) {
    if (!font || loadedFonts.has(font.n)) return;
    loadedFonts.add(font.n);

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.dataset.vteFont = font.n;
    link.href = buildCssUrl(font, [400, 700].filter(w => font.w.includes(w)));
    document.head.appendChild(link);
}

function buildCssUrl(font, weights) {
    const family = font.n.replace(/ /g, '+');
    const w = (weights && weights.length ? weights : [400])
        .filter((v, i, a) => a.indexOf(v) === i)
        .sort((a, b) => a - b);
    return `https://fonts.googleapis.com/css2?family=${family}:wght@${w.join(';')}&display=swap`;
}

/* ============================================================
   ВЫБОР И ПРЕДПРОСМОТР
============================================================ */
function selectFont(font, card) {
    previewFont = font;

    container.querySelectorAll('.vte-font-card').forEach(c => c.classList.remove('selected'));
    card?.classList.add('selected');

    const sel = container.querySelector('#vte-font-weight');
    sel.textContent = '';
    for (const w of font.w) {
        const suffix = w === 400 ? ' (обычный)' : w === 700 ? ' (жирный)' : '';
        const opt = h('option', { value: String(w), text: `${w}${suffix}` });
        if (w === 400) opt.selected = true;
        sel.appendChild(opt);
    }
    if (!font.w.includes(400) && sel.firstElementChild) {
        sel.firstElementChild.selected = true;
    }

    setCurrentLabel(font.n, false);
    container.querySelector('#vte-font-apply').disabled = false;

    loadFont(font);
    if (container.querySelector('#vte-font-live').checked) applyPreview(font);
}

function setCurrentLabel(name, done) {
    const label = container.querySelector('#vte-font-current');
    if (!label) return;
    label.textContent = '';
    label.classList.toggle('vte-ok', !!done);
    label.append(
        h('span.vte-font-current-ic', {}, [icon(done ? 'fa-circle-check' : 'fa-font')]),
        h('strong', { text: name })
    );
    if (done) label.append(h('span', { text: ' применён' }));
}

function applyPreview(font) {
    if (!font) return;
    ensurePreviewStyle();

    const stack = buildStack(font);
    const selector = currentSelector();
    const weight = container.querySelector('#vte-font-weight').value;

    previewStyleEl.textContent =
        `${selector} {\n` +
        `    font-family: ${stack} !important;\n` +
        (weight && weight !== '400' ? `    font-weight: ${weight} !important;\n` : '') +
        `}`;

    onPreviewStart(font.n);
}

function clearPreview() {
    if (previewStyleEl) previewStyleEl.textContent = '';
    onPreviewEnd();
}

function currentSelector() {
    const id = container.querySelector('#vte-font-target').value;
    if (id === 'custom') {
        const v = container.querySelector('#vte-font-custom').value.trim();
        return v || 'body';
    }
    return TARGETS.find(t => t.id === id)?.selector || 'body';
}

function buildStack(font) {
    const fallback = {
        sans: `'Segoe UI', Arial, sans-serif`,
        serif: `'Times New Roman', Georgia, serif`,
        display: `Impact, sans-serif`,
        handwriting: `'Comic Sans MS', cursive`,
        monospace: `Consolas, monospace`,
    }[font.c] || 'sans-serif';
    return `'${font.n}', ${fallback}`;
}

/* ============================================================
   ПРИМЕНЕНИЕ В CSS
============================================================ */
function commit() {
    if (!previewFont) return;

    const font = previewFont;
    const weight = container.querySelector('#vte-font-weight').value;
    const extra = container.querySelector('#vte-font-extra-weights').checked;

    const weights = extra
        ? [300, 400, 700, Number(weight)].filter(w => font.w.includes(w))
        : [Number(weight)].filter(w => font.w.includes(w));

    onFontSelected({
        family: font.n,
        stack: buildStack(font),
        weight: Number(weight) || 400,
        selector: currentSelector(),
        importUrl: buildCssUrl(font, weights.length ? weights : [400]),
        subsets: font.s,
        category: font.c,
    });

    clearPreview();
    setCurrentLabel(font.n, true);
    setTimeout(() => {
        if (previewFont === font) setCurrentLabel(font.n, false);
    }, 2200);
}

/* ============================================================
   ПУБЛИЧНЫЕ ХЕЛПЕРЫ
============================================================ */
export function stopPreview() {
    clearPreview();
}

export function getFontList() {
    return FONTS.map(f => ({ ...f }));
}

export function isAvailable(family) {
    try { return document.fonts.check(`16px '${family}'`); } catch { return false; }
}
