import asyncio
import json
import os
import re
from collections import deque
from datetime import datetime, timezone, timedelta

from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import filter, AstrMessageEvent, MessageChain
from astrbot.api.message_components import Image as CompImage, Video as CompVideo, Plain
from astrbot.api.star import Context, Star, register

from .twitter_client import TwitterClient

DATA_DIR = "data/config"
DATA_FILE = "astrbot_plugin_denpa_push_data.json"

# 同一条推文连续多少轮推送失败后强制跳过(防止会话基线永久卡死在某条上)
PUSH_MAX_FAIL_ROUNDS = 5


def _plain(text: str) -> MessageChain:
    """Create a plain text MessageChain."""
    chain = MessageChain()
    chain.chain.append(Plain(text))
    return chain


def _img(url: str) -> MessageChain:
    """Create an image MessageChain from URL or file path."""
    chain = MessageChain()
    if url.startswith("http"):
        chain.chain.append(CompImage.fromURL(url))
    else:
        chain.chain.append(CompImage.fromFileSystem(url))
    return chain


def _chain(components: list) -> MessageChain:
    """Create a MessageChain from a list of components."""
    chain = MessageChain()
    for c in components:
        chain.chain.append(c)
    return chain


def _unwrap_event(event) -> AstrMessageEvent:
    """兼容 AstrBot v4.26.0: event 可能是 ContextWrapper 或 AstrMessageEvent。"""
    if hasattr(event, "context") and hasattr(event.context, "event"):
        return event.context.event
    return event

# Shared persistent Playwright (module-level, survives plugin reload)
_pw_instance = None
_pw_browser = None


async def _get_shared_browser():
    """Lazy-init and return a persistent Chromium browser shared across all instances."""
    global _pw_instance, _pw_browser
    if _pw_browser and _pw_browser.is_connected():
        return _pw_browser
    if not _pw_instance:
        from playwright.async_api import async_playwright

        _pw_instance = await async_playwright().start()
    _pw_browser = await _pw_instance.chromium.launch(headless=True)
    return _pw_browser


async def _close_shared_browser():
    """Close shared Playwright and browser."""
    global _pw_instance, _pw_browser
    if _pw_browser:
        await _pw_browser.close()
        _pw_browser = None
    if _pw_instance:
        await _pw_instance.stop()
        _pw_instance = None


def _twitter_media_url(url: str, size: str = "orig") -> str:
    """Set Twitter media size suffix, handling both :name and ?name= formats."""
    if not url or "pbs.twimg.com" not in url:
        return url
    # strip existing :name suffix
    for s in (":thumb", ":small", ":medium", ":large", ":orig"):
        if url.endswith(s):
            url = url[: -len(s)]
            break
    # strip existing ?name= query param
    url = re.sub(r"\?format=\w+&name=\w+", "", url)
    return f"{url}:{size}"


def _file_to_data_uri(path: str) -> str:
    """Read a local image file and return a base64 data URI."""
    import base64, mimetypes

    mime = mimetypes.guess_type(path)[0] or "image/jpeg"
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    return f"data:{mime};base64,{b64}"


