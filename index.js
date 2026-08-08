/**
 * 弹窗顺手 + 密钥小眼睛 (Popup Polish)
 * ------------------------------------------------------------------
 * SillyTavern / TauriTavern 通用扩展，两件事：
 *
 * 1) API 密钥框右边加一个「小眼睛」
 *    原生 `#api_key_*` 是 type="text"，但客户端存完密钥就把框清空，所以平时框里是空的。
 *    点眼睛：框里有字 → 直接明文；框里是空的 → 向后端 /api/secrets/find 要已存的密钥填回框里。
 *    我们填进去的明文在点别的按钮之前会自己抹掉，免得客户端把同一把密钥又存一遍。
 *
 * 2) 输入类弹窗（新增 / 改名 API 连接配置、各种「起个名字」弹窗）优化
 *    - 输入框更宽更高，名字超长时**保持一行**往右延伸（原生是 textarea 会换行）
 *    - 输入法弹出时把弹窗整体上顶，直到**输入框和「取消 / 确认」那一排一起露在输入法上方**
 *      （上面的勾选项该顶出屏幕就顶出去），这样不用收输入法就能直接保存
 *    - 顶上去之后可以用手指把弹窗**拉回来看**上面的内容，拉的过程不关输入法；推 / 拉都有边界
 *    - 输入法一收（点空白、输入法自带的收起键、返回键都算）弹窗自动回原位
 *    - 点空白处仍然是原生行为（收输入法），输入法一收弹窗自动回位
 *    - 原生开窗动画是 `scaleY(0) → scaleY(1)` + 背景实时高斯模糊，手机上必卡；
 *      换成短促的位移 + 淡入，并且开窗过程中不做模糊
 *
 * 全部改动只作用在弹窗和密钥框上，可以在「扩展」面板里逐项关掉。
 */

const MODULE_NAME = 'tavernPopupPolish';
const LOG = '[popup-polish]';
const VERSION = '1.7.1';
const SETTINGS_REV = 4;    // 改过默认值就 +1，用来把旧的默认值迁移掉   // 面板标题后面会显示，用来确认装上的到底是哪一版

const DEFAULT_SETTINGS = {
    enabled: true,

    /* 密钥小眼睛 */
    keyReveal: true,        // 密钥框右边加小眼睛
    guardKeyHint: true,     // 不让已存的密钥出现在输入框的提示文字(placeholder)里

    /* 弹窗输入框外观 */
    widePopup: false,       // 输入类弹窗整体更宽（用户反馈太宽，默认关掉，宽度就是原生的）
    popupWidth: 640,        // 目标宽度(px)，窄屏自动收到 100dvw-12px
    roomyInput: true,       // 输入框更高（原生 rows=1 太扁）
    inputHeight: 42,        // 输入框最小高度(px)
    singleLine: true,       // 名字超长时保持一行往右延伸，不换行

    /* 新增 API 连接配置时预填的名字 */
    nameMode: 'model',      // model=只要模型名 / model-preset / api-model / keep=原样不改

    /* 新增 API 连接配置时那排「要一起保存哪些设置」的勾选项 */
    rememberExclude: true,  // 记住上次点保存时没勾的项，下次打开自动还原成没勾
    excludeMemory: [],      // 上次没勾的字段（英文字段名，跟界面语言无关）

    /* 切换连接配置时的「后端错误 / Unauthorized」误报抑制 */
    // 根因：切换 connection profile / API / preset 时客户端会立刻 trigger('#api_button_*')
    // 去打 /api/backends/chat-completions/status，这个请求不等 waitUntilCondition，可能用
    // 还没生效的 token 去请求 → 上游返回 401 → 后端把它包成
    // 「后端错误 Failed to get chat completions status: Unauthorized (request id: …)」弹出来。
    // 真实连接事后是好的。这里只在这一类「明显是切换过早」的窗口里吞掉那一条 toast。
    suppressSwitchErrors: true,   // 关掉就把这个抑制整个停掉，误报照常弹
    switchGraceMs: 6000,          // 感知到切换后这毫秒内是「误报窗口」
    // 也可以显式调大。各路切换事件都用这同一个值

    /* 输入法避让 */
    kbdAvoid: true,         // 输入法遮住输入框时把弹窗往上推
    kbdWholePopup: true,    // 一次把弹窗底部（含「取消 / 确认」那一排）都顶到输入法上方
    liftMax: false,         // 不管输入法多高，一次顶到极限（输入框顶部贴着屏幕顶）
    assumeKbd: true,        // 环境完全测不出输入法高度时，按屏幕比例假定一个（TauriTavern 安卓常见）
    assumeKbdPct: 45,       // 假定输入法占屏幕高度的百分之几
    blindSeen: false,       // 这个环境已经确认过「测不出输入法」——记下来，以后点输入框立刻上顶，不用再等
    kbdMargin: 16,          // 弹窗底部与输入法之间留的空(px)。按钮还是被挡住就把它调大（比如 60）
    kbdMinInset: 90,        // 视口底部被吃掉超过这个值才算「输入法开了」(px)
    dragShift: true,        // 可以用手指上下拖动弹窗
    dragUpMax: 150,         // 自动避让之后，还允许往上多拖多少(px)。防止拖到只剩一个按钮
    dragAlways: false,      // 输入法没开时也允许拖动
    dragOverflow: true,     // 弹窗比屏幕高（顶部被切掉）时也允许拖着看
    freezeHeight: true,     // 输入法弹出时不让弹窗跟着 dvh 变高变矮（防抖）

    /* 动画 */
    smoothAnim: true,       // 换掉原生 scaleY 开窗动画
    animMs: 150,            // 开窗动画时长(ms)
    cheapBackdrop: true,    // 弹窗背景不做高斯模糊（只保留压暗）
    deferFocus: false,      // 等开窗动画结束再聚焦输入框（输入法晚一点弹，更不卡；某些环境可能不自动弹输入法）

    diag: false,          // 在弹窗里显示一条诊断信息（排查用）
    debug: false,
};

const TXT = {
    showKey: ['显示密钥明文', 'Show the key'],
    hideKey: ['隐藏密钥', 'Hide the key'],
    keySaved: ['密钥已保存', 'Key saved'],
    keyExposureOff: [
        '客户端不让看密钥明文：去设置里打开「允许密钥暴露 / Allow Keys Exposure」再重启',
        'Key exposure is disabled — enable "Allow Keys Exposure" in settings and restart',
    ],
    keyEmpty: ['这个来源还没存过密钥', 'No key stored for this source yet'],
    keyReadFailed: ['没能读到已存的密钥', 'Could not read the stored key'],
    title: ['弹窗顺手 + 密钥小眼睛', 'Popup Polish'],
};

/* ------------------------------------------------------------------ utils */

function ctx() {
    try {
        return globalThis.SillyTavern?.getContext?.() ?? null;
    } catch {
        return null;
    }
}

function cfg() {
    const store = ctx()?.extensionSettings;
    if (!store) {
        globalThis.__tppFallbackCfg ??= { ...DEFAULT_SETTINGS };
        return globalThis.__tppFallbackCfg;
    }
    if (!store[MODULE_NAME]) store[MODULE_NAME] = {};
    const own = store[MODULE_NAME];
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (own[k] === undefined) own[k] = Array.isArray(v) ? [...v] : v;
    }
    // 一次性迁移：老设置里存着的旧默认值要跟着改（光改 DEFAULT_SETTINGS 对老用户没用）
    if (!(own.rev >= 2)) own.widePopup = false;     // rev 1 → 2：弹窗宽度还给原生
    if (!(own.rev >= 3)) own.dragUpMax = 150;       // rev 2 → 3：往上拖的范围收紧（以前能拖到只剩按钮）
    own.rev = SETTINGS_REV;
    return own;
}

function saveCfg() {
    try {
        ctx()?.saveSettingsDebounced?.();
    } catch { /* ignore */ }
}

function isZh() {
    const lang = ctx()?.getCurrentLocale?.() || document.documentElement.lang || navigator.language || '';
    return /^zh/i.test(String(lang));
}

function t(key) {
    const pair = TXT[key] || ['', ''];
    return isZh() ? pair[0] : pair[1];
}

function dbg(...args) {
    if (cfg().debug) console.log(LOG, ...args);
}

function warn(...args) {
    console.warn(LOG, ...args);
}

function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

function toast(kind, message) {
    try {
        globalThis.toastr?.[kind]?.(message);
    } catch {
        console.log(LOG, message);
    }
}

/** 把一个数字型 CSS 变量读成 px 数 */
function cssPx(name) {
    try {
        const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        if (!raw) return 0;
        const n = parseFloat(raw);
        return Number.isFinite(n) ? n : 0;
    } catch {
        return 0;
    }
}

/* ------------------------------------------------- 视口 / 输入法高度 */

