// modules/cssGenerator.js
// Парсинг, поиск CSS-переменных и безопасная перезапись пользовательского CSS.
// Полностью тема-независим: карта переменных строится из самого CSS в рантайме.
import * as cssIndex from './cssRules.js';

const MARKER_START = '/* ==== VTE:AUTO START — не редактируйте вручную ==== */';
const MARKER_END   = '/* ==== VTE:AUTO END ==== */';

// Свойства, для которых имеет смысл искать переменную по имени
// Свойства, для которых имеет смысл искать переменную по имени.
// Подсказки специально сделаны длинными: короткое 'font' совпадало
// с --mainFontSize и ломало размеры интерфейса.
const VAR_NAME_HINTS = {
    'background-color': ['bg', 'background', 'tint', 'fill', 'surface', 'panel'],
    'color':            ['text', 'fg', 'foreground', 'font-color', 'fontcolor', 'bodycolor'],
    'border-color':     ['border', 'outline', 'stroke'],
    'font-family':      ['font-family', 'fontfamily', 'fontface', 'font-face', 'typeface', 'family'],
    'font-size':        ['font-size', 'fontsize', 'mainfontsize', 'fontscale'],
    'border-radius':    ['radius', 'rounded', 'corner'],
    'box-shadow':       ['boxshadow', 'box-shadow'],
    'text-shadow':      ['textshadow', 'text-shadow'],
    'opacity':          ['opacity', 'alpha'],
    'backdrop-filter':  ['blurstrength', 'blur'],
    'filter':           ['blurstrength', 'blur', 'filter'],
};

// Если имя переменной содержит одно из этих слов — она НЕ подходит
// для данного свойства, даже если подсказка совпала.
const VAR_NAME_DENY = {
    'font-family':      ['size', 'scale', 'weight', 'height', 'spacing', 'color', 'shadow', 'width'],
    'font-size':        ['family', 'face', 'color', 'weight', 'shadow'],
    'color':            ['bg', 'background', 'border', 'shadow', 'tint', 'size', 'width', 'radius', 'family'],
    'background-color': ['text', 'border', 'font', 'size', 'width', 'radius', 'shadow'],
    'border-color':     ['background', 'text', 'font', 'size', 'width', 'radius', 'shadow', 'tint'],
    'border-radius':    ['color', 'font', 'blur', 'shadow', 'family'],
    'box-shadow':       ['color', 'font', 'size', 'width', 'family'],
    'text-shadow':      ['color', 'font', 'size', 'family'],
    'opacity':          ['color', 'font', 'size', 'family'],
    'backdrop-filter':  ['color', 'font', 'size', 'family'],
    'filter':           ['color', 'font', 'size', 'family'],
};

// Системные переменные SillyTavern: в них можно писать ТОЛЬКО перечисленные
// свойства. Любая другая запись сломает вёрстку топбара и иконок.
const VAR_PROPERTY_LOCK = {
    '--mainfontsize':      ['font-size'],
    '--fontscale':         ['font-size'],
    '--blurstrength':      ['backdrop-filter', 'filter'],
    '--shadowwidth':       ['text-shadow'],
    '--topbarblocksize':   ['height', 'min-height'],
    '--avatar-base-width': ['width'],
    '--avatar-base-height':['height'],
};

let state = {
    rootVars: new Map(),      // name -> value (без --)
    varUsage: new Map(),      // varName -> [{ selector, property }]
    parsedRules: [],          // [{ selector, decls: Map }]
};

export function init() {
    state = { rootVars: new Map(), varUsage: new Map(), parsedRules: [] };
}

