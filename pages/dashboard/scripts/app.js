/**
 * 电波推送 · DenpaPush Dashboard
 * bridge 通信 + ECG 心电图 + M3 动态主题 + 界面设置
 */

import {
  argbFromHex,
  hexFromArgb,
  themeFromSourceColor,
  sourceColorFromImage,
} from "./vendor/material-color-utilities.js";

const bridge = window.AstrBotPluginPage;

// 时间线一次渲染的最大卡片数(保留天数可能远超旧版的 50 条硬上限)
const MAX_TIMELINE_CARDS = 500;

// ─── State ───
const state = {
  ctx: null,
  status: null,
  subscriptions: {},
  logs: [],
  timeline: { mode: "overview", history: [] },
  uiConfig: {
    color_mode: "dynamic",
    brand_color: "#1d9bf0",
    background_mode: "theme",
    custom_background: "#F5F6F8",
    custom_background_dark: "#0C0E13",
    background_image: "",
    background_accent: "",
    corner_radius: 14,
    acrylic_enabled: true,
    material_opacity: 45,
    material_blur: 5,
    material_type: "acrylic",
    font_mode: "misans",
    glow_enabled: true,
    glow_intensity: 15,
    shadow_enabled: true,
    shadow_intensity: 60,
    bg_scrim: 40,
    parallax_mode: "click",
    ecg_mode: "auto",       // ECG 波形: auto=随今日推送数 / manual=手动
    ecg_speed: 60,          // 手动速度(% of 1.0, 20~120 → 0.2~1.2 px/帧)
    ecg_complexity: 5,      // 手动复杂度(0~10)
  },
};

const DEFAULT_SOURCE = "#1d9bf0";

// ─── Helpers ───
function currentIsDark() {
  return document.documentElement.getAttribute("data-theme") === "dark";
}

function toast(msg, type = "info") {
  const container = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// ─── M3 Palette Application (照搬 denpa_echo 完整实现) ───
const paletteCache = {};
const STATUS_SOURCES = { success: "#1B9C5D", warning: "#C98A1B" };
const statusCache = {};
function statusColors(isDark) {
  const key = isDark ? "d" : "l";
  if (statusCache[key]) return statusCache[key];
  const mk = (src) => {
    const s = isDark
      ? themeFromSourceColor(argbFromHex(src)).schemes.dark
      : themeFromSourceColor(argbFromHex(src)).schemes.light;
    return { fg: hexFromArgb(s.primary), bg: hexFromArgb(s.primaryContainer) };
  };
  const v = { success: mk(STATUS_SOURCES.success), warning: mk(STATUS_SOURCES.warning) };
  statusCache[key] = v;
  return v;
}

function rgbStr(hex) {
  const h = hex.replace("#", "");
  return `${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}`;
}

function alphaComposite(fg, bg, a) {
  const ph = fg.replace("#", ""), bh = bg.replace("#", "");
  const pr = parseInt(ph.slice(0, 2), 16), pg = parseInt(ph.slice(2, 4), 16), pb = parseInt(ph.slice(4, 6), 16);
  const br = parseInt(bh.slice(0, 2), 16), bg2 = parseInt(bh.slice(2, 4), 16), bb = parseInt(bh.slice(4, 6), 16);
  const r = Math.round(a * pr + (1 - a) * br);
  const g = Math.round(a * pg + (1 - a) * bg2);
  const b = Math.round(a * pb + (1 - a) * bb);
  const to = (x) => x.toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

const SURFACE_TONES = {
  light: { appBg: 98, low: 96, mid: 94, high: 92, highest: 90 },
  dark: { appBg: 6, low: 10, mid: 12, high: 17, highest: 22 },
};
const SCRIM = { low: 0.05, mid: 0.08, high: 0.11, highest: 0.14 };

function derivePalette(sourceHex, isDark) {
  sourceHex = sourceHex || DEFAULT_SOURCE;
  const key = sourceHex.toLowerCase() + (isDark ? ":d" : ":l");
  if (paletteCache[key]) return paletteCache[key];
  const argb = argbFromHex(sourceHex);
  const theme = themeFromSourceColor(argb);
  const s = isDark ? theme.schemes.dark : theme.schemes.light;
  const tp = theme.palettes.primary;
  const neutral = theme.palettes.neutral;
  const nv = theme.palettes.neutralVariant;
  const st = SURFACE_TONES[isDark ? "dark" : "light"];
  const sc = (t) => hexFromArgb(neutral.tone(t));
  const primaryHex = hexFromArgb(s.primary);
  const cLow = sc(st.low), cMid = sc(st.mid), cHigh = sc(st.high), cHighest = sc(st.highest);
  const appBg = sc(st.appBg);
  const bg1 = alphaComposite(primaryHex, cLow, SCRIM.low);
  const bg2 = alphaComposite(primaryHex, cMid, SCRIM.mid);
  const bg3 = alphaComposite(primaryHex, cHigh, SCRIM.high);
  const bg4 = alphaComposite(primaryHex, cHighest, SCRIM.highest);
  // Mica 色调: 壁纸/品牌主色叠在表面色上形成低饱和染色 (跟随动态取色)
  const micaA = alphaComposite(primaryHex, cLow, isDark ? 0.12 : 0.08);
  const micaB = alphaComposite(primaryHex, cMid, isDark ? 0.18 : 0.12);
  const pal = {
    brand: hexFromArgb(s.primary),
    onBrand: hexFromArgb(s.onPrimary),
    surface: hexFromArgb(s.primaryContainer),
    onSurface: hexFromArgb(s.onPrimaryContainer),
    hover: hexFromArgb(tp.tone(isDark ? 76 : 44)),
    pressed: hexFromArgb(tp.tone(isDark ? 84 : 36)),
    tint: hexFromArgb(tp.tone(isDark ? 24 : 90)),
    weak: hexFromArgb(tp.tone(isDark ? 32 : 88)),
    line: hexFromArgb(tp.tone(isDark ? 48 : 60)),
    secondary: hexFromArgb(s.secondary),
    onSecondary: hexFromArgb(s.onSecondary),
    secondaryContainer: hexFromArgb(s.secondaryContainer),
    onSecondaryContainer: hexFromArgb(s.onSecondaryContainer),
    tertiary: hexFromArgb(s.tertiary),
    onTertiary: hexFromArgb(s.onTertiary),
    tertiaryContainer: hexFromArgb(s.tertiaryContainer),
    onTertiaryContainer: hexFromArgb(s.onTertiaryContainer),
    fg1: hexFromArgb(s.onSurface),
    fg2: hexFromArgb(s.onSurfaceVariant),
    fg3: hexFromArgb(nv.tone(isDark ? 66 : 40)),
    fg4: hexFromArgb(s.outlineVariant),
    fgInverted: hexFromArgb(s.inverseOnSurface),
    appBg, bg1, bg2, bg3, bg4,
    bgInv: hexFromArgb(s.inverseSurface),
    stroke1: hexFromArgb(s.outline),
    stroke2: hexFromArgb(s.outlineVariant),
    stroke3: isDark ? hexFromArgb(nv.tone(40)) : hexFromArgb(nv.tone(90)),
    fgTinted: hexFromArgb(tp.tone(isDark ? 80 : 36)),
    fgTinted2: hexFromArgb(tp.tone(isDark ? 70 : 44)),
    popupBg: isDark ? sc(st.high) : sc(st.highest),
    popupFg: hexFromArgb(s.onSurface),
    mica1: micaA,
    mica2: micaB,
    errorFg: hexFromArgb(s.error),
    errorBg: hexFromArgb(s.errorContainer),
  };
  paletteCache[key] = pal;
  return pal;
}

let _paletteCache = "";
function applyPalette(sourceHex, isDark) {
  const key = `${sourceHex}|${isDark}`;
  if (key === _paletteCache) return;
  _paletteCache = key;
  const p = derivePalette(sourceHex, isDark);
  const st = statusColors(isDark);
  const root = document.documentElement;
  const set = (k, v) => root.style.setProperty(k, v);
  set("--color-brand", p.brand);
  set("--color-brand-on", p.onBrand);
  set("--color-brand-surface", p.surface);
  set("--color-on-brand-surface", p.onSurface);
  set("--color-brand-hover", p.hover);
  set("--color-brand-pressed", p.pressed);
  set("--color-brand-tint", p.tint);
  set("--color-brand-weak", p.weak);
  set("--color-brand-line", p.line);
  set("--color-secondary", p.secondary);
  set("--color-on-secondary", p.onSecondary);
  set("--color-secondary-container", p.secondaryContainer);
  set("--color-on-secondary-container", p.onSecondaryContainer);
  set("--color-tertiary", p.tertiary);
  set("--color-on-tertiary", p.onTertiary);
  set("--color-tertiary-container", p.tertiaryContainer);
  set("--color-on-tertiary-container", p.onTertiaryContainer);
  set("--color-fg-1", p.fg1);
  set("--color-fg-2", p.fg2);
  set("--color-fg-3", p.fg3);
  set("--color-fg-4", p.fg4);
  set("--color-fg-inverted", p.fgInverted);
  set("--color-app-bg", p.appBg);
  set("--color-bg-1", p.bg1);
  set("--color-bg-2", p.bg2);
  set("--color-bg-3", p.bg3);
  set("--color-bg-4", p.bg4);
  set("--color-bg-inverted", p.bgInv);
  set("--color-stroke-1", p.stroke1);
  set("--color-stroke-2", p.stroke2);
  set("--color-stroke-3", p.stroke3);
  set("--color-fg-tinted", p.fgTinted);
  set("--color-fg-tinted-2", p.fgTinted2);
  set("--popup-bg", p.popupBg);
  set("--popup-fg", p.popupFg);
  set("--mica-tint-1", p.mica1);
  set("--mica-tint-2", p.mica2);
  set("--mica-rgb-1", rgbStr(p.mica1));
  set("--mica-rgb-2", rgbStr(p.mica2));
  set("--acrylic-rgb", rgbStr(p.bg2));
  set("--acrylic-rgb-low", rgbStr(p.bg1));
  set("--acrylic-rgb-high", rgbStr(p.bg4));
  set("--control-rgb", rgbStr(p.bg3));
  set("--color-success-fg", st.success.fg);
  set("--color-success-bg", st.success.bg);
  set("--color-warning-fg", st.warning.fg);
  set("--color-warning-bg", st.warning.bg);
  set("--color-error-fg", p.errorFg);
  set("--color-error-bg", p.errorBg);
  // 通知依赖 --color-brand 的组件(hero canvas 波形等)刷新缓存
  window.dispatchEvent(new CustomEvent("denpa:palette-changed"));
}

// ─── Dynamic Accent from Background Image ───
// 照搬 denpa_echo: MCU sourceColorFromImage 需要 Image 元素，不能传 canvas
const dynamicSourceCache = {};
function applyDynamicAccent(imageSrc) {
  const isDark = currentIsDark();
  const cacheKey = imageSrc.substring(0, 64);
  if (dynamicSourceCache[cacheKey]) {
    applyPalette(dynamicSourceCache[cacheKey], isDark);
    return;
  }
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = async () => {
    try {
      // 缩小到 64x64 再取色，避免处理全分辨率大图卡顿
      const size = 64;
      const cvs = document.createElement("canvas");
      cvs.width = size; cvs.height = size;
      const c = cvs.getContext("2d");
      c.drawImage(img, 0, 0, size, size);
      const small = new Image();
      small.src = cvs.toDataURL("image/png");
      await new Promise((res) => { small.onload = res; });
      const srcArgb = await sourceColorFromImage(small);
      const hex = hexFromArgb(srcArgb);
      dynamicSourceCache[cacheKey] = hex;
      const ui = state.uiConfig;
      if (ui.color_mode === "dynamic" && ui.background_mode === "image") {
        applyPalette(hex, currentIsDark());
        if (ui.background_accent !== hex) {
          ui.background_accent = hex;
          bridge.apiPost("dashboard/ui_config", state.uiConfig).catch(() => {});
        }
      }
    } catch (e) {
      console.warn("[DenpaPush] dynamic accent extraction failed:", e);
    }
  };
  img.src = imageSrc;
}

// ─── UI Config ───
async function loadUiConfig() {
  try {
    const cfg = await bridge.apiGet("dashboard/ui_config");
    if (cfg && typeof cfg === "object") {
      state.uiConfig = { ...state.uiConfig, ...cfg };
    }
  } catch (_) {}
}

function applyUiConfig() {
  const root = document.documentElement;
  const ui = state.uiConfig;
  const isDark = currentIsDark();

  // Brand color
  if (ui.color_mode === "static" && ui.brand_color) {
    applyPalette(ui.brand_color, isDark);
  } else if (ui.color_mode === "dynamic") {
    if (ui.background_mode === "image" && ui.background_image) {
      // 已有提取结果 → 同步套用；否则异步取色
      if (ui.background_accent) {
        applyPalette(ui.background_accent, isDark);
      } else {
        applyDynamicAccent(ui.background_image.startsWith("data:") ? ui.background_image : `./bg?t=${Date.now()}`);
      }
    } else {
      applyPalette(DEFAULT_SOURCE, isDark);
    }
  }

  // Background
  const body = document.body;
  const bgLayer = document.getElementById("bg-layer");
  body.classList.remove("bg-mode-brand-gradient", "bg-mode-custom");
  if (bgLayer) bgLayer.style.backgroundImage = "";
  if (ui.background_mode === "brand_gradient") {
    body.classList.add("bg-mode-brand-gradient");
  } else if (ui.background_mode === "custom") {
    const bg = isDark ? ui.custom_background_dark || "#1a1a1a" : ui.custom_background || "#f5f5f5";
    root.style.setProperty("--color-app-bg", bg);
    body.classList.add("bg-mode-custom");
  } else if (ui.background_mode === "image" && ui.background_image) {
    const bgSrc = ui.background_image.startsWith("data:") ? ui.background_image : `./bg?t=${Date.now()}`;
    if (bgLayer) bgLayer.style.backgroundImage = `url('${bgSrc}')`;
  }

  // Radius
  const r = Math.max(0, Math.min(40, Number(ui.corner_radius ?? 14)));
  root.style.setProperty("--radius-large", `${r}px`);
  root.style.setProperty("--radius-xlarge", `${r}px`);
  root.style.setProperty("--radius-medium", `${Math.min(r, 12)}px`);
  root.style.setProperty("--radius-small", `${Math.min(r, 10)}px`);

  // Material
  root.style.setProperty("--material-opacity", ((ui.material_opacity ?? 45) / 100).toString());
  root.style.setProperty("--material-blur", `${ui.material_blur ?? 5}px`);
  root.style.setProperty("--bg-scrim", (ui.bg_scrim ?? 40) / 100);

  const appEl = document.getElementById("app");
  if (appEl) {
    appEl.classList.toggle("acrylic-off", ui.acrylic_enabled === false);
    appEl.classList.toggle("material-mica", ui.material_type === "mica");
    appEl.classList.toggle("glow-off", ui.glow_enabled === false);
    appEl.classList.toggle("shadow-off", ui.shadow_enabled === false);
    appEl.classList.toggle("font-builtin", ui.font_mode === "builtin");
    appEl.classList.toggle("font-misans", ui.font_mode !== "builtin");
    appEl.classList.toggle("bg-image-active", !!(ui.background_mode === "image" && ui.background_image));
    root.style.setProperty("--glow-strength", ((ui.glow_intensity ?? 15) / 100).toString());
    root.style.setProperty("--shadow-strength", ((ui.shadow_intensity ?? 60) / 100).toString());
  }

  syncSettingsInputs();
  updateBgPreview();

  // ECG 波形模式应用(自动/手动) —— 轻量路径, 不打断波形流
  if (ecg) applyEcgMode(false);
}

function syncSettingsInputs() {
  const ui = state.uiConfig;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };

  set("ui-color-mode", ui.color_mode);
  set("ui-bg-mode", ui.background_mode);
  set("ui-material-type", ui.material_type);
  set("ui-font", ui.font_mode);
  set("ui-radius", ui.corner_radius);
  set("ui-brand-color", ui.brand_color);
  set("ui-brand-color-picker", ui.brand_color);
  set("ui-custom-bg", ui.custom_background);
  set("ui-custom-bg-picker", ui.custom_background);
  set("ui-custom-bg-dark", ui.custom_background_dark);
  set("ui-custom-bg-dark-picker", ui.custom_background_dark);
  set("ui-material", ui.material_opacity);
  set("ui-blur", ui.material_blur);
  set("ui-glow", ui.glow_intensity);
  set("ui-shadow", ui.shadow_intensity);
  set("ui-scrim", ui.bg_scrim);
  set("ui-acrylic-on", ui.acrylic_enabled === false ? "false" : "true");
  set("ui-glow-on", ui.glow_enabled === false ? "false" : "true");
  set("ui-shadow-on", ui.shadow_enabled === false ? "false" : "true");
  set("ui-parallax-hover", ui.parallax_mode === "hover" ? "hover" : "click");
  set("ui-ecg-mode", ui.ecg_mode || "auto");
  set("ui-ecg-speed", ui.ecg_speed ?? 60);
  set("ui-ecg-complexity", ui.ecg_complexity ?? 5);

  // Slider labels
  const label = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
  label("ui-radius-val", `${ui.corner_radius}px`);
  label("ui-material-val", `${ui.material_opacity}%`);
  label("ui-blur-val", `${ui.material_blur}px`);
  label("ui-glow-val", `${ui.glow_intensity}%`);
  label("ui-shadow-val", `${ui.shadow_intensity}%`);
  label("ui-scrim-val", `${ui.bg_scrim}%`);
  label("ui-ecg-speed-val", `${ui.ecg_speed ?? 60}%`);
  label("ui-ecg-complexity-val", `${ui.ecg_complexity ?? 5}`);

  syncConditionalBlocks();

  // 自定义下拉(如有)同步显示当前选中项
  pvSyncAllSelects();
}

// 设置面板: 按模式/开关条件收起对应的参数调节块(带展开收起动画)
function syncConditionalBlocks() {
  const ui = state.uiConfig;
  const toggle = (id, show) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("collapsed", !show);
  };

  // 泛光/阴影强度: 对应开关关闭时收起
  toggle("glow-param-block", ui.glow_enabled !== false);
  toggle("shadow-param-block", ui.shadow_enabled !== false);
  // 背景图暗色遮罩: 仅 image 背景模式
  toggle("scrim-param-block", ui.background_mode === "image");
  // 材质参数(不透明度/模糊): 仅 材质启用 且 材质类型=acrylic
  toggle("mica-hide-block", ui.acrylic_enabled !== false && ui.material_type === "acrylic");
  // ECG 手动参数: 仅手动模式
  toggle("ecg-manual-block", ui.ecg_mode === "manual");
  // 颜色: 主题色仅 static 取色; 自定义背景仅 custom 背景模式
  toggle("color-brand-block", ui.color_mode === "static");
  toggle("color-custom-bg-block", ui.background_mode === "custom");
  // 背景图上传: 仅 image 背景模式
  toggle("bg-image-row", ui.background_mode === "image");
}