function isMobileUA() {
    if (typeof globalThis.__tppMobile === 'boolean') return globalThis.__tppMobile;   // 测试覆盖
    return /Android|iPhone|iPad|iPod|Mobile|Tauri/i.test(navigator.userAgent || '');
}

/** 布局视口高度（`__tppLayoutH` 是测试覆盖用的） */
function layoutHeight() {
    const test = Number(globalThis.__tppLayoutH);
    if (Number.isFinite(test) && test > 0) return test;
    return document.documentElement.clientHeight || window.innerHeight || 0;
}

/**
 * 手机上「输入法没弹出时」的视口高度。
 * 安卓 WebView 如果跑在 adjustResize 模式（TauriTavern 常见），输入法弹出会把
 * **布局视口**整个缩小 —— 这时 visualViewport 和布局视口一样高，inset 恒等于 0，
 * 光看 inset 根本看不出输入法开着。所以额外记住历史最大高度当基线。
 */
let baseLayoutH = 0;

/**
 * 有些安卓 WebView（用户的 TauriTavern 就是）输入法弹出时**页面一点都察觉不到**：
 * 布局视口不缩、visualViewport 不缩、原生层也没注入 --tt-ime-bottom。
 * 这种环境只能：① 试 VirtualKeyboard API 拿键盘矩形；② 拿不到就按屏幕比例假定一个。
 */
let kbdBlind = false;        // 已确认这个环境测不出输入法
let assumedInset = 0;        // 当前按比例假定的输入法高度（0 = 没在假定）
let vkTried = false;

/**
 * 「用户刚刚碰过的东西」。盲区里假定的输入法高度是**猜**的，只有在用户确实点了
 * 弹窗里的输入框时才作数：
 *   - 真手指点输入框  → 输入法一定会弹 → 立刻上顶（不用等，这是「推得慢」的解法）
 *   - 程序自己 focus（弹窗 autofocus、失焦后被抢回来）→ 安卓不会弹输入法，
 *     这时候乱顶就是那下「回位之后又闪一下跳上去」
 */
let lastTouch = { target: null, at: -1e9 };

function noteUserPointer(target) {
    lastTouch = { target: target instanceof Element ? target : null, at: performance.now() };
}

/**
 * 这次 focus 该不该当成「输入法要来了」。两种算：
 *   ① 用户的手指刚落在**这个输入框上** —— 点输入框，输入法必来
 *   ② 弹窗刚刚打开（是用户点按钮打开的），客户端 autofocus 到输入框 —— 这一路
 *      在 TauriTavern 上输入法也会跟着弹，所以照样算
 * 关键是这两种都**不包括**「点了空白处收输入法之后，焦点被程序抢回输入框」——
 * 那种情况输入法根本没弹，跟着顶一下就是用户看到的「回位后又闪一下」。
 */
function focusMeansKeyboard(dlg, state, target) {
    const fresh = performance.now() - lastTouch.at < 1200;
    const el = lastTouch.target;
    if (fresh && el && (el === target || target.contains?.(el) || el.contains?.(target))) return true;
    if (!state.hadRound && performance.now() - (state.openedAt || 0) < 900) return true;
    return false;
}

/** 最近几次位移的流水（诊断用：闪一下这种问题，事后截图是看不见的，得有流水） */
const trace = [];

function note(reason, px) {
    trace.push({ t: Math.round(performance.now()), px: Math.round(px), reason });
    if (trace.length > 24) trace.shift();
}

function traceText() {
    const now = performance.now();
    return trace.slice(-5).map((e) => `${Math.round(now - e.t)}ms:${e.px}(${e.reason})`).join(' ');
}

/** VirtualKeyboard API：只有 overlaysContent = true 时才会给出键盘矩形 */
function vkInset() {
    const vk = navigator.virtualKeyboard;
    if (!vk) return -1;                       // 不支持
    if (!vkTried) {
        vkTried = true;
        try {
            vk.overlaysContent = true;        // 只在确认测不出输入法之后才会走到这里
            vk.addEventListener?.('geometrychange', () => schedule());
        } catch { /* ignore */ }
    }
    const r = vk.boundingRect;
    return r && r.height > 0 ? r.height : 0;
}

function noteLayoutHeight() {
    const h = layoutHeight();
    if (h > baseLayoutH) baseLayoutH = h;
    return h;
}

/**
 * 可见区域（去掉输入法占的那一块）。四路信号取最保守的那个：
 *   - visualViewport：手机浏览器（Chrome / Termux 里的酒馆）输入法弹出只缩它
 *   - --tt-ime-bottom：TauriTavern 的 Android 原生层直接注入的输入法高度
 *   - 布局视口本身缩小：WebView 的 adjustResize 模式
 *   - globalThis.__tppKbdInset：测试用的手动覆盖
 */
function viewport() {
    const layoutH = noteLayoutHeight();
    const vv = window.visualViewport;
    const top = vv ? vv.offsetTop : 0;
    let bottom = vv ? vv.offsetTop + vv.height : layoutH;

    // adjustResize 下布局视口已经不含输入法，可见区不可能超过它
    bottom = Math.min(bottom, layoutH);

    const shrink = Math.max(0, baseLayoutH - layoutH);      // 布局视口自己缩了多少
    const seen = Math.max(layoutH - bottom, shrink);        // 已经被别的信号反映出来的输入法高度

    // 关键：`--tt-ime-bottom` 只在别的信号都没反映出输入法时才用。
    // 否则（WebView 已经把布局视口压小、原生层又注入了输入法高度）会把输入法算两遍，
    // 可见区直接被算成 0，避让量就永远被夹在极限上 —— 表现就是「改了跟没改一样」。
    const ime = cssPx('--tt-ime-bottom');
    if (ime > 0 && seen < 40) bottom = Math.min(bottom, layoutH - ime);

    // 真实信号都没反映出输入法时，才轮到 VirtualKeyboard API 和「按比例假定」
    let source = seen >= 40 ? 'viewport' : (ime > 0 ? 'ime-var' : 'none');
    if (layoutH - bottom < 40 && kbdBlind) {
        const vk = vkInset();
        if (vk > 40) {
            bottom = layoutH - vk;
            source = 'vk-api';
        } else if (assumedInset > 40) {
            bottom = layoutH - assumedInset;
            source = 'assumed';
        }
    }

    const test = Number(globalThis.__tppKbdInset);
    if (Number.isFinite(test) && test > 0) {
        bottom = layoutH - test;
        source = 'test';
    }

    // 兜底：可见区再怎么算也不该只剩一条缝
    if (bottom < 100) bottom = Math.min(layoutH, 100);

    return { top, bottom, layoutH, inset: Math.max(0, layoutH - bottom), imeVar: ime, shrink, vvH: vv?.height || 0, source };
}

function keyboardOpen(vp = viewport()) {
    if (vp.source === 'assumed' || vp.source === 'vk-api') return true;
    if (vp.inset >= cfg().kbdMinInset) return true;
    // adjustResize：视口自己缩了，inset 看不出来 —— 只在手机上启用这一路，
    // 免得桌面用户拖动窗口高度时被误判成输入法。
    if (isMobileUA() && baseLayoutH - vp.layoutH >= cfg().kbdMinInset && isEditable(document.activeElement)) {
        return true;
    }
    return false;
}

/* ------------------------------------------------------- 弹窗增强 */

/** 当前被我们接管的弹窗 → 状态 */
const popups = new Map();

/** 最近一次是靠哪条路接管的（诊断用） */
let lastHook = 'none';

function isEditable(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el.isContentEditable) return true;
    if (el instanceof HTMLTextAreaElement) return true;
    if (el instanceof HTMLInputElement) {
        return !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'].includes(el.type);
    }
    return false;
}

/** 这个弹窗是不是「让人输入点东西」的弹窗 */
function mainInputOf(dlg) {
    const input = dlg.querySelector('.popup-input');
    if (!input) return null;
    if (input.style.display === 'none') return null;      // 非 INPUT 型弹窗，客户端会显式藏起来
    if (!input.offsetParent && !dlg.hasAttribute('open')) return null;
    return input;
}

/** 输入法要避让的目标：弹窗里当前聚焦的输入控件，没有就用主输入框 */
function shiftTarget(dlg) {
    const state = popups.get(dlg);
    const active = document.activeElement;
    if (active && dlg.contains(active) && isEditable(active)) return active;
    return state?.input || mainInputOf(dlg);
}

function currentShift(dlg) {
    if (typeof dlg.__tppShift === 'number') return dlg.__tppShift;
    return parseFloat(dlg.style.getPropertyValue('--tpp-shift')) || 0;
}

/**
 * 弹窗**这一刻**实际的纵向位移（从 computed transform 矩阵里读）。
 * 不能用 --tpp-shift 当基线：过渡 / 开窗动画进行中它是「目标值」，
 * 而 getBoundingClientRect() 给的是插值后的位置，两者相减会算出偏移量，
 * 于是每次重算都往上多推一截。
 */