/* ============================================================
   ГЕНЕРАЦИЯ СЕЛЕКТОРА ДЛЯ ЭЛЕМЕНТА
============================================================ */
export function generateSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el === document.body) return 'body';
    if (el === document.documentElement) return 'html';

    // 1. Стабильный id — самый надёжный вариант
    if (el.id && isStableToken(el.id)) {
        return `#${cssEscape(el.id)}`;
    }

    // 2. Известные структурные паттерны SillyTavern
    const st = stPattern(el);
    if (st) return st;

    // 3. Классы: берём осмысленные, отбрасываем служебные и рантайм-мусор
    const classes = usefulClasses(el);
    if (classes.length) {
        let sel = '.' + classes.map(cssEscape).join('.');
        if (document.querySelectorAll(sel).length <= 40) {
            const scoped = scopeWithAncestor(el, sel);
            return scoped || sel;
        }
    }

    // 4. Фолбэк: путь от ближайшего id-родителя
    return pathFromIdAncestor(el);
}

function stPattern(el) {
    const mes = el.closest('.mes');
    if (!mes) return null;

    const isUser = mes.getAttribute('is_user') === 'true';
    const role = isUser ? '.mes[is_user="true"]' : '.mes[is_user="false"]';

    // Сам пузырь сообщения
    if (el.classList.contains('mes')) return role;

    const map = [
        ['mes_block', ' .mes_block'],
        ['mes_text', ' .mes_text'],
        ['mesAvatarWrapper', ' .mesAvatarWrapper'],
        ['avatar', ' .mesAvatarWrapper .avatar'],
        ['ch_name', ' .ch_name'],
        ['name_text', ' .ch_name .name_text'],
        ['mes_buttons', ' .mes_buttons'],
        ['mesIDDisplay', ' .mesIDDisplay'],
        ['tokenCounterDisplay', ' .tokenCounterDisplay'],
        ['mes_timer', ' .mes_timer'],
        ['mes_reasoning', ' .mes_reasoning'],
        ['mes_reasoning_header', ' .mes_reasoning_header'],
    ];

    for (const [cls, suffix] of map) {
        if (el.classList.contains(cls)) return role + suffix;
    }

    if (el.tagName === 'IMG' && el.closest('.avatar')) {
        return role + ' .mesAvatarWrapper .avatar img';
    }

    // Инлайн-разметка внутри текста
    const inline = { EM: 'em', I: 'i', STRONG: 'strong', B: 'b', Q: 'q', CODE: 'code', HR: 'hr', P: 'p' };
    if (inline[el.tagName] && el.closest('.mes_text')) {
        return `.mes_text ${inline[el.tagName]}`;
    }

    return null;
}

function usefulClasses(el) {
    const banned = /^(ui-|jq|select2|swiper|ng-|is-|has-|active|selected|open|closed|hidden|shown|show|dragging|animated|fa-|interactable|last_mes|vte-|aa-|ag-)/i;
    return Array.from(el.classList)
        .filter(c => c && !banned.test(c) && !/^\d/.test(c) && c.length > 1)
        .slice(0, 3);
}

function scopeWithAncestor(el, sel) {
    let p = el.parentElement;
    let depth = 0;
    while (p && depth < 5) {
        if (p.id && isStableToken(p.id)) {
            const scoped = `#${cssEscape(p.id)} ${sel}`;
            if (document.querySelector(scoped) === el || document.querySelectorAll(scoped).length <= 20) {
                return scoped;
            }
        }
        p = p.parentElement;
        depth++;
    }
    return null;
}

function pathFromIdAncestor(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 6) {
        if (cur.id && isStableToken(cur.id)) {
            parts.unshift(`#${cssEscape(cur.id)}`);
            break;
        }
        const cls = usefulClasses(cur);
        let part = cur.tagName.toLowerCase();
        if (cls.length) part += '.' + cls.map(cssEscape).join('.');
        else {
            const idx = Array.from(cur.parentElement?.children || [])
                .filter(c => c.tagName === cur.tagName).indexOf(cur);
            if (idx > 0) part += `:nth-of-type(${idx + 1})`;
        }
        parts.unshift(part);
        cur = cur.parentElement;
        if (cur === document.body) { parts.unshift('body'); break; }
    }
    return parts.join(' > ').replace(/ > /g, ' ');
}

function isStableToken(v) {
    // Отбрасываем сгенерированные id вида x123456, uid-..., :r1:
    return /^[a-z][\w-]{1,60}$/i.test(v) && !/^\w{0,3}\d{4,}$/.test(v);
}