function updateBgPreview() {
  const ui = state.uiConfig;
  const wrap = document.getElementById("bg-preview-wrap");
  const img = document.getElementById("bg-preview");
  if (ui.background_image && wrap && img) {
    img.src = ui.background_image.startsWith("data:") ? ui.background_image : `./bg?t=${Date.now()}`;
    wrap.style.display = "";
  } else if (wrap) {
    wrap.style.display = "none";
  }
}

function collectUiConfig() {
  const get = (id) => document.getElementById(id)?.value;
  return {
    color_mode: get("ui-color-mode"),
    background_mode: get("ui-bg-mode"),
    material_type: get("ui-material-type"),
    font_mode: get("ui-font"),
    corner_radius: Number(get("ui-radius")),
    brand_color: get("ui-brand-color"),
    custom_background: get("ui-custom-bg"),
    custom_background_dark: get("ui-custom-bg-dark"),
    material_opacity: Number(get("ui-material")),
    material_blur: Number(get("ui-blur")),
    glow_intensity: Number(get("ui-glow")),
    shadow_intensity: Number(get("ui-shadow")),
    bg_scrim: Number(get("ui-scrim")),
    acrylic_enabled: get("ui-acrylic-on") === "true",
    glow_enabled: get("ui-glow-on") === "true",
    shadow_enabled: get("ui-shadow-on") === "true",
    parallax_mode: get("ui-parallax-hover") === "hover" ? "hover" : "click",
    ecg_mode: get("ui-ecg-mode") === "manual" ? "manual" : "auto",
    ecg_speed: Number(get("ui-ecg-speed")),
    ecg_complexity: Number(get("ui-ecg-complexity")),
    background_image: state.uiConfig.background_image,
    background_accent: state.uiConfig.background_accent,
  };
}

// ─── Theme Toggle ───
const ICON_SUN = "M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58a.996.996 0 0 0-1.41 0 .996.996 0 0 0 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37a.996.996 0 0 0-1.41 0 .996.996 0 0 0 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0a.996.996 0 0 0 0-1.41l-1.06-1.06zm1.06-10.96a.996.996 0 0 0 0-1.41.996.996 0 0 0-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.36c.39-.39.39-1.03 0-1.41s-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06z";
const ICON_MOON = "M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36a5.389 5.389 0 0 1-4.4 2.26 5.403 5.403 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z";

function syncThemeIcon() {
  const pathEl = document.getElementById("icon-theme-path");
  const labelEl = document.getElementById("btn-theme-label");
  if (!pathEl) return;
  const dark = currentIsDark();
  pathEl.setAttribute("d", dark ? ICON_SUN : ICON_MOON);
  if (labelEl) labelEl.textContent = dark ? "亮色主题" : "暗色主题";
}

// ─── ECG Waveform Engine (v3: multi-archetype + rhythm engine) ───
// Shape functions
function _ecgGauss(t,c,w){return Math.exp(-Math.pow((t-c)/w,2));}
function _ecgGaussAsym(t,c,wL,wR){const w=t<c?wL:wR;return Math.exp(-Math.pow((t-c)/w,2));}
function _ecgSech2(t,c,w){const v=(t-c)/w;const ch=Math.cosh(v);return 1/(ch*ch);}
function _ecgTri(t,c,w){const d=Math.abs(t-c)/w;return d<1?1-d:0;}
// Seeded random
function _ecgSR(seed){let s=(seed*9301+49297)%233280;return s/233280;}
function _ecgSRn(seed,n){return _ecgSR(seed*31+n*17+7);}
function _ecgSRr(seed,n,min,max){return min+_ecgSRn(seed,n)*(max-min);}
// Deterministic noise (no frame jitter)
function _ecgNoiseAt(totalX){const i=Math.floor(totalX);const f=totalX-i;const a=_ecgSR(i*7919);const b=_ecgSR((i+1)*7919);return a+(b-a)*f;}
// Component constructors
function _cg(pos,amp,w){return{pos,amp,shape:"g",w};}
function _ca(pos,amp,wL,wR){return{pos,amp,shape:"ga",wL,wR};}
function _cs(pos,amp,w){return{pos,amp,shape:"s",w};}
function _ct(pos,amp,w){return{pos,amp,shape:"t",w};}

// Beat generators
function _genSinus(seed,intensity){
  const s=seed+1;const cl=240*(1+_ecgSRr(s,0,-0.08,0.08)+intensity*0.02*(_ecgSRn(s,50)-0.5));
  const bl=Math.sin(seed*0.7)*0.015+Math.sin(seed*0.3)*0.008;const C=[];
  if(_ecgSRn(s,1)>0.08){const pA=_ecgSRr(s,2,0.06,0.16),pP=_ecgSRr(s,3,0.08,0.18),pW=_ecgSRr(s,4,0.015,0.030);
    if(_ecgSRn(s,5)>0.85){C.push(_cg(pP-0.015,pA*0.6,pW*0.7));C.push(_cg(pP+0.015,pA*0.7,pW*0.7));}else C.push(_cg(pP,pA,pW));}
  C.push(_cs(_ecgSRr(s,7,0.22,0.28),_ecgSRr(s,6,-0.15,-0.02),_ecgSRr(s,8,0.004,0.010)));
  const rA=_ecgSRr(s,9,0.55,1.05),rP=_ecgSRr(s,10,0.27,0.35),rW=_ecgSRr(s,11,0.004,0.009);
  if(_ecgSRn(s,12)>0.88){C.push(_cs(rP-0.008,rA*0.6,rW));C.push(_cs(rP+0.008,rA*0.7,rW));}
  else if(_ecgSRn(s,13)>0.5)C.push(_ca(rP,rA,rW*0.7,rW*1.3));else C.push(_cs(rP,rA,rW));
  C.push(_cg(_ecgSRr(s,15,0.32,0.40),_ecgSRr(s,14,-0.35,-0.05),_ecgSRr(s,16,0.005,0.014)));
  if(_ecgSRn(s,17)>0.88)C.push(_cg(_ecgSRr(s,18,0.38,0.42),_ecgSRr(s,19,0.05,0.12),0.008));
  const st=_ecgSRr(s,20,-0.03,0.02);if(Math.abs(st)>0.005)C.push(_cg(_ecgSRr(s,21,0.40,0.46),st,0.04));
  const tI=_ecgSRn(s,22)<(0.05+intensity*0.03);let tA=_ecgSRr(s,23,0.10,0.30);if(tI)tA=-tA;
  const tP=_ecgSRr(s,24,0.42,0.58),tW=_ecgSRr(s,25,0.022,0.048);
  if(_ecgSRn(s,26)>0.85){C.push(_ca(tP,tA*0.7,tW*0.6,tW*1.2));C.push(_cg(tP+tW*1.5,-tA*0.3,tW));}
  else if(_ecgSRn(s,27)>0.80)C.push(_cs(tP,tA,tW*0.6));else C.push(_ca(tP,tA,tW*0.7,tW*1.3));
  if(_ecgSRn(s,28)>0.80)C.push(_cg(_ecgSRr(s,29,0.60,0.72),_ecgSRr(s,30,0.03,0.08),0.025));
  if(_ecgSRn(s,31)<0.03+intensity*0.02)C.push(_ct(_ecgSRr(s,32,0.0,1.0),_ecgSRr(s,33,-0.3,0.5),0.003));
  return{length:cl,baseline:bl,components:C,type:"sinus"};
}
function _genPVCWide(seed,intensity){
  const s=seed+1;const cl=200*(1+_ecgSRr(s,0,-0.10,0.10));const bl=Math.sin(seed*0.5)*0.02;const C=[];
  const pol=_ecgSRn(s,2)>0.5?1:-1;const rA=pol*_ecgSRr(s,1,0.40,1.20);const rP=_ecgSRr(s,3,0.20,0.40);const rW=_ecgSRr(s,4,0.012,0.028);
  if(_ecgSRn(s,5)>0.5){C.push(_ca(rP,rA*0.7,rW*0.6,rW));C.push(_cg(rP+rW*0.8,rA*0.5,rW*0.8));}else C.push(_ca(rP,rA,rW*0.7,rW*1.4));
  C.push(_cg(rP+rW*1.5,-rA*0.4,rW*0.9));C.push(_ca(_ecgSRr(s,7,0.50,0.65),-rA*_ecgSRr(s,6,0.15,0.45),0.020,0.050));
  if(_ecgSRn(s,8)>0.5)C.push(_cg(0.45,-rA*0.1,0.03));return{length:cl,baseline:bl,components:C,type:"pvc_wide"};
}
function _genPVCNotched(seed,intensity){
  const s=seed+1;const cl=195*(1+_ecgSRr(s,0,-0.10,0.10));const bl=Math.sin(seed*0.6)*0.018;const C=[];
  const pol=_ecgSRn(s,1)>0.5?1:-1;const bP=_ecgSRr(s,2,0.25,0.38);const nN=2+Math.floor(_ecgSRn(s,3)*3);
  for(let i=0;i<nN;i++){C.push(_cs(bP+i*_ecgSRr(s,4+i,0.006,0.018),pol*_ecgSRr(s,10+i,0.20,0.80)*(1-i*0.15),_ecgSRr(s,20+i,0.008,0.016)));}
  C.push(_cg(_ecgSRr(s,30,0.52,0.68),-pol*_ecgSRr(s,31,0.15,0.40),0.030));return{length:cl,baseline:bl,components:C,type:"pvc_notched"};
}
function _genPVCTall(seed,intensity){
  const s=seed+1;const cl=205*(1+_ecgSRr(s,0,-0.10,0.10));const C=[];
  C.push(_cs(_ecgSRr(s,1,0.28,0.34),_ecgSRr(s,2,0.90,1.60),0.006));C.push(_cg(_ecgSRr(s,3,0.34,0.40),-_ecgSRr(s,4,0.30,0.70),0.010));
  C.push(_cg(_ecgSRr(s,5,0.50,0.62),-_ecgSRr(s,6,0.20,0.45),0.035));return{length:cl,baseline:0,components:C,type:"pvc_tall"};
}
function _genPVDwarf(seed,intensity){
  const s=seed+1;const cl=220*(1+_ecgSRr(s,0,-0.10,0.10));const bl=Math.sin(seed*0.4)*0.015;const pol=_ecgSRn(s,1)>0.5?1:-1;const C=[];
  C.push(_ca(_ecgSRr(s,2,0.28,0.38),pol*_ecgSRr(s,3,0.15,0.40),0.015,0.035));C.push(_cg(_ecgSRr(s,4,0.55,0.70),-pol*_ecgSRr(s,5,0.08,0.20),0.040));
  return{length:cl,baseline:bl,components:C,type:"pvc_dwarf"};
}
function _genPAC(seed,intensity){
  const s=seed+1;const cl=180*(1+_ecgSRr(s,0,-0.06,0.06));const bl=Math.sin(seed*0.7)*0.012;const C=[];
  const pI=_ecgSRn(s,1)>0.5;C.push(_cg(_ecgSRr(s,3,0.10,0.18),(pI?-1:1)*_ecgSRr(s,2,0.10,0.22),_ecgSRr(s,4,0.012,0.022)));
  C.push(_cs(_ecgSRr(s,5,0.28,0.34),_ecgSRr(s,6,0.60,0.95),0.006));C.push(_cg(_ecgSRr(s,7,0.34,0.40),-_ecgSRr(s,8,0.15,0.30),0.010));
  const tI=_ecgSRn(s,9)>0.6;C.push(_cg(_ecgSRr(s,10,0.45,0.58),(tI?-1:1)*_ecgSRr(s,11,0.12,0.25),0.030));
  return{length:cl,baseline:bl,components:C,type:"pac"};
}
function _genFusion(seed,intensity){
  const s=seed+1;const cl=225*(1+_ecgSRr(s,0,-0.08,0.08));const C=[];
  C.push(_cg(_ecgSRr(s,1,0.10,0.16),_ecgSRr(s,2,0.04,0.10),0.020));
  const rA=_ecgSRr(s,3,0.45,0.85),rW=_ecgSRr(s,4,0.008,0.014);
  if(_ecgSRn(s,5)>0.5)C.push(_ca(_ecgSRr(s,6,0.28,0.34),rA,rW*0.7,rW*1.2));else C.push(_cs(_ecgSRr(s,6,0.28,0.34),rA,rW));
  C.push(_cg(_ecgSRr(s,7,0.36,0.42),-_ecgSRr(s,8,0.10,0.30),0.012));C.push(_cg(_ecgSRr(s,9,0.48,0.60),_ecgSRr(s,10,-0.05,0.20),0.030));
  return{length:cl,baseline:0,components:C,type:"fusion"};
}
function _genEscape(seed,intensity){
  const s=seed+1;const cl=300*(1+_ecgSRr(s,0,-0.05,0.05));const C=[];
  if(_ecgSRn(s,1)>0.5)C.push(_cg(_ecgSRr(s,2,0.15,0.25),-_ecgSRr(s,3,0.05,0.12),0.018));
  C.push(_cs(_ecgSRr(s,4,0.35,0.42),_ecgSRr(s,5,0.50,0.80),0.006));C.push(_cg(_ecgSRr(s,6,0.42,0.48),-_ecgSRr(s,7,0.12,0.25),0.010));
  C.push(_cg(_ecgSRr(s,8,0.55,0.68),_ecgSRr(s,9,0.10,0.22),0.030));return{length:cl,baseline:0,components:C,type:"escape"};
}
function _genPolymorphic(seed,intensity){
  const s=seed+1;const cl=160*(1+_ecgSRr(s,0,-0.20,0.20));const bl=Math.sin(seed*1.3)*0.03+(_ecgSRn(s,1)-0.5)*0.04;const C=[];
  const nC=3+Math.floor(_ecgSRn(s,2)*6);
  for(let i=0;i<nC;i++){const p=_ecgSRr(s,10+i*3,0.02,0.98);const a=_ecgSRr(s,11+i*3,-0.80,0.90)*(0.5+intensity*0.1);const w=_ecgSRr(s,20+i,0.003,0.030);
    const sc=_ecgSRn(s,12+i*3);if(sc<0.25)C.push(_cs(p,a,w));else if(sc<0.50)C.push(_cg(p,a,w));else if(sc<0.75)C.push(_ca(p,a,w*0.6,w*1.4));else C.push(_ct(p,a,w));}
  return{length:cl,baseline:bl,components:C,type:"polymorphic"};
}
function _genFib(seed,intensity){
  const s=seed+1;const ft=_ecgSRn(s,0)>0.5?"fine":"coarse";const amp=ft==="fine"?0.08:0.20;
  return{length:300,baseline:0,type:"fib",fibType:ft,fibAmp:amp,fibSeed:s};
}
function _genFlutter(seed,intensity){
  const s=seed+1;const C=[];const nS=4+Math.floor(_ecgSRn(s,0)*3);
  for(let i=0;i<nS;i++){C.push(_ca(0.05+i*(0.90/nS),-_ecgSRr(s,10+i,0.08,0.15),0.004,0.020));}
  const qP=_ecgSRr(s,20,0.40,0.55);C.push(_cs(qP,_ecgSRr(s,21,0.50,0.80),0.006));C.push(_cg(qP+0.04,-_ecgSRr(s,22,0.15,0.25),0.010));C.push(_cg(qP+0.12,_ecgSRr(s,23,0.10,0.20),0.025));
  return{length:280,baseline:0,components:C,type:"flutter"};
}