function actualShift(dlg) {
    try {
        const raw = getComputedStyle(dlg).transform;
        if (!raw || raw === 'none') return 0;
        const nums = raw.slice(raw.indexOf('(') + 1, -1).split(',').map(Number);
        if (raw.startsWith('matrix3d')) return nums[13] || 0;
        return nums[5] || 0;
    } catch {
        return currentShift(dlg);
    }
}

/**
 * 位移写内联 `transform`，不写自定义属性。
 * 自定义属性是**会继承**的：改一次 `--tpp-shift`，弹窗里每个子元素的样式都要重算，
 * 拖动时每帧几十次 → 那就是「拖起来卡卡的」的真凶。transform 不继承，只动合成器。
 * `--tpp-shift` 只在非拖动时同步一份，给开窗 / 关窗的 keyframes 用。
 */
function setShift(dlg, px, { fast = false, why = '' } = {}) {
    const v = Math.round(px);
    if (why && dlg.__tppShift !== v) note(why, v);
    dlg.__tppShift = v;
    dlg.style.transform = `translate3d(0, ${v}px, 0)`;
    if (!fast) dlg.style.setProperty('--tpp-shift', `${v}px`);
}

/** 要顶到输入法上方的那条底边：整窗底部（含按钮排），或者只要输入框底部 */
function avoidBottom(dlg, shift) {
    if (cfg().kbdWholePopup) return dlg.getBoundingClientRect().bottom - shift;
    const target = shiftTarget(dlg);
    if (target) return target.getBoundingClientRect().bottom - shift;
    return dlg.getBoundingClientRect().bottom - shift;
}

/**
 * 位移的允许范围（推 / 拉都不许过头）。
 *   min（负 = 往上）：一路推到**弹窗底边**（取消 / 确认那一排）落在输入法上方，
 *                     上面的内容该出屏幕就出屏幕 —— 想看再拉回来。
 *                     唯一的红线：不能把正在输入的那个框推出屏幕顶部。
 *   max（≥0 = 往下）：弹窗比屏幕高、顶部本来就被截掉时，截掉多少就允许往下拉回多少；
 *                     没被截断时 max = 0，也就是「最多回到原位」
 */
function bounds(dlg) {
    const vp = viewport();
    const shift = actualShift(dlg);
    const dr = dlg.getBoundingClientRect();
    const baseDlgTop = dr.top - shift;

    // 需要顶多少（弹窗底边落到输入法上方）
    const needMin = -Math.max(0, avoidBottom(dlg, shift) + cfg().kbdMargin - vp.bottom);

    // 红线：正在输入的那个框的顶部不能出屏幕。手动拖动允许一直顶到这条线，
    // 所以「上面的内容推出屏幕」是想推多少推多少，不再被自动量卡住。
    const target = shiftTarget(dlg);
    let hardMin = needMin;
    if (target) {
        const r = target.getBoundingClientRect();
        hardMin = -Math.max(0, (r.top - shift) - vp.top - 8);
    }
    hardMin = Math.min(0, hardMin);

    // 手指能往上拖到哪：自动避让量再多 dragUpMax（默认 150px）。
    // 不设这个上限就能一路拖到「只剩一个确定按钮」，很难看；
    // 但上限永远不会越过 hardMin，所以输入框一定还在屏幕里，拖上去一定拖得回来。
    const extra = Math.max(0, Number(cfg().dragUpMax) || 0);
    const dragMin = Math.max(hardMin, Math.min(needMin, 0) - extra);

    const clipped = Math.max(0, vp.top - baseDlgTop);
    return { min: dragMin, needMin, hardMin, dragMin, max: cfg().dragOverflow ? clipped : 0, vp, shift, clipped };
}

/**
 * 算这个弹窗现在该往上推多少。
 * shift 为负数表示往上推；自动避让只会在 [min, 0] 里选，永远不会自己往下拉。
 * `need > 0` = 底边（默认含按钮排）确实被输入法压住了。
 */
function measure(dlg) {
    const b = bounds(dlg);
    const need = avoidBottom(dlg, b.shift) + cfg().kbdMargin - b.vp.bottom;
    // liftMax：不信输入法高度，直接顶到红线（输入框贴着屏幕顶）—— 测不准的环境用这个稳
    const want = cfg().liftMax && need > 1 ? b.hardMin : -Math.max(0, need);

    return { shift: clamp(want, b.hardMin, 0), min: b.min, hardMin: b.hardMin, max: b.max, need, vp: b.vp };
}

function applyAutoShift(dlg, { force = false } = {}) {
    const state = popups.get(dlg);
    if (!state || !cfg().kbdAvoid) return;
    if (!dlg.hasAttribute('open') || dlg.hasAttribute('closing')) return;
    if (state.drag?.active) return;                   // 手指正按着，别跟他抢（也别在拖动中强制重排）

    const vp = viewport();
    const open = keyboardOpen(vp);
    if (cfg().freezeHeight && !open) freezeHeight(dlg);

    if (cfg().diag || dlg.__tppDiag) renderDiag(dlg);

    const m = measure(dlg);
    const active = document.activeElement;
    const typing = !!(active && dlg.contains(active) && isEditable(active));
    // 「该避让」= 检测到输入法，或者（在打字的前提下）底边确实被挡住了。
    // 后一路是给检测不出输入法高度的环境兜底的；没在打字就绝不动别的弹窗。
    let want = open || (typing && m.need > 1);

    // 刚刚因为「输入法收了」回过位：这一小会儿不许再顶上去。
    // 输入法收起的过程里各种信号会抖（原生层、VirtualKeyboard 的矩形、WebView 自己的滚动），
    // 抖一下就重顶一次 = 用户看到的「回位之后又闪一下跳上去」。
    // 用户真的又去点输入框时会把这个窗口清掉（见 noteFocusIn），所以不影响响应速度。
    if (want && state.settleUntil && performance.now() < state.settleUntil) want = false;
    // 假定的输入法高度是猜的，只在用户确实点过这个弹窗里的东西时才拿它顶
    if (want && vp.source === 'assumed' && !state.armed) want = false;

    if (want) {
        // 新的一轮 —— 手动拖过的锁只在同一轮里有效
        if (!state.kbdWasOpen) {
            state.kbdWasOpen = true;
            state.manual = false;
            state.manualNoKbd = false;
        }
        if (state.manual && !force) return;           // 这一轮里用户自己拉过，听他的
        if (Math.abs(m.shift - currentShift(dlg)) < 1) return;
        setShift(dlg, m.shift, { why: vp.source });
        dbg('auto shift', m.shift, 'need', m.need, 'min', m.min);
        return;
    }

    // 这一轮结束了（输入法收了）→ **一定**回原位，哪怕这一轮里用手拖过。
    // 安卓用输入法自带的收起键 / 返回键收输入法时输入框不会失焦，所以这件事
    // 只能靠这里的状态翻转来做，靠 focusout 会漏。
    if (state.kbdWasOpen) {
        state.kbdWasOpen = false;
        state.hadRound = true;
        state.manual = false;
        state.manualNoKbd = false;
        state.armed = false;
        state.settleUntil = performance.now() + 450;   // 回位过程中不许被抖动的信号再顶上去
        if (currentShift(dlg) !== 0) setShift(dlg, 0, { why: 'kbd-closed' });
        dbg('keyboard round ended -> reset');
        return;
    }

    // 从头到尾没输入法：用户自己拖着看被截断的内容，别把他拽回去
    if (state.manual || state.manualNoKbd) return;
    if (currentShift(dlg) !== 0) setShift(dlg, 0, { why: 'idle' });
}