function cssEscape(v) {
    if (window.CSS?.escape) return CSS.escape(v);
    return String(v).replace(/([^\w-])/g, '\\$1');
}

/* ============================================================
   ПАРСИНГ CSS
============================================================ */
export function parse(css) {
    state.rootVars.clear();
    state.varUsage.clear();
    state.parsedRules = [];

    const clean = stripComments(css || '');

    // Все :root блоки (их может быть несколько — как в темах с секциями)
    const rootRe = /(^|[^-\w]):root\s*\{([^}]*)\}/g;
    let m;
    while ((m = rootRe.exec(clean)) !== null) {
        for (const [name, value] of parseDecls(m[2])) {
            if (name.startsWith('--')) {
                state.rootVars.set(name, value); // последнее объявление побеждает
            }
        }
    }

    // Все правила + где какие переменные используются
    const ruleRe = /([^{}@]+)\{([^{}]*)\}/g;
    while ((m = ruleRe.exec(clean)) !== null) {
        const selector = m[1].trim().replace(/\s+/g, ' ');
        if (!selector || selector.startsWith('@')) continue;
        const decls = parseDecls(m[2]);
        state.parsedRules.push({ selector, decls });

        for (const [prop, value] of decls) {
            const varRe = /var\(\s*(--[\w-]+)/g;
            let vm;
            while ((vm = varRe.exec(value)) !== null) {
                if (!state.varUsage.has(vm[1])) state.varUsage.set(vm[1], []);
                state.varUsage.get(vm[1]).push({ selector, property: prop });
            }
        }
    }

    // Переменные из живого DOM (SmartTheme* и всё, что задал сам ST)
    collectLiveVars();

    return {
        vars: new Map(state.rootVars),
        usage: new Map(state.varUsage),
        rules: state.parsedRules.length,
    };
}

function collectLiveVars() {
    try {
        const cs = getComputedStyle(document.documentElement);
        // computedStyleMap недоступен везде — перебираем известные префиксы ST
        const known = [
            '--SmartThemeBodyColor', '--SmartThemeEmColor', '--SmartThemeUnderlineColor',
            '--SmartThemeQuoteColor', '--SmartThemeBlurTintColor', '--SmartThemeChatTintColor',
            '--SmartThemeUserMesBlurTintColor', '--SmartThemeBotMesBlurTintColor',
            '--SmartThemeShadowColor', '--SmartThemeBorderColor',
            '--mainFontSize', '--blurStrength', '--shadowWidth',
        ];
        for (const name of known) {
            const v = cs.getPropertyValue(name).trim();
            if (v && !state.rootVars.has(name)) {
                state.rootVars.set(name, v);
            }
        }
    } catch {}
}

function parseDecls(body) {
    const out = new Map();
    // Разбиваем по ; с учётом вложенных скобок (градиенты, shadow, url)
    let depth = 0, buf = '';
    const chunks = [];
    for (const ch of body) {
        if (ch === '(') depth++;
        if (ch === ')') depth = Math.max(0, depth - 1);
        if (ch === ';' && depth === 0) { chunks.push(buf); buf = ''; continue; }
        buf += ch;
    }
    if (buf.trim()) chunks.push(buf);

    for (const chunk of chunks) {
        const i = chunk.indexOf(':');
        if (i < 1) continue;
        const name = chunk.slice(0, i).trim();
        const value = chunk.slice(i + 1).trim();
        if (name && value) out.set(name, value);
    }
    return out;
}

function stripComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/* ============================================================
   ПОИСК ПОДХОДЯЩЕЙ ПЕРЕМЕННОЙ
============================================================ */

// Селекторы, для которых можно менять глобальные переменные темы.
// Для всех остальных элементов переменные не трогаем: иначе правка
// одного сообщения меняет размер шрифта во всём интерфейсе.
const GLOBAL_SELECTORS = [':root', 'html', 'body', '*', 'html, body', 'body, html'];