@register(
    "astrbot_plugin_denpa_push",
    "astrbot_user",
    "Twitter/X 推文监控、翻译与推送插件",
    "1.0.0",
)
class DenpaPushPlugin(Star):
    def __init__(self, context: Context, config: AstrBotConfig = None):
        super().__init__(context)
        self.config = config or {}
        self.twitter = TwitterClient()
        self.subscriptions = {}  # {session_umo: {username: {info}}}
        self.monitored_sessions = set()
        self.monitor_task = None
        self._running = False
        self._rebuild_running = False
        self._data_path = self._get_data_path()
        self._seed_cache = {}  # {image_url: rgb_tuple}
        self._push_logs = deque(maxlen=100)  # dashboard 信号日志
        self._push_history = deque()  # dashboard 推送历史(含卡片详情)，按保留天数清理
        self._total_pushes = 0
        self._push_fail_counts = {}  # {(session_umo, username, tweet_id): 连续失败轮数}
        self._token_stats = {"prompt": 0, "completion": 0, "total": 0, "calls": 0}
        self._register_dashboard_apis(context)

    def _get_data_path(self):
        root = getattr(self.context, "astrbot_root", os.getcwd())
        return os.path.join(root, DATA_DIR, DATA_FILE)

    @property
    def _push_history_path(self):
        return os.path.join(os.path.dirname(self._data_path), "denpa_push_history.json")

    @property
    def _token_stats_path(self):
        return os.path.join(os.path.dirname(self._data_path), "denpa_push_token_stats.json")

    def _load_push_history(self):
        try:
            if os.path.exists(self._push_history_path):
                with open(self._push_history_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                # 向后兼容：旧格式是 list，新格式是 {"history": [...], "total_pushes": N}
                if isinstance(data, list):
                    self._push_history = deque(data)
                    self._total_pushes = len(self._push_history)
                elif isinstance(data, dict):
                    hist = data.get("history", [])
                    self._push_history = deque(hist)
                    self._total_pushes = data.get("total_pushes", len(self._push_history))
        except Exception as e:
            logger.warning(f"[DenpaPush] Failed to load push history: {e}")
        # 按保留天数清理过期卡片
        self._prune_push_history(quiet=True)

    def _history_retention_days(self) -> int:
        """追踪卡片保留天数（0 = 永久保留）。"""
        try:
            return int(self.config.get("history_retention_days", 30) or 0)
        except (TypeError, ValueError):
            return 30

    def _prune_push_history(self, quiet: bool = False):
        """按保留天数清理过期追踪卡片。

        自动清除关闭或保留天数为 0 时不做任何事（永久保留）。
        无有效时间戳的条目一律保留，避免误删。
        """
        auto_clean = self.config.get("history_auto_clean", True)
        if isinstance(auto_clean, str):
            auto_clean = auto_clean.strip().lower() not in ("0", "false", "no", "")
        if not auto_clean:
            return
        days = self._history_retention_days()
        if days <= 0:
            return
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        kept = []
        dropped = 0
        for entry in self._push_history:
            raw = entry.get("time", "") if isinstance(entry, dict) else ""
            try:
                t = datetime.fromisoformat(raw.replace("Z", "+00:00"))
                if t.tzinfo is None:
                    t = t.replace(tzinfo=timezone.utc)
            except Exception:
                kept.append(entry)  # 无有效时间戳的条目保留
                continue
            if t >= cutoff:
                kept.append(entry)
            else:
                dropped += 1
        if dropped:
            self._push_history.clear()
            self._push_history.extend(kept)
            self._save_push_history()
            if not quiet:
                self._log_push(
                    f"已自动清理 {dropped} 条超过 {days} 天的追踪卡片", "info"
                )

    def _save_push_history(self):
        try:
            os.makedirs(os.path.dirname(self._push_history_path), exist_ok=True)
            with open(self._push_history_path, "w", encoding="utf-8") as f:
                json.dump({
                    "history": list(self._push_history),
                    "total_pushes": self._total_pushes,
                }, f, ensure_ascii=False)
        except Exception as e:
            logger.warning(f"[DenpaPush] Failed to save push history: {e}")

    def _load_token_stats(self):
        """从磁盘加载累计 token 统计（跨重启累计）。"""
        try:
            if os.path.exists(self._token_stats_path):
                with open(self._token_stats_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                stats = {
                    k: int(data.get(k, 0) or 0)
                    for k in ("prompt", "completion", "total", "calls")
                }
                if not stats.get("total"):
                    stats["total"] = stats["prompt"] + stats["completion"]
                self._token_stats.update(stats)
        except Exception as e:
            logger.warning(f"[DenpaPush] Failed to load token stats: {e}")

    def _save_token_stats(self):
        try:
            os.makedirs(os.path.dirname(self._token_stats_path), exist_ok=True)
            with open(self._token_stats_path, "w", encoding="utf-8") as f:
                json.dump(self._token_stats, f, ensure_ascii=False)
        except Exception as e:
            logger.warning(f"[DenpaPush] Failed to save token stats: {e}")

    async def initialize(self):
        try:
            import twikit

        except ImportError:
            logger.error("twikit 未安装，请确保 requirements.txt 中的依赖已被安装")
        self._apply_twitter_credentials()
        self._load_data()
        self._load_push_history()
        self._load_token_stats()
        auto_monitor = True
        if self.subscriptions and auto_monitor:
            self._start_monitor()
        logger.info("Twitter Monitor plugin initialized")
        # 自动后台重建历史卡片（补齐缺失头像/媒体/配色）
        if self._push_history:
            asyncio.create_task(self._rebuild_history_async())

    def _apply_twitter_credentials(self):
        auth_token = self.config.get("twitter_auth_token", "")
        ct0 = self.config.get("twitter_ct0", "")
        if auth_token:
            self.twitter.set_credentials(auth_token, ct0)

    async def terminate(self):
        self._running = False
        self._save_token_stats()
        if self.monitor_task:
            self.monitor_task.cancel()
            self.monitor_task = None

    # ═══════════════════════════════════════════════════════════
    # Dashboard API (Signal Observatory)
    # ═══════════════════════════════════════════════════════════

    def _register_dashboard_apis(self, context: Context) -> None:
        """注册 Dashboard 后端 API。"""
        apis = [
            ("dashboard/status", self._api_dashboard_status, ["GET"], "面板状态"),
            ("dashboard/subscriptions", self._api_dashboard_subscriptions, ["GET"], "订阅列表"),
            ("dashboard/subscribe", self._api_dashboard_subscribe, ["POST"], "添加订阅"),
            ("dashboard/unsubscribe", self._api_dashboard_unsubscribe, ["POST"], "移除订阅"),
            ("dashboard/logs", self._api_dashboard_logs, ["GET"], "推送日志"),
            ("dashboard/ui_config", self._api_dashboard_ui_config, ["GET", "POST"], "界面设置持久化"),
            ("dashboard/config", self._api_dashboard_config, ["GET", "POST"], "插件配置读写"),
            ("dashboard/toggle_monitor", self._api_dashboard_toggle_monitor, ["POST"], "会话监控开关"),
            ("dashboard/history", self._api_dashboard_history, ["GET"], "推送历史详情"),
            ("bg/upload", self._api_bg_upload, ["POST"], "上传背景图"),
            ("bg/remove", self._api_bg_remove, ["POST"], "移除背景图"),
        ]
        for route, handler, methods, desc in apis:
            context.register_web_api(
                f"/astrbot_plugin_denpa_push/{route}", handler, methods, desc
            )

    def _log_push(self, msg: str, log_type: str = "push"):
        """记录一条 dashboard 信号日志。"""
        self._push_logs.appendleft({
            "time": datetime.now(timezone.utc).isoformat(),
            "type": log_type,
            "message": msg,
        })

    def _record_push_history(self, info: dict, session_umo: str, source: str = "auto"):
        """记录一条推送历史（自动/手动共用），含时间、会话与卡片详情。

        info: _build_card_data 返回的富结构 dict
        session_umo: 推送目标会话标识
        source: "auto" | "manual"
        """
        hist_media = (
            (info.get("images") or [])
            + (info.get("gifs") or [])
            + (info.get("videos") or [])
        )
        hist_thumbs = []
        for m in hist_media[:4]:
            mu = m.get("media_url", "")
            if mu:
                hist_thumbs.append(_twitter_media_url(mu, "medium"))
        self._push_history.appendleft({
            "time": datetime.now(timezone.utc).isoformat(),
            "source": source,
            "session": session_umo,
            "tweet_id": info.get("tweet_id", ""),
            "screen_name": info.get("screen_name", ""),
            "user_name": info.get("user_name", ""),
            "avatar_url": info.get("avatar_url", ""),
            "text": (info.get("original_text") or "")[:300],
            "translated_text": (info.get("translated_text") or "")[:300],
            "tweet_url": info.get("tweet_url", ""),
            "seed_color": info.get("seed_color", ""),
            "palette": info.get("palette", []),
            "thumbnail_urls": hist_thumbs,
            "image_count": info.get("image_count", 0),
            "gif_count": info.get("gif_count", 0),
            "video_count": info.get("video_count", 0),
            "has_media": bool(hist_thumbs),
            "created_at_str": info.get("created_at_str", ""),
            "quoted_screen_name": info.get("quoted_screen_name", ""),
            "quoted_text": (info.get("quoted_text") or "")[:200],
        })
        self._save_push_history()
        self._prune_push_history()

    def _data_cache_size_bytes(self) -> int:
        """统计插件在数据目录下持久化文件的总大小（字节）。

        涵盖: 订阅数据、推送历史缓存、UI 配置（含背景图）、
        token 累计统计、backgrounds 临时目录与 debug_render 调试目录。
        data/config 下其他插件的文件不会被计入。
        """
        data_dir = os.path.dirname(self._data_path)
        total = 0
        try:
            if not os.path.isdir(data_dir):
                return 0
            for name in os.listdir(data_dir):
                if name.startswith(("denpa_", "astrbot_plugin_denpa")) or name in (
                    "backgrounds",
                    "debug_render",
                ):
                    path = os.path.join(data_dir, name)
                    if os.path.isfile(path):
                        total += os.path.getsize(path)
                    elif os.path.isdir(path):
                        for root, _dirs, files in os.walk(path):
                            for f in files:
                                try:
                                    total += os.path.getsize(os.path.join(root, f))
                                except OSError:
                                    pass
        except OSError as e:
            logger.warning(f"[DenpaPush] Failed to measure data cache size: {e}")
        return total

    async def _api_dashboard_status(self):
        """Dashboard 总览状态。"""
        from astrbot.api.web import request, json_response

        total_tracked = sum(len(users) for users in self.subscriptions.values())
        # 计算今日推送数（本地时区 00:00 起）
        today_pushes = 0
        try:
            from datetime import datetime as _dt
            now_local = _dt.now()
            today_start = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
            for item in self._push_history:
                t = item.get("time", "")
                if t:
                    try:
                        dt = _dt.fromisoformat(t.replace("Z", "+00:00"))
                        if dt.astimezone().replace(tzinfo=None) >= today_start:
                            today_pushes += 1
                    except Exception:
                        pass
        except Exception:
            pass
        return json_response({
            "monitor_running": self._running,
            "total_tracked": total_tracked,
            "total_pushes": self._total_pushes,
            "today_pushes": today_pushes,
            "poll_interval": int(self.config.get("poll_interval", 5)),
            "session_count": len(self.monitored_sessions),
            "monitored_sessions": list(self.monitored_sessions),
            "auth_configured": bool(self.config.get("twitter_auth_token", "")),
            "playwright_ready": _pw_browser is not None and _pw_browser.is_connected(),
            "translation_language": self.config.get("translation_language", "中文"),
            "color_source": self.config.get("color_source", "avatar"),
            "gif_encoder": self.config.get("gif_encoder", "auto"),
            "proxy": self.config.get("proxy", ""),
            "token_stats": dict(self._token_stats),
            "cache_size_bytes": self._data_cache_size_bytes(),
        })

    async def _api_dashboard_subscriptions(self):
        """返回全部订阅 {session: {username: info}}。"""
        from astrbot.api.web import json_response

        return json_response(self.subscriptions)

    def _normalize_session(self, session: str, message_type: str = "") -> str:
        """把前端传入的会话统一为 unified_msg_origin 格式。

        支持两种输入:
        - 完整会话 "平台:消息类型:ID"(如 小赤羽:FriendMessage:2728007259)
        - 纯 QQ 号 "2728007259": 若该 QQ 号已存在于现有会话则复用原会话(类型以其为准);
          否则按 message_type(FriendMessage 私聊 / GroupMessage 群聊, 默认私聊)
          用现有会话的平台前缀拼成 "平台:类型:QQ号"。
        无可参照会话时返回空串(由调用方回退到下拉会话或报错)。
        """
        session = (session or "").strip()
        if not session:
            return ""
        if ":" in session:
            return session
        existing = list(self.subscriptions) or list(self.monitored_sessions)
        # 该 QQ 号已是某个会话: 复用(保留其原始类型, 群/私聊都对得上)
        for s in existing:
            if s and ":" in s and s.rsplit(":", 1)[-1] == session:
                return s
        # 新 QQ 号: 用前端指定类型, 未指定或非法则默认私聊
        mtype = (message_type or "").strip()
        if mtype not in ("FriendMessage", "GroupMessage"):
            mtype = "FriendMessage"
        if existing:
            platform_id = existing[0].split(":", 1)[0]
            return f"{platform_id}:{mtype}:{session}"
        return ""

    async def _api_dashboard_subscribe(self):
        """Dashboard 添加订阅（可指定 session，否则自动选择）。"""
        from astrbot.api.web import request, json_response, error_response

        payload = await request.json()
        username = (payload.get("username") or "").strip().lstrip("@")
        if not username:
            return error_response("缺少 username", status_code=400)

        # 选择目标 session: 优先用前端指定的（纯 QQ 号按所选类型补全前缀），否则自动选
        target_session = self._normalize_session(
            payload.get("session", ""), payload.get("session_type", "")
        )
        if not target_session:
            if self.monitored_sessions:
                target_session = next(iter(self.monitored_sessions))
            elif self.subscriptions:
                target_session = next(iter(self.subscriptions))
        if not target_session:
            return error_response("无可用会话，请先在群聊中使用 /twitter add 初始化", status_code=400)

        # 已追踪该账号则直接返回(用 get 避免提前创建会话键)
        if username in self.subscriptions.get(target_session, {}):
            return json_response({"ok": True, "message": f"@{username} 已在追踪中"})

        try:
            await self.twitter.ensure_ready()
            user = await self.twitter.get_user_by_screen_name(username)
            tweets = await self.twitter.get_user_tweets(user.id, count=1)
            last_id = tweets[0].id if tweets else "0"
            avatar_url = getattr(user, "profile_image_url", "") or ""
            if avatar_url:
                avatar_url = avatar_url.replace("_normal.", "_400x400.")
            # 拉取成功后才落会话键，失败时不残留内存幻影会话
            session_users = self.subscriptions.setdefault(target_session, {})
            if username in session_users:
                return json_response({"ok": True, "message": f"@{username} 已在追踪中"})
            session_users[username] = {
                "user_id": user.id,
                "name": getattr(user, "name", "") or username,
                "avatar_url": avatar_url,
                "last_tweet_id": last_id,
                "last_checked_at": datetime.now(timezone.utc).isoformat(),
            }
            self.monitored_sessions.add(target_session)
            self._save_data()
            self._start_monitor()
            self._log_push(f"开始追踪 @{username} ({user.name})", "info")
            return json_response({"ok": True, "message": f"已追踪 @{username}"})
        except Exception as e:
            logger.error(f"[Dashboard] subscribe failed: {e}")
            return error_response(f"添加失败: {str(e)[:120]}", status_code=500)

    async def _api_dashboard_unsubscribe(self):
        """Dashboard 移除订阅（可指定 session，否则从所有 session 移除）。"""
        from astrbot.api.web import request, json_response, error_response

        payload = await request.json()
        username = (payload.get("username") or "").strip().lstrip("@")
        if not username:
            return error_response("缺少 username", status_code=400)

        target_session = payload.get("session", "")
        removed = False

        if target_session:
            # 按会话级别移除
            session_users = self.subscriptions.get(target_session, {})
            if username in session_users:
                del session_users[username]
                removed = True
                if not session_users:
                    del self.subscriptions[target_session]
        else:
            # 从所有 session 移除
            for sess_umo in list(self.subscriptions.keys()):
                session_users = self.subscriptions.get(sess_umo, {})
                if username in session_users:
                    del session_users[username]
                    removed = True
                    if not session_users:
                        del self.subscriptions[sess_umo]

        if not removed:
            return error_response(f"未找到 @{username}", status_code=404)

        self._save_data()
        if not self.subscriptions:
            self._stop_monitor()
        self._log_push(f"取消追踪 @{username}", "info")
        return json_response({"ok": True, "message": f"已取消追踪 @{username}"})

    async def _api_dashboard_logs(self):
        """返回推送日志。"""
        from astrbot.api.web import json_response

        return json_response({"logs": list(self._push_logs)})

    async def _api_dashboard_ui_config(self):
        """界面设置持久化（独立 JSON 文件）。"""
        from astrbot.api.web import request, json_response, error_response

        path = os.path.join(
            os.path.dirname(self._data_path), "denpa_push_ui_config.json"
        )
        if request.method == "GET":
            try:
                with open(path, "r", encoding="utf-8") as f:
                    return json_response(json.load(f))
            except (FileNotFoundError, json.JSONDecodeError):
                return json_response({})
        else:
            payload = await request.json()
            try:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "w", encoding="utf-8") as f:
                    json.dump(payload, f, ensure_ascii=False)
                return json_response({"saved": True})
            except Exception as e:
                return error_response(f"保存失败: {e}", status_code=500)

    async def _api_dashboard_config(self):
        """插件配置读写（对应 _conf_schema.json 声明的 key）。"""
        from astrbot.api.web import request, json_response, error_response

        SCHEMA_KEYS = [
            "twitter_auth_token", "twitter_ct0", "poll_interval",
            "text_translate_provider", "image_translate_provider",
            "image_translate_mode", "translation_language",
            "text_translate_prompt", "image_translate_prompt",
            "color_source", "gif_encoder",
            "history_retention_days", "history_auto_clean", "proxy",
        ]
        if request.method == "GET":
            data = {k: self.config.get(k, "") for k in SCHEMA_KEYS}
            # 未保存过的新选项回退到 schema 默认值，避免界面显示空
            if data.get("history_retention_days") in ("", None):
                data["history_retention_days"] = 30
            if data.get("history_auto_clean") in ("", None):
                data["history_auto_clean"] = True
            # 脱敏: token 只显示前6位
            for key in ("twitter_auth_token", "twitter_ct0"):
                v = data.get(key, "")
                if v and len(v) > 6:
                    data[key + "_masked"] = v[:6] + "…" + v[-4:]
            return json_response(data)
        else:
            payload = await request.json()
            try:
                for k in SCHEMA_KEYS:
                    if k in payload:
                        v = payload[k]
                        # 布尔开关统一归一化为真布尔，避免 "false" 字符串被当 truthy
                        if k == "history_auto_clean":
                            if isinstance(v, str):
                                v = v.strip().lower() not in ("0", "false", "no", "")
                            else:
                                v = bool(v)
                        self.config[k] = v
                self.config.save_config()
                # 热更新凭据
                self._apply_twitter_credentials()
                return json_response({"saved": True})
            except Exception as e:
                return error_response(f"保存失败: {e}", status_code=500)

    async def _api_dashboard_history(self):
        """推送历史详情（含推文内容、翻译、色板）。"""
        from astrbot.api.web import json_response

        auto_clean = self.config.get("history_auto_clean", True)
        if isinstance(auto_clean, str):
            auto_clean = auto_clean.strip().lower() not in ("0", "false", "no", "")
        return json_response({
            "history": list(self._push_history),
            "rebuilding": self._rebuild_running,
            "retention_days": self._history_retention_days(),
            "auto_clean": bool(auto_clean),
            "count": len(self._push_history),
        })

    async def _rebuild_history_async(self):
        """后台重新构建历史 timeline 卡片。

        扫描 _push_history 中缺失 avatar_url/thumbnail_urls 的条目，
        按 tweet_url 解析 tweet_id 并重新拉取推文，补齐头像、媒体缩略图、
        媒体计数、引用推文、发布时间与配色。
        """
        if self._rebuild_running:
            return
        self._rebuild_running = True
        self._log_push("开始后台重建历史卡片", "info")
        try:
            await self.twitter.ensure_ready()
            rebuilt = 0
            skipped = 0
            for entry in list(self._push_history):
                # 已具备头像与媒体缩略图的条目跳过
                if entry.get("avatar_url") and entry.get("thumbnail_urls"):
                    skipped += 1
                    continue
                # 解析 tweet_id：优先字段，其次从 tweet_url 提取
                tweet_id = str(entry.get("tweet_id") or "")
                if not tweet_id and entry.get("tweet_url"):
                    parts = entry["tweet_url"].split("/status/")
                    if len(parts) == 2 and parts[1]:
                        tweet_id = parts[1].split("?")[0].strip()
                if not tweet_id:
                    continue
                try:
                    tweet = await self.twitter.get_tweet_by_id(tweet_id)
                    data = TwitterClient.extract_tweet_data(tweet)
                    raw_av = (data.get("user") or {}).get("avatar_url", "") or ""
                    if raw_av:
                        entry["avatar_url"] = raw_av.replace("_normal.", "_400x400.")
                    images, gifs, videos = TwitterClient.extract_tweet_media(data)
                    thumbs = []
                    for m in (images + gifs + videos)[:4]:
                        mu = m.get("media_url", "")
                        if mu:
                            thumbs.append(_twitter_media_url(mu, "medium"))
                    entry["thumbnail_urls"] = thumbs
                    entry["image_count"] = len(images)
                    entry["gif_count"] = len(gifs)
                    entry["video_count"] = len(videos)
                    entry["has_media"] = bool(thumbs)
                    entry["tweet_id"] = str(data.get("id", tweet_id))
                    q = data.get("quoted_tweet") or {}
                    if q:
                        entry["quoted_screen_name"] = (
                            q.get("user", {}).get("screen_name", "") if q.get("user") else ""
                        )
                        entry["quoted_text"] = (q.get("text", "") or "")[:200]
                    dt = data.get("created_at_datetime")
                    if dt and hasattr(dt, "astimezone"):
                        try:
                            entry["created_at_str"] = dt.astimezone(
                                timezone(timedelta(hours=8))
                            ).strftime("%m月%d日 %H:%M")
                        except Exception:
                            pass
                    # 补齐原文/译文
                    if not entry.get("text"):
                        entry["text"] = (data.get("text", "") or "")[:300]
                    # 缺失配色则重新取色
                    if not entry.get("seed_color"):
                        color_source = self.config.get("color_source", "avatar")
                        seed_url = entry.get("avatar_url", "")
                        if color_source == "first_image" and images:
                            first_url = images[0].get("media_url", "")
                            if first_url:
                                seed_url = _twitter_media_url(first_url, "orig")
                        if seed_url:
                            seed_rgb = await self._extract_seed_color(seed_url)
                            pal, _is_dark = self._generate_palette(seed_rgb)
                            entry["seed_color"] = (
                                "#%02x%02x%02x" % seed_rgb if seed_rgb else ""
                            )
                            entry["palette"] = pal
                    rebuilt += 1
                    self._save_push_history()
                    await asyncio.sleep(2)  # 规避 Twitter API 速率限制
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    logger.warning(
                        f"[Rebuild] Failed for tweet {tweet_id}: {e}"
                    )
                    continue
            self._log_push(
                f"历史卡片重建完成，补全 {rebuilt} 条，跳过 {skipped} 条", "info"
            )
        except Exception as e:
            logger.error(f"[Rebuild] History rebuild failed: {e}")
            self._log_push(f"历史卡片重建失败: {str(e)[:60]}", "error")
        finally:
            self._rebuild_running = False

    async def _api_dashboard_toggle_monitor(self):
        """按会话开启/关闭监控推送。"""
        from astrbot.api.web import request, json_response, error_response

        payload = await request.json()
        session = payload.get("session", "")
        enabled = payload.get("enabled", True)
        if not session:
            return error_response("缺少 session", status_code=400)

        if enabled:
            self.monitored_sessions.add(session)
            if any(self.subscriptions.get(s) for s in self.monitored_sessions):
                self._start_monitor()
        else:
            self.monitored_sessions.discard(session)
            if not self.monitored_sessions:
                self._stop_monitor()

        self._save_data()
        self._log_push(
            f"会话 {'开启' if enabled else '关闭'}监控: {session[:20]}…",
            "info",
        )
        return json_response({"ok": True, "enabled": enabled})

    async def _api_bg_upload(self):
        """上传 UI 背景图，以 base64 data URI 内联存储。"""
        import base64
        import time as _time
        from astrbot.api.web import request, json_response, error_response, PluginUploadFile

        files = await request.files()
        upload = files.get("file")
        if not isinstance(upload, PluginUploadFile):
            return error_response("缺少上传文件（字段名应为 file）", status_code=400)

        ext = os.path.splitext(upload.filename)[1].lower()
        if ext not in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
            return error_response("仅支持 jpg/png/webp/gif 图片", status_code=400)

        # 取文件字节：优先用 body 属性，否则临时落盘读取后删除
        body = getattr(upload, "body", None)
        if body is None:
            bg_dir = os.path.join(os.path.dirname(self._data_path), "backgrounds")
            os.makedirs(bg_dir, exist_ok=True)
            tmp_path = os.path.join(bg_dir, f"tmp_{int(_time.time())}{ext}")
            await upload.save(tmp_path)
            try:
                with open(tmp_path, "rb") as f:
                    body = f.read()
            finally:
                try:
                    os.remove(tmp_path)
                except Exception:
                    pass

        if len(body) > 20 * 1024 * 1024:
            return error_response("图片不能超过 20MB", status_code=400)

        mime = {
            ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".png": "image/png", ".webp": "image/webp",
            ".gif": "image/gif",
        }.get(ext, "application/octet-stream")
        data_uri = f"data:{mime};base64," + base64.b64encode(body).decode("ascii")

        # 持久化到 ui_config JSON
        path = os.path.join(
            os.path.dirname(self._data_path), "denpa_push_ui_config.json"
        )
        try:
            ui = {}
            if os.path.exists(path):
                with open(path, "r", encoding="utf-8") as f:
                    ui = json.load(f)
            ui["background_image"] = data_uri
            ui["background_mode"] = "image"
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                json.dump(ui, f, ensure_ascii=False)
        except Exception as e:
            logger.warning(f"[DenpaPush] 保存背景图配置失败: {e}")

        logger.info(f"[DenpaPush] 背景图已上传（base64 内联，{len(body)} 字节）")
        return json_response({
            "saved": True,
            "data": data_uri,
            "filename": upload.filename,
        })

    async def _api_bg_remove(self):
        """移除背景图。"""
        from astrbot.api.web import json_response

        path = os.path.join(
            os.path.dirname(self._data_path), "denpa_push_ui_config.json"
        )
        try:
            ui = {}
            if os.path.exists(path):
                with open(path, "r", encoding="utf-8") as f:
                    ui = json.load(f)
            ui["background_image"] = ""
            ui["background_accent"] = ""
            ui["background_mode"] = "theme"
            with open(path, "w", encoding="utf-8") as f:
                json.dump(ui, f, ensure_ascii=False)
        except Exception:
            pass
        return json_response({"removed": True})

    def _load_data(self):
        try:
            if os.path.exists(self._data_path):
                with open(self._data_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                tracked = data.get("tracked_users")
                if tracked is not None:
                    sessions = data.get("monitored_sessions", [])
                    self.subscriptions = {}
                    for s in sessions:
                        self.subscriptions[s] = dict(tracked)
                    self.monitored_sessions = set(sessions)
                else:
                    self.subscriptions = data.get("subscriptions", {})
                    self.monitored_sessions = set(data.get("monitored_sessions", []))
                total = sum(len(users) for users in self.subscriptions.values())
                logger.info(
                    f"Loaded {len(self.subscriptions)} sessions with {total} tracked users"
                )
        except Exception as e:
            logger.warning(f"Failed to load data: {e}")
            self.subscriptions = {}
            self.monitored_sessions = set()

    def _save_data(self):
        try:
            os.makedirs(os.path.dirname(self._data_path), exist_ok=True)
            data = {
                "subscriptions": self.subscriptions,
                "monitored_sessions": list(self.monitored_sessions),
            }
            with open(self._data_path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.error(f"Failed to save data: {e}")

    def _start_monitor(self):
        if self.monitor_task and not self.monitor_task.done():
            return
        self._running = True
        self.monitor_task = asyncio.create_task(self._monitor_loop())
        logger.info("Monitor loop started")

    def _stop_monitor(self):
        self._running = False
        if self.monitor_task:
            self.monitor_task.cancel()
            self.monitor_task = None
        logger.info("Monitor loop stopped")

    @filter.command("twitter")
    async def twitter_cmd(self, event: AstrMessageEvent):
        parts = event.message_str.strip().split()
        if len(parts) < 2:
            yield _plain(
                "用法:\n"
                "/twitter add <username>  - 关注用户\n"
                "/twitter remove <username>  - 取消关注\n"
                "/twitter list  - 关注列表\n"
                "/twitter push <url>  - 手动推送单条推文\n"
                "/twitter monitor  - 切换本会话的推送开关"
            )
            return

        sub = parts[1].lower()

        auth_token = self.config.get("twitter_auth_token", "")
        if not auth_token:
            yield _plain(
                "请先在插件配置中设置 twitter_auth_token 和 twitter_ct0"
            )
            return
        self.twitter.set_credentials(auth_token, self.config.get("twitter_ct0", ""))

        if sub == "add" and len(parts) >= 3:
            yield await self._cmd_add(event, parts[2])
        elif sub == "remove" and len(parts) >= 3:
            yield await self._cmd_remove(event, parts[2])
        elif sub == "list":
            yield await self._cmd_list(event)
        elif sub == "push" and len(parts) >= 3:
            for result in await self._cmd_push(event, parts[2]):
                yield result
        elif sub == "monitor":
            yield await self._cmd_monitor(event)
        else:
            yield _plain(f"未知子指令: {sub}")

    @filter.llm_tool(name="twitter_add")
    async def twitter_add(self, event: AstrMessageEvent, usernames: list):
        """当用户说「关注」「订阅」「跟踪」某个推特账号时使用此工具。会开始监控该用户的推文并自动推送新内容。

        Args:
            usernames(array[string]): 要关注的用户名，如 ["ApexLiveComms"]
        """
        event = _unwrap_event(event)
        if isinstance(usernames, str):
            usernames = [usernames]
        for name in usernames:
            result = await self._cmd_add(event, name)
            yield result

    @filter.llm_tool(name="twitter_remove")
    async def twitter_remove(self, event: AstrMessageEvent, usernames: list):
        """当用户说「取消关注」「取关」「删除订阅」某个推特账号时使用此工具。支持模糊匹配。
        Args:
            usernames(array[string]): 要取消关注的用户名，如 ["apexlive"]
        """
        event = _unwrap_event(event)
        if isinstance(usernames, str):
            usernames = [usernames]
        umo = event.unified_msg_origin
        session_users = self.subscriptions.get(umo, {})
        for raw in usernames:
            matched = [n for n in session_users if raw.lower() in n.lower()]
            if not matched:
                result = await self._cmd_remove(event, raw)
                yield result
            else:
                for name in matched:
                    result = await self._cmd_remove(event, name)
                    yield result

    @filter.llm_tool(name="twitter_push")
    async def twitter_push(self, event: AstrMessageEvent, url: str):
        """当用户发来一个推特链接并要求「推送」「翻译」「看看」「读取」「解析」时使用此工具。会获取推文内容、翻译、生成卡片并发送图片/视频。不要自己解释推文内容，交给此工具处理。

        Args:
            url(string): 推特链接，如 https://x.com/username/status/123456
        """
        event = _unwrap_event(event)
        umo = event.unified_msg_origin
        m = __import__("re").search(
            r"(?:twitter\.com|x\.com)/(\w+)/status/(\d+)", url
        )
        username = m.group(1) if m else "unknown"
        tweet_id = m.group(2) if m else ""
        silent = bool(self.config.get("silent_mode", False))
        for chain in await self._cmd_push(event, url, silent=silent):
            await self.context.send_message(umo, chain)
            await asyncio.sleep(0.3)
        if not silent:
            yield f"已推送 @{username} 的推文 {tweet_id}"

    @filter.llm_tool(name="twitter_list")
    async def twitter_list(self, event: AstrMessageEvent):
        """列出当前群聊已关注的 Twitter 用户。"""
        event = _unwrap_event(event)
        umo = event.unified_msg_origin
        session_users = self.subscriptions.get(umo, {})
        lines = ["已关注用户:"]
        for name in session_users:
            lines.append(f"  @{name}")
        yield _plain("\n".join(lines) if len(lines) > 1 else "暂无关注用户")

    @filter.llm_tool(name="denpa_push")
    async def denpa_push(self, event: AstrMessageEvent):
        """开启或关闭当前会话的自动推送。"""
        event = _unwrap_event(event)
        umo = event.unified_msg_origin
        if umo in self.monitored_sessions:
            self.monitored_sessions.discard(umo)
            self._save_data()
            yield _plain("已关闭本会话的自动推送")
        else:
            self.monitored_sessions.add(umo)
            self._save_data()
            if any(self.subscriptions.get(s) for s in self.monitored_sessions):
                self._start_monitor()
            yield _plain("已开启本会话的自动推送")

    async def _cmd_add(self, event: AstrMessageEvent, username: str):
        username = username.lstrip("@")
        umo = event.unified_msg_origin
        session_users = self.subscriptions.setdefault(umo, {})
        if username in session_users:
            yield _plain(f"本群已关注 @{username}")
        try:
            user = await self.twitter.get_user_by_screen_name(username)
            tweets = await self.twitter.get_user_tweets(user.id, count=1)
            last_id = tweets[0].id if tweets else "0"
            avatar_url = getattr(user, "profile_image_url", "") or ""
            if avatar_url:
                avatar_url = avatar_url.replace("_normal.", "_400x400.")
            session_users[username] = {
                "user_id": user.id,
                "name": getattr(user, "name", "") or username,
                "avatar_url": avatar_url,
                "last_tweet_id": last_id,
                "last_checked_at": datetime.now(timezone.utc).isoformat(),
            }
            self._save_data()
            self._start_monitor()
            yield _plain(
                f"本群已关注 @{username}（{user.name}），开始跟踪"
            )
        except Exception as e:
            logger.error(f"Failed to add user {username}: {e}")
            yield _plain(f"添加失败: {str(e)[:100]}")

    async def _cmd_remove(self, event: AstrMessageEvent, username: str):
        username = username.lstrip("@")
        umo = event.unified_msg_origin
        session_users = self.subscriptions.get(umo, {})
        if username not in session_users:
            return _plain(f"本群未关注 @{username}")
        del session_users[username]
        if not session_users:
            del self.subscriptions[umo]
        self._save_data()
        if not self.subscriptions:
            self._stop_monitor()
        return _plain(f"本群已取消关注 @{username}")

    async def _cmd_list(self, event: AstrMessageEvent):
        umo = event.unified_msg_origin
        session_users = self.subscriptions.get(umo, {})
        if not session_users:
            return _plain("本群暂无关注用户")
        lines = ["本群关注用户:"]
        for name, info in session_users.items():
            lines.append(
                f"  @{name}  (最后ID: {info.get('last_tweet_id', 'N/A')[:12]}...)"
            )
        return _plain("\n".join(lines))

    async def _cmd_push(self, event: AstrMessageEvent, url: str, silent: bool = False):
        results = []
        m = re.search(r"(?:twitter\.com|x\.com)/(\w+)/status/(\d+)", url)
        if not m:
            results.append(
                _plain(
                    "无效的推文链接，格式: https://x.com/username/status/123456"
                )
            )
            return results
        username, tweet_id = m.group(1), m.group(2)
        try:
            if not silent:
                results.append(_plain("正在获取推文..."))
            tweet = await self.twitter.get_tweet_by_id(tweet_id)
            data = TwitterClient.extract_tweet_data(tweet)

            # 2. 图片提前下载到临时文件发送（避免发送时 pbs.twimg.com 直连超时）
            from astrbot.api.message_components import Node, Plain
            import tempfile, httpx as _httpx, subprocess, os

            async def _convert_to_gif(mp4_path):
                try:
                    import json, shutil, glob as _glob

                    _ffmpeg = shutil.which("ffmpeg")
                    _ffprobe = shutil.which("ffprobe")
                    if not _ffmpeg or not _ffprobe:
                        logger.warning(
                            "ffmpeg/ffprobe not found, GIF conversion unavailable. "
                            "Install: apt install ffmpeg"
                        )
                        return None

                    gif_path = mp4_path.rsplit(".", 1)[0] + ".gif"
                    # detect original fps via ffprobe
                    fps = 15
                    try:
                        probe = await asyncio.create_subprocess_exec(
                            _ffprobe,
                            "-v", "error",
                            "-select_streams", "v:0",
                            "-show_entries", "stream=r_frame_rate",
                            "-of", "json",
                            mp4_path,
                            stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL,
                        )
                        out, _ = await probe.communicate()
                        info = json.loads(out.decode())
                        num, den = map(
                            int, info["streams"][0]["r_frame_rate"].split("/")
                        )
                        fps = num / den if den else 15
                    except Exception:
                        pass

                    encoder = self.config.get("gif_encoder", "auto")
                    _gifski = shutil.which("gifski") if encoder != "ffmpeg" else None
                    if encoder == "gifski" and not _gifski:
                        logger.warning("gifski not found, falling back to ffmpeg. Install: apt install gifski")
                    if _gifski:
                        # gifski: ffmpeg 导出 PNG 帧 → gifski 编码高质量 GIF
                        frames_dir = tempfile.mkdtemp(prefix="denpa_frames_")
                        try:
                            frame_pattern = os.path.join(frames_dir, "frame_%04d.png")
                            ffmpeg_proc = await asyncio.create_subprocess_exec(
                                _ffmpeg,
                                "-i", mp4_path,
                                "-vf", f"fps={fps:.2f}",
                                "-y", frame_pattern,
                                stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL,
                            )
                            rc = await ffmpeg_proc.wait()
                            if rc == 0 and os.listdir(frames_dir):
                                gifski_proc = await asyncio.create_subprocess_exec(
                                    _gifski,
                                    "-o", gif_path,
                                    "--fps", str(int(fps)),
                                    os.path.join(frames_dir, "frame_*.png"),
                                    stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL,
                                )
                                rc2 = await gifski_proc.wait()
                                if rc2 == 0 and os.path.exists(gif_path):
                                    return gif_path
                        finally:
                            shutil.rmtree(frames_dir, ignore_errors=True)

                    # fallback: ffmpeg palettegen+paletteuse
                    palette_filter = (
                        f"fps={fps:.2f},"
                        f"split[s0][s1];"
                        f"[s0]palettegen=stats_mode=diff[p];"
                        f"[s1][p]paletteuse=dither=none"
                    )
                    proc = await asyncio.create_subprocess_exec(
                        _ffmpeg,
                        "-i", mp4_path,
                        "-vf", palette_filter,
                        "-y", gif_path,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                    rc = await proc.wait()
                    if rc == 0 and os.path.exists(gif_path):
                        return gif_path
                except Exception as e:
                    logger.warning(f"GIF conversion failed: {e}")
                return None

            async def _dl_file(url, suffix=".jpg"):
                try:
                    proxy = self.config.get("proxy", None)
                    async with _httpx.AsyncClient(
                        proxy=proxy if proxy else None, timeout=60
                    ) as c:
                        r = await c.get(url)
                        r.raise_for_status()
                        ext = suffix
                        # try to detect extension from url
                        for s in [".mp4", ".gif", ".jpg", ".jpeg", ".png"]:
                            if s in url.lower():
                                ext = s
                                break
                        tmp = tempfile.NamedTemporaryFile(suffix=ext, delete=False)
                        tmp.write(r.content)
                        tmp.close()
                        return tmp.name
                except Exception as e:
                    logger.warning(f"Media download failed: {url[:60]} - {e}")
                    return None

            # 提前下载图片，同时传给卡片渲染复用
            images, gifs, videos = TwitterClient.extract_tweet_media(data)
            media_url_to_path = {}
            img_files = await asyncio.gather(
                *[
                    _dl_file(_twitter_media_url(img.get("media_url", ""), "orig"))
                    for img in images
                    if img.get("media_url", "")
                ]
            )
            for img, path in zip(
                [img for img in images if img.get("media_url", "")], img_files
            ):
                if path:
                    media_url_to_path[img["media_url"]] = path

            info = await self._build_card_data(data, media_url_to_path)

            # 1. 卡片 PNG 直接发送（多张长文章分块）
            for url in info.get("card_img_urls", [info.get("card_img_url", "")]):
                if url:
                    results.append(_img(url))
            results.append(
                _plain(
                    f"📢 @{info['screen_name']}\n{info.get('tweet_url', '')}"
                )
            )

            uname = info.get("user_name", info["screen_name"])
            img_contents = [Plain(f"📸 @{info['screen_name']} 的图片")]
            for f in img_files:
                if f:
                    img_contents.append(CompImage.fromFileSystem(f))
            if len(img_contents) > 1:
                node = Node(uin="0", name=uname, content=img_contents)
                results.append(_chain([node]))
            for gif in info.get("gifs", []):
                vurl = gif.get("video_url", gif.get("media_url", ""))
                if vurl:
                    f = await _dl_file(vurl, suffix=".mp4")
                    if f:
                        gif_path = await _convert_to_gif(f)
                        if gif_path:
                            results.append(
                                _chain([CompImage.fromFileSystem(gif_path)])
                            )
                        else:
                            results.append(
                                _chain([CompVideo.fromFileSystem(f)])
                            )
            for vid in info.get("videos", []):
                vurl = vid.get("video_url", vid.get("media_url", ""))
                if vurl:
                    f = await _dl_file(vurl)
                    if f:
                        results.append(
                            _chain([CompVideo.fromFileSystem(f)])
                        )

            # 记录到推送历史（手动推送），溯源时间与会话
            self._total_pushes += 1
            self._log_push(
                f"@{info['screen_name']} [手动] → {event.unified_msg_origin[:20]}…",
                "push",
            )
            self._record_push_history(info, event.unified_msg_origin, source="manual")
        except Exception as e:
            logger.error(f"Failed to push tweet {tweet_id}: {e}")
            results.append(_plain(f"推送失败: {str(e)[:100]}"))
        return results

    async def _cmd_monitor(self, event: AstrMessageEvent):
        umo = event.unified_msg_origin
        if umo in self.monitored_sessions:
            self.monitored_sessions.discard(umo)
            self._save_data()
            return _plain("已关闭本会话的自动推送")
        else:
            self.monitored_sessions.add(umo)
            self._save_data()
            if any(self.subscriptions.get(s) for s in self.monitored_sessions):
                self._start_monitor()
            return _plain("已开启本会话的自动推送")

    async def _monitor_loop(self):
        interval = max(1, int(self.config.get("poll_interval", 5))) * 60
        total_subs = (
            sum(len(users) for users in self.subscriptions.values())
            if self.subscriptions
            else 0
        )
        logger.info(
            f"[Monitor] Loop started, interval={interval}s, subscriptions={len(self.subscriptions)}, tracked_users={total_subs}, monitored_sessions={len(self.monitored_sessions)}"
        )
        while self._running:
            try:
                await self.twitter.ensure_ready()
            except Exception as e:
                logger.warning(f"Twitter client not ready: {e}")
                await asyncio.sleep(60)
                continue

            # Build unique user set across all sessions
            unique_users = {}
            user_sessions = {}
            for session_umo, session_users in list(self.subscriptions.items()):
                for username, info in session_users.items():
                    if username not in unique_users:
                        unique_users[username] = info
                    user_sessions.setdefault(username, []).append(session_umo)

            for username in list(unique_users.keys()):
                try:
                    info = unique_users[username]
                    user_id = info["user_id"]
                    tweets = await self.twitter.get_user_tweets(user_id, count=20)

                    # Backfill avatar/display name for legacy subscriptions missing them
                    if tweets and not info.get("avatar_url"):
                        tu = getattr(tweets[0], "user", None)
                        av = (getattr(tu, "profile_image_url", "") or "") if tu else ""
                        if av:
                            av = av.replace("_normal.", "_400x400.")
                        disp_name = (getattr(tu, "name", "") or "") if tu else ""
                        for sess_umo in user_sessions.get(username, []):
                            sess_users = self.subscriptions.get(sess_umo)
                            if sess_users and username in sess_users:
                                if av:
                                    sess_users[username]["avatar_url"] = av
                                if disp_name:
                                    sess_users[username]["name"] = disp_name
                        self._save_data()
                        logger.info(f"[Monitor] Backfilled avatar for @{username}")

                    # Highest last_tweet_id across sessions tracking this user
                    last_id = "0"
                    for sess_umo in user_sessions.get(username, []):
                        sess_users = self.subscriptions.get(sess_umo, {})
                        uid = sess_users.get(username, {}).get("last_tweet_id", "0")
                        if uid > last_id:
                            last_id = uid

                    new_tweets = [t for t in tweets if t.id > last_id]

                    if new_tweets:
                        pushed_any = False
                        for sess_umo in user_sessions.get(username, []):
                            sess_users = self.subscriptions.get(sess_umo)
                            sess_info = (sess_users or {}).get(username)
                            if not sess_info:
                                continue
                            # 未监控的会话: 丢弃本轮新推文并推进基线, 防止开启监控后补推轰炸
                            if sess_umo not in self.monitored_sessions:
                                sess_info["last_tweet_id"] = new_tweets[0].id
                                sess_info["last_checked_at"] = datetime.now(
                                    timezone.utc
                                ).isoformat()
                                continue
                            # 该会话自己的待推区间(各会话基线独立, 失败会话下轮从失败点补推)
                            sess_new = [
                                t
                                for t in tweets
                                if t.id > sess_info.get("last_tweet_id", "0")
                            ]
                            if not sess_new:
                                continue
                            logger.info(
                                f"[Monitor] {username} → {sess_umo[:20]}…: "
                                f"{len(sess_new)} new tweets "
                                f"(last={sess_info.get('last_tweet_id', '0')[:15]}..)"
                            )
                            for t in reversed(sess_new):
                                ok = False
                                try:
                                    data = TwitterClient.extract_tweet_data(t)
                                    results = await self._process_and_push(
                                        data, [sess_umo]
                                    )
                                    ok = results.get(sess_umo, False)
                                except Exception as e:
                                    logger.error(
                                        f"[Monitor] Push failed for {username}: {t.id}: {e}"
                                    )
                                if ok:
                                    # 推送成功 → 基线推进到本条
                                    sess_info["last_tweet_id"] = t.id
                                    sess_info["last_checked_at"] = datetime.now(
                                        timezone.utc
                                    ).isoformat()
                                    pushed_any = True
                                    self._push_fail_counts.pop(
                                        (sess_umo, username, t.id), None
                                    )
                                else:
                                    # 推送失败 → 基线不推进, 停在本条之前, 下轮自动补推
                                    fkey = (sess_umo, username, t.id)
                                    fail_rounds = (
                                        self._push_fail_counts.get(fkey, 0) + 1
                                    )
                                    self._push_fail_counts[fkey] = fail_rounds
                                    if fail_rounds >= PUSH_MAX_FAIL_ROUNDS:
                                        # 连续多轮失败: 强制跳过, 防基线永久卡死
                                        logger.warning(
                                            f"[Monitor] {username} → {sess_umo[:20]}…: "
                                            f"{t.id[:15]}.. failed {fail_rounds} rounds, skipping"
                                        )
                                        self._log_push(
                                            f"@{username} 推文 {t.id[:12]}… 连续 "
                                            f"{fail_rounds} 轮推送失败，已强制跳过",
                                            "error",
                                        )
                                        sess_info["last_tweet_id"] = t.id
                                        sess_info["last_checked_at"] = datetime.now(
                                            timezone.utc
                                        ).isoformat()
                                        self._push_fail_counts.pop(fkey, None)
                                    else:
                                        self._log_push(
                                            f"@{username} → {sess_umo[:20]}… 推送失败，基线未推进，下轮补推",
                                            "error",
                                        )
                                    break
                                await asyncio.sleep(2)
                        self._save_data()
                        if pushed_any:
                            logger.info(
                                f"[Monitor] {username}: pushed, baseline advanced per session"
                            )
                    else:
                        logger.debug(f"[Monitor] {username}: no new tweets")
                except asyncio.CancelledError:
                    return
                except Exception as e:
                    estr = str(e)
                    if "429" in estr or "Rate limit" in estr:
                        logger.warning(
                            f"[Monitor] Rate limited for {username}, aborting this round"
                        )
                        self._log_push(f"@{username} 触发速率限制，本轮中止", "error")
                        break
                    logger.error(f"[Monitor] Error for {username}: {e}")
                    self._log_push(f"@{username} 检查异常: {estr[:60]}", "error")

            await asyncio.sleep(interval)

    async def _extract_seed_color(self, image_url: str):
        if image_url in self._seed_cache:
            return self._seed_cache[image_url]
        try:
            import httpx
            from PIL import Image
            import io
            from material_color_utilities import prominent_colors_from_image

            proxy = self.config.get("proxy", None)
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
                "Referer": "https://x.com/",
            }
            img_bytes = None
            used_url = image_url
            if "_normal." in image_url:
                sizes = ["_400x400.", "_bigger.", "_normal."]
                base = image_url.replace("_normal.", "{}")
                async with httpx.AsyncClient(
                    proxy=proxy if proxy else None, timeout=15
                ) as _c:
                    for s in sizes:
                        try:
                            u = base.format(s)
                            _r = await _c.get(u, headers=headers)
                            _r.raise_for_status()
                            img_bytes = _r.content
                            used_url = u
                            break
                        except Exception:
                            continue
            else:
                async with httpx.AsyncClient(
                    proxy=proxy if proxy else None, timeout=15
                ) as _c:
                    _r = await _c.get(image_url, headers=headers)
                    _r.raise_for_status()
                    img_bytes = _r.content
            if not img_bytes:
                return (103, 80, 164)
            _img = Image.open(io.BytesIO(img_bytes)).convert("RGBA")
            # align with MCU: downsample to 48×48 before quantizing
            _img = _img.resize((48, 48), Image.LANCZOS)
            colors = prominent_colors_from_image(_img, max_colors=128)
            if not colors:
                return (103, 80, 164)
            # colors 是 RRGGBB hex 格式 #rrggbb
            h = colors[0].lstrip("#")
            rgb = (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
            logger.warning(
                f"Seed extracted: RGB={rgb} from {len(img_bytes)} bytes via {used_url.split('/')[-1][:40]}"
            )
            self._seed_cache[image_url] = rgb
            return rgb
        except Exception as e:
            logger.warning(f"Seed color extraction failed: {type(e).__name__}: {e}")
            self._seed_cache[image_url] = (103, 80, 164)
            return (103, 80, 164)

    def _generate_palette(self, seed_rgb):
        h = int(
            __import__("datetime")
            .datetime.now(
                __import__("datetime").timezone(
                    __import__("datetime").timedelta(hours=8)
                )
            )
            .strftime("%H")
        )
        is_dark = h >= 18 or h < 6

        try:
            from material_color_utilities import theme_from_color

            def rgb_str(c):
                return f"{int(c[1:3], 16)}, {int(c[3:5], 16)}, {int(c[5:7], 16)}"

            hex_color = f"#{seed_rgb[0]:02x}{seed_rgb[1]:02x}{seed_rgb[2]:02x}"
            theme = theme_from_color(hex_color)
            scheme = theme.schemes.dark if is_dark else theme.schemes.light
            palette = {
                "primary": scheme.primary,
                "primary_rgb": rgb_str(scheme.primary),
                "on_primary": scheme.on_primary,
                "on_primary_rgb": rgb_str(scheme.on_primary),
                "secondary": scheme.secondary,
                "secondary_rgb": rgb_str(scheme.secondary),
                "surface": scheme.surface,
                "surface_rgb": rgb_str(scheme.surface),
                "surface_variant": scheme.surface_variant,
                "surface_variant_rgb": rgb_str(scheme.surface_variant),
                "on_surface": scheme.on_surface,
                "on_surface_rgb": rgb_str(scheme.on_surface),
                "on_surface_variant": scheme.on_surface_variant,
                "on_surface_variant_rgb": rgb_str(scheme.on_surface_variant),
                "background": scheme.background,
                "background_rgb": rgb_str(scheme.background),
                "surface_container": scheme.surface_container,
                "surface_container_rgb": rgb_str(scheme.surface_container),
            }
            logger.warning(
                f"Dynamic palette from seed={hex_color} (dark={is_dark}): primary={scheme.primary}"
            )
            return palette, is_dark
        except Exception as e:
            logger.warning(f"Dynamic palette failed: {e}")

        # Fallback hardcoded palettes
        if is_dark:
            return {
                "primary": "#d0bcff",
                "primary_rgb": "208, 188, 255",
                "on_primary": "#381e72",
                "on_primary_rgb": "56, 30, 114",
                "secondary": "#cac4d0",
                "secondary_rgb": "202, 196, 208",
                "surface": "#1c1b1f",
                "surface_rgb": "28, 27, 31",
                "surface_variant": "#141318",
                "surface_variant_rgb": "20, 19, 24",
                "on_surface": "#e6e1e5",
                "on_surface_rgb": "230, 225, 229",
                "on_surface_variant": "#c9c5d0",
                "on_surface_variant_rgb": "201, 197, 208",
                "background": "#141318",
                "background_rgb": "20, 19, 24",
                "surface_container": "#1c1b1f",
                "surface_container_rgb": "28, 27, 31",
            }, is_dark
        return {
            "primary": "#5700d2",
            "primary_rgb": "87, 0, 210",
            "on_primary": "#ffffff",
            "on_primary_rgb": "255, 255, 255",
            "secondary": "#554262",
            "secondary_rgb": "85, 66, 98",
            "surface": "#fdf7ff",
            "surface_rgb": "253, 247, 255",
            "surface_variant": "#efe5ff",
            "surface_variant_rgb": "239, 229, 255",
            "on_surface": "#1d1a24",
            "on_surface_rgb": "29, 26, 36",
            "on_surface_variant": "#49454f",
            "on_surface_variant_rgb": "73, 69, 79",
            "background": "#fdf7ff",
            "background_rgb": "253, 247, 255",
            "surface_container": "#f0eaf8",
            "surface_container_rgb": "240, 234, 248",
        }, is_dark

    async def _build_card_data(self, data: dict, media_url_to_path: dict = None) -> dict:
        import re as _re

        article = data.get("article")
        if article and article.get("rest_id"):
            try:
                full_text = await self.twitter.get_full_article_text(data["id"])
                if full_text:
                    article["full_text"] = full_text
                    data["article_full_text"] = full_text
            except Exception as e:
                logger.warning(f"Full article fetch failed: {e}")
        elif not article:
            try:
                full_text = await self.twitter.get_full_article_text(data["id"])
                if full_text:
                    data["text"] = full_text
                    data["article_full_text"] = full_text
                    title_m = _re.search(
                        r"<h1[^>]*>(.*?)</h1>", full_text, _re.I | _re.S
                    )
                    title = _re.sub(
                        r"<[^>]+>", "", title_m.group(1) if title_m else ""
                    ).strip()
                    data["article"] = {
                        "title": title,
                        "full_text": full_text,
                        "preview_text": "",
                        "rest_id": data["id"],
                    }
            except Exception as e:
                logger.warning(f"Fallback article fetch failed: {e}")

        # 如果推文是引用推文但未提取到数据（twikit get_tweet_by_id 不返回 quoted_status_result），单独获取
        if data.get("is_quote") and not data.get("quoted_tweet"):
            try:
                q = await self.twitter.fetch_quoted_tweet_data(data["id"])
                if q:
                    data["quoted_tweet"] = q
            except Exception as e:
                logger.warning(f"Failed to fetch quoted tweet data: {e}")

        # 如果引推也有文章（NoteTweet），获取引推文章全文
        q_data = data.get("quoted_tweet", {})
        q_article = q_data.get("article", {}) if q_data else {}
        if q_article and q_article.get("rest_id") and q_data.get("id"):
            try:
                q_art_full = await asyncio.wait_for(
                    self.twitter.get_full_article_text(q_data["id"]), timeout=20
                )
                if q_art_full:
                    q_article["full_text"] = q_art_full
            except Exception as e:
                logger.warning(f"Quoted article fetch failed: {e}")

        translated_text = data.get("text", "")
        try:
            translated_text = await self._translate_text(data)
        except Exception as e:
            logger.warning(f"Translation failed: {e}")
            translated_text = data.get("text", "(翻译失败)")

        # 提取引用推文数据用于卡片
        quoted = data.get("quoted_tweet", {})
        quoted_user = quoted.get("user", {}) if quoted else {}
        quoted_media = quoted.get("media", []) if quoted else []
        quoted_thumbnails = []
        for m in quoted_media[:2]:
            mu = m.get("media_url", "")
            if not mu:
                continue
            if media_url_to_path and mu in media_url_to_path:
                quoted_thumbnails.append(_file_to_data_uri(media_url_to_path[mu]))
            else:
                quoted_thumbnails.append(_twitter_media_url(mu, "medium"))
        q_user_name = quoted_user.get("name", "")
        q_screen_name = quoted_user.get("screen_name", "")
        q_avatar = quoted_user.get("avatar_url", "")

        # 引用推文的文章数据
        q_article_data = quoted.get("article", {}) if quoted else {}
        q_article_title = q_article_data.get("title", "") if q_article_data else ""
        q_article_text = q_article_data.get("full_text", "") if q_article_data else ""
        q_article_preview = (
            q_article_data.get("preview_text", "") if q_article_data else ""
        )

        image_translations = None
        images, gifs, videos = TwitterClient.extract_tweet_media(data)
        # 合并引用推文的媒体到待推送列表
        if quoted:
            q_imgs, q_gifs, q_vids = TwitterClient.extract_tweet_media(quoted)
            images.extend(q_imgs)
            gifs.extend(q_gifs)
            videos.extend(q_vids)
        # 翻译时跳过链接预览图：推文全文只有链接时，图片都是预览图
        raw_text = data.get("text", "").strip()
        urls = data.get("urls", [])
        text_no_urls = raw_text
        for u in urls:
            text_no_urls = (
                text_no_urls.replace(u.get("url", ""), "")
                .replace(u.get("expanded_url", ""), "")
                .strip()
            )
        is_link_only = len(text_no_urls.strip()) < 5
        if is_link_only:
            images_for_translate = []
        else:
            images_for_translate = images
        if images_for_translate:
            try:
                image_translations = await asyncio.wait_for(
                    self._translate_images(images_for_translate), timeout=120
                )
            except asyncio.TimeoutError:
                logger.warning("Image translation timed out, skipping")
                image_translations = None
            except Exception as e:
                logger.warning(f"Image translation failed: {e}")

        article = data.get("article")
        thumbnail_urls = []
        all_media = images + gifs + videos
        for m in all_media[:4]:
            poster = m.get("media_url", "")
            if poster:
                if media_url_to_path and poster in media_url_to_path:
                    thumbnail_urls.append(_file_to_data_uri(media_url_to_path[poster]))
                else:
                    thumbnail_urls.append(_twitter_media_url(poster, "medium"))

        import os as _os

        tmpl_path = _os.path.join(
            _os.path.dirname(__file__), "templates", "tweet_card.html"
        )
        with open(tmpl_path, "r", encoding="utf-8") as f:
            template = f.read()

        # 图片译文合并到文字译文末尾
        if image_translations:
            translated_text = f"{translated_text}\n\n{image_translations}"

        raw_avatar = data["user"]["avatar_url"]
        avatar_url = raw_avatar.replace("_normal.", "_400x400.")
        logger.warning(f"Avatar URL: {raw_avatar} -> {avatar_url}")

        color_source = self.config.get("color_source", "avatar")
        seed_url = avatar_url
        if color_source == "first_image":
            # 从原始推文的第一张媒体取色（图片/GIF/视频缩略图）
            orig_all = data.get("media", [])
            if orig_all:
                first_url = orig_all[0].get("media_url", "")
                if first_url:
                    seed_url = _twitter_media_url(first_url, "orig")
                    logger.warning(f"Seed from first media: {seed_url[:80]}...")

        seed_rgb = await self._extract_seed_color(seed_url)
        logger.warning(f"Seed RGB: {seed_rgb}")
        palette, is_dark = self._generate_palette(seed_rgb)
        card_data = {
            "user_name": data["user"]["name"],
            "screen_name": data["user"]["screen_name"],
            "user_id": data["user"]["id"],
            "avatar_url": data["user"]["avatar_url"],
            "created_at_str": (
                data["created_at_datetime"]
                .astimezone(
                    __import__("datetime").timezone(
                        __import__("datetime").timedelta(hours=8)
                    )
                )
                .strftime("%m月%d日 %H:%M")
            )
            if data.get("created_at_datetime")
            and hasattr(data["created_at_datetime"], "strftime")
            else str(data.get("created_at", "")),
            "article_title": article.get("title", "") if article else "",
            "article_cover_url": article.get("cover_url", "") if article else "",
            "article_text": data.get("article_full_text")
            or (article.get("full_text", "") if article else ""),
            "article_preview": article.get("preview_text", "") if article else "",
            "original_text": data.get("text", ""),
            "translated_text": translated_text,
            "image_count": len(images),
            "gif_count": len(gifs),
            "video_count": len(videos),
            "thumbnail_urls": thumbnail_urls,
            "quoted_user_name": q_user_name,
            "quoted_screen_name": q_screen_name,
            "quoted_avatar_url": q_avatar,
            "quoted_text": quoted.get("text", ""),
            "quoted_thumbnail_urls": quoted_thumbnails,
            "has_quoted_tweet": bool(quoted and quoted.get("text")),
            "q_article_title": q_article_title,
            "q_article_text": q_article_text,
            "q_article_preview": q_article_preview,
            "has_q_article": bool(q_article_title or q_article_text),
            "palette": palette,
            "is_dark": is_dark,
            "seed_color": "#%02x%02x%02x" % seed_rgb if seed_rgb else "",
            "tweet_url": f"https://x.com/{data['user']['screen_name']}/status/{data.get('id', '')}",
            "text": data.get("text", ""),
        }

        # 长文章分块渲染
        import re as _re

        article_raw = data.get("article_full_text") or (
            article.get("full_text", "") if article else ""
        )
        article_text = (
            _re.sub(r"<[^>]+>", "", article_raw).strip() if article_raw else ""
        )
        MAX_CHUNK = 2000

        def split_into_chunks(text):
            """Split text into ~MAX_CHUNK chunks at paragraph boundaries."""
            paras = text.split("\n\n")
            chunks, cur, cl = [], [], 0
            for p in paras:
                plen = len(p)
                if cl + plen > MAX_CHUNK and cur:
                    chunks.append("\n\n".join(cur))
                    cur, cl = [], 0
                # if a single paragraph exceeds MAX_CHUNK, force-split at sentence
                if plen > MAX_CHUNK:
                    import re as _re

                    sentences = _re.split(r"(?<=[。！？.!?])", p)
                    s_chunk, s_cl = [], 0
                    for s in sentences:
                        if s_cl + len(s) > MAX_CHUNK and s_chunk:
                            cur.append("".join(s_chunk))
                            cl += len(cur[-1]) + 2
                            s_chunk, s_cl = [s], len(s)
                        else:
                            s_chunk.append(s)
                            s_cl += len(s)
                    if s_chunk:
                        cur.append("".join(s_chunk))
                        cl += len(cur[-1]) + 2
                else:
                    cur.append(p)
                    cl += plen + 2
            if cur:
                chunks.append("\n\n".join(cur))
            return chunks

        if len(article_text) > MAX_CHUNK:
            t_chunks = split_into_chunks(translated_text)

            # 译文块数决定卡片数，原文只用在第一张
            card_img_urls = []
            for i, t_chunk in enumerate(t_chunks):
                sub = dict(card_data)
                sub["article_title"] = (
                    card_data["article_title"]
                    if i == 0
                    else f"(续 {i + 1}/{len(t_chunks)})"
                )
                sub["article_text"] = ""
                if i > 0:
                    sub["article_preview"] = ""
                sub["translated_text"] = t_chunk
                img_url = await self._render_card(template, sub)
                if img_url:
                    card_img_urls.append(img_url)
            if not card_img_urls:
                card_img_urls = [await self._render_card(template, card_data)]
        else:
            card_img_urls = [await self._render_card(template, card_data)]

        return {
            "card_img_urls": card_img_urls,
            "card_img_url": card_img_urls[0] if card_img_urls else "",
            "translated_text": translated_text,
            "images": images,
            "gifs": gifs,
            "videos": videos,
            "screen_name": data["user"]["screen_name"],
            "user_name": data["user"]["name"],
            "user_id": data["user"]["id"],
            "avatar_url": avatar_url,
            "tweet_url": f"https://x.com/{data['user']['screen_name']}/status/{data['id']}",
            "tweet_id": data.get("id", ""),
            "original_text": data.get("text", ""),
            "seed_color": card_data["seed_color"],
            "palette": card_data["palette"],
            "is_dark": card_data["is_dark"],
            "created_at_str": card_data["created_at_str"],
            "image_count": card_data["image_count"],
            "gif_count": card_data["gif_count"],
            "video_count": card_data["video_count"],
            "quoted_screen_name": card_data["quoted_screen_name"],
            "quoted_text": card_data["quoted_text"],
        }

    async def _dump_render_debug(self, html: str, card_data: dict, png_path: str):
        debug_dir = os.path.join(
            getattr(self.context, "astrbot_root", os.getcwd()),
            "data",
            "config",
            "debug_render",
        )
        os.makedirs(debug_dir, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        tweet_id = card_data.get("id", "unknown")
        base = os.path.join(debug_dir, f"{ts}_{tweet_id}")
        try:
            with open(f"{base}.html", "w", encoding="utf-8") as f:
                f.write(html)
            meta = {
                "tweet_id": tweet_id,
                "card_data_keys": list(card_data.keys()),
                "screenshot_png": png_path,
                "rendered_at": ts,
            }
            with open(f"{base}.json", "w", encoding="utf-8") as f:
                json.dump(meta, f, ensure_ascii=False, indent=2)
            logger.debug(f"Render debug dumped to {base}.*")
        except Exception as e:
            logger.warning(f"Failed to dump render debug: {e}")

    async def _render_card(self, template: str, card_data: dict) -> str:
        """本地 Playwright 渲染 HTML → PNG，返回文件路径。"""
        import tempfile, os as _os, time as _time

        _tag = f"{id(self)}_{int(_time.time() * 1000000) % 1000000}"
        html_path = _os.path.join(tempfile.gettempdir(), f"astrbot_twitter_{_tag}.html")
        png_path = _os.path.join(tempfile.gettempdir(), f"astrbot_twitter_{_tag}.png")
        from jinja2 import Template

        html = Template(template).render(card_data)
        with open(html_path, "w", encoding="utf-8") as f:
            f.write(html)

        try:
            try:
                browser = await _get_shared_browser()
                ctx = await browser.new_context(device_scale_factor=2)
                page = await ctx.new_page()
                await page.set_viewport_size({"width": 620, "height": 100})
                await page.goto(
                    f"file:///{html_path.replace(chr(92), '/')}",
                    wait_until="domcontentloaded",
                    timeout=10000,
                )
                await page.wait_for_timeout(300)
                h = await page.evaluate("document.body.scrollHeight")
                await page.set_viewport_size({"width": 620, "height": h})
                await page.wait_for_timeout(500)
                await page.screenshot(
                    path=png_path, full_page=True, omit_background=True
                )
                await ctx.close()
                await self._dump_render_debug(html, card_data, png_path)
                return png_path
            except Exception as e:
                logger.error(f"Local card render failed: {e}")

            try:
                card_img_url = await self.html_render(
                    template,
                    card_data,
                    options={"type": "png", "full_page": True, "timeout": 15000},
                )
                return card_img_url
            except Exception as e2:
                logger.error(f"Remote card render also failed: {e2}")
                return ""
        finally:
            try:
                if _os.path.exists(html_path):
                    _os.remove(html_path)
            except Exception:
                pass

    async def _process_and_push(self, data: dict, target_sessions: list) -> dict:
        """推送一条推文到各目标会话。

        返回 {session_umo: bool}: 该会话本次是否完整推送成功。
        失败会话由调用方决定基线是否推进(失败不推进, 下轮补推)。
        """
        if not target_sessions:
            return {}

        import tempfile, httpx as _httpx

        async def _dl_file(url, suffix=".jpg"):
            try:
                proxy = self.config.get("proxy", None)
                async with _httpx.AsyncClient(
                    proxy=proxy if proxy else None, timeout=60
                ) as c:
                    r = await c.get(url)
                    r.raise_for_status()
                    ext = suffix
                    for s in [".mp4", ".gif", ".jpg", ".jpeg", ".png"]:
                        if s in url.lower():
                            ext = s
                            break
                    tmp = tempfile.NamedTemporaryFile(suffix=ext, delete=False)
                    tmp.write(r.content)
                    tmp.close()
                    return tmp.name
            except Exception as e:
                logger.warning(f"Media download failed: {url[:60]} - {e}")
                return None

        # 提前下载图片，传给卡片渲染复用
        images, gifs, videos = TwitterClient.extract_tweet_media(data)
        media_url_to_path = {}
        img_files = await asyncio.gather(
            *[
                _dl_file(_twitter_media_url(img.get("media_url", ""), "orig"))
                for img in images
                if img.get("media_url", "")
            ]
        )
        for img, path in zip(
            [img for img in images if img.get("media_url", "")], img_files
        ):
            if path:
                media_url_to_path[img["media_url"]] = path

        info = await self._build_card_data(data, media_url_to_path)

        results = {s: False for s in target_sessions}
        for session_umo in target_sessions:
            try:
                # 主消息：卡片（多张分块）+ 推主注明
                card_urls = info.get("card_img_urls", [info.get("card_img_url", "")])
                first_card = True
                for url in card_urls:
                    if not url:
                        continue
                    card_chain = MessageChain()
                    if url.startswith("http"):
                        card_chain.chain.append(CompImage.fromURL(url))
                    else:
                        card_chain.chain.append(CompImage.fromFileSystem(url))
                    if first_card:
                        card_chain.message(
                            f"\n📢 @{info['screen_name']}\n{info.get('tweet_url', '')}"
                        )
                        first_card = False
                    logger.info(f"[Push] Card to {session_umo}")
                    await self.context.send_message(session_umo, card_chain)
                    await asyncio.sleep(0.5)
                if first_card:
                    fallback = MessageChain()
                    if info["translated_text"]:
                        fallback.message(
                            f"📢 @{info['screen_name']}\n{info.get('tweet_url', '')}\n\n{info['translated_text'][:500]}"
                        )
                    else:
                        fallback.message(
                            f"📢 @{info['screen_name']} 新推文\n{info.get('tweet_url', '')}"
                        )
                    await self.context.send_message(session_umo, fallback)

                # 图片合并到一条群合并转发消息
                from astrbot.api.message_components import Node, Plain

                img_contents = []
                for f in img_files:
                    if f:
                        img_contents.append(CompImage.fromFileSystem(f))
                if img_contents:
                    node = Node(
                        uin="0",
                        name=info.get("user_name", info["screen_name"]),
                        content=img_contents,
                    )
                    fwd_chain = MessageChain()
                    fwd_chain.chain.append(node)
                    logger.info(f"[Push] Images forward to {session_umo}")
                    await self.context.send_message(session_umo, fwd_chain)
                    await asyncio.sleep(0.5)

                # GIF/视频直接发送
                for gif in info.get("gifs", []):
                    gurl = gif.get("video_url", gif.get("media_url", ""))
                    if gurl:
                        gif_chain = MessageChain()
                        gif_chain.chain.append(CompVideo.fromURL(gurl))
                        logger.info(f"[Push] GIF to {session_umo}")
                        await self.context.send_message(session_umo, gif_chain)
                        await asyncio.sleep(0.5)
                for vid in info.get("videos", []):
                    vurl = vid.get("video_url", vid.get("media_url", ""))
                    if vurl:
                        vid_chain = MessageChain()
                        vid_chain.chain.append(CompVideo.fromURL(vurl))
                        logger.info(f"[Push] Video to {session_umo}")
                        await self.context.send_message(session_umo, vid_chain)
                        await asyncio.sleep(0.5)

                self._total_pushes += 1
                self._log_push(
                    f"@{info['screen_name']} → {session_umo[:20]}…",
                    "push",
                )
                self._record_push_history(info, session_umo, source="auto")
                results[session_umo] = True
            except Exception as e:
                logger.error(f"[Push] Failed to push to {session_umo}: {e}")
                self._log_push(f"推送失败 @{info.get('screen_name', '?')}: {str(e)[:60]}", "error")
        return results

    async def _get_provider_id(self) -> str:
        pid = self.config.get("text_translate_provider", "")
        if not pid and self.monitored_sessions:
            try:
                pid = await self.context.get_current_chat_provider_id(
                    umo=list(self.monitored_sessions)[0]
                )
            except Exception:
                pass
        if isinstance(pid, str):
            return pid
        if isinstance(pid, dict):
            return pid.get("id", "")
        return str(pid) if pid else ""

    def _track_token_usage(self, llm_resp):
        """从 LLM 响应对象中提取 token 用量并累计。

        AstrBot 的 LLMResponse.usage 是 TokenUsage dataclass:
          input_other: int   — 非缓存输入 token
          input_cached: int  — 缓存输入 token
          output: int        — 输出 token
          input  (@property) = input_other + input_cached
          total  (@property) = input_other + input_cached + output
        注意 input / total 是 @property, vars() 拿不到, 必须用属性访问。
        """
        if not llm_resp:
            return
        usage = (
            getattr(llm_resp, "usage", None)
            or getattr(llm_resp, "token_usage", None)
            or getattr(llm_resp, "usage_stats", None)
        )
        if not usage:
            return
        try:
            if isinstance(usage, dict):
                # 字典格式 (旧版兼容)
                prompt_t = int(usage.get("prompt_tokens") or usage.get("input_tokens") or usage.get("input") or 0)
                completion_t = int(usage.get("completion_tokens") or usage.get("output_tokens") or usage.get("output") or 0)
                total_t = int(usage.get("total_tokens") or usage.get("total") or (prompt_t + completion_t))
            else:
                # AstrBot TokenUsage 对象: 用属性访问 (input/total 是 @property)
                prompt_t = int(getattr(usage, "input", 0) or getattr(usage, "input_other", 0))
                completion_t = int(getattr(usage, "output", 0))
                total_t = int(getattr(usage, "total", 0) or (prompt_t + completion_t))
            self._token_stats["prompt"] += prompt_t
            self._token_stats["completion"] += completion_t
            self._token_stats["total"] += total_t
            self._token_stats["calls"] += 1
            self._save_token_stats()
        except Exception as e:
            logger.warning(f"[DenpaPush] token usage parse failed: {e}, usage={usage!r}")

    async def _translate_text(self, data: dict) -> str:
        import re as _re

        text = data.get("text", "")
        article = data.get("article")
        if article:
            full = (
                data.get("article_full_text")
                or article.get("full_text")
                or article.get("preview_text", "")
            )
            full = _re.sub(r"<[^>]+>", "", full).strip()
            text = f"{article.get('title', '')}\n\n{full}"

        # 追加引用推文
        quoted = data.get("quoted_tweet", {})
        quoted_text = quoted.get("text", "")
        quoted_user = quoted.get("user", {})
        quoted_article = quoted.get("article", {})
        if quoted_article:
            qa_full = quoted_article.get("full_text") or quoted_article.get(
                "preview_text", ""
            )
            qa_full = _re.sub(r"<[^>]+>", "", qa_full).strip()
            if qa_full:
                quoted_text = f"{quoted_article.get('title', '')}\n\n{qa_full}"
        if quoted_text:
            q_name = quoted_user.get("name", "")
            text = f"{text}\n\n[引用 @{quoted_user.get('screen_name', '')} ({q_name})]:\n{quoted_text}"

        if not text or not text.strip():
            return "(无文字内容)"

        # 过滤链接
        text = _re.sub(r"https?://\S+", "", text).strip()
        if not text:
            return "(无文字内容)"

        target_lang = self.config.get("translation_language", "中文")
        provider_id = await self._get_provider_id()
        if not provider_id:
            provider_id = self.config.get("text_translate_provider", "")

        if not provider_id:
            return text

        MAX_CHUNK = 10000
        translated_parts = []

        paras = text.split("\n\n")
        chunks, cur, cl = [], [], 0
        for p in paras:
            plen = len(p)
            if cl + plen > MAX_CHUNK and cur:
                chunks.append("\n\n".join(cur))
                cur, cl = [], 0
            cur.append(p)
            cl += plen + 2
        if cur:
            chunks.append("\n\n".join(cur))

        async def _do_chunk(i, chunk):
            prefix = f"(第{i + 1}/{len(chunks)}部分)\n" if len(chunks) > 1 else ""
            default_prompt = f"请将以下内容翻译成{{lang}}，只返回翻译结果:\n\n{{prefix}}{{text}}"
            prompt_tpl = self.config.get("text_translate_prompt", "") or default_prompt
            prompt = prompt_tpl.replace("{lang}", target_lang).replace("{prefix}", prefix).replace("{text}", chunk)
            try:
                llm_resp = await self.context.llm_generate(
                    chat_provider_id=provider_id,
                    prompt=prompt,
                )
                self._track_token_usage(llm_resp)
                if llm_resp and llm_resp.completion_text:
                    return llm_resp.completion_text.strip()
                else:
                    return chunk
            except Exception as e:
                logger.warning(f"LLM translate chunk {i} failed: {e}")
                return chunk

        translated_parts = list(
            await asyncio.gather(
                *[_do_chunk(i, chunk) for i, chunk in enumerate(chunks)]
            )
        )

        return "\n\n".join(translated_parts) if translated_parts else text

    async def _translate_images(self, images: list) -> str:
        if not images:
            return ""

        mode = self.config.get("image_translate_mode", "multimodal")
        provider_id = self.config.get("image_translate_provider", "")
        target_lang = self.config.get("translation_language", "中文")
        if not provider_id:
            provider_id = self.config.get("text_translate_provider", "")

        if not provider_id:
            return "(未配置翻译提供商)"

        img_urls = [
            img.get("media_url", "") for img in images[:4] if img.get("media_url", "")
        ]
        if not img_urls:
            return ""

        if mode == "multimodal":
            default_img_prompt = (
                f"理解图片内容并翻译成{{lang}}，"
                f"自行组织格式使用户能简单直接理解。"
                f"尽量简短，不要使文本量过大影响阅读。"
                f"如果图片中没有文字输出'(无文字)'。"
            )
            img_prompt_tpl = self.config.get("image_translate_prompt", "") or default_img_prompt

            async def _translate_one(url):
                try:
                    prompt = img_prompt_tpl.replace("{lang}", target_lang)
                    resp = await asyncio.wait_for(
                        self.context.llm_generate(
                            chat_provider_id=provider_id,
                            prompt=prompt,
                            image_urls=[url],
                        ),
                        timeout=60,
                    )
                    self._track_token_usage(resp)
                    return resp.completion_text or ""
                except Exception as e:
                    logger.warning(
                        f"Image LLM timeout/fail: {url[:50]} - {type(e).__name__}"
                    )
                    return ""

            results = await asyncio.gather(
                *[_translate_one(u) for u in img_urls], return_exceptions=True
            )
            parts = [
                r for r in results if isinstance(r, str) and r and "(无文字)" not in r
            ]
            return " | ".join(parts)
        elif mode == "text_extraction":
            translations = []
            for img_url in img_urls:
                text_in_image = await self._ocr_image(img_url)
                if text_in_image:
                    llm_resp = await self.context.llm_generate(
                        chat_provider_id=provider_id,
                        prompt=f"将以下内容翻译成{target_lang}:\n\n{text_in_image}",
                    )
                    self._track_token_usage(llm_resp)
                    result = llm_resp.completion_text or ""
                    if result:
                        translations.append(result)
            if translations:
                return " | ".join(translations)
        return ""

    async def _ocr_image(self, img_url: str) -> str:
        try:
            from easyocr import Reader
            import httpx

            reader = Reader(["ch_sim", "en"], gpu=False)
            async with httpx.AsyncClient(timeout=30) as c:
                r = await c.get(img_url)
                if r.status_code == 200:
                    import tempfile

                    tmp = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
                    tmp.write(r.content)
                    tmp.close()
                    results = reader.readtext(tmp.name)
                    os.unlink(tmp.name)
                    return " ".join(txt for _, txt, _ in results)
        except ImportError:
            pass
        except Exception as e:
            logger.warning(f"OCR failed: {e}")
        return ""