/** 一行诊断文本：把我们看到的视口 / 几何 / 结论全摊出来，排查用 */
function diagText(dlg) {
    const vp = viewport();
    const m = dlg ? measure(dlg) : null;
    const r = dlg?.getBoundingClientRect();
    const state = dlg ? popups.get(dlg) : null;
    const input = state?.input || (dlg ? mainInputOf(dlg) : null);
    const ir = input?.getBoundingClientRect();
    const ctrls = dlg?.querySelector('.popup-controls')?.getBoundingClientRect();
    const n = (v) => (v === undefined || v === null ? '-' : Math.round(v));
    const okBtn = ctrls ? (ctrls.bottom <= vp.bottom + 2 ? 'YES' : 'NO') : '-';
    return [
        `tpp v${VERSION} hook=${state?.how || lastHook} pops=${popups.size} enh=${dlg?.classList.contains('tpp-popup') ? 1 : 0}`,
        `layoutH=${n(vp.layoutH)} base=${n(baseLayoutH)} vvH=${n(vp.vvH)} ime=${n(vp.imeVar)} shrink=${n(vp.shrink)}`,
        `visible=${n(vp.top)}..${n(vp.bottom)} inset=${n(vp.inset)} kbd=${keyboardOpen(vp) ? 'YES' : 'no'} src=${vp.source}`,
        `blind=${kbdBlind ? 1 : 0}/seen=${cfg().blindSeen ? 1 : 0} assume=${n(assumedInset)} vk=${navigator.virtualKeyboard ? (vkTried ? 'on' : 'idle') : 'none'} mobile=${isMobileUA() ? 1 : 0} arm=${state?.armed ? 1 : 0} settle=${state?.settleUntil > performance.now() ? 1 : 0}`,
        `dlg=${n(r?.top)}..${n(r?.bottom)} input=${n(ir?.top)}..${n(ir?.bottom)} ctrls=${n(ctrls?.top)}..${n(ctrls?.bottom)}`,
        `tag=${dlg?.tagName} css=${getComputedStyle(dlg).getPropertyValue('--tpp-css').trim() || 'NO'} ctrlsInDlg=${dlg?.querySelector('.popup-controls') ? 1 : 0}/doc=${document.querySelectorAll('.popup-controls').length} in1line=${input?.classList.contains('tpp-oneline') ? 1 : 0} inH=${n(ir?.height)}`,
        `need=${n(m?.need)} shift=${n(dlg ? currentShift(dlg) : null)} dragMin=${n(m?.min)} hardMin=${n(m?.hardMin)} btn=${okBtn}`,
        `last: ${traceText()}`,
    ].join('\n');
}

function renderDiag(dlg) {
    const on = cfg().diag;
    dlg.__tppDiag = on;
    let box = dlg.querySelector(':scope > .popup-body > .tpp-diag') || dlg.querySelector('.tpp-diag');
    if (!on) {
        box?.remove();
        return;
    }
    if (!box) {
        box = document.createElement('pre');
        box.className = 'tpp-diag';
        (dlg.querySelector('.popup-body') || dlg).appendChild(box);
    }
    box.textContent = diagText(dlg);
}

/** 把弹窗的最大高度钉在「输入法没开时」的视口高度上，输入法弹出时弹窗就不会变形抖动 */
function freezeHeight(dlg) {
    const h = layoutHeight();
    // adjustResize 的 WebView 在输入法弹出时布局视口是缩小的，别把缩小后的高度钉进去
    const use = Math.max(h, baseLayoutH);
    if (use > 0) dlg.style.setProperty('--tpp-vh', `${use}px`);
}

/* ------------------------------------------------------- 手指拖动 */

/** 手机上弹窗常比屏幕高，顶部被切掉一截 —— 这种情况也该能拖着看 */
function overflowsViewport(dlg) {
    if (!cfg().dragOverflow) return false;
    return bounds(dlg).clipped > 4;
}

function dragEnabled(dlg) {
    const c = cfg();
    if (!c.enabled || !c.dragShift) return false;
    return c.dragAlways || keyboardOpen() || currentShift(dlg) !== 0 || overflowsViewport(dlg);
}

/** 从这个元素上开始滑动算不算「拖弹窗」 */
function dragAllowedFrom(dlg, target) {
    if (!(target instanceof Element)) return true;
    if (target.closest('.popup-controls, .popup-button-close, button, select, option, a')) return false;
    if (isEditable(target)) return false;                 // 输入框里滑动是选字，不抢
    // 自己能滚的容器交给它自己滚。先比高度（免费），只有真的溢出了才去问样式
    // （getComputedStyle 会强制算样式，手指刚落下时最不该干这个）
    for (let el = target; el && el !== dlg; el = el.parentElement) {
        if (el.scrollHeight <= el.clientHeight + 2) continue;
        if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) return false;
    }
    return true;
}

function bindDrag(dlg, state) {
    let pendingY = null;
    let frame = 0;

    const shiftFor = (d) => clamp(d.start + (pendingY - d.y0), d.min, d.max);

    // 一帧只写一次位移：安卓的 touchmove 比刷新率密得多，逐个写就是白掉帧
    const flush = () => {
        frame = 0;
        const d = state.drag;
        if (!d?.active || pendingY === null) return;
        setShift(dlg, shiftFor(d), { fast: true });
    };

    const begin = (y, target) => {
        if (!dragAllowedFrom(dlg, target)) {
            state.drag = null;
            return;
        }
        // start 用「这一刻实际位移」，半路截住正在滑动的弹窗也不会跳
        state.drag = { y0: y, start: actualShift(dlg), active: false, min: 0, max: 0 };
    };

    const move = (y, prevent) => {
        const d = state.drag;
        if (!d) return;
        const dy = y - d.y0;
        if (!d.active) {
            if (Math.abs(dy) < 8) return;                 // 阈值内当点击处理（点空白 → 原生收输入法）
            if (!dragEnabled(dlg)) {
                state.drag = null;
                return;
            }
            d.active = true;
            const b = bounds(dlg);
            d.min = Math.min(b.min, d.start);              // 已经顶得比上限还高时，别一碰就把他拽下来
            d.max = b.max;
            state.manual = true;                          // 之后不再自动推，听用户的
            // 全程没输入法时拖 = 在看被截断的内容，别在轮询里把他拽回原位。
            // （有输入法的那一轮结束时一定回位，见 applyAutoShift）
            state.manualNoKbd = !state.kbdWasOpen;
            dlg.classList.add('tpp-dragging');
        }
        // 关键：把这一串触摸的默认行为取消掉 —— 连带取消 click 与焦点变化，
        // 所以拉弹窗的时候输入法不会被收起来。
        prevent?.();
        pendingY = y;
        if (!frame) frame = requestAnimationFrame(flush);
    };

    const end = () => {
        if (frame) {
            cancelAnimationFrame(frame);
            frame = 0;
        }
        const d = state.drag;
        if (d?.active) {
            const last = pendingY === null ? currentShift(dlg) : shiftFor(d);
            setShift(dlg, last, { fast: true, why: 'drag' });
            dlg.classList.remove('tpp-dragging');
            // 松手之后再把 --tpp-shift 同步回去（关窗动画的 keyframes 要用它）。
            // 自定义属性是会继承的，写一次整棵子树都要重算样式 —— 放到下一帧，
            // 免得这活跟手指抬起来的那一帧撞在一起。
            requestAnimationFrame(() => dlg.style.setProperty('--tpp-shift', `${Math.round(last)}px`));
        }
        pendingY = null;
        state.drag = null;
    };

    const onTouchStart = (e) => {
        if (e.touches.length !== 1) return end();
        begin(e.touches[0].clientY, e.target);
    };
    const onTouchMove = (e) => {
        if (e.touches.length !== 1) return;
        move(e.touches[0].clientY, () => { if (e.cancelable) e.preventDefault(); });
    };
    const onPointerDown = (e) => {
        if (e.pointerType === 'touch') return;            // 触摸走 touch 事件（那边才能拦住焦点变化）
        if (e.button !== 0) return;
        begin(e.clientY, e.target);
    };
    const onPointerMove = (e) => {
        if (e.pointerType === 'touch') return;
        move(e.clientY, () => { if (e.cancelable) e.preventDefault(); });
    };

    dlg.addEventListener('touchstart', onTouchStart, { passive: true });
    dlg.addEventListener('touchmove', onTouchMove, { passive: false });
    dlg.addEventListener('touchend', end, { passive: true });
    dlg.addEventListener('touchcancel', end, { passive: true });
    dlg.addEventListener('pointerdown', onPointerDown);
    dlg.addEventListener('pointermove', onPointerMove);
    dlg.addEventListener('pointerup', end);
    dlg.addEventListener('pointercancel', end);
}

/* --------------------------------------------------- 装配 / 卸载弹窗 */

let rafToken = 0;

function schedule() {
    if (rafToken) return;
    rafToken = requestAnimationFrame(() => {
        rafToken = 0;
        for (const dlg of [...popups.keys()]) {
            if (!document.contains(dlg)) {
                forget(dlg);
                continue;
            }
            applyAutoShift(dlg);
        }
    });
}

function forget(dlg) {
    popups.delete(dlg);
}

/** 等开窗动画结束（拿不到动画就退化成定时器） */
function afterOpen(dlg, callback) {
    let done = false;
    const run = () => {
        if (done) return;
        done = true;
        try {
            callback();
        } catch (error) {
            warn('afterOpen failed', error);
        }
    };
    dlg.addEventListener('animationend', run, { once: true });
    setTimeout(run, (cfg().animMs || 150) + 120);
}

/** 输入框相关的外观处理。弹窗还没打开时可能拿不到输入框，所以开窗后会再调一次。 */
function applyInputLook(dlg, state) {
    const c = cfg();
    const input = state.input || mainInputOf(dlg);
    if (!input) return false;
    state.input = input;

    dlg.classList.add('tpp-input-popup');
    if (c.widePopup) {
        dlg.classList.add('tpp-wide');
        dlg.style.setProperty('--tpp-width', `${c.popupWidth}px`);
    }
    if (c.roomyInput) {
        dlg.classList.add('tpp-roomy');
        dlg.style.setProperty('--tpp-input-height', `${c.inputHeight}px`);
    }
    if (c.singleLine && (Number(input.rows) || 1) <= 1) {
        input.classList.add('tpp-oneline');
        input.setAttribute('wrap', 'off');
    }
    return true;
}