function isGlobalSelector(selector) {
    const parts = String(selector || '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
    if (!parts.length) return false;
    return parts.every(p => GLOBAL_SELECTORS.includes(p));
}

export function findVariable(selector, property, currentValue) {
    if (property.startsWith('--')) return { name: property, source: 'direct' };

    const global = isGlobalSelector(selector);
    const typeOk = valueTypeChecker(property);
    const known = (name) => state.rootVars.get(name);

    // Переменная годится, если она не заблокирована для этого свойства
    // и её текущее значение того же типа, что записываемое свойство.
    const usable = (name, checkNameDeny) => {
        if (isVarLocked(name, property)) return false;
        if (checkNameDeny && isVarDenied(name, property)) return false;
        const v = known(name);
        if (v != null && !typeOk(v)) return false;
        return true;
    };

    // Переменная «принадлежит» выбранному элементу только если ВСЕ места
    // её использования совпадают с этим селектором. Иначе запись в неё
    // затронет другие части интерфейса.
    const usedOnlyHere = (name) => {
        const uses = state.varUsage.get(name) || [];
        if (!uses.length) return false;
        return uses.every(u => selectorsMatch(u.selector, selector));
    };

    // 1. Точное совпадение selector + property
    for (const [name, uses] of state.varUsage) {
        if (!usable(name, false)) continue;
        if (!uses.some(u => u.property === property && selectorsMatch(u.selector, selector))) continue;
        if (!global && !usedOnlyHere(name)) continue;
        return { name, value: known(name), source: 'exact' };
    }

    // Дальше идут «догадки». Для конкретного элемента они запрещены:
    // пишем обычное правило в авто-блок — это всегда безопасно.
    if (!global) return null;

    // 2. Тот же элемент, но правило описано другим селектором
    const base = baseToken(selector);
    if (base) {
        for (const [name, uses] of state.varUsage) {
            if (!usable(name, true)) continue;
            if (uses.some(u => u.property === property && u.selector.includes(base))) {
                return { name, value: known(name), source: 'related' };
            }
        }
    }

    // 3. По имени и совместимости типа значения
    const hints = VAR_NAME_HINTS[property];
    if (!hints) return null;

    let best = null;
    for (const [name, value] of state.rootVars) {
        const lower = name.toLowerCase();
        const hit = hints.find(x => lower.includes(x));
        if (hit === undefined) continue;
        if (!usable(name, true)) continue;
        if (!typeOk(value)) continue;

        const score = hints.indexOf(hit) * 10
            + (base && lower.includes(base.replace(/[.#\[\]"=]/g, '')) ? -25 : 0)
            + name.length * 0.1;

        if (!best || score < best.score) best = { name, value, score, source: 'name' };
    }

    return best ? { name: best.name, value: best.value, source: best.source } : null;
}


function isVarDenied(name, property) {
    const bad = VAR_NAME_DENY[property];
    if (!bad) return false;
    const lower = name.toLowerCase();
    return bad.some(x => lower.includes(x));
}

function isVarLocked(name, property) {
    const allow = VAR_PROPERTY_LOCK[name.toLowerCase()];
    if (!allow) return false;
    return !allow.includes(property);
}

function selectorsMatch(a, b) {
    const norm = (s) => s.split(',').map(x => x.trim().replace(/\s+/g, ' '));
    const A = norm(a), B = norm(b);
    return A.some(x => B.includes(x));
}

function baseToken(selector) {
    const m = selector.match(/[#.][\w-]+/);
    return m ? m[0] : null;
}

function valueTypeChecker(property) {
    const str = (v) => String(v ?? '').trim();

    const isColor = (v) =>
        /^(#|rgba?\(|hsla?\(|hwb\(|lab\(|lch\(|oklch\(|oklab\(|[a-z]+$)/i.test(str(v));

    const isLength = (v) =>
        /^-?[\d.]+(px|em|rem|vw|vh|vmin|vmax|%|pt|ch|ex)$/i.test(str(v))
        || /calc\(/i.test(str(v));

    if (/color$/i.test(property) || property === 'color') return isColor;

    if (property === 'font-family') {
        return (v) => {
            const s = str(v);
            if (!s) return false;
            if (/^-?[\d.]/.test(s)) return false;                    // 15px, 1.2 — это не шрифт
            if (/calc\(|var\(/i.test(s)) return false;
            if (/^(#|rgba?\(|hsla?\()/i.test(s)) return false;
            if (/^(none|unset|inherit|initial|normal|bold)$/i.test(s)) return false;
            return /[a-z]/i.test(s);
        };
    }

    if (property === 'font-size') {
        return (v) => /^-?[\d.]+(px|em|rem|pt|%)$/i.test(str(v)) || /calc\(/i.test(str(v));
    }

    if (property === 'font-weight') {
        return (v) => /^(\d{3}|normal|bold|lighter|bolder)$/i.test(str(v));
    }

    if (property === 'box-shadow' || property === 'text-shadow') {
        return (v) => /px/i.test(str(v)) && /(rgba?\(|hsla?\(|#[0-9a-f]{3,8})/i.test(str(v));
    }

    if (property === 'opacity') {
        // Панель отдаёт значение как (n/100).toFixed(2), то есть «1.00» и «0.00».
        // Старая проверка /^(0|1|0?\.\d+)$/ отбрасывала «1.00» и проценты,
        // и подходящая переменная считалась негодной.
        return (v) => /^(?:0|1|0?\.\d+|1\.0+|\d{1,3}%)$/.test(str(v));
    }

    if (/(radius|width|height|size|spacing|indent|top|left|right|bottom|gap)/i.test(property)) {
        return isLength;
    }

    return () => true;
}

/* ============================================================
   ЗАПИСЬ ИЗМЕНЕНИЙ
============================================================ */
export function updateRule(css, selector, property, value, opts = {}) {
    let out = css || '';

    if (property === '__reset__') {
        return removeFromAutoBlock(out, selector);
    }

    const empty = value === '' || value === 'unset' || value == null;

    // Пустое значение означает «убрать правку». В переменную темы пустоту
    // писать нельзя: получалось `--var: ;` или `--var: unset;`, и переменная
    // умирала сразу во всём интерфейсе. Такие случаи идут в авто-блок,
    // где upsertAutoBlock просто удаляет строку.
    if (opts.useVariables !== false && !empty) {
        const found = findVariable(selector, property, value);
        if (found?.name && !isInlineVar(found.name)) {
            const updated = setRootVariable(out, found.name, value);
            if (updated !== out) {
                state.rootVars.set(found.name, value);
                return updated;
            }
        }
    }

    // Экспериментально: менять значение прямо в правиле темы,
    // вместо того чтобы дублировать его в авто-блоке.
    if (opts.editInPlace) {
        const edited = editInPlace(out, selector, property, value);
        if (edited != null) return edited;
    }

    return setDeclaration(out, selector, property, value);
}

/**
 * SillyTavern задаёт часть переменных темы прямо в атрибуте style у <html>
 * через documentElement.style.setProperty. Инлайновый стиль сильнее любого
 * правила :root в таблице стилей, поэтому наша запись в такую переменную
 * видна только в слое предпросмотра и пропадает вместе с ним.
 * Такие переменные не трогаем — пишем обычное правило в авто-блок.
 */
function isInlineVar(name) {
    const clean = name.startsWith('--') ? name : `--${name}`;
    try {
        return document.documentElement.style.getPropertyValue(clean).trim() !== '';
    } catch {
        return false;
    }
}

/* ============================================================
   ПРАВКА СУЩЕСТВУЮЩЕГО ПРАВИЛА ТЕМЫ
============================================================ */
function normSel(v) {
    return String(v ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Ищет в теме правило, которое описывает РОВНО этот селектор.
 *
 * Правила со списком через запятую сознательно пропускаются: правка в них
 * задела бы все селекторы списка сразу. Такие случаи уходят в авто-блок,
 * где видно, что именно добавлено.
 */
function findThemeRule(css, selector) {
    const key = normSel(selector);
    if (!key) return null;

    let index;
    try { index = cssIndex.buildIndex(css); } catch { return null; }

    let hit = null;
    for (const rule of index.rules) {
        if (rule.inAutoBlock) continue;
        if (!cssIndex.isContextActive(rule)) continue;   // @media, который сейчас не действует

        if (rule.parts.length === 1) {
            if (normSel(rule.parts[0].raw) !== key) continue;
        } else if (normSel(rule.effectiveSelector) !== key) {
            continue;
        }
        hit = rule;   // последнее правило в файле побеждает, как в самом CSS
    }
    return hit;
}

/** Куда пойдёт правка. Нужно для подсказки в панели. */
export function findEditSpot(css, selector, property) {
    const rule = findThemeRule(css, selector);
    if (!rule) return null;

    const decl = property ? cssIndex.findDeclaration(rule, property) : null;
    const pos = decl ? decl.start : rule.ruleStart;

    return {
        selector: rule.selectorRaw,
        line: String(css).slice(0, pos).split('\n').length,
        hasProperty: !!decl,
        inMedia: rule.conditions.length > 0,
    };
}

function editInPlace(css, selector, property, value) {
    const rule = findThemeRule(css, selector);
    if (!rule) return null;

    const decl = cssIndex.findDeclaration(rule, property);
    const empty = value === '' || value === 'unset' || value == null;

    if (decl) {
        if (empty) return cssIndex.removeDeclaration(css, decl);
        // !important сохраняем таким, каким его написал автор темы
        return cssIndex.replaceDeclarationValue(css, decl, value, {
            important: decl.important,
        });
    }

    if (empty) return null;

    // Нового свойства ещё нет — дописываем в конец правила,
    // с той же важностью, что у соседних строк
    const important = rule.decls.some(d => d.important);
    return cssIndex.insertDeclaration(css, rule, property, value, { important });
}


/** Меняет значение переменной в существующем :root, иначе создаёт :root в авто-блоке */
export function setRootVariable(css, name, value) {
    const clean = name.startsWith('--') ? name : `--${name}`;
    const re = new RegExp(
        `(:root[^{}]*\\{[^}]*?)(\\s*${escapeRe(clean)}\\s*:)([^;}]*)(;?)`,
        'gi'
    );

    // В CSS побеждает ПОСЛЕДНЕЕ объявление. Раньше правился первый найденный
    // :root, а второй продолжал перекрывать его — правка выглядела так, будто
    // не сработала вообще. Темы с несколькими секциями :root ломались об это.
    let last = null;
    let m;
    while ((m = re.exec(css)) !== null) {
        last = m;
        if (m.index === re.lastIndex) re.lastIndex++;
    }

    if (last) {
        const replacement = `${last[1]}${last[2]} ${value}${last[4] || ';'}`;
        return css.slice(0, last.index)
            + replacement
            + css.slice(last.index + last[0].length);
    }

    // Переменной нет — добавляем в авто-блок
    return upsertAutoBlock(css, ':root', clean, value);
}

/** Пишет обычное объявление в авто-блок (не трогая ручной CSS темы) */
export function setDeclaration(css, selector, property, value) {
    return upsertAutoBlock(css, selector, property, value);
}

/* ---------- Авто-блок: единственная зона, которую расширение переписывает ---------- */
function getAutoBlock(css) {
    const s = css.indexOf(MARKER_START);
    const e = css.indexOf(MARKER_END);
    if (s === -1 || e === -1 || e < s) return null;
    return { start: s, end: e + MARKER_END.length, body: css.slice(s + MARKER_START.length, e) };
}

function upsertAutoBlock(css, selector, property, value) {
    const block = getAutoBlock(css);
    let body = block ? block.body : '\n';

    const rules = parseAutoBody(body);
    const key = selector.trim().replace(/\s+/g, ' ');
    if (!rules.has(key)) rules.set(key, new Map());

    if (value === '' || value === 'unset' || value == null) {
        rules.get(key).delete(property);
        if (rules.get(key).size === 0) rules.delete(key);
    } else {
        const bang = selector === ':root' ? '' : ' !important';
        rules.get(key).set(property, `${stripBang(value)}${bang}`);
    }

    const newBody = serializeAutoBody(rules);
    const newBlock = `${MARKER_START}\n${newBody}${MARKER_END}`;

    if (block) {
        return css.slice(0, block.start) + newBlock + css.slice(block.end);
    }
    return `${css.trimEnd()}\n\n${newBlock}\n`;
}

function removeFromAutoBlock(css, selector) {
    const block = getAutoBlock(css);
    if (!block) return css;
    const rules = parseAutoBody(block.body);
    rules.delete(selector.trim().replace(/\s+/g, ' '));
    const newBlock = rules.size
        ? `${MARKER_START}\n${serializeAutoBody(rules)}${MARKER_END}`
        : '';
    return (css.slice(0, block.start) + newBlock + css.slice(block.end)).replace(/\n{3,}/g, '\n\n');
}

/* ============================================================
   СМЫСЛОВЫЕ РАЗДЕЛЫ АВТО-БЛОКА
   Раздел определяется по селектору: одно правило CSS физически
   не может лежать в двух разделах одновременно.
============================================================ */
const AUTO_GROUPS = [
    {
        id: 'vars',
        title: 'Переменные темы',
        test: (s) => s === ':root' || s.startsWith(':root'),
    },
    {
        id: 'base',
        title: 'Основа: страница, шрифты, текст',
        test: (s) => /^(html|body|\*)\b/.test(s),
    },
    {
        id: 'scroll',
        title: 'Полосы прокрутки',
        test: (s) => /scrollbar|-webkit-resizer/i.test(s),
    },
    {
        id: 'send',
        title: 'Нижняя панель ввода',
        test: (s) => /#send_form|#send_but|#send_textarea|#leftSendForm|#rightSendForm|#form_sheld|#mes_stop|#nonQRFormItems|#options_button|#extensionsMenuButton|#sw-bar-btn|#qr--bar/i.test(s),
    },
    {
        id: 'topbar',
        title: 'Верхняя панель и её иконки',
        test: (s) => /#top-bar|#top-settings-holder|drawer-icon|drawer-toggle|drawer-header|DrawerIcon|drawer_icon|#nav-toggle/i.test(s),
    },
    {
        id: 'chat',
        title: 'Чат и сообщения',
        test: (s) => /#chat\b|\.mes\b|\.mes[_-]|#chat_|swipe|\.last_mes|#bg1|#bg_custom/i.test(s),
    },
    {
        id: 'avatar',
        title: 'Аватары и персоны',
        test: (s) => /avatar|persona|#user_avatar_block/i.test(s),
    },
    {
        id: 'panels',
        title: 'Боковые панели и настройки',
        test: (s) => /#right-nav-panel|#left-nav-panel|#WorldInfo|#rm_|drawer-content|#extensions_settings|#character_popup|inline-drawer/i.test(s),
    },
    {
        id: 'popups',
        title: 'Окна, меню, подсказки',
        test: (s) => /dialogue_popup|#dialogue|#shadow_popup|\.popup|toast|tooltip|menu|context/i.test(s),
    },
    {
        id: 'other',
        title: 'Прочее',
        test: () => true,
    },
];

function sectionFor(selector) {
    const s = normSel(selector);
    for (const g of AUTO_GROUPS) {
        if (g.test(s)) return g;
    }
    return AUTO_GROUPS[AUTO_GROUPS.length - 1];
}

function parseAutoBody(body) {
    const rules = new Map();
    // Комментарии-заголовки разделов убираем: они создаются заново
    // при каждой записи, иначе попали бы внутрь имени селектора.
    const clean = stripComments(String(body || ''));

    const re = /([^{}]+){([^{}]*)}/g;
    let m;
    while ((m = re.exec(clean)) !== null) {
        const sel = m[1].trim().replace(/\s+/g, ' ');
        if (!sel) continue;
        if (!rules.has(sel)) rules.set(sel, new Map());
        for (const [p, v] of parseDecls(m[2])) {
            rules.get(sel).set(p, v);
        }
    }
    return rules;
}

function serializeAutoBody(rules) {
    const groups = new Map();

    for (const [sel, decls] of rules) {
        if (!decls || !decls.size) continue;
        const g = sectionFor(sel);
        if (!groups.has(g.id)) groups.set(g.id, []);
        groups.get(g.id).push([sel, decls]);
    }

    let out = '';
    // Разделы идут в фиксированном порядке, :root всегда первым,
    // чтобы переменные объявлялись до использования
    for (const def of AUTO_GROUPS) {
        const items = groups.get(def.id);
        if (!items || !items.length) continue;

        out += `/* ---- ${def.title} ---- */\n`;
        for (const [sel, decls] of items) {
            out += `${sel} {\n`;
            for (const [p, v] of decls) out += `    ${p}: ${v};\n`;
            out += `}\n\n`;
        }
    }
    return out;
}


function stripBang(v) {
    return String(v).replace(/\s*!important\s*$/i, '').trim();
}

function escapeRe(v) {
    return String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ============================================================
   ИМПОРТЫ ШРИФТОВ
============================================================ */
export function addFontImport(css, importUrl) {
    if (!importUrl) return css;
    const src = css || '';
    if (src.includes(importUrl)) return src;

    const line = `@import url("${importUrl}");`;

    // Ищем позицию после всех комментариев, @charset и уже существующих
    // @import. Разбор идёт по символам, поэтому многострочные комментарии
    // больше не разрезаются пополам.
    let i = 0;
    let insertAt = 0;

    while (i < src.length) {
        if (/\s/.test(src[i])) { i++; insertAt = i; continue; }

        if (src[i] === '/' && src[i + 1] === '*') {
            const end = src.indexOf('*/', i + 2);
            i = end === -1 ? src.length : end + 2;
            insertAt = i;
            continue;
        }

        if (src[i] === '@' && /^@(charset|import)\b/i.test(src.slice(i, i + 12))) {
            const end = src.indexOf(';', i);
            i = end === -1 ? src.length : end + 1;
            insertAt = i;
            continue;
        }

        break;
    }

    const head = src.slice(0, insertAt).replace(/\s*$/, '');
    const tail = src.slice(insertAt).replace(/^\s*/, '');

    return (head ? head + '\n' : '') + line + '\n' + (tail ? '\n' + tail : '');
}


export function removeFontImport(css, importUrl) {
    return css.split('\n')
        .filter(l => !(l.includes('@import') && l.includes(importUrl)))
        .join('\n');
}

/* ============================================================
   ДИАГНОСТИКА
============================================================ */
export function getVariables() {
    return Array.from(state.rootVars, ([name, value]) => ({
        name,
        value,
        usedIn: (state.varUsage.get(name) || []).length,
    }));
}

export function validate(css) {
    const errors = [];
    let depth = 0;
    const clean = stripComments(css);
    for (let i = 0; i < clean.length; i++) {
        if (clean[i] === '{') depth++;
        if (clean[i] === '}') {
            depth--;
            if (depth < 0) {
                errors.push({ line: lineAt(clean, i), message: 'Лишняя закрывающая скобка }' });
                depth = 0;
            }
        }
    }
    if (depth > 0) errors.push({ line: null, message: `Не закрыто скобок: ${depth}` });

    // Объявления вне правил — частая причина «отвалившегося» блока CSS
    const orphan = /(^|\})\s*([a-z-]+\s*:\s*[^;{}]+;)/gi;
    let m;
    while ((m = orphan.exec(clean)) !== null) {
        errors.push({ line: lineAt(clean, m.index), message: `Свойство вне селектора: ${m[2].slice(0, 40)}` });
    }
    return errors;
}

function lineAt(text, index) {
    return text.slice(0, index).split('\n').length;
}
