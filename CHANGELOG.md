# Changelog

## Unreleased

### Features
- **静默处理模式** (`silent_mode` 配置项): 收到推文链接后仅回复一次确认请求，直接发送解析结果（卡片/图片/视频），不再让 LLM 输出额外对话文本

### Fixes
- **历史卡片每次重启重复拉取**: 启动重建任务的完整性判断改为按 `avatar_url`/`thumbnail_urls` 键是否存在（而非值真值），纯文字推文的空缩略图列表不再被误判为缺失；启动时仅当存在真正缺键的旧条目才触发重建，已完整的卡片不再每次重启重新请求 Twitter

## v2.0.0 (2026-08-03)

### Features
- **Cumulative token consumption**: Token stats now persist across restarts (`denpa_push_token_stats.json`) instead of resetting each run; overview subtitle updated accordingly
- **Overview cache size**: Status overview now shows the total on-disk size of the plugin's persistent data files (subscriptions, push-history cache, UI config/backgrounds, debug_render)
- **Sidebar ECG Logo — three-line sweep style**: Final redesign with dark base trace + theme-colored comet tail + white leading tip with glow, drawn in native 22×22 viewBox
- **Activity-driven logo speed**: Logo animation switches between three gears by daily push count (0 → 2.4s slow / 10 → 1.6s normal / 20 → 0.8s fast), with hover acceleration
- **Dynamic color integration**: Logo colors now follow the plugin's Material 3 dynamic palette (wallpaper accent extraction / custom brand color), auto-adapting to light & dark themes
- **ECG waveform generator** (`ecg-generator.js`): Gaussian pulse synthesis of physiological PQRST waveforms — PR / QRS / ST / QT intervals verified within normal ranges (75bpm), asymmetric T wave, baseline drift; parameterized SVG path & animated icon output; Node CLI + browser dual mode
- **Hero ECG waveform**: Waveform diversity with 15s rotation, speed/intensity driven by today's push count (capped at 20), rendering performance optimization
- **Hero ECG waveform — auto/manual mode**: Settings panel toggle between auto (waveform speed & complexity driven by today's push count) and manual (custom speed 20–120% + complexity 0–10 sliders); manual controls collapse/hide with animation in auto mode
- **Settings panel — conditional parameter blocks**: Parameter controls now collapse/hide when their governing option is off or switched — glow/shadow intensity (when their toggle is off), material opacity/blur (when material off or Mica), background-image scrim & upload (when bg mode ≠ image), theme color (when color mode ≠ static), custom backgrounds (when bg mode ≠ custom); unified `.collapse-block` animated collapse
- **Parallax wallpaper interactions**: Click / long-press / drag-select three-state interactions, configurable parallax mode, responsive sidebar
- **MD3 card rendering**: Layered card layout with full palette roles, per-avatar accent extraction, light/dark auto switching

### Fixes
- **Hero waveform ignores custom brand color in static color mode**: `applyPalette()` now dispatches a `palette-changed` event to invalidate the waveform's cached brand color, so static custom theme colors apply immediately
- **Tracked tweet cards stuck in dark theme**: Card MD3 palette is now re-derived per current theme (light included) instead of reusing backend-precomputed palettes that may be dark-only
- **Card theme switching & tab double-glass**: Fixed card theme toggle bug and duplicated glass layers inside tab content
- **ECG Logo white tip color**: Leading tip forced to pure white (Material `on-primary` can carry a hue tint); bumped cached resource version to force refresh
- **Resource cache invalidation**: Versioned `?v=` query strings for dashboard CSS/JS so updates always take effect

### Chores
- Dashboard asset cache versioning (`?v=` bump per release)
- Ruff formatting & metadata sync

## v1.1.0 (2026-05-22)

### Features
- **Plugin rename**: Renamed from `astrbot_plugin_twitter_monitor` to `astrbot_plugin_denpa_push`
- **Dynamic MD3 color palette**: Replaced 39 preset matching (CIELAB) with `material_color_utilities.theme_from_color()` — generates proper Material Design 3 light/dark schemes from any seed color using Google's Hct color science
- **Color extraction via QuantizerCelebi+Score**: Replaced 1×1 average pixel with `prominent_colors_from_image()`, matching the same algorithm used by the Material Design reference project
- **Recursive retweet handling**: Pure retweets are now resolved and displayed in the quote tweet card style, with full text, media, and NoteTweet/Article content extracted from `tweet.retweeted_tweet`
- **Layered card template**: New MD3 card layout — `background` full card → `surface_container` text pad → `on_surface`/`on_surface_variant` text hierarchy
- **Full MD3 palette roles**: Added `background`, `surface_container`, `on_surface_variant` to complement the existing 6 core roles
- **Parallel LLM translation**: Long article texts are now split and translated concurrently via `asyncio.gather`
- **Quoted article translation**: Quoted tweet article text (NoteTweet/Note) is now included in the translation prompt

### Fixes
- **NoteTweet truncated text**: Fixed order of text source priority — `note_tweet.text` (full 1599 chars) now checked before `legacy.full_text` (301-char preview), restoring full bio tweets from accounts like @MimikuWo
- **Avatar CDN fallback**: Added `User-Agent`, `Accept`, `Referer` headers to avatar download; fallback through `_400x400` → `_bigger` → `_normal` size; gray seed fallback using `user_id` hash for per-user variation
- **Hex color extraction**: Fixed crash when `prominent_colors_from_image` returns 6-char hex (`#RRGGBB`) instead of 8-char ARGB — code now indexes `h[0:2]`, `h[2:4]`, `h[4:6]` correctly
- **pure retweet text**: Resolved "RT @user: https://t.co/..." placeholder by recursively extracting the retweeted tweet's full content via `tweet.retweeted_tweet`
- **Fallback article fetch**: When twikit's `Article` detection misses, falls back to fetching via the Article/Longform endpoint
- **created_at_datetime strptime**: Wrapped twikit's datetime parsing in try/except — older Python versions without `%z` support in `strptime` now fall back to the raw time string
- **Full text override**: Ensured raw GraphQL `full_text` overrides twikit's truncated `tweet.text` in all code paths

### Chores
- Ruff formatted `main.py` and `twitter_client.py`
- README and metadata synced from master