/* ------------------------------------- 新增 API 连接配置的默认名字 */

/**
 * 「新增API连接配置」弹窗里那一排勾选项就是这份配置的字段。每个勾选框的
 * `value` 是**英文字段名**（`API` / `Model` / `Settings Preset`…，客户端只翻译显示文字，
 * 不动 value），所以拿它当 key 是稳的，中英文界面都能用。
 * 改名弹窗（edit.html）的那排勾选项里没有值，认不出来 → 自动跳过，不碰用户的旧名字。
 */
function profileFields(dlg) {
    const out = new Map();
    for (const box of dlg.querySelectorAll('input[name="exclude"]')) {
        const span = box.closest('label')?.querySelector('span');
        const strong = span?.querySelector('strong');
        if (!span || !strong) continue;
        const value = span.textContent.replace(strong.textContent, '').replace(/\u00a0/g, ' ').trim();
        if (value) out.set(box.value, value);
    }
    return out.size ? out : null;
}

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 客户端预填的名字固定是 `${API} ${Model} - ${预设}`（重名时后面还有 ` (2)`）。
 *  只有确认是这串**自动拼的**名字才替换 —— 用户自己打过字、或者在改名，一律不碰。 */
function looksSuggested(value, fields) {
    const base = `${fields.get('API') || ''} ${fields.get('Model') || ''} - ${fields.get('Settings Preset') || ''}`
        .replace(/\s+/g, ' ').trim();
    if (!base || base === '-') return false;
    const v = String(value).trim();
    return v === base || new RegExp(`^${escapeRe(base)} \\(\\d+\\)$`).test(v);
}

function composeName(fields, mode) {
    const api = fields.get('API') || '';
    const model = fields.get('Model') || '';
    const preset = fields.get('Settings Preset') || '';
    if (mode === 'model-preset') return [model, preset].filter(Boolean).join(' - ');
    if (mode === 'api-model') return [api, model].filter(Boolean).join(' ');
    return model;                                   // 默认：只要模型名
}

/** 已经存在的配置名（重名客户端会直接报错，所以自己加个 (2)） */
function takenNames() {
    const names = new Set();
    for (const opt of document.querySelectorAll('#connection_profiles option')) {
        const name = opt.textContent.trim();
        if (name) names.add(name);
    }
    return names;
}

function uniqueName(name) {
    const taken = takenNames();
    if (!taken.has(name)) return name;
    for (let i = 2; i < 200; i++) {
        const candidate = `${name} (${i})`;
        if (!taken.has(candidate)) return candidate;
    }
    return name;
}

/** 这排勾选项 + 一个输入框 = 「新增API连接配置」那个弹窗（改名弹窗认不出字段值，会被排除掉） */
function isCreateProfilePopup(dlg) {
    return !!profileFields(dlg) && !!mainInputOf(dlg);
}

function excludeBoxes(dlg) {
    return [...dlg.querySelectorAll('input[name="exclude"]')];
}

/**
 * 把上次没勾的项还原成没勾。
 * 注意：客户端是**监听勾选框的 input 事件**来维护「这份配置不保存哪些字段」的，
 * 所以光把 `checked` 改掉只是看着没勾，必须把事件补发出去，客户端才真的不保存它。
 */
function applyExcludeMemory(dlg, state) {
    if (!cfg().enabled || !cfg().rememberExclude || state.excludeApplied) return 0;
    if (!isCreateProfilePopup(dlg)) return 0;
    state.excludeApplied = true;                     // 只在开窗时还原一次，之后随用户改
    const memory = cfg().excludeMemory;
    if (!Array.isArray(memory) || !memory.length) return 0;

    let n = 0;
    for (const box of excludeBoxes(dlg)) {
        if (!box.checked || !memory.includes(box.value)) continue;
        box.checked = false;
        box.dispatchEvent(new Event('input', { bubbles: true }));
        box.dispatchEvent(new Event('change', { bubbles: true }));
        n++;
    }
    dbg('exclude memory restored', memory, n);
    return n;
}

/** 点了保存 → 把「现在没勾哪些」记下来（取消 / 关掉弹窗不记） */
function rememberExclude(dlg) {
    if (!cfg().enabled || !cfg().rememberExclude) return;
    if (!isCreateProfilePopup(dlg)) return;
    const list = excludeBoxes(dlg).filter((b) => !b.checked).map((b) => b.value);
    const prev = Array.isArray(cfg().excludeMemory) ? cfg().excludeMemory : [];
    if (prev.length === list.length && prev.every((v) => list.includes(v))) return;
    cfg().excludeMemory = list;
    saveCfg();
    dbg('exclude memory saved', list);
}

/** 把预填的长名字换成用户选的写法（默认只留模型名） */
function fixSuggestedName(dlg) {
    const mode = cfg().nameMode;
    if (!cfg().enabled || mode === 'keep') return false;
    const input = mainInputOf(dlg);
    if (!input) return false;
    const fields = profileFields(dlg);
    if (!fields || !looksSuggested(input.value, fields)) return false;

    const name = uniqueName(composeName(fields, mode));
    if (!name || name === input.value) return false;
    input.value = name;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    try {
        input.setSelectionRange(0, name.length);     // 跟原生一样全选，直接打字就能覆盖
    } catch { /* ignore */ }
    dbg('suggested name ->', name);
    return true;
}

function enhance(dlg, how = 'unknown') {
    if (!cfg().enabled || popups.has(dlg)) return;
    const c = cfg();
    const state = {
        input: mainInputOf(dlg), manual: false, manualNoKbd: false, kbdWasOpen: false, drag: null, how,
        openedAt: performance.now(), armed: false, hadRound: false, settleUntil: 0,
    };
    popups.set(dlg, state);
    lastHook = how;

    dlg.classList.add('tpp-popup');
    setShift(dlg, 0);

    if (c.smoothAnim) {
        dlg.classList.add('tpp-anim');
        dlg.style.setProperty('--tpp-anim-ms', `${c.animMs}ms`);
    }
    if (c.cheapBackdrop) dlg.classList.add('tpp-cheap-backdrop');
    if (c.freezeHeight) {
        dlg.classList.add('tpp-freeze');
        freezeHeight(dlg);
    }

    applyInputLook(dlg, state);
    applyExcludeMemory(dlg, state);
    fixSuggestedName(dlg);

    bindDrag(dlg, state);

    // 点「保存」才记住这排勾选项（捕获阶段：在客户端读走这些值之前）。
    // 输入框里按回车也是保存（客户端的 data-result-event="submit"）。
    dlg.addEventListener('click', (e) => {
        if (e.target instanceof Element && e.target.closest('.popup-button-ok')) rememberExclude(dlg);
    }, true);
    dlg.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.shiftKey) return;
        if (e.target instanceof Element && e.target.classList.contains('popup-input')) rememberExclude(dlg);
    }, true);

    // 用户点进弹窗里另一个输入框 → 重新按那个框避让
    dlg.addEventListener('focusin', () => {
        // 用户主动点进某个输入框 = 重新表达意图，恢复自动避让
        state.manual = false;
        state.manualNoKbd = false;
        schedule();
    });
    dlg.addEventListener('input', schedule);

    dbg('enhanced', { how, input: !!state.input, classes: dlg.className });
    schedule();
    afterOpen(dlg, () => {
        applyInputLook(dlg, state);          // 开窗后输入框才量得到，补一次
        applyExcludeMemory(dlg, state);      // 接管得晚（扫描兜底）时这里才轮得到
        fixSuggestedName(dlg);               // 接管得晚的话这时候才看得到预填的名字
        // 接管得晚（扫描兜底）时 focusin 可能已经过去了，这里补一次判定
        const active = document.activeElement;
        if (active && dlg.contains(active) && isEditable(active)) noteFocusIn(active);
        schedule();
    });
}

/**
 * 最早的钩子：`showModal()` 之前。
 * 这里装配可以避免弹窗先以原生样子闪一帧，也是唯一能在浏览器处理 autofocus
 * 之前把 autofocus 摘掉的时机（deferFocus）。
 */