// Rhythm engine — v3: 15s 切换 + 顺序遍历(不重复)
class _RhythmEngine{
  constructor(intensity){
    this.intensity=intensity;
    this.pattern=null;
    this.patternLen=0;
    this.patternIdx=0;
    this._pool=[];
    this._poolIdx=0;
    this._poolKey="";
    this._pickPattern();
  }
  _shuffle(arr){
    for(let i=arr.length-1;i>0;i--){
      const j=Math.floor(Math.random()*(i+1));
      const t=arr[i];arr[i]=arr[j];arr[j]=t;
    }
    return arr;
  }
  _pickPattern(){
    const i=this.intensity;let p;
    if(i===0)p=["flatline"];
    else if(i<=1)p=["normal","normal","normal","occasional_pac"];
    else if(i<=2)p=["normal","occasional_pac","occasional_pvc"];
    else if(i<=3)p=["normal","occasional_pvc","occasional_pac","bigeminy"];
    else if(i<=4)p=["bigeminy","occasional_pvc","occasional_pac","trigeminy"];
    else if(i<=5)p=["bigeminy","trigeminy","couplets","occasional_pvc","multifocal"];
    else if(i<=6)p=["couplets","trigeminy","bigeminy","multifocal","salvo"];
    else if(i<=7)p=["couplets","salvo","multifocal","polymorphic_run","bigeminy","trigeminy"];
    else if(i<=8)p=["salvo","multifocal","polymorphic_run","bigeminy","couplets","torsades_burst","vfib_segment"];
    else if(i<=9)p=["polymorphic_run","salvo","multifocal","torsades_burst","vfib_segment","flutter_rhythm","couplets","chaotic_mix"];
    else p=["polymorphic_run","salvo","vfib_segment","flutter_rhythm","torsades_burst","multifocal","chaotic_mix","couplets","bigeminy","chaotic_mix"];
    // pattern 长度: 高强度 ~5 拍 ≈ 15s (72px/s × 15s ÷ ~217px/beat)
    const baseLen = i>=8?4:i>=5?8:12;
    const varLen  = i>=8?3:i>=5?6:8;
    this.patternLen=baseLen+Math.floor(Math.random()*varLen);
    this.patternIdx=0;
    // 顺序遍历 pattern 池, 走完再 reshuffle, 避免重复选取
    const key=p.join(",");
    if(this._poolKey!==key){
      this._poolKey=key;
      this._pool=this._shuffle([...p]);
      this._poolIdx=0;
    }
    if(this._poolIdx>=this._pool.length){
      this._pool=this._shuffle([...p]);
      this._poolIdx=0;
    }
    this.pattern=this._pool[this._poolIdx++];
  }
  _rPVC(){const t=["pvc_wide","pvc_notched","pvc_tall","pvc_dwarf"];const w=[0.35,0.30,0.20,0.15];let r=Math.random();
    for(let i=0;i<t.length;i++){r-=w[i];if(r<=0)return t[i];}return t[0];}
  nextBeatType(){
    if(this.patternIdx>=this.patternLen)this._pickPattern();
    this.patternIdx++;
    const p=this.pattern;const r=Math.random();
    switch(p){
      case"flatline":return"flatline";
      case"normal":if(r<0.05+this.intensity*0.01)return"pac";if(r<0.08+this.intensity*0.015)return"pvc_wide";return"sinus";
      case"occasional_pac":if(r<0.15)return"pac";if(r<0.20)return"pvc_wide";return"sinus";
      case"occasional_pvc":if(r<0.15)return"pvc_wide";if(r<0.20)return"pvc_notched";if(r<0.25)return"pac";return"sinus";
      case"bigeminy":return this.patternIdx%2===0?"sinus":this._rPVC();
      case"trigeminy":return this.patternIdx%3===0?this._rPVC():"sinus";
      case"couplets":return(this.patternIdx%4===0||this.patternIdx%4===1)?this._rPVC():"sinus";
      case"salvo":{const c=this.patternIdx%6;return(c>=1&&c<=4)?this._rPVC():"sinus";}
      case"multifocal":if(r<0.35)return this._rPVC();if(r<0.45)return"fusion";if(r<0.52)return"pac";if(r<0.57)return"escape";return"sinus";
      case"polymorphic_run":if(r<0.45)return"polymorphic";if(r<0.58)return"pvc_wide";if(r<0.66)return"pvc_notched";if(r<0.72)return"pvc_tall";return"sinus";
      case"vfib_segment":if(r<0.50)return"fib";if(r<0.68)return"polymorphic";if(r<0.80)return"flutter";if(r<0.88)return"pvc_wide";return"pvc_notched";
      case"flutter_rhythm":if(r<0.50)return"flutter";if(r<0.65)return"sinus";if(r<0.75)return"pac";if(r<0.85)return"fib";return"pvc_dwarf";
      case"torsades_burst":if(r<0.35)return"polymorphic";if(r<0.50)return"pvc_tall";if(r<0.63)return"pvc_wide";if(r<0.74)return"fib";if(r<0.84)return"flutter";return"pvc_notched";
      case"chaotic_mix":if(r<0.18)return"polymorphic";if(r<0.33)return this._rPVC();if(r<0.44)return"fib";if(r<0.54)return"flutter";if(r<0.63)return"fusion";if(r<0.71)return"pac";if(r<0.78)return"escape";if(r<0.85)return"sinus";return this._rPVC();
      default:return"sinus";
    }
  }
}