function patchShowModal() {
    const proto = globalThis.HTMLDialogElement?.prototype;
    if (!proto || proto.__tppPatched) return;
    const original = proto.showModal;
    proto.showModal = function (...args) {
        let deferred = null;
        try {
            if (this.classList?.contains('popup') && cfg().enabled) {
                enhance(this, 'showModal');
                if (cfg().deferFocus && mainInputOf(this)) {
                    const auto = this.querySelector('[autofocus]');
                    if (auto) {
                        auto.removeAttribute('autofocus');
                        deferred = auto;
                    }
                }
            }
        } catch (error) {
            warn('pre-show hook failed', error);
        }
        const result = original.apply(this, args);
        if (deferred) {
            afterOpen(this, () => {
                deferred.setAttribute('autofocus', '');
                try {
                    deferred.focus();
                } catch { /* ignore */ }
            });
        }
        return result;
    };
    proto.__tppPatched = true;
}

/** 这个元素现在是不是一个「开着的」弹窗（polyfill 的 dialog 可能不是 <dialog>，也可能没有 open 属性） */
function looksOpen(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el.hasAttribute('open') || el.open === true) return true;
    if (el.hasAttribute('closing')) return false;
    return !!el.offsetParent && el.getBoundingClientRect().height > 0;
}

/**
 * 兜底 1：DOM 观察（整棵树，不只 body 的直接子节点 —— 有的客户端会把弹窗塞进容器里）。
 * 兜底 2：定时扫一遍所有 .popup。只要 showModal 补丁和观察器都漏了（老 WebView 没有
 *        HTMLDialogElement、走 polyfill、或者客户端用 show() 而不是 showModal()），
 *        这一路也能把弹窗接管过来。
 */
function watchPopups() {
    const observer = new MutationObserver((records) => {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (!(node instanceof HTMLElement)) continue;
                if (node.matches?.('.popup')) enhance(node, 'observer');
                else node.querySelectorAll?.('.popup').forEach((el) => enhance(el, 'observer-sub'));
            }
            for (const node of record.removedNodes) {
                if (node instanceof HTMLElement && popups.has(node)) forget(node);
            }
        }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
}

function sweepPopups() {
    if (!cfg().enabled) return;
    // 手指正按着的时候一个字都别查：looksOpen() 会读几何 = 强制重排，正好卡在拖动的每一帧上
    for (const state of popups.values()) if (state.drag?.active) return;
    for (const el of document.querySelectorAll('.popup')) {
        if (popups.has(el)) continue;
        if (!looksOpen(el)) continue;
        enhance(el, 'sweep');
    }
}

/** 输入框拿到焦点：先等真实信号，等不到就断定这个环境是「输入法盲区」，按比例假定一个 */
let assumeTimer = 0;

function noteFocusIn(target) {
    if (!cfg().enabled || !cfg().kbdAvoid || !cfg().assumeKbd) return;
    if (!isEditable(target)) return;
    if (!isMobileUA()) return;                       // 桌面没有软键盘，别乱顶
    const dlg = target.closest?.('.popup');
    const state = dlg ? popups.get(dlg) : null;
    if (!state) return;

    // 输入法要来了 → 允许拿假定的高度顶，并解除回位后的冷静期
    const byUser = focusMeansKeyboard(dlg, state, target);
    if (byUser) {
        state.armed = true;
        state.settleUntil = 0;
    }

    const apply = () => {
        assumeTimer = 0;
        const raw = viewport();
        // 真实信号出现了（视口缩了 / 原生层报了高度）→ 什么都不用假定
        if (raw.inset >= 40 && raw.source !== 'assumed') {
            kbdBlind = false;
            assumedInset = 0;
            schedule();
            return;
        }
        kbdBlind = true;
        if (cfg().blindSeen !== true) {               // 记住这个环境，下次点输入框就不用再等
            cfg().blindSeen = true;
            saveCfg();
        }
        if (vkInset() > 40) {                        // VirtualKeyboard API 能给真高度，最好
            assumedInset = 0;
        } else {
            const pct = clamp(Number(cfg().assumeKbdPct) || 45, 20, 80);
            assumedInset = Math.round(raw.layoutH * pct / 100);
        }
        dbg('keyboard blind -> assume', assumedInset);
        schedule();
    };

    clearTimeout(assumeTimer);
    // 这个环境已知测不出输入法（这次或上次会话确认过）+ 是用户自己点的 → 立刻顶，
    // 不等输入法弹完（「输入法都出来了弹窗还没上去」就是等出来的）。
    // 其余情况给真实信号 350ms 先说话。
    if ((kbdBlind || cfg().blindSeen === true) && byUser) apply();
    else assumeTimer = setTimeout(apply, 350);
}

function noteFocusOut() {
    clearTimeout(assumeTimer);
    assumeTimer = 0;
    setTimeout(() => {
        const active = document.activeElement;
        if (isEditable(active) && active.closest?.('.popup')) return;   // 还在别的输入框里
        if (assumedInset) {
            assumedInset = 0;                        // 输入框失焦 = 输入法收了（盲区里只能这么判断）
            schedule();
        }
    }, 60);
}

function bindViewport() {
    // 记住用户最后碰的是什么（判断一次 focus 是真手指点的还是程序抢的）
    const seen = (e) => noteUserPointer(e.target);
    document.addEventListener('touchstart', seen, { capture: true, passive: true });
    document.addEventListener('pointerdown', seen, { capture: true, passive: true });
    document.addEventListener('mousedown', seen, { capture: true, passive: true });

    const vv = window.visualViewport;
    vv?.addEventListener('resize', schedule);
    vv?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    document.addEventListener('focusin', (e) => {
        noteFocusIn(e.target);
        schedule();
    });
    document.addEventListener('focusout', () => {
        noteFocusOut();
        schedule();
    });
    // 测试 / 兜底钩子：有的 WebView 不发 visualViewport 事件
    document.addEventListener('tpp-viewport', schedule);
    setInterval(() => {
        sweepPopups();
        if (popups.size) schedule();
    }, 250);
}

/* ------------------------------------------------------- 密钥小眼睛 */

/** 密钥输入框 → { eye, injected, origType, origPlaceholder, obs } */
const eyes = new Map();

/** 「已保存的密钥被写进提示文字」的特征：客户端写的是 `<Key saved> (sk-xxxx)` */
const KEY_HINT_RE = /(<?\s*key\s*saved|密钥已保存|已保存)/i;

function looksLikeKeyHint(value) {
    if (!value) return false;
    return KEY_HINT_RE.test(value) || /[A-Za-z0-9_-]{16,}/.test(value);
}

function keyInputs() {
    return [...document.querySelectorAll('input[id^="api_key_"], input#custom_api_key')];
}

function setEyeState(rec, revealed) {
    if (!rec?.eye) return;
    rec.eye.classList.toggle('fa-eye', !revealed);
    rec.eye.classList.toggle('fa-eye-slash', revealed);
    rec.eye.title = revealed ? t('hideKey') : t('showKey');
}

function mask(input) {
    if (input.type !== 'password') input.type = 'password';
}

/**
 * 向后端要已存的密钥明文。
 * 走的是跟原生「查看隐藏的 API 密钥」同一个开关，没开会回 403。
 */
async function fetchStoredKey(keyName) {
    if (!keyName) return { ok: false, status: 0 };
    const headers = ctx()?.getRequestHeaders?.() || { 'Content-Type': 'application/json' };
    try {
        const res = await fetch('/api/secrets/find', {
            method: 'POST',
            headers,
            body: JSON.stringify({ key: keyName }),
        });
        if (!res.ok) return { ok: false, status: res.status };
        const data = await res.json();
        return { ok: true, value: typeof data?.value === 'string' ? data.value : '' };
    } catch (error) {
        warn('read secret failed', error);
        return { ok: false, status: 0 };
    }
}

async function toggleReveal(input) {
    const rec = eyes.get(input);
    if (!rec) return;

    // 当前是明文 → 收起来（我们填进去的明文顺手抹掉）
    if (input.type !== 'password') {
        if (rec.injected) {
            input.value = '';
            rec.injected = false;
        }
        mask(input);
        setEyeState(rec, false);
        return;
    }

    if (!input.value) {
        const res = await fetchStoredKey(input.id);
        if (!res.ok) {
            toast('warning', res.status === 403 ? t('keyExposureOff') : t('keyReadFailed'));
            return;
        }
        if (!res.value) {
            toast('info', t('keyEmpty'));
            return;
        }
        input.value = res.value;
        rec.injected = true;
    }
    input.type = 'text';
    setEyeState(rec, true);
}

/** 把我们填进去的明文抹掉：留着的话点「连接 / 加载模型」会让客户端把同一把密钥又存一遍 */
function clearInjected(input, rec) {
    if (!rec.injected) return;
    rec.injected = false;
    input.value = '';
    mask(input);
    setEyeState(rec, false);
    dbg('cleared injected key', input.id);
}

function guardPlaceholder(input, rec) {
    const enforce = () => {
        if (!cfg().enabled || !cfg().guardKeyHint) return;
        const value = input.getAttribute('placeholder') || '';
        if (!value || value === t('keySaved')) return;
        if (value === rec.origPlaceholder) return;
        if (!looksLikeKeyHint(value)) return;
        rec.nativeHint = value;
        input.setAttribute('placeholder', t('keySaved'));
    };
    const obs = new MutationObserver(enforce);
    obs.observe(input, { attributes: true, attributeFilter: ['placeholder'] });
    rec.obs = obs;
    enforce();
}