class EcgWaveform {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx2d = canvas.getContext("2d");
    this.offset = 0;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.intensity = 1;
    this.active = false;
    this.pushCount = 0;
    this.speedOverride = null;  // null = auto from pushCount, number = manual
    this.speed = 0.1;
    this.ampScale = 0.85;
    this.noiseLevel = 0.002;
    this.complexityOverride = null;
    this.beats = [];
    this._beatIdx = 0;
    this._lastBeatEnd = 0;
    this.beatCounter = 0;
    this.rhythm = new _RhythmEngine(this.intensity);
    this._cachedBrand = null;
    this._lastTheme = null;
    // 主题色更新(静态自定义色 / 动态取色)时失效品牌色缓存, 下一帧读取新色
    window.addEventListener("denpa:palette-changed", () => {
      this._cachedBrand = null;
    });
    this._lastTime = 0;
    this._visible = true;       // IntersectionObserver 控制
    this._pageVisible = true;   // visibilitychange 控制 (标签页前台/后台)
    this._rafId = 0;
    this._resize();
    this._bindResize();
    this._applySpeed();
    this._bindVisibility();
    this._loop();
  }

  _shouldRender() { return this._visible && this._pageVisible; }

  _bindVisibility() {
    // canvas 滚出视口时暂停渲染, 回到视口时恢复 (避免滚动卡顿)
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        this._visible = e.isIntersecting;
        this._checkResume();
      }
    }, { threshold: 0.01 });
    io.observe(this.canvas);
    // 页面切到后台也暂停
    document.addEventListener("visibilitychange", () => {
      this._pageVisible = !document.hidden;
      if (!this._pageVisible && this._rafId) {
        cancelAnimationFrame(this._rafId);
        this._rafId = 0;
      } else {
        this._checkResume();
      }
    });
  }

  _checkResume() {
    if (this._shouldRender() && !this._rafId) {
      this._lastTime = 0;  // 重置时间基准, 避免 dt 跳跃
      this._loop();
    }
  }

  _resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.canvas.width = w * this.dpr;
    this.canvas.height = h * this.dpr;
    this.ctx2d.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.w = w; this.h = h;
  }
  _bindResize() { let t; window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(() => this._resize(), 150); }); }

  _applySpeed() {
    if (this.speedOverride !== null) {
      this.speed = this.speedOverride;
    } else {
      // 自动：0推文=0.2，20推文=1.2，线性映射（基于今日推送数）
      this.speed = 0.2 + (Math.min(this.pushCount, 20) / 20) * 1.0;
    }
  }

  setActive(v) { this.active = v; }

  setPushCount(n) {
    this.pushCount = n;
    // 复杂度被手动覆盖时优先使用覆盖值
    if (this.complexityOverride !== null) {
      this.intensity = Math.min(10, Math.max(0, this.complexityOverride));
    } else {
      // 今日推送 20 条时到达 intensity 10（基于日均而非历史累计）
      this.intensity = n === 0 ? 0 : Math.min(10, Math.ceil(n / 2));
    }
    const ampMap = ECG_AMP_MAP;
    const noiseMap = ECG_NOISE_MAP;
    this.ampScale = ampMap[this.intensity];
    this.noiseLevel = noiseMap[this.intensity];
    this.rhythm = new _RhythmEngine(this.intensity);
    this.beats = [];
    this._beatIdx = 0;
    this._lastBeatEnd = 0;
    this.beatCounter = 0;
    this._applySpeed();
  }

  setSpeed(v) {
    this.speedOverride = v;
    this._applySpeed();
  }

  setComplexity(c) {
    this.complexityOverride = c;
    this.intensity = Math.min(10, Math.max(0, c));
    const ampMap = ECG_AMP_MAP;
    const noiseMap = ECG_NOISE_MAP;
    this.ampScale = ampMap[this.intensity];
    this.noiseLevel = noiseMap[this.intensity];
    this._applySpeed();
    this.rhythm = new _RhythmEngine(this.intensity);
    this.beats = [];
    this._beatIdx = 0;
    this._lastBeatEnd = 0;
    this.beatCounter = 0;
  }

  _ensureBeats(upToX) {
    while (this._lastBeatEnd < upToX) {
      const bt = this.rhythm.nextBeatType();
      if (bt === "flatline") { this.beats.push({startX:this._lastBeatEnd,length:800,baseline:0,components:[],type:"flatline"}); this._lastBeatEnd += 800; continue; }
      const beat = this._genBeat(bt, this.beatCounter++);
      beat.startX = this._lastBeatEnd;
      this.beats.push(beat);
      this._lastBeatEnd += beat.length;
      if (this.intensity >= 2 && Math.random() < 0.03 + this.intensity * 0.01) {
        const pl = 100 + Math.random() * 200;
        this.beats.push({startX:this._lastBeatEnd,length:pl,baseline:beat.baseline,components:[],type:"pause"});
        this._lastBeatEnd += pl;
      }
    }
    const minKeep = this.offset - this.w - 100;
    while (this.beats.length > 1 && this.beats[0].startX + this.beats[0].length < minKeep) {
      this.beats.shift();
      this._beatIdx = Math.max(0, this._beatIdx - 1);
    }
  }

  _genBeat(type, idx) {
    const seed = idx * 137 + 42;
    switch (type) {
      case "sinus": return _genSinus(seed, this.intensity);
      case "pac": return _genPAC(seed, this.intensity);
      case "pvc_wide": return _genPVCWide(seed, this.intensity);
      case "pvc_notched": return _genPVCNotched(seed, this.intensity);
      case "pvc_tall": return _genPVCTall(seed, this.intensity);
      case "pvc_dwarf": return _genPVDwarf(seed, this.intensity);
      case "fusion": return _genFusion(seed, this.intensity);
      case "escape": return _genEscape(seed, this.intensity);
      case "polymorphic": return _genPolymorphic(seed, this.intensity);
      case "fib": return _genFib(seed, this.intensity);
      case "flutter": return _genFlutter(seed, this.intensity);
      default: return _genSinus(seed, this.intensity);
    }
  }

  _findBeat(x) {
    this._ensureBeats(x + 50);
    while (this._beatIdx < this.beats.length - 1 && this.beats[this._beatIdx + 1].startX <= x) this._beatIdx++;
    while (this._beatIdx > 0 && this.beats[this._beatIdx].startX > x) this._beatIdx--;
    return this.beats[this._beatIdx] || null;
  }

  _compY(comp, t) {
    switch (comp.shape) {
      case "g": return comp.amp * _ecgGauss(t, comp.pos, comp.w);
      case "ga": return comp.amp * _ecgGaussAsym(t, comp.pos, comp.wL, comp.wR);
      case "s": return comp.amp * _ecgSech2(t, comp.pos, comp.w);
      case "t": return comp.amp * _ecgTri(t, comp.pos, comp.w);
      default: return comp.amp * _ecgGauss(t, comp.pos, comp.w);
    }
  }

  _waveY(x) {
    const totalX = x + this.offset;
    const beat = this._findBeat(totalX);
    if (!beat) return 0;
    if (beat.type === "fib") return this._fibY(totalX, beat);
    if (beat.type === "flatline" || beat.type === "pause") return beat.baseline + (_ecgNoiseAt(totalX) - 0.5) * this.noiseLevel;
    const localT = (totalX - beat.startX) / beat.length;
    if (localT < 0 || localT > 1) return beat.baseline;
    let y = beat.baseline;
    for (let i = 0; i < beat.components.length; i++) y += this._compY(beat.components[i], localT);
    y += (_ecgNoiseAt(totalX) - 0.5) * this.noiseLevel;
    return y;
  }

  _fibY(totalX, beat) {
    const amp = beat.fibAmp * this.ampScale;
    const s = beat.fibSeed;
    return beat.baseline + Math.sin(totalX*0.12+s)*amp*0.4 + Math.sin(totalX*0.25+s*2)*amp*0.3 + Math.sin(totalX*0.41+s*3)*amp*0.2 + (_ecgSR(totalX*7.3+s)-0.5)*amp*0.5 + (_ecgNoiseAt(totalX)-0.5)*this.noiseLevel*4;
  }

  _getBrand() {
    const theme = document.documentElement.dataset.theme || "dark";
    if (this._cachedBrand && this._lastTheme === theme) return this._cachedBrand;
    this._lastTheme = theme;
    this._cachedBrand = getComputedStyle(document.documentElement).getPropertyValue("--color-brand").trim() || "#1d9bf0";
    return this._cachedBrand;
  }

  _loop(ts) {
    if (!this._shouldRender()) { this._rafId = 0; return; }
    this._draw(ts);
    this._rafId = requestAnimationFrame((t) => this._loop(t));
  }

  _draw(ts) {
    const { ctx2d: ctx, w, h } = this;
    if (!w || !h) { this._resize(); return; }
    ctx.clearRect(0, 0, w, h);

    // Time-based delta for consistent speed regardless of frame rate
    if (!this._lastTime) this._lastTime = ts || performance.now();
    const now = ts || performance.now();
    const dt = Math.min(50, now - this._lastTime); // cap at 50ms to avoid jumps after tab switch
    this._lastTime = now;
    this.offset += this.speed * (dt / 16.667); // normalize to 60fps baseline

    const mid = h * 0.55;
    const amp = h * 0.225 * this.ampScale;
    const brand = this._getBrand();

    // ── Wave-space sampling (jitter fix) ──
    // Sample at fixed wave-space (texture) positions, NOT fixed screen positions.
    //
    // Old approach (screen-space): sample at screen x=0,2,4… → wave-space
    //   positions = x+offset drift each frame as offset changes → sharp peaks
    //   are captured some frames, missed others → flicker/shimmer.
    //
    // New approach (wave-space): sample at fixed wave-space integers
    //   (e.g. 100,102,104…) → same wave values every frame → screen positions
    //   shift smoothly by sub-pixel amounts → canvas anti-aliasing produces
    //   stable, smooth scrolling with zero jitter.
    const step = 2;
    const txStart = Math.floor(this.offset / step) * step;
    const txEnd = this.offset + w;
    const sampleTxs = [];
    for (let tx = txStart; tx <= txEnd + step; tx += step) sampleTxs.push(tx);

    // Add peak-center positions (already in wave-space) for narrow QRS spikes
    this._ensureBeats(txEnd + 100);
    for (const beat of this.beats) {
      if (beat.startX + beat.length < txStart) continue;
      if (beat.startX > txEnd) break;
      if (!beat.components || beat.type === "fib" || beat.type === "flatline" || beat.type === "pause") continue;
      for (const comp of beat.components) {
        const peakTx = beat.startX + comp.pos * beat.length;
        if (peakTx >= txStart - step && peakTx <= txEnd + step) {
          sampleTxs.push(peakTx);
          sampleTxs.push(peakTx - 1);
          sampleTxs.push(peakTx + 1);
        }
      }
    }

    // Sort & deduplicate in wave-space, map to screen, evaluate
    sampleTxs.sort((a, b) => a - b);
    const pts = [];
    let lastTx = -Infinity;
    for (const tx of sampleTxs) {
      if (tx - lastTx < 0.3) continue;
      lastTx = tx;
      const sx = tx - this.offset;          // screen position (may be fractional)
      if (sx < -1 || sx > w + 1) continue;
      // _waveY(sx) internally computes totalX = sx + offset = tx
      pts.push({ x: sx, y: mid - this._waveY(sx) * amp });
    }

    // ── 构建路径一次, 复用给 fill + glow + line ──
    const wavePath = new Path2D();
    wavePath.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) wavePath.lineTo(pts[i].x, pts[i].y);

    // Fill under curve
    const fillPath = new Path2D(wavePath);
    fillPath.lineTo(w, h); fillPath.lineTo(0, h); fillPath.closePath();
    const fg = ctx.createLinearGradient(0, mid - amp, 0, h);
    fg.addColorStop(0, _ecgColorMix(brand, 0.14));
    fg.addColorStop(0.5, _ecgColorMix(brand, 0.04));
    fg.addColorStop(1, _ecgColorMix(brand, 0));
    ctx.fillStyle = fg; ctx.fill(fillPath);

    // Glow layers (widest first, 无 shadowBlur, 用多 stroke 宽度模拟)
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.strokeStyle = _ecgColorMix(brand, 0.06); ctx.lineWidth = 8;
    ctx.stroke(wavePath);
    ctx.strokeStyle = _ecgColorMix(brand, 0.12); ctx.lineWidth = 4.5;
    ctx.stroke(wavePath);

    // Main line with gradient (shadowBlur 仅在此层使用一次)
    const lg = ctx.createLinearGradient(0, 0, w, 0);
    lg.addColorStop(0, _ecgColorMix(brand, 0));
    lg.addColorStop(0.12, _ecgColorMix(brand, 0.4));
    lg.addColorStop(0.85, _ecgColorMix(brand, 1));
    lg.addColorStop(1, _ecgColorMix(brand, 0.7));
    ctx.save(); ctx.shadowColor = brand; ctx.shadowBlur = 8;
    ctx.strokeStyle = lg; ctx.lineWidth = 2;
    ctx.stroke(wavePath); ctx.restore();

    // Scan head (单次 shadowBlur, 合并两层为一个 arc)
    const head = pts[pts.length - 1];
    if (head) {
      ctx.save(); ctx.shadowColor = brand; ctx.shadowBlur = 12;
      ctx.fillStyle = _ecgColorMix(brand, 0.35);
      ctx.beginPath(); ctx.arc(head.x, head.y, 7, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(head.x, head.y, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }
}
function _ecgColorMix(color, alpha) {
  if (!color) return `rgba(29, 155, 240, ${alpha})`;
  color = color.trim();
  if (color.startsWith("#")) {
    const hex = color.slice(1);
    const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

// ─── ECG 自动/手动模式应用 ───
const ECG_AMP_MAP = [0.03, 0.45, 0.65, 0.80, 0.90, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5];
const ECG_NOISE_MAP = [0.0008, 0.0015, 0.002, 0.003, 0.005, 0.007, 0.009, 0.012, 0.016, 0.020, 0.025];

/**
 * 应用 ECG 自动/手动模式。
 * @param {boolean} [heavy] 手动模式下是否全量应用(setComplexity 会重建节律并重置波形)。
 *    模式切换时传 true; 滑条实时调节时传 false(仅更新速度/强度/噪声, 不打断波形流)。
 */
function applyEcgMode(heavy) {
  if (!ecg) return;
  const ui = state.uiConfig;
  if (ui.ecg_mode === "manual") {
    // 手动: 速度 = ecg_speed(%) → 0.2~1.2 px/帧(与自动映射区间一致)
    ecg.setSpeed((Number(ui.ecg_speed) || 60) / 100);
    const c = Math.min(10, Math.max(0, Number(ui.ecg_complexity) || 5));
    if (heavy) {
      ecg.setComplexity(c);
    } else {
      // 轻量: 仅调整强度/幅度/噪声, 保持当前波形流连续
      ecg.complexityOverride = c;
      ecg.intensity = c;
      ecg.ampScale = ECG_AMP_MAP[c];
      ecg.noiseLevel = ECG_NOISE_MAP[c];
    }
  } else if (ecg.speedOverride !== null || ecg.complexityOverride !== null) {
    // 自动: 清除手动覆盖, 由今日推送数重新驱动速度与复杂度
    ecg.speedOverride = null;
    ecg.complexityOverride = null;
    if (typeof ecg.pushCount === "number") ecg.setPushCount(ecg.pushCount);
  }
}

// Timeline 侧边竖直时间线状态
let _tlScrollBound = false;
let _tlHoverBound = false;
let _tlCurrentTime = "";
let _tlCurrentDate = "";
let _tlHoveringCard = null;


// 视差效果状态
let _parallaxRaf = 0;
let _parallaxMouseX = 0, _parallaxMouseY = 0;
let _parallaxHolding = false;
let _parallaxHoldTimer = null;
let _parallaxActiveWrap = null;
// click 模式辅助：起点坐标 + 是否已移动（用于区分点击 / 拖选）
let _parallaxStartX = 0, _parallaxStartY = 0;
let _parallaxMoved = false;

function _applyParallax(wrap, clientX, clientY) {
  if (!wrap) return;
  const rect = wrap.getBoundingClientRect();
  const dx = (clientX - (rect.left + rect.width / 2)) / rect.width;
  const dy = (clientY - (rect.top + rect.height / 2)) / rect.height;
  const maxMove = 10, maxTilt = 8;
  const tx = dx * maxMove, ty = dy * maxMove;
  const rx = -dy * maxTilt, ry = dx * maxTilt;
  wrap.style.transform = `perspective(800px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) translateZ(20px) translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px)`;
}

function _resetParallax(wrap, animated) {
  if (!wrap) return;
  clearTimeout(wrap._parallaxTimer);
  if (animated) {
    wrap.style.transition = "transform 0.28s cubic-bezier(0.2, 0, 0, 1)";
    wrap.style.transform = "";
    setTimeout(() => { wrap.style.transition = ""; }, 300);
  } else {
    wrap.style.transform = "";
    wrap.style.transition = "";
  }
}

function _extractTimeDate(item) {
  let timeStr = "00:00", dateStr = "01月01日";
  const dt = item.time ? new Date(item.time) : null;
  if (dt && !isNaN(dt)) {
    const hh = String(dt.getHours()).padStart(2, "0");
    const mm = String(dt.getMinutes()).padStart(2, "0");
    const mo = String(dt.getMonth() + 1).padStart(2, "0");
    const dd = String(dt.getDate()).padStart(2, "0");
    timeStr = `${hh}:${mm}`;
    dateStr = `${mo}月${dd}日`;
  }
  return { timeStr, dateStr };
}

function _initTimelineBadge() {
  const rail = document.getElementById("tl-rail");
  if (!rail) return;
  if (!_tlScrollBound) {
    _tlScrollBound = true;
    window.addEventListener("scroll", _updateTimelineBadge, { passive: true });
  }
  if (!_tlHoverBound) {
    _tlHoverBound = true;
    _bindCardHover();
  }
  _updateTimelineBadge();
}

// 鼠标悬停卡片时，胶囊滑到对应位置并显示该卡片时间
// 视差效果根据设置：hover 常驻 或 click/long-press 触发
function _bindCardHover() {
  const container = document.getElementById("tracking-history");
  if (!container) return;

  const mode = () => state.uiConfig.parallax_mode || "click";

  // ── 鼠标悬停 → 胶囊跟随（始终生效） ──
  container.addEventListener("mouseover", (e) => {
    const card = e.target.closest(".tl-entry");
    if (card && card !== _tlHoveringCard) {
      _tlHoveringCard = card;
      _moveRailPillToCard(card, true);
    }
  });

  container.addEventListener("mouseleave", () => {
    _tlHoveringCard = null;
    _updateTimelineBadge();
    // hover 模式：离开容器时复位所有卡片
    if (mode() === "hover") {
      container.querySelectorAll(".tl-card-wrap").forEach(w => _resetParallax(w, true));
      _parallaxActiveWrap = null;
    }
  });

  // ── mousemove：hover 模式常驻跟随 / click 模式长按跟随 + 位移检测 ──
  container.addEventListener("mousemove", (e) => {
    const m = mode();
    if (m === "hover") {
      const card = e.target.closest(".tl-entry");
      if (!card) return;
      const wrap = card.querySelector(".tl-card-wrap");
      if (!wrap) return;
      // 切换卡片时无动画复位上一张
      if (_parallaxActiveWrap && _parallaxActiveWrap !== wrap) {
        _resetParallax(_parallaxActiveWrap, false);
      }
      _parallaxActiveWrap = wrap;
      _parallaxMouseX = e.clientX;
      _parallaxMouseY = e.clientY;
      if (_parallaxRaf) return;
      _parallaxRaf = requestAnimationFrame(() => {
        _parallaxRaf = 0;
        _applyParallax(_parallaxActiveWrap, _parallaxMouseX, _parallaxMouseY);
      });
    } else if (m === "click") {
      // 仅在 pending 阶段（尚未进入长按）检测拖拽位移
      // 一旦进入长按跟随，鼠标移动就是视差跟随，不再判定为拖选
      if (_parallaxActiveWrap && !_parallaxHolding && !_parallaxMoved) {
        const dx = e.clientX - _parallaxStartX;
        const dy = e.clientY - _parallaxStartY;
        if (Math.abs(dx) + Math.abs(dy) > 5) {
          _parallaxMoved = true;
          // 已移动 → 取消长按定时器，放任浏览器接管选区
          clearTimeout(_parallaxHoldTimer);
        }
      }
      // 长按跟随视差
      if (_parallaxHolding && _parallaxActiveWrap) {
        _parallaxMouseX = e.clientX;
        _parallaxMouseY = e.clientY;
        if (_parallaxRaf) return;
        _parallaxRaf = requestAnimationFrame(() => {
          _parallaxRaf = 0;
          _applyParallax(_parallaxActiveWrap, _parallaxMouseX, _parallaxMouseY);
        });
      }
    }
  });

  // ── click 模式：mousedown 记录起点 + 长按检测（不立即视差，放任前 300ms 选区） ──
  container.addEventListener("mousedown", (e) => {
    if (mode() !== "click" || e.button !== 0) return;
    const card = e.target.closest(".tl-entry");
    if (!card) return;
    const wrap = card.querySelector(".tl-card-wrap");
    if (!wrap) return;

    // 记录起点，不立即应用视差（让浏览器原生选区有机会工作）
    _parallaxStartX = e.clientX;
    _parallaxStartY = e.clientY;
    _parallaxActiveWrap = wrap;
    _parallaxHolding = false;
    _parallaxMoved = false;

    // 300ms 后仍未移动 → 进入长按跟随模式
    clearTimeout(_parallaxHoldTimer);
    _parallaxHoldTimer = setTimeout(() => {
      if (!_parallaxMoved) {
        _parallaxHolding = true;
        wrap.style.transition = ""; // 去掉 transition 以便流畅跟随
        wrap.classList.add("parallax-active"); // 禁用 user-select 防止误选
        _applyParallax(wrap, _parallaxStartX, _parallaxStartY);
      }
    }, 300);
  });

  // ── click：无位移的纯点击 → 一次性视差动画 + 立即回弹（拖选不会触发 click） ──
  container.addEventListener("click", (e) => {
    if (mode() !== "click" || _parallaxMoved) return;
    const card = e.target.closest(".tl-entry");
    if (!card) return;
    const wrap = card.querySelector(".tl-card-wrap");
    if (!wrap) return;
    wrap.style.transition = "transform 0.12s cubic-bezier(0.2, 0, 0, 1)";
    _applyParallax(wrap, e.clientX, e.clientY);
    // 下一帧立即回弹，浏览器先渲染倾斜态再启动复位动画
    clearTimeout(wrap._parallaxTimer);
    wrap._parallaxTimer = setTimeout(() => _resetParallax(wrap, true), 16);
  });

  // ── mouseup：长按平滑复位 / 清理状态 ──
  document.addEventListener("mouseup", () => {
    if (mode() !== "click") return;
    clearTimeout(_parallaxHoldTimer);
    if (_parallaxHolding) {
      _parallaxHolding = false;
      _parallaxActiveWrap?.classList.remove("parallax-active");
      _resetParallax(_parallaxActiveWrap, true);
    }
    _parallaxActiveWrap = null;
  });
}

// 滚动时：如果没有 hover 卡片，胶囊跟随视口中心
function _updateTimelineBadge() {
  if (_tlHoveringCard) return; // 正在 hover，不覆盖

  const rail = document.getElementById("tl-rail");
  if (!rail) return;
  const timelineTab = document.getElementById("tab-timeline");
  if (!timelineTab || !timelineTab.classList.contains("active")) {
    rail.classList.remove("visible");
    return;
  }
  const cards = document.querySelectorAll("#tracking-history .tl-entry");
  if (cards.length === 0) {
    rail.classList.remove("visible");
    return;
  }
  rail.classList.add("visible");

  // 找到视口中心最近的卡片
  const refY = window.innerHeight * 0.5;
  let closest = cards[0];
  let minDist = Infinity;
  cards.forEach(e => {
    const rect = e.getBoundingClientRect();
    const center = rect.top + rect.height / 2;
    const dist = Math.abs(center - refY);
    if (dist < minDist) { minDist = dist; closest = e; }
  });

  _moveRailPillToCard(closest, false);
}

// 将胶囊移动到卡片对应的竖线位置
function _moveRailPillToCard(card, isHover) {
  const rail = document.getElementById("tl-rail");
  const pill = document.getElementById("tl-rail-pill");
  if (!rail || !pill) return;

  const railRect = rail.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();

  // 卡片中心 Y 坐标（视口坐标）
  const cardCenterY = cardRect.top + cardRect.height / 2;

  // 转换为 rail 内的像素偏移
  let yInRail = cardCenterY - railRect.top;

  // 限位：确保胶囊始终在视口可见的竖线部分内
  const railH = railRect.height;
  // 可见区域在 rail 内的像素范围
  const visTop = Math.max(0, -railRect.top);
  const visBottom = Math.min(railH, window.innerHeight - railRect.top);
  // 胶囊边缘留白
  const pillH = pill.offsetHeight || 30;
  const margin = pillH / 2 + 4;

  yInRail = Math.max(visTop + margin, Math.min(visBottom - margin, yInRail));

  // 设置胶囊位置（像素）
  pill.style.top = yInRail + "px";

  // 更新时间文字
  const time = card.dataset.time || "--:--";
  const date = card.dataset.date || "--月--日";
  _updateRailText("tl-rail-time", time, _tlCurrentTime);
  _updateRailText("tl-rail-date", date, _tlCurrentDate);
  _tlCurrentTime = time;
  _tlCurrentDate = date;

  // hover 状态高亮
  pill.classList.toggle("hovering", isHover);
}

function _updateRailText(id, newText, oldText) {
  if (newText === oldText) return;
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add("changing");
  setTimeout(() => {
    el.textContent = newText;
    el.classList.remove("changing");
  }, 140);
}

// ─── Masonry: waterfall layout for timeline cards ───
let _masonryResizeTimer = null;
function _applyMasonry() {
  const container = document.getElementById("tracking-history");
  if (!container) return;
  const items = Array.from(container.children);
  if (items.length === 0) { container.classList.remove("masonry-ready"); container.style.height=""; return; }

  const minCol = 340;
  const gap = 16;
  const cw = container.clientWidth;

  // If container is hidden (tab not active), clientWidth is 0 — skip layout
  // entirely. It will be re-applied when the tab becomes visible via switchTab.
  if (cw === 0) return;

  const numCols = Math.max(1, Math.floor((cw + gap) / (minCol + gap)));

  if (numCols <= 1) {
    container.classList.remove("masonry-ready");
    container.classList.remove("tl-reflow");
    items.forEach(it => { it.style.position=""; it.style.left=""; it.style.top=""; it.style.width=""; });
    container.style.height = "";
    return;
  }

  const colW = (cw - gap * (numCols - 1)) / numCols;
  const colH = new Array(numCols).fill(0);

  container.classList.add("masonry-ready");
  // Enable smooth reflow: existing cards glide to their new position.
  // Newly inserted cards (.tl-entry-new) are excluded — they animate in
  // with their own entrance animation instead (see CSS .tl-reflow rule).
  // Freshly built DOM is suppressed via .tl-no-transition (set by
  // _buildAndLayoutHistory) so first layout doesn't slide cards from (0,0).
  if (container.classList.contains("tl-no-transition")) {
    container.classList.remove("tl-reflow");
  } else {
    container.classList.add("tl-reflow");
  }

  // Pause entrance animations while measuring so offsetHeight is stable.
  // Unlike `animation: none`, pausing then resuming does NOT restart the
  // animation — the old approach replayed every card's entrance animation
  // on each refresh, making the whole list flash.
  items.forEach(it => it.style.animationPlayState = "paused");

  items.forEach(item => {
    if (item.classList.contains("tl-date-sep")) {
      const top = Math.max(...colH);
      item.style.left = "0px";
      item.style.top = top + "px";
      item.style.width = "100%";
      const mt = parseFloat(getComputedStyle(item).marginTop) || 0;
      const mb = parseFloat(getComputedStyle(item).marginBottom) || 0;
      colH.fill(top + item.offsetHeight + mt + mb + gap);
    } else {
      const col = colH.indexOf(Math.min(...colH));
      item.style.left = (col * (colW + gap)) + "px";
      item.style.top = colH[col] + "px";
      item.style.width = colW + "px";
      colH[col] += item.offsetHeight + gap;
    }
  });

  container.style.height = Math.max(...colH) + "px";

  // Resume entrance animations from where they were paused (no replay)
  items.forEach(it => { it.style.animationPlayState = ""; });
}

function _scheduleMasonry() {
  _applyMasonry();
  // Re-run once after a paint in case fonts/images shift layout
  requestAnimationFrame(_applyMasonry);
}

function _bindMasonryResize() {
  if (_masonryResizeTimer !== null) return;
  let t;
  window.addEventListener("resize", () => {
    clearTimeout(t);
    t = setTimeout(() => {
      _applyMasonry();
      _updateTimelineBadge();
    }, 150);
  });
  _masonryResizeTimer = 1;
}

function _watchMasonryImages(container) {
  const imgs = container.querySelectorAll("img");
  imgs.forEach(img => {
    if (!img.complete) {
      img.addEventListener("load", () => {
        _scheduleMasonry();
        requestAnimationFrame(() => _updateTimelineBadge());
      }, { once: true });
      img.addEventListener("error", () => {
        _scheduleMasonry();
        requestAnimationFrame(() => _updateTimelineBadge());
      }, { once: true });
    }
  });
}

// ─── Render: Status ───
function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return `${i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function renderStatus(data) {
  if (!data) return;
  const badge = document.getElementById("monitor-badge");
  const running = data.monitor_running;
  badge.className = `badge ${running ? "badge-brand" : "badge-neutral"}`;
  badge.textContent = running ? "API 正常" : "○ 离线";

  document.getElementById("stat-loop").textContent = running ? "运行中" : "已停止";
  document.getElementById("stat-pushes").textContent = data.today_pushes ?? data.total_pushes ?? 0;
  document.getElementById("stat-subs").textContent = data.total_tracked || 0;
  document.getElementById("stat-interval").textContent = `${data.poll_interval || 5} min`;

  // Additional status cards
  const setIf = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setIf("stat-auth", data.auth_configured ? "已配置" : "未配置");
  setIf("stat-pw", data.playwright_ready ? "就绪" : "未启动");
  setIf("stat-lang", data.translation_language || "中文");
  setIf("stat-sessions", data.session_count || 0);

  // Token stats
  const ts = data.token_stats || {};
  setIf("stat-token-prompt", (ts.prompt || 0).toLocaleString());
  setIf("stat-token-completion", (ts.completion || 0).toLocaleString());
  setIf("stat-token-total", (ts.total || 0).toLocaleString());
  setIf("stat-token-calls", ts.calls || 0);

  // 缓存数据（插件本地持久化文件总大小）
  setIf("stat-cache", fmtBytes(data.cache_size_bytes || 0));


  if (ecg) {
    ecg.setActive(running);
    // 波形强度/速度由「今日推送数」驱动（日均），而非历史累计总数
    const pushCount = data.today_pushes || 0;
    // 仅在推送数变化时重置波形，避免每次刷新都跳变
    if (ecg.pushCount !== pushCount) {
      ecg.setPushCount(pushCount);
    }
    // 侧边栏 ECG Logo 速度档位: 0→慢速 2.4s / 10→标准 1.6s / 20→快速 0.8s
    const logo = document.querySelector(".sidebar-logo");
    if (logo) {
      logo.classList.remove("slow", "normal", "fast");
      logo.classList.add(pushCount <= 0 ? "slow" : pushCount < 15 ? "normal" : "fast");
    }
  }

  // Dynamic theme: use brand_color from status if dynamic mode
  if (state.uiConfig.color_mode === "dynamic" && data.brand_color) {
    state.uiConfig.background_accent = data.brand_color;
    applyPalette(data.brand_color, currentIsDark());
  }
}

// ─── Render: Subscriptions (管理订阅 tab) ───
function renderSubs(data) {
  if (!data) return;
  const container = document.getElementById("subs-session-list");
  const sessionSelect = document.getElementById("session-select");
  if (!container) return;
  container.innerHTML = "";

  const sessions = Object.keys(data);

  // Update session selector dropdown
  if (sessionSelect) {
    const curVal = sessionSelect.value;
    sessionSelect.innerHTML = '<option value="__all__">全部会话</option>';
    sessions.forEach(s => {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s.length > 28 ? s.slice(0, 28) + "…" : s;
      sessionSelect.appendChild(opt);
    });
    if (sessions.includes(curVal) || curVal === "__all__") sessionSelect.value = curVal;
  }

  // Update add-subscription session selector
  const addSessionSelect = document.getElementById("add-session-select");
  if (addSessionSelect) {
    const curVal = addSessionSelect.value;
    addSessionSelect.innerHTML = '<option value="">选择会话…</option>';
    sessions.forEach(s => {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s.length > 28 ? s.slice(0, 28) + "…" : s;
      addSessionSelect.appendChild(opt);
    });
    if (sessions.includes(curVal)) addSessionSelect.value = curVal;
  }

  // 自定义下拉(如有)同步选项/选中显示
  pvSyncAllSelects();

  if (sessions.length === 0) {
    container.innerHTML = '<p style="color:var(--color-fg-3);font-size:13px;padding:12px 0">暂无订阅，使用下方输入框添加</p>';
    return;
  }

  const filterSession = sessionSelect ? sessionSelect.value : "__all__";

  for (const [session, users] of Object.entries(data)) {
    if (filterSession !== "__all__" && session !== filterSession) continue;
    const names = Object.keys(users);
    const isMonitored = state.status?.monitored_sessions?.includes(session);

    const group = document.createElement("div");
    group.className = "sub-group";
    group.innerHTML = `
      <div class="sub-group-header">
        <span class="sub-session-name" title="${escapeHtml(session)}">${escapeHtml(session)}</span>
        <label class="sub-monitor-toggle">
          <input type="checkbox" class="monitor-toggle" data-session="${escapeHtml(session)}" ${isMonitored ? "checked" : ""} />
          <span>监控</span>
        </label>
      </div>
    `;

    const grid = document.createElement("div");
    grid.className = "sub-account-grid";

    names.forEach(name => {
      const info = users[name] || {};
      const lastCheck = info.last_checked_at
        ? new Date(info.last_checked_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
        : "—";
      const dispName = info.name || name;
      const avatarUrl = info.avatar_url || "";
      const letter = (name.charAt(0) || "?").toUpperCase();
      const avHtml = avatarUrl
        ? `<span class="sub-av-letter">${escapeHtml(letter)}</span><img class="sub-av-img" src="${escapeHtml(avatarUrl)}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'" onload="this.previousElementSibling.style.display='none'" />`
        : `<span class="sub-av-letter">${escapeHtml(letter)}</span>`;
      const el = document.createElement("div");
      el.className = "sub-account-card";
      el.innerHTML = `
        <div class="sub-av" style="background:var(--color-brand)">${avHtml}</div>
        <div class="sub-meta">
          <div class="sub-name">${escapeHtml(dispName)}</div>
          <div class="sub-handle">@${escapeHtml(name)} · 最后检查 ${lastCheck}</div>
        </div>
        <button class="btn btn-subtle btn-sm btn-remove" data-name="${escapeHtml(name)}" data-session="${escapeHtml(session)}" title="取消追踪">
          <svg viewBox="0 0 24 24" style="width:14px;height:14px"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      `;
      grid.appendChild(el);
    });

    group.appendChild(grid);
    container.appendChild(group);
  }

  // Bind remove buttons
  container.querySelectorAll(".btn-remove").forEach(btn => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.name;
      const session = btn.dataset.session || "";
      try {
        await bridge.apiPost("dashboard/unsubscribe", { username: name, session });
        toast(`已取消追踪 @${name}`, "success");
        refresh();
      } catch (e) {
        toast(e?.message || "操作失败", "error");
      }
    });
  });

  // Bind monitor toggles
  container.querySelectorAll(".monitor-toggle").forEach(chk => {
    chk.addEventListener("change", async () => {
      const session = chk.dataset.session;
      try {
        await bridge.apiPost("dashboard/toggle_monitor", { session, enabled: chk.checked });
        toast(chk.checked ? "已开启监控" : "已关闭监控", "success");
        refresh();
      } catch (e) {
        toast(e?.message || "操作失败", "error");
        chk.checked = !chk.checked;
      }
    });
  });
}

// ─── Render: Push History ───

/** Convert ARGB int or hex string to CSS hex color */
function argbToHex(v) {
  if (typeof v === "string") return v.startsWith("#") ? v : v;
  if (typeof v === "number") return hexFromArgb(v);
  return String(v);
}
/** Convert ARGB int or hex to "r, g, b" string */
function argbToRgbStr(v) {
  return rgbStr(argbToHex(v));
}

function _deriveCardPalette(seed, isDark) {
  // 使用 Material Color Utilities 生成对应主题的 MD3 配色
  try {
    const argb = argbFromHex(seed);
    const theme = themeFromSourceColor(argb);
    const s = isDark ? theme.schemes.dark : theme.schemes.light;
    const tp = theme.palettes.primary;
    const nv = theme.palettes.neutralVariant;
    const neutral = theme.palettes.neutral;
    return {
      // 暗色用 neutralVariant 色调匹配插件蓝灰暗色主题，亮色用 neutral 浅色
      surface_container: isDark ? hexFromArgb(nv.tone(20)) : hexFromArgb(neutral.tone(94)),
      primary: hexFromArgb(s.primary),
      on_primary: hexFromArgb(s.onPrimary),
      surface: isDark ? hexFromArgb(neutral.tone(16)) : hexFromArgb(s.surface),
      surface_variant: isDark ? hexFromArgb(nv.tone(26)) : hexFromArgb(s.surfaceVariant),
      on_surface: hexFromArgb(s.onSurface),
      on_surface_variant: hexFromArgb(s.onSurfaceVariant),
    };
  } catch (e) {
    return null;
  }
}

function buildHistoryCard(item) {
  const rawPal = item.palette || {};
  const seed = item.seed_color || argbToHex(rawPal.primary) || "#1d9bf0";
  const isManual = item.source === "manual";
  const isDark = currentIsDark();

  // 按当前主题重新生成 MD3 配色(暗/亮), 避免后端预计算配色与主题不符
  // (后端预计算的 rawPal 可能是暗色配色, 亮色主题下直接使用会保持暗色)
  let pal = rawPal;
  const themedPal = _deriveCardPalette(seed, isDark);
  if (themedPal) pal = themedPal;

  // Build CSS custom properties from palette
  const cssVars = [
    `--md-surface-container:${argbToHex(pal.surface_container || "#f0eaf8")}`,
    `--md-surface-container-rgb:${argbToRgbStr(pal.surface_container || "#f0eaf8")}`,
    `--md-primary:${argbToHex(pal.primary || seed)}`,
    `--md-primary-rgb:${argbToRgbStr(pal.primary || seed)}`,
    `--md-on-primary:${argbToHex(pal.on_primary || "#fff")}`,
    `--md-on-primary-rgb:${argbToRgbStr(pal.on_primary || "#fff")}`,
    `--md-surface:${argbToHex(pal.surface || "#fdf7ff")}`,
    `--md-surface-rgb:${argbToRgbStr(pal.surface || "#fdf7ff")}`,
    `--md-surface-variant:${argbToHex(pal.surface_variant || "#efe5ff")}`,
    `--md-surface-variant-rgb:${argbToRgbStr(pal.surface_variant || "#efe5ff")}`,
    `--md-on-surface:${argbToHex(pal.on_surface || "#1d1a24")}`,
    `--md-on-surface-rgb:${argbToRgbStr(pal.on_surface || "#1d1a24")}`,
    `--md-on-surface-variant:${argbToHex(pal.on_surface_variant || "#49454f")}`,
    `--md-on-surface-variant-rgb:${argbToRgbStr(pal.on_surface_variant || "#49454f")}`,
  ].join(";");

  const timeRaw = item.created_at_str
    || (item.time ? new Date(item.time).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
  const avUrl = item.avatar_url || "";
  const letter = (item.user_name || item.screen_name || "?").charAt(0).toUpperCase();
  const thumbs = item.thumbnail_urls || [];
  const imgN = item.image_count || 0, gifN = item.gif_count || 0, vidN = item.video_count || 0;
  const hasMedia = imgN > 0 || gifN > 0 || vidN > 0;
  const qSn = item.quoted_screen_name || "";
  const qTxt = item.quoted_text || "";
  const sessionInfo = item.session ? escapeHtml(item.session) : "";
  const sourceLabel = isManual ? "手动推送" : "已推送";
  const tweetUrl = item.tweet_url || "#";

  const el = document.createElement("div");
  el.className = "tl-entry";
  const { timeStr, dateStr } = _extractTimeDate(item);
  el.dataset.time = timeStr;
  el.dataset.date = dateStr;
  el.innerHTML = `
    <div class="tl-card-wrap">
      <div class="tweet-card ${isManual ? "is-manual" : ""}" style="${cssVars}">
        <div class="card-inner">
          <div class="tc-header">
            ${avUrl
              ? `<div class="tc-avatar"><img src="${escapeHtml(avUrl)}" alt="avatar" referrerpolicy="no-referrer" onerror="this.style.display='none';this.parentElement.textContent='${escapeHtml(letter)}'" /><span class="tc-avatar-fallback">${escapeHtml(letter)}</span></div>`
              : `<div class="tc-avatar">${escapeHtml(letter)}</div>`
            }
            <div class="tc-header-text">
              <div class="tc-name">${escapeHtml(item.user_name || item.screen_name)}</div>
              <div class="tc-handle">@${escapeHtml(item.screen_name)} · ${escapeHtml(timeRaw)}</div>
            </div>
            <span class="tc-source ${isManual ? "tc-source-manual" : ""}">${isManual ? "✎" : "✓"} ${escapeHtml(sourceLabel)}</span>
          </div>

          <div class="tc-chip-row">
            <span class="tc-chip tc-chip-original"><svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg> Original</span>
          </div>

          <div class="tc-orig-text">${escapeHtml(item.text || item.original_text || "")}</div>

          ${qSn ? `
          <div class="tc-quote-block">
            <div class="tc-quote-indent"></div>
            <div class="tc-quote-body">
              <div class="tc-quote-header">
                <div class="tc-quote-avatar">${escapeHtml((qSn).charAt(0).toUpperCase())}</div>
                <div class="tc-quote-user">
                  <div class="tc-quote-name">@${escapeHtml(qSn)}</div>
                </div>
              </div>
              <div class="tc-quote-text">${escapeHtml(qTxt)}</div>
            </div>
          </div>` : ""}

          <div class="tc-divider"></div>

          <div class="tc-chip-row">
            <span class="tc-chip tc-chip-translated"><svg viewBox="0 0 24 24" style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> 中文翻译</span>
          </div>

          <div class="tc-trans-text">${escapeHtml(item.translated_text || "")}</div>

          ${hasMedia ? `
          <div class="tc-divider"></div>
          <div class="tc-media-row">
            <svg viewBox="0 0 24 24"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg> ${imgN} images${gifN > 0 ? ` · ${gifN} gifs` : ""}${vidN > 0 ? ` · ${vidN} videos` : ""}
          </div>
          ${thumbs.length ? `
          <div class="tc-media-grid">
            ${thumbs.map(u => `<img src="${escapeHtml(u)}" alt="media" referrerpolicy="no-referrer" onerror="this.style.display='none'" />`).join("")}
          </div>` : ""}
          ` : ""}

          <div class="tc-divider"></div>

          <div class="tc-footer">
            ${sessionInfo ? `<span class="tc-session">会话: ${sessionInfo}</span>` : ""}
            <a class="tc-link" href="${escapeHtml(tweetUrl)}" target="_blank" rel="noopener">查看原推 →</a>
          </div>
        </div>
      </div>
    </div>
  `;
  return el;
}

function _historyItemKey(item) {
  // Build a stable unique key from available fields
  const sn = item.screen_name || "?";
  const t = item.time || item.created_at_str || "";
  const src = item.source || "auto";
  const txt = (item.text || item.original_text || "").slice(0, 32);
  return `${sn}|${t}|${src}|${txt}`;
}

function renderHistory(data) {
  const allItems = data?.history || [];
  const prevMode = state.timeline._lastMode || null;
  const prevKeys = state.timeline._renderedKeys || null;
  state.timeline.history = allItems;
  const currentMode = state.timeline.mode;

  // 在时间线页头提示当前保留策略(天数 / 永久 / 条数)
  const retentionHint = document.getElementById("tl-retention-hint");
  if (retentionHint) {
    const days = Number(data?.retention_days) || 0;
    const autoClean = data?.auto_clean !== false;
    const count = Number(data?.count) ?? allItems.length;
    let policy;
    if (!autoClean) policy = "永久保留";
    else if (days <= 0) policy = "永久保留";
    else policy = `保留最近 ${days} 天`;
    retentionHint.textContent = `已收录 ${count} 条 · ${policy} · 按时间排列`;
  }

  // Rebuild tabs (accounts may have changed)
  renderTimelineTabs();

  const emptyHtml = '<p style="color:var(--color-fg-3);font-size:13px;padding:12px 0">暂无推送记录</p>';

  // Timeline (tracking-history): apply tab filter
  const tlCt = document.getElementById("tracking-history");
  if (!tlCt) return;

  let items = allItems;
  let emptyMsg = emptyHtml;

  if (currentMode === "manual") {
    items = allItems.filter(it => it.source === "manual");
    emptyMsg = '<p style="color:var(--color-fg-3);font-size:13px;padding:12px 0">暂无手动推送记录</p>';
  } else if (currentMode !== "overview") {
    items = allItems.filter(it => (it.screen_name || "") === currentMode);
    emptyMsg = '<p style="color:var(--color-fg-3);font-size:13px;padding:12px 0">该账号暂无推送记录</p>';
  }

  // Determine if we can do an incremental update (same tab, same theme,
  // data just refreshed with potentially new items)
  // Theme switches set _forceRender to bypass incremental update (cards need
  // rebuild to apply new dark/light MD3 palette via currentIsDark())
  const newKeys = new Set(items.map(_historyItemKey));
  const forceRender = state.timeline._forceRender || false;
  state.timeline._forceRender = false;
  const canIncremental = prevMode === currentMode && prevKeys !== null && !forceRender;

  if (canIncremental && items.length > 0) {
    // ── Incremental update: find new items not in prevKeys ──
    const newItems = items.filter(it => !prevKeys.has(_historyItemKey(it)));
    if (newItems.length === 0) {
      // Nothing new — update state, skip DOM entirely (no flicker)
      state.timeline._renderedKeys = newKeys;
      state.timeline._lastMode = currentMode;
      _initTimelineBadge();
      return;
    }
    // Check if some previous items are gone (different dataset)
    const oldOnly = [...prevKeys].filter(k => !newKeys.has(k));
    if (oldOnly.length > 0) {
      // Dataset changed significantly — full re-render needed
      _fullRenderHistory(tlCt, items, emptyMsg);
    } else {
      // ── Insert only new cards at the top, animate them in ──
      _insertNewCards(tlCt, newItems, items);
    }
    state.timeline._renderedKeys = newKeys;
    state.timeline._lastMode = currentMode;
    _initTimelineBadge();
    _bindMasonryResize();
    _scheduleMasonry();
    _watchMasonryImages(tlCt);
    return;
  }

  // ── Full re-render (tab switch, theme change, first load) ──
  _fullRenderHistory(tlCt, items, emptyMsg);
  state.timeline._renderedKeys = items.length > 0 ? newKeys : null;
  state.timeline._lastMode = currentMode;
}

function _fullRenderHistory(tlCt, items, emptyMsg) {
  const hasExistingContent = tlCt.children.length > 0;

  if (hasExistingContent) {
    // Reset hover — cards are about to be destroyed, mouseleave won't fire
    _tlHoveringCard = null;
    // Hide rail immediately during transition
    const rail = document.getElementById("tl-rail");
    if (rail) rail.classList.remove("visible");
    // Tab switch: fade out old → swap → fade in new
    tlCt.classList.add("tl-switching");
    setTimeout(() => {
      _buildAndLayoutHistory(tlCt, items, emptyMsg);
    }, 150);
  } else {
    // First load or empty → no fade, build + layout synchronously
    _buildAndLayoutHistory(tlCt, items, emptyMsg);
  }
}

function _buildAndLayoutHistory(tlCt, items, emptyMsg) {
  tlCt.innerHTML = "";
  if (items.length === 0) {
    tlCt.innerHTML = emptyMsg;
    tlCt.classList.remove("tl-switching");
    tlCt.classList.remove("masonry-ready");
    tlCt.style.height = "";
    return;
  }
  const frag = document.createDocumentFragment();
  const sliced = items.slice(0, MAX_TIMELINE_CARDS);
  // 时间线面板隐藏时(首次加载、在其它页签刷新), 入场动画无法运行会停在 opacity:0,
  // 首次打开时间线时卡片不可见("切走再切回"才被 kickstart)。此时禁用入场动画,
  // 卡片/日期条保持默认可见, 打开即显示(确定性修复)。
  const instant = tlCt.clientWidth === 0;
  let lastDate = "";
  let dateCount = 0;
  let lastCountEl = null;
  sliced.forEach(item => {
    const { dateStr } = _extractTimeDate(item);
    if (dateStr !== lastDate) {
      if (lastCountEl) lastCountEl.textContent = `${dateCount} 条`;
      lastDate = dateStr;
      dateCount = 0;
      const grp = document.createElement("div");
      grp.className = "tl-date-sep";
      if (instant) grp.classList.add("tl-sep-instant");
      grp.innerHTML = `<div class="tl-date-sep-label"><span class="tl-date-sep-dot"></span><span class="tl-date-sep-text">${dateStr}</span></div><span class="tl-date-sep-count">0 条</span><div class="tl-date-sep-line"></div>`;
      frag.appendChild(grp);
      lastCountEl = grp.querySelector(".tl-date-sep-count");
    }
    dateCount++;
    const card = buildHistoryCard(item);
    if (instant) card.classList.add("tl-entry-instant");
    frag.appendChild(card);
  });
  if (lastCountEl) lastCountEl.textContent = `${dateCount} 条`;
  tlCt.appendChild(frag);

  // Keep hidden during layout to prevent grid→masonry flash
  tlCt.classList.add("tl-switching");
  _initTimelineBadge();
  _bindMasonryResize();

  // Apply masonry synchronously, then reveal after a paint frame
  // Suppress reflow transitions on this first pass: freshly built cards have
  // no previous top/left, so transitions would slide them in from (0,0).
  tlCt.classList.add("tl-no-transition");
  _applyMasonry();
  _watchMasonryImages(tlCt);

  // Reveal on next frame — masonry positions are already set
  requestAnimationFrame(() => {
    // Re-measure once more (fonts may have shifted heights)
    tlCt.classList.remove("tl-no-transition");
    _applyMasonry();
    tlCt.classList.remove("tl-switching");
    _updateTimelineBadge();
  });
}

// "08月03日" → 803,增量插入时用于保持日期条的时间降序(跨年场景不精确,可接受)
function _dateStrToNum(s) {
  const m = /^(\d{2})月(\d{2})日$/.exec(s || "");
  return m ? Number(m[1]) * 100 + Number(m[2]) : 0;
}

function _insertNewCards(tlCt, newItems, allFilteredItems) {
  // Group new items by date, keeping their time-descending order.
  // Each group is inserted right after its date separator (creating a new
  // separator when the date doesn't exist yet, placed before the first
  // older separator) — instead of dumping everything at the very top,
  // which scrambled the date-grouping order.
  const groups = [];
  newItems.forEach(item => {
    const { dateStr } = _extractTimeDate(item);
    const last = groups[groups.length - 1];
    if (last && last.dateStr === dateStr) last.items.push(item);
    else groups.push({ dateStr, items: [item] });
  });

  // 时间线面板隐藏时插入(在其它页签时刷新), 入场动画同理会停在 opacity:0;
  // 禁用入场动画, 打开时间线时立即可见
  const instant = tlCt.clientWidth === 0;

  groups.forEach(g => {
    const frag = document.createDocumentFragment();
    const existingSep = Array.from(tlCt.querySelectorAll(".tl-date-sep"))
      .find(sep => sep.querySelector(".tl-date-sep-text")?.textContent === g.dateStr);

    let sepEl = null;
    if (!existingSep) {
      sepEl = document.createElement("div");
      sepEl.className = "tl-date-sep tl-sep-new";
      if (instant) sepEl.classList.add("tl-sep-instant");
      sepEl.innerHTML = `<div class="tl-date-sep-label"><span class="tl-date-sep-dot"></span><span class="tl-date-sep-text">${g.dateStr}</span></div><span class="tl-date-sep-count">0 条</span><div class="tl-date-sep-line"></div>`;
      // Drop the "new" marker once its entrance animation finishes so
      // later reflows animate this separator smoothly too
      sepEl.addEventListener("animationend", () => sepEl.classList.remove("tl-sep-new"), { once: true });
      frag.appendChild(sepEl);
    }

    g.items.forEach(item => {
      const card = buildHistoryCard(item);
      card.classList.add("tl-entry-new");
      if (instant) card.classList.add("tl-entry-instant");
      // Once the slide-in finishes, drop the "new" marker so the card joins
      // the normal reflow transition pool. Also pin `animation: none` —
      // otherwise removing the class changes animation-name back to the
      // default tl-entry-in, which would restart an entrance animation.
      card.addEventListener("animationend", () => {
        card.style.animation = "none";
        card.classList.remove("tl-entry-new");
      }, { once: true });
      frag.appendChild(card);
    });

    if (existingSep) {
      // Date already in the timeline: new (newer) cards go right after it
      existingSep.after(frag);
    } else {
      // New date: insert before the first older separator, else append
      const targetNum = _dateStrToNum(g.dateStr);
      let anchor = null;
      for (const sep of tlCt.querySelectorAll(".tl-date-sep")) {
        if (sep !== sepEl && _dateStrToNum(sep.querySelector(".tl-date-sep-text")?.textContent) < targetNum) {
          anchor = sep;
          break;
        }
      }
      if (anchor) anchor.before(frag);
      else tlCt.appendChild(frag);
    }
  });

  // Update date counts for all separators
  _updateDateCounts(tlCt, allFilteredItems);
}

function _updateDateCounts(tlCt, allItems) {
  const counts = {};
  allItems.forEach(item => {
    const { dateStr } = _extractTimeDate(item);
    counts[dateStr] = (counts[dateStr] || 0) + 1;
  });
  tlCt.querySelectorAll(".tl-date-sep").forEach(sep => {
    const text = sep.querySelector(".tl-date-sep-text")?.textContent;
    if (text && counts[text] != null) {
      sep.querySelector(".tl-date-sep-count").textContent = `${counts[text]} 条`;
    }
  });
}

function renderTimelineTabs() {
  const wrap = document.getElementById("timeline-sub-tabs");
  if (!wrap) return;

  // Only show subscribed accounts in sub-tabs (not unsubscribed manual push accounts)
  const names = new Set();
  for (const users of Object.values(state.subscriptions || {})) {
    for (const n of Object.keys(users)) names.add(n);
  }
  const sortedNames = [...names].sort();

  const mode = state.timeline.mode;
  let html = `<button class="sub-tab ${mode === "overview" ? "active" : ""}" data-tlmode="overview"><span class="dot"></span>总览</button>`;

  for (const n of sortedNames) {
    html += `<button class="sub-tab ${mode === n ? "active" : ""}" data-tlmode="${escapeHtml(n)}"><span class="dot"></span>@${escapeHtml(n)}</button>`;
  }

  html += `<button class="sub-tab ${mode === "manual" ? "active" : ""}" data-tlmode="manual"><span class="dot"></span>手动推送</button>`;
  wrap.innerHTML = html;
}

// ─── Render: Logs ───
function renderLogs(data) {
  if (!data) return;
  const list = document.getElementById("log-list");
  const logs = data.logs || data;
  if (!Array.isArray(logs) || logs.length === 0) {
    list.innerHTML = '<p style="color:var(--color-fg-3);font-size:13px;padding:12px 0">等待信号捕获…</p>';
    return;
  }
  list.innerHTML = "";
  logs.slice(0, 40).forEach(log => {
    const time = new Date(log.time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    const el = document.createElement("div");
    el.className = "log-item";
    el.innerHTML = `
      <span class="log-time">${time}</span>
      <span class="log-badge ${log.type}">${log.type === "push" ? "推送" : log.type === "error" ? "异常" : "信息"}</span>
      <span class="log-text">${escapeHtml(log.message)}</span>
    `;
    list.appendChild(el);
  });
}

// ─── Plugin Config Load ───
async function loadPluginConfig() {
  try {
    const cfg = await bridge.apiGet("dashboard/config");
    if (!cfg) return;
    const set = (id, val) => { const el = document.getElementById(id); if (el && val != null) el.value = val; };
    set("cfg-twitter_auth_token", cfg.twitter_auth_token || "");
    set("cfg-twitter_ct0", cfg.twitter_ct0 || "");
    set("cfg-poll_interval", cfg.poll_interval || 5);
    set("cfg-proxy", cfg.proxy || "");
    set("cfg-text_translate_provider", cfg.text_translate_provider || "");
    set("cfg-image_translate_provider", cfg.image_translate_provider || "");
    set("cfg-image_translate_mode", cfg.image_translate_mode || "multimodal");
    set("cfg-translation_language", cfg.translation_language || "中文");
    set("cfg-color_source", cfg.color_source || "avatar");
    set("cfg-text_translate_prompt", cfg.text_translate_prompt || "");
    set("cfg-image_translate_prompt", cfg.image_translate_prompt || "");
    set("cfg-history_retention_days", cfg.history_retention_days ?? 30);
    set("cfg-history_auto_clean", cfg.history_auto_clean !== false ? "true" : "false");
    // 自定义下拉(如有)同步显示当前选中项
    pvSyncAllSelects();
  } catch (e) {
    console.warn("[DenpaPush] load config error:", e);
  }
}

// ─── Refresh ───
async function refresh() {
  try {
    const [status, subs, logs, history] = await Promise.all([
      bridge.apiGet("dashboard/status"),
      bridge.apiGet("dashboard/subscriptions"),
      bridge.apiGet("dashboard/logs"),
      bridge.apiGet("dashboard/history"),
    ]);
    if (status) { state.status = status; renderStatus(status); }
    if (subs) { state.subscriptions = subs; renderSubs(subs); renderTimelineTabs(); }
    if (logs) { state.logs = logs; renderLogs(logs); }
    if (history) { state.timeline.history = history.history || []; renderHistory(history); }
  } catch (e) {
    console.warn("[DenpaPush] refresh error:", e);
  }
}

// ─── Tab Switching ───
function switchTab(name) {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  const tabBtn = document.querySelector(`.tab[data-tab="${name}"]`);
  if (tabBtn) tabBtn.classList.add("active");
  document.querySelectorAll(".tab-content").forEach(p => p.classList.remove("active"));
  const panel = document.getElementById(`tab-${name}`);
  if (panel) panel.classList.add("active");
  // Toggle sidebar sub-tabs visibility
  const subTabs = document.getElementById("timeline-sub-tabs");
  if (subTabs) subTabs.classList.toggle("show", name === "timeline");
  // Update floating navigator visibility + re-apply masonry when timeline becomes visible
  if (name === "timeline") {
    requestAnimationFrame(() => {
      _updateTimelineBadge();
      // Re-apply masonry: container may have had clientWidth=0 when first rendered
      // (timeline tab was hidden), so masonry was skipped. Now it's visible.
      const tlCt = document.getElementById("tracking-history");
      if (tlCt && tlCt.children.length > 0) {
        _applyMasonry();
        _updateTimelineBadge();
      }
    });
  } else {
    // Hide rail when leaving timeline tab
    const rail = document.getElementById("tl-rail");
    if (rail) rail.classList.remove("visible");
  }
}

// ─── Init ───
let ecg;

async function init() {
  state.ctx = await bridge.ready();
  await loadUiConfig();
  applyUiConfig();
  syncThemeIcon();

  ecg = new EcgWaveform(document.getElementById("ecg-canvas"));
  applyEcgMode(true);  // 应用已保存的自动/手动模式(全量)

  // Tab clicks
  document.querySelectorAll(".tab[data-tab]").forEach(tab => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  // Sidebar toggle（手动收缩 / 展开）
  let _sidebarManualCollapse = false;
  const sidebarEl = document.getElementById("sidebar");
  document.getElementById("sidebar-toggle").addEventListener("click", () => {
    sidebarEl.classList.toggle("collapsed");
    _sidebarManualCollapse = sidebarEl.classList.contains("collapsed");
  });

  // 响应式：窗口缩小时自动收缩侧边栏，放大时自动展开（除非用户手动收起）
  const SIDEBAR_BREAKPOINT = 900;
  let _sidebarRaf = 0;
  function _autoSidebar() {
    if (_sidebarRaf) return;
    _sidebarRaf = requestAnimationFrame(() => {
      _sidebarRaf = 0;
      const narrow = window.innerWidth < SIDEBAR_BREAKPOINT;
      if (narrow && !sidebarEl.classList.contains("collapsed")) {
        sidebarEl.classList.add("collapsed");
      } else if (!narrow && !_sidebarManualCollapse && sidebarEl.classList.contains("collapsed")) {
        sidebarEl.classList.remove("collapsed");
      }
    });
  }
  window.addEventListener("resize", _autoSidebar, { passive: true });
  _autoSidebar(); // 初始检查

  // Theme toggle
  const themeBtn = document.getElementById("btn-theme");
  if (themeBtn) {
    themeBtn.addEventListener("click", (e) => {
      const html = document.documentElement;
      const switchTheme = () => {
        html.dataset.theme = html.dataset.theme === "dark" ? "light" : "dark";
        syncThemeIcon();
        applyUiConfig();
        // 强制重建推文卡片以应用暗/亮色 MD3 配色（绕过增量更新优化）
        state.timeline._forceRender = true;
        renderHistory({ history: state.timeline.history });
      };
      const x = e.clientX || window.innerWidth / 2;
      const y = e.clientY || window.innerHeight / 2;
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (document.startViewTransition && !reduce) {
        const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
        html.style.setProperty("--vt-x", x + "px");
        html.style.setProperty("--vt-y", y + "px");
        html.style.setProperty("--vt-r", r + "px");
        document.startViewTransition(switchTheme);
      } else {
        switchTheme();
      }
    });
  }

  // Refresh button
  document.getElementById("btn-refresh-all").addEventListener("click", refresh);

  // Timeline sub-tab switching (sidebar, event delegation for dynamically generated tabs)
  const subTabsWrap = document.getElementById("timeline-sub-tabs");
  if (subTabsWrap) {
    subTabsWrap.addEventListener("click", (e) => {
      const tab = e.target.closest(".sub-tab");
      if (!tab) return;
      const mode = tab.dataset.tlmode;
      if (state.timeline.mode === mode) return;
      state.timeline.mode = mode;
      // Reset hover state — old cards will be destroyed, so mouseleave won't fire
      _tlHoveringCard = null;
      // Update active states
      subTabsWrap.querySelectorAll(".sub-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      // Re-render filtered timeline with transition
      renderHistory({ history: state.timeline.history });
    });
  }

  // Add subscription
  document.getElementById("btn-add-sub").addEventListener("click", async () => {
    const input = document.getElementById("add-username");
    const name = input.value.trim().replace(/^@/, "");
    if (!name) return;
    const addSessionSelect = document.getElementById("add-session-select");
    const addSessionInput = document.getElementById("add-session-input");
    const addSessionType = document.getElementById("add-session-type");
    // Priority: manual input > dropdown selection
    const session = (addSessionInput && addSessionInput.value.trim()) || (addSessionSelect ? addSessionSelect.value : "");
    if (!session) {
      toast("请选择或输入目标会话", "warning");
      return;
    }
    try {
      await bridge.apiPost("dashboard/subscribe", {
        username: name,
        session,
        session_type: addSessionType ? addSessionType.value : "",
      });
      toast(`已开始追踪 @${name}`, "success");
      input.value = "";
      if (addSessionSelect) addSessionSelect.value = "";
      if (addSessionInput) addSessionInput.value = "";
      if (addSessionType) addSessionType.value = "FriendMessage";
      pvSyncAllSelects();
      refresh();
    } catch (e) {
      toast(e?.message || "添加失败", "error");
    }
  });
  document.getElementById("add-username").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("btn-add-sub").click();
  });
  document.getElementById("add-session-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("btn-add-sub").click();
  });

  // Session filter change → re-render subscription list
  document.getElementById("session-select")?.addEventListener("change", () => {
    renderSubs(state.subscriptions);
  });

  // ─── Plugin config (schema) load/save ───
  loadPluginConfig();
  document.getElementById("btn-save-config").addEventListener("click", async () => {
    const keys = [
      "twitter_auth_token", "twitter_ct0", "poll_interval",
      "text_translate_provider", "image_translate_provider",
      "image_translate_mode", "translation_language",
      "text_translate_prompt", "image_translate_prompt",
      "color_source", "history_retention_days", "proxy",
    ];
    const payload = {};
    keys.forEach(k => {
      const el = document.getElementById(`cfg-${k}`);
      if (el) payload[k] = el.value;
    });
    // poll_interval → int
    payload.poll_interval = Number(payload.poll_interval) || 5;
    // 保留天数 → int；布尔开关 → 真布尔
    payload.history_retention_days = Number(payload.history_retention_days) || 0;
    const autoCleanEl = document.getElementById("cfg-history_auto_clean");
    payload.history_auto_clean = autoCleanEl ? autoCleanEl.value === "true" : true;
    try {
      await bridge.apiPost("dashboard/config", payload);
      toast("配置已保存", "success");
      refresh();
    } catch (e) {
      toast(e?.message || "保存失败", "error");
    }
  });

  // ─── Settings panel bindings ───
  bindSettingsEvents();
  // 自定义主题下拉: 将所有 select.select 替换为 pv-select 组件(原生弹层→主题弹层)
  pvInitSelects();

  // Initial load + polling
  refresh();
  setInterval(refresh, 30000);

  document.getElementById("app").classList.add("ready");
}

function bindSettingsEvents() {
  // Sliders live update
  const sliders = [
    ["ui-material", "ui-material-val", "%"],
    ["ui-blur", "ui-blur-val", "px"],
    ["ui-glow", "ui-glow-val", "%"],
    ["ui-shadow", "ui-shadow-val", "%"],
    ["ui-scrim", "ui-scrim-val", "%"],
    ["ui-ecg-speed", "ui-ecg-speed-val", "%"],
    ["ui-ecg-complexity", "ui-ecg-complexity-val", ""],
  ];
  sliders.forEach(([id, labelId, suffix]) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", () => {
      document.getElementById(labelId).textContent = el.value + suffix;
      liveApplySettings();
    });
  });

  // Radius
  const radiusEl = document.getElementById("ui-radius");
  if (radiusEl) radiusEl.addEventListener("input", () => {
    document.getElementById("ui-radius-val").textContent = radiusEl.value + "px";
    liveApplySettings();
  });

  // Selects / checkboxes → live apply
  ["ui-color-mode", "ui-bg-mode", "ui-material-type", "ui-font", "ui-acrylic-on", "ui-glow-on", "ui-shadow-on", "ui-parallax-hover", "ui-ecg-mode"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", liveApplySettings);
  });

  // Color pickers sync
  const colorPairs = [
    ["ui-brand-color-picker", "ui-brand-color"],
    ["ui-custom-bg-picker", "ui-custom-bg"],
    ["ui-custom-bg-dark-picker", "ui-custom-bg-dark"],
  ];
  colorPairs.forEach(([pickerId, textId]) => {
    const picker = document.getElementById(pickerId);
    const text = document.getElementById(textId);
    if (picker && text) {
      picker.addEventListener("input", () => { text.value = picker.value; liveApplySettings(); });
      text.addEventListener("change", () => { picker.value = text.value; liveApplySettings(); });
    }
  });

  // Save
  document.getElementById("btn-save-ui").addEventListener("click", async () => {
    const cfg = collectUiConfig();
    state.uiConfig = { ...state.uiConfig, ...cfg };
    try {
      await bridge.apiPost("dashboard/ui_config", cfg);
      toast("设置已保存", "success");
    } catch (e) {
      toast("保存失败", "error");
    }
  });

  // Reset
  document.getElementById("btn-reset-ui").addEventListener("click", () => {
    state.uiConfig = {
      color_mode: "dynamic", brand_color: "#1d9bf0", background_mode: "theme",
      custom_background: "#F5F6F8", custom_background_dark: "#0C0E13",
      background_image: "", background_accent: "", corner_radius: 14,
      acrylic_enabled: true, material_opacity: 45, material_blur: 5,
      material_type: "acrylic", font_mode: "misans",
      glow_enabled: true, glow_intensity: 15, shadow_enabled: true,
      shadow_intensity: 60, bg_scrim: 40,
      parallax_mode: "click",
      ecg_mode: "auto", ecg_speed: 60, ecg_complexity: 5,
    };
    applyUiConfig();
    applyEcgMode(true);  // 恢复默认后立即全量应用
    toast("已恢复默认");
  });

  // Background image upload
  const bgFile = document.getElementById("bg-image-file");
  if (bgFile) {
    bgFile.addEventListener("change", () => {
      const file = bgFile.files[0];
      if (file) {
        document.getElementById("bg-file-name").textContent = file.name;
      }
    });
  }
  document.getElementById("btn-bg-upload")?.addEventListener("click", async () => {
    const file = bgFile?.files[0];
    if (!file) { toast("请先选择图片", "error"); return; }
    const btn = document.getElementById("btn-bg-upload");
    btn.disabled = true;
    btn.textContent = "上传中...";
    try {
      const resp = await bridge.upload("bg/upload", file);
      // bridge.upload 返回格式不固定，兼容多种结构
      const dataUri = resp.data || (resp.body && resp.body.data) || (typeof resp === "string" && resp.startsWith("data:") ? resp : "");
      if (!dataUri) throw new Error("上传响应中未找到背景图数据");
      state.uiConfig.background_image = dataUri;
      state.uiConfig.background_accent = "";
      state.uiConfig.background_mode = "image";
      document.getElementById("bg-file-name").textContent = (resp && resp.filename) || file.name;
      document.getElementById("ui-bg-mode").value = "image";
      pvSyncAllSelects();
      updateBgPreview();
      // 直接应用背景
      const body = document.body;
      body.classList.remove("bg-mode-brand-gradient", "bg-mode-custom");
      const bgLayer = document.getElementById("bg-layer");
      if (bgLayer) bgLayer.style.backgroundImage = `url('${dataUri}')`;
      // 立即触发动态取色
      if (state.uiConfig.color_mode === "dynamic") {
        await applyDynamicAccent(dataUri);
      }
      applyUiConfig();
      // 持久化
      bridge.apiPost("dashboard/ui_config", state.uiConfig).catch(() => {});
      toast("背景图上传成功", "success");
    } catch (e) {
      toast(`上传失败: ${e.message}`, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "上传";
    }
  });
  document.getElementById("btn-bg-remove")?.addEventListener("click", async () => {
    try {
      await bridge.apiPost("bg/remove", {});
      state.uiConfig.background_image = "";
      state.uiConfig.background_accent = "";
      applyUiConfig();
      toast("背景图已移除");
    } catch (_) {}
  });
}

function liveApplySettings() {
  const prevMode = state.uiConfig.parallax_mode;
  const prevEcgMode = state.uiConfig.ecg_mode;
  const cfg = collectUiConfig();
  state.uiConfig = { ...state.uiConfig, ...cfg };
  applyUiConfig();
  // ECG 模式切换(自动↔手动)时全量应用, 立即反映新参数
  if (prevEcgMode !== cfg.ecg_mode) applyEcgMode(true);
  // 视差模式切换时清除残留 transform
  if (prevMode !== cfg.parallax_mode) {
    const container = document.getElementById("tracking-history");
    if (container) container.querySelectorAll(".tl-card-wrap").forEach(w => _resetParallax(w, false));
    _parallaxActiveWrap = null;
    _parallaxHolding = false;
    clearTimeout(_parallaxHoldTimer);
  }
}

// ─── 自定义主题下拉 (替代原生 select, 全令牌化, 消除与主题割裂) — 复刻 denpa_echo preview ───
function pvInitSelects() {
  document.querySelectorAll("select.select").forEach((sel) => {
    if (sel.dataset.pvSel) return;
    sel.dataset.pvSel = "1";
    // 保留原 select 的内联尺寸(width/max-width), 避免包裹层布局跳动
    const wrap = document.createElement("div");
    wrap.className = "pv-select";
    if (sel.style.width) wrap.style.width = sel.style.width;
    if (sel.style.maxWidth) wrap.style.maxWidth = sel.style.maxWidth;
    sel.style.display = "none";
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "pv-select-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    const label = document.createElement("span");
    label.className = "pv-select-label";
    const caret = document.createElement("span");
    caret.className = "pv-select-caret";
    caret.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>';
    trigger.appendChild(label);
    trigger.appendChild(caret);
    const menu = document.createElement("div");
    menu.className = "pv-select-menu";
    menu.setAttribute("role", "listbox");
    const sync = () => {
      const cur = sel.value;
      label.textContent = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : "";
      menu.innerHTML = "";
      Array.from(sel.options).forEach((opt) => {
        const li = document.createElement("div");
        li.className = "pv-select-option";
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", opt.value === cur ? "true" : "false");
        const t = document.createElement("span");
        t.textContent = opt.textContent;
        const ck = document.createElement("span");
        ck.className = "pv-check";
        ck.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
        li.appendChild(t);
        li.appendChild(ck);
        li.addEventListener("click", () => {
          sel.value = opt.value;
          wrap.classList.remove("open");
          trigger.setAttribute("aria-expanded", "false");
          sync();
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          sel.dispatchEvent(new Event("input", { bubbles: true }));
        });
        menu.appendChild(li);
      });
    };
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = wrap.classList.toggle("open");
      trigger.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) sync();
    });
    wrap.appendChild(trigger);
    wrap.appendChild(menu);
    sel.parentNode.insertBefore(wrap, sel);
    sync();
  });
}
// 外部改值(加载配置/恢复默认/动态选项/上传背景)后, 同步所有自定义下拉的显示
function pvSyncAllSelects() {
  document.querySelectorAll("select.select").forEach((sel) => {
    const wrap = sel.previousElementSibling;
    if (wrap && wrap.classList.contains("pv-select")) {
      const lbl = wrap.querySelector(".pv-select-label");
      const cur = sel.value;
      if (lbl) lbl.textContent = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : "";
      wrap.querySelectorAll(".pv-select-option").forEach((li, i) => {
        li.setAttribute("aria-selected", sel.options[i] && sel.options[i].value === cur ? "true" : "false");
      });
    }
  });
}
// 点击页面其他区域关闭所有展开的自定义下拉
document.addEventListener("click", () => {
  document.querySelectorAll(".pv-select.open").forEach((w) => {
    w.classList.remove("open");
    w.querySelector(".pv-select-trigger").setAttribute("aria-expanded", "false");
  });
});

// ─── ECG Logo: hover 加速绘制脉冲 ───
(function initEcgLogoHover() {
  const logo = document.querySelector(".sidebar-logo");
  if (!logo) return;
  const animated = logo.querySelectorAll(".ecg-tail, .ecg-head");
  const fastDur = "0.7s";
  logo.addEventListener("mouseenter", () => {
    animated.forEach(el => el.style.animationDuration = fastDur);
  });
  // 离开 hover 时清除内联时长, 恢复 --speed 档位速度 (日均推文驱动)
  logo.addEventListener("mouseleave", () => {
    animated.forEach(el => el.style.animationDuration = "");
  });
})();

init();