function attachEye(input) {
    const rec = {
        origType: input.getAttribute('type'),
        origPlaceholder: input.getAttribute('placeholder') || '',
        injected: false,
    };

    const eye = document.createElement('div');
    eye.className = 'menu_button fa-solid fa-eye tpp-eye';
    eye.title = t('showKey');
    eye.tabIndex = 0;
    eye.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleReveal(input);
    });
    input.insertAdjacentElement('afterend', eye);
    rec.eye = eye;
    eyes.set(input, rec);

    // 原生密钥框是 type="text"（明文直接可见），先遮成圆点，点眼睛才看
    mask(input);
    const style = getComputedStyle(input);
    eye.style.marginTop = style.marginTop;
    eye.style.marginBottom = style.marginBottom;

    input.addEventListener('input', () => { rec.injected = false; });
    guardPlaceholder(input, rec);
    dbg('eye attached', input.id);
}

/** 别人（比如 api-panel-layout）已经在这一行放过眼睛了，就不再放第二只 */
function foreignEye(input) {
    const row = input.parentElement;
    if (!row) return false;
    return [...row.children].some(el => el !== input
        && !el.classList.contains('tpp-eye')
        && (el.classList.contains('fa-eye') || el.classList.contains('fa-eye-slash') || el.classList.contains('ttal-eye')));
}

function ensureEyes() {
    if (!cfg().enabled || !cfg().keyReveal) return;
    for (const input of keyInputs()) {
        if (!eyes.has(input) && foreignEye(input)) continue;
        if (eyes.has(input)) {
            if (!document.contains(eyes.get(input).eye)) {
                // 客户端重建了这一行，把眼睛放回去
                input.insertAdjacentElement('afterend', eyes.get(input).eye);
            }
            continue;
        }
        try {
            attachEye(input);
        } catch (error) {
            warn('attach eye failed', input.id, error);
        }
    }
}

/** 关掉「小眼睛」时把密钥框还原成原生样子 */
function removeEyes() {
    for (const [input, rec] of eyes) {
        try {
            if (rec.injected) input.value = '';
            rec.obs?.disconnect();
            if (rec.nativeHint && (input.getAttribute('placeholder') || '') === t('keySaved')) {
                input.setAttribute('placeholder', rec.nativeHint);
            }
            if (rec.origType) input.setAttribute('type', rec.origType);
            else input.removeAttribute('type');
            rec.eye?.remove();
        } catch (error) {
            warn('remove eye failed', error);
        }
    }
    eyes.clear();
}

function bindKeyGuards() {
    // 点「连接 / 加载模型」等任何按钮之前，先把我们填的明文抹掉。
    // 必须挂在 document 的捕获阶段：客户端的处理器绑得比我们早，同一元素上先跑它。
    document.addEventListener('click', (event) => {
        if (!eyes.size) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest('.tpp-eye')) return;
        const isControl = target.closest('button, .menu_button, select, option, [id^="api_button"], .fa-solid');
        if (!isControl) return;
        for (const [input, rec] of eyes) {
            if (rec.injected && target !== input) clearInjected(input, rec);
        }
    }, true);

    document.addEventListener('change', (event) => {
        if (!eyes.size) return;
        if (event.target?.matches?.('#chat_completion_source, #main_api, #textgen_type')) {
            for (const [input, rec] of eyes) clearInjected(input, rec);
        }
    }, true);
}

/* --------------------------------------------------- 切换连接配置的误报抑制 */

/**
 * 切换 connection profile / API / preset 时，客户端会立刻 trigger('#api_button_*')
 * 去打 /api/backends/chat-completions/status —— 这一发不等 waitUntilCondition，可能用还没
 * 生效的 token，上游回 401，后端包成「后端错误 Failed to get chat completions status:
 * Unauthorized: Invalid token (request id: …)」弹出来。真实连接事后是好的。
 *
 * 注意：切换 preset 这个动作恰恰是发生「在线状态」的（你之前一直能聊天，只是换了个 token），
 * 所以不能用「在线就放行」来区分真假 401 —— 那样会把切换误报全放过。
 *
 * 真假 401 的边界只靠两条：
 *   ① 我们刚感知到一次切换（事件 / 下拉 change），且在 switchGraceMs 内；
 *   ② toast 文案同时匹配「chat completions status」和「Unauthorized」。
 * 两条全中才吞。聊天时真实 401 的文案一般是「Chat completion error: …」，不含
 * 「chat completions status」，撞不上；window 外的也撞不上。所以这组判别够窄。
 */

let switchArmedAt = 0;          // 最近一次感知到切换的时间戳，0 = 没有

function armSwitchWindow() {
    if (!cfg().enabled || !cfg().suppressSwitchErrors) return;
    switchArmedAt = performance.now();
    dbg('switch window armed (error suppression active)');
}

async function bindSwitchErrorSuppressor() {
    const context = ctx();
    const eventTypes = context?.event_types;
    const eventSource = context?.eventSource;

    if (eventSource && eventTypes) {
        const onSwitch = () => armSwitchWindow();
        const names = [
            eventTypes.CONNECTION_PROFILE_LOADED,
            eventTypes.CONNECTION_PROFILE_CREATED,
            eventTypes.CONNECTION_PROFILE_UPDATED,
            eventTypes.MAIN_API_CHANGED,
            eventTypes.CHATCOMPLETION_SOURCE_CHANGED,
            eventTypes.OAI_PRESET_CHANGED_BEFORE,
            eventTypes.OAI_PRESET_CHANGED_AFTER,
            eventTypes.PRESET_CHANGED,
            eventTypes.SECRET_WRITTEN,
            eventTypes.SECRET_ROTATED,
        ];
        for (const name of names) {
            if (typeof name === 'string') {
                try { eventSource.on(name, onSwitch); } catch { /* ignore */ }
            }
        }
    }

    // 兜底：下拉 change。TauriTavern 上事件系统不一定全发，下拉这一路最实在。
    // 注意 OAI preset 下拉在 ST 里叫 #settings_preset_openai（不是 #preset_select），
    // 这一项之前漏了，导致切 OAI preset 时 arm 不上窗口，Unauthorized toast 漏网。
    const switchySelectors = '#connection_profiles, #main_api, #chat_completion_source, #textgen_type, #settings_preset_openai, #preset_select_openai';
    document.addEventListener('change', (event) => {
        if (!(event.target instanceof Element)) return;
        if (!event.target.matches(switchySelectors)) return;
        armSwitchWindow();
    }, true);

    // 另一路兜底：拦截「点连接按钮 / API 按钮被 trigger」那一刻 —— 切 preset 会连锁
    // trigger('#api_button_openai') 去打 status，arm 在这一发之前更保险。
    document.addEventListener('click', (event) => {
        if (!(event.target instanceof Element)) return;
        if (!event.target.closest('#api_button_openai, #api_button')) return;
        armSwitchWindow();
    }, true);

    try { wrapToastrError(); } catch (error) { warn('toastr wrap failed', error); }
}

function shouldSuppressSwitchError(message, title) {
    if (!cfg().enabled || !cfg().suppressSwitchErrors) return false;
    if (switchArmedAt === 0) {
        dbg('toast not suppressed: no switch armed (no switch perceived)');
        return false;
    }
    const grace = Math.max(0, Number(cfg().switchGraceMs) || 0);
    const since = performance.now() - switchArmedAt;
    if (grace > 0 && since > grace) {
        dbg('toast not suppressed: grace expired', { since, grace });
        return false;
    }
    const text = `${title ?? ''} ${message ?? ''}`;
    const hitStatus = /chat completions status/i.test(text);
    const hitUnauth = /Unauthorized/i.test(text);
    if (!(hitStatus && hitUnauth)) {
        dbg('toast not suppressed: text mismatch', { hitStatus, hitUnauth, text });
        return false;
    }
    dbg('toast SUPPRESSED:', { message, title, since, grace });
    return true;
}

function wrapToastrError() {
    const lib = globalThis.toastr;
    if (!lib || lib.__tppWrapped) return;
    const original = lib.error;
    lib.error = function (message, title, opts) {
        try {
            if (shouldSuppressSwitchError(message, title)) {
                dbg('suppressed switch-unauthorized toast:', message, title);
                return null;
            }
        } catch (error) {
            warn('suppress check failed', error);
        }
        return original.call(this, message, title, opts);
    };
    lib.error.__tppWrapped = true;
    if (!globalThis.__tppToastrErrorOrig) globalThis.__tppToastrErrorOrig = original;
}

/* --------------------------------------------------- 扩展设置面板 */

/* 常用的就这几项，其余全塞进「高级设置」折叠起来 */
const TOGGLES = [
    ['enabled', '启用本扩展', 'Enable this extension'],
    ['keyReveal', '密钥框右边加「小眼睛」', 'Add an eye button next to the API key'],
    ['kbdAvoid', '输入法弹出时把弹窗顶上去（带「取消 / 确认」）', 'Lift the popup above the keyboard'],
    ['dragShift', '可以用手指上下拖动弹窗', 'Drag the popup up and down'],
    ['rememberExclude', '记住上次没勾的项（新增配置弹窗）', 'Remember which settings you unchecked'],
    ['suppressSwitchErrors', '切换连接配置时压住「后端错误 / Unauthorized」误报', 'Suppress the Unauthorized backend error right after switching connection profile'],
];

const NUMBERS = [
    ['assumeKbdPct', '输入法占屏幕高度 (%)：顶得不够就调大', 'Keyboard height (% of screen)', 20, 80],
    ['dragUpMax', '往上最多再拖 (px)', 'Extra drag range upwards (px)', 0, 600],
];

const SELECTS = [
    ['nameMode', '新配置的默认名字', 'Suggested profile name', [
        ['model', '只要模型名', 'Model only'],
        ['model-preset', '模型名 - 预设', 'Model - preset'],
        ['api-model', 'API + 模型名', 'API + model'],
        ['keep', '不改（客户端原来那串）', 'Leave it alone'],
    ]],
];

const TOGGLES_ADV = [
    ['guardKeyHint', '不让已存的密钥出现在提示文字里', 'Keep the stored key out of the placeholder'],
    ['widePopup', '输入类弹窗更宽（默认关，宽度就是原生的）', 'Wider input popups'],
    ['roomyInput', '输入框更高（不那么扁）', 'Taller input field'],
    ['singleLine', '名字超长保持一行往右延伸', 'Keep the name on one line'],
    ['kbdWholePopup', '连「取消 / 确认」一起顶（关掉就只保证输入框露出来）', 'Also lift the OK/Cancel row'],
    ['liftMax', '一次顶到最高', 'Always lift as far as allowed'],
    ['assumeKbd', '测不出输入法高度时按屏幕比例假定（安卓 WebView 必需）', 'Assume a keyboard height when it cannot be measured'],
    ['dragAlways', '输入法没开时也能拖', 'Allow dragging even without the keyboard'],
    ['dragOverflow', '弹窗比屏幕高时可以拖着看', 'Drag to peek when the popup is taller than the screen'],
    ['freezeHeight', '输入法弹出时不让弹窗变形', 'Freeze popup height while the keyboard is open'],
    ['smoothAnim', '换掉原生开窗动画（更顺）', 'Replace the native open animation'],
    ['cheapBackdrop', '弹窗背景不做高斯模糊（更顺）', 'No backdrop blur for popups'],
    ['deferFocus', '等动画结束再弹输入法', 'Focus the input after the animation'],
    ['diag', '在弹窗里显示诊断信息（排查用）', 'Show a diagnostic readout inside the popup'],
    ['debug', '调试日志', 'Debug logging'],
];

const NUMBERS_ADV = [
    ['popupWidth', '弹窗目标宽度 (px)', 'Popup width (px)', 360, 1200],
    ['inputHeight', '输入框最小高度 (px)', 'Input height (px)', 24, 96],
    ['kbdMargin', '弹窗底边与输入法的间距 (px)', 'Gap above the keyboard (px)', 0, 80],
    ['animMs', '开窗动画时长 (ms)', 'Animation duration (ms)', 60, 400],
    ['switchGraceMs', '切换连接配置后压住误报的窗口 (ms)', 'Error-suppression grace window after a switch (ms)', 1000, 20000],
];

function buildSettingsUI() {
    const host = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!host || document.querySelector('#tpp_settings')) return;

    const block = document.createElement('div');
    block.id = 'tpp_settings';
    // inline-drawer-content 默认 display:none（折叠），但不同 ST 版本 / 客户端可能改这个默认；
    // 这里显式把 content 设成折叠态，确保扩展面板在插件列表里默认是收起的，点一下才展开。
    block.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>${t('title')}</b><small class="tpp-ver">v${VERSION}</small>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content flex-container flexFlowColumn" style="display:none;"></div>
        </div>`;
    const content = block.querySelector('.inline-drawer-content');

    const addToggle = (host, [key, zh, en]) => {
        const label = document.createElement('label');
        label.className = 'checkbox_label';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.id = `tpp_opt_${key}`;
        box.checked = !!cfg()[key];
        const span = document.createElement('span');
        span.textContent = isZh() ? zh : en;
        box.addEventListener('change', () => {
            cfg()[key] = box.checked;
            saveCfg();
            if (key === 'keyReveal' || key === 'enabled') {
                if (cfg().enabled && cfg().keyReveal) ensureEyes();
                else removeEyes();
            }
        });
        label.append(box, span);
        host.appendChild(label);
    };

    const addNumber = (host, [key, zh, en, min, max]) => {
        const row = document.createElement('div');
        row.className = 'flex-container alignItemsCenter tpp-setting-row';
        const span = document.createElement('span');
        span.textContent = isZh() ? zh : en;
        const field = document.createElement('input');
        field.type = 'number';
        field.className = 'text_pole';
        field.id = `tpp_num_${key}`;
        field.min = String(min);
        field.max = String(max);
        field.value = String(cfg()[key]);
        field.addEventListener('change', () => {
            const value = clamp(Number(field.value) || DEFAULT_SETTINGS[key], min, max);
            field.value = String(value);
            cfg()[key] = value;
            saveCfg();
        });
        row.append(span, field);
        host.appendChild(row);
    };

    const addSelect = (host, [key, zh, en, options]) => {
        const row = document.createElement('div');
        row.className = 'flex-container alignItemsCenter tpp-setting-row';
        const span = document.createElement('span');
        span.textContent = isZh() ? zh : en;
        const select = document.createElement('select');
        select.className = 'text_pole';
        select.id = `tpp_sel_${key}`;
        for (const [value, ozh, oen] of options) {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = isZh() ? ozh : oen;
            select.appendChild(opt);
        }
        select.value = String(cfg()[key]);
        select.addEventListener('change', () => {
            cfg()[key] = select.value;
            saveCfg();
        });
        row.append(span, select);
        host.appendChild(row);
    };

    for (const item of TOGGLES) addToggle(content, item);
    for (const item of SELECTS) addSelect(content, item);
    for (const item of NUMBERS) addNumber(content, item);

    // 剩下的一堆折起来：平时不用看
    const adv = document.createElement('details');
    adv.className = 'tpp-advanced';
    const sum = document.createElement('summary');
    sum.textContent = isZh() ? '高级设置' : 'Advanced';
    adv.appendChild(sum);
    for (const item of TOGGLES_ADV) addToggle(adv, item);
    for (const item of NUMBERS_ADV) addNumber(adv, item);
    content.appendChild(adv);

    const hint = document.createElement('small');
    hint.className = 'tpp-hint';
    hint.textContent = isZh()
        ? '设置在下一次打开弹窗时生效。输入法弹出时弹窗整体上顶，「取消 / 确认」一定露在键盘上方；在弹窗空白处上下滑动可以把上面的内容拉回来看（滑动不会收输入法，点一下空白才收，收了自动回位）。'
        : 'Settings apply the next time a popup opens. Swipe on an empty area of the popup to pull it back; swiping keeps the keyboard open, a tap closes it.';
    content.appendChild(hint);

    host.appendChild(block);
}

/* --------------------------------------------------------- 初始化 */

function start() {
    try {
        patchShowModal();
        watchPopups();
        bindViewport();
        bindKeyGuards();
        bindSwitchErrorSuppressor();
        ensureEyes();
        buildSettingsUI();
    } catch (error) {
        warn('start failed', error);
    }

    setInterval(() => {
        if (!document.querySelector('#tpp_settings')) {
            try {
                buildSettingsUI();
            } catch { /* ignore */ }
        }
        if (cfg().enabled && cfg().keyReveal) ensureEyes();
    }, 1500);

    console.log(LOG, 'ready v' + VERSION);
}

globalThis.popupPolish = {
    VERSION, cfg, kbdState: () => ({ kbdBlind, assumedInset, vk: !!navigator.virtualKeyboard }), diagText, sweepPopups, applyAutoShift, saveCfg, viewport, keyboardOpen, measure, bounds, popups, eyes,
    enhance, ensureEyes, removeEyes, schedule, currentShift, setShift,
    trace, traceText, noteUserPointer, noteFocusIn, noteFocusOut, fixSuggestedName, profileFields, composeName,
    applyExcludeMemory, rememberExclude, isCreateProfilePopup,
    resetBlind: () => { kbdBlind = false; assumedInset = 0; },
};

const jq = globalThis.jQuery || globalThis.$;
if (jq) jq(() => start());
else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
