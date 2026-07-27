from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import sys
import tempfile
import shutil
import threading
import time
import urllib.error
import urllib.request
import zipfile
from typing import Any
from pathlib import Path

import tornado.web
from jupyter_server.base.handlers import APIHandler
from jupyter_server.utils import url_path_join

from nitro_ai_judge_cli import api as nitro_api
from nitro_ai_judge_cli import contests as nitro_contests
from nitro_ai_judge_cli import state as nitro_state
from nitro_ai_judge_cli import submissions as nitro_submissions


_PLAYWRIGHT_READY = False
_CACHE_TTL_SECONDS = 24 * 60 * 60.0
_CACHE_LOCK = threading.Lock()
_CONTEST_CACHE: dict[Any, tuple[float, list[dict[str, Any]]]] = {}
_TASK_CACHE: dict[Any, tuple[float, list[dict[str, Any]]]] = {}


def _string_field(value: Any) -> str:
    return value if isinstance(value, str) else str(value or "")


def _load_auth() -> dict[str, Any]:
    state = nitro_state.load_state() or {}
    if state:
        state = nitro_api.ensure_fresh_state(state) or {}

    auth = nitro_api.get_auth(state)
    if not auth:
        raise tornado.web.HTTPError(401, "Not logged in to Nitro AI Judge")

    cf_cookie, session_cookie, bearer = auth
    if not session_cookie and not bearer:
        raise tornado.web.HTTPError(401, "Not logged in to Nitro AI Judge")

    return {
        "cookies": (cf_cookie or "", session_cookie or ""),
        "bearer": bearer or "",
        "state": state,
    }


def _login(username: str, password: str) -> dict[str, Any]:
    username = str(username or "").strip()
    password = str(password or "")
    if not username or not password:
        raise tornado.web.HTTPError(400, "Username and password are required")
    result = nitro_api.do_login(username, password)
    if not isinstance(result, dict):
        raise tornado.web.HTTPError(
            502, "Nitro AI Judge login returned an invalid response"
        )
    if not result.get("success") or not result.get("tokens"):
        message = result.get("error") or "Nitro AI Judge login failed"
        raise tornado.web.HTTPError(401, str(message))

    nitro_api.save_token_state(result["tokens"], result.get("username") or username)
    return _load_auth()


def _ensure_playwright_browser() -> None:
    global _PLAYWRIGHT_READY
    if _PLAYWRIGHT_READY:
        return

    command = [sys.executable, "-m", "playwright", "install", "chromium"]
    subprocess.run(command, check=True)
    _PLAYWRIGHT_READY = True


def _coerce_timestamp(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return value
    return value


def _serialize_competition(item: dict[str, Any]) -> dict[str, Any]:
    start = _coerce_timestamp(item.get("competitionStart"))
    end = _coerce_timestamp(item.get("competitionEnd"))
    now_ms = int(time.time() * 1000)

    has_started = True
    if isinstance(start, (int, float)):
        has_started = start <= now_ms

    is_running = has_started
    if isinstance(end, (int, float)):
        is_running = has_started and now_ms < end

    has_access = item.get("_nitroHasAccess")
    if has_access is None:
        for key in ("hasAccess", "has_access", "accessible", "isAccessible", "canAccess"):
            if key in item:
                has_access = item.get(key)
                break

    return {
        "org": item.get("organizationSlug") or "",
        "slug": item.get("competitionSlug") or "",
        "title": item.get("title") or "",
        "competitionStart": start,
        "competitionEnd": end,
        "hasStarted": has_started,
        "isRunning": is_running,
        "hasAccess": True if has_access is None else bool(has_access),
    }


def _serialize_task(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(item.get("id") or ""),
        "title": item.get("title") or "",
        "synopsis": item.get("synopsis") or "",
    }


def _normalize_task_data_category(category: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "_", str(category or "").strip().lower()).strip("_")
    aliases = {
        "prejudging": "pre_judging_script",
        "prejudgingscript": "pre_judging_script",
        "prejudging_script": "pre_judging_script",
        "pre_judging": "pre_judging_script",
        "pre_judge": "pre_judging_script",
        "pre_judge_script": "pre_judging_script",
        "starter_kit": "custom_archive",
    }
    normalized = aliases.get(normalized, normalized)
    if normalized == "pre_judging_script":
        return normalized
    return nitro_contests.normalize_task_file_category(normalized)


def _task_page_has_prejudging_script(cookies: tuple[str, str], org: str, comp: str, task_id: str) -> bool:
    status, body, _ = nitro_api.request_text(
        path=f"/competitions/{org}/{comp}/{task_id}/view",
        cookies=cookies,
        timeout=30,
    )
    if status != 200:
        return False
    text = body.lower()
    return "pre_judging_script/download" in text or "prejudging_script/download" in text


def _task_page_prejudging_href(
    cookies: tuple[str, str], org: str, comp: str, task_id: str
) -> str | None:
    status, body, _ = nitro_api.request_text(
        path=f"/competitions/{org}/{comp}/{task_id}/view",
        cookies=cookies,
        timeout=30,
    )
    if status != 200:
        return None

    match = re.search(
        r'href="([^"]*pre[_-]?judg(?:ing)?[_-]?script/download[^"]*)"',
        body,
        re.IGNORECASE,
    )
    if match:
        return match.group(1)

    match = re.search(
        r"href='([^']*pre[_-]?judg(?:ing)?[_-]?script/download[^']*)'",
        body,
        re.IGNORECASE,
    )
    if match:
        return match.group(1)

    return None


def _load_task_data_options(
    auth: dict[str, Any], org: str, comp: str, task_id: str
) -> list[dict[str, Any]]:
    items = nitro_contests.get_task_data_options(
        auth["cookies"], auth["bearer"], org, comp, task_id
    )
    if not any(item.get("category") == "pre_judging_script" for item in items):
        if _task_page_has_prejudging_script(auth["cookies"], org, comp, task_id):
            items.append(
                {
                    "category": "pre_judging_script",
                    "label": "Pre-judging script",
                    "available": True,
                }
            )
    return items


def _download_task_data(
    auth: dict[str, Any],
    org: str,
    comp: str,
    task_id: str,
    categories: list[str] | None,
    output_dir: str,
    force: bool,
) -> list[dict[str, Any]]:
    explicit_categories = categories is not None
    normalized_categories = (
        [_normalize_task_data_category(category) for category in categories] if categories else None
    )
    if normalized_categories is None:
        normalized_categories = [
            item["category"]
            for item in _load_task_data_options(auth, org, comp, task_id)
            if item.get("available")
        ]

    if not normalized_categories:
        raise RuntimeError("No downloadable task data files found")

    task_file_links = nitro_contests.load_task_file_links(
        auth["cookies"], org, comp, task_id
    )
    results: list[dict[str, Any]] = []
    for category in normalized_categories:
        if category == "statement":
            body = nitro_contests.task_statement_markdown(
                auth["cookies"], auth["bearer"], org, comp, task_id
            )
            headers: dict[str, str] = {}
        elif category == "pre_judging_script":
            href = _task_page_prejudging_href(auth["cookies"], org, comp, task_id)
            if not href:
                if not explicit_categories:
                    continue
                raise RuntimeError("Could not find a pre-judging script download link")
            status, body, headers = nitro_api.request(
                path=nitro_contests.request_path_from_href(href),
                cookies=auth["cookies"],
                timeout=180,
            )
            if status != 200 or nitro_contests.response_is_html(body, headers):
                if not explicit_categories:
                    continue
                preview = body.decode("utf-8", errors="replace")
                raise RuntimeError(
                    f"Could not download {category}: HTTP {status}: {preview[:200]}"
                )
        else:
            status, body, headers = nitro_contests.download_task_file(
                auth["cookies"],
                auth["bearer"],
                org,
                comp,
                task_id,
                category,
                task_file_links,
            )
            if status != 200 or nitro_contests.response_is_html(body, headers):
                if not explicit_categories:
                    continue
                preview = body.decode("utf-8", errors="replace")
                raise RuntimeError(
                    f"Could not download {category}: HTTP {status}: {preview[:200]}"
                )

        path = nitro_contests.write_task_file(
            body,
            headers,
            category,
            None,
            output_dir,
            force=force,
        )
        path = _expand_downloaded_archive(path, force=force)
        results.append({"category": category, "path": path, "bytes": len(body)})

    if not results:
        raise RuntimeError("No downloadable task data files found")
    return results


def _expand_downloaded_archive(path: str, *, force: bool) -> str:
    candidate = Path(path)
    if not candidate.is_file() or not zipfile.is_zipfile(candidate):
        return path

    target_dir = candidate.with_suffix("")
    if target_dir.exists():
        if not force:
            raise RuntimeError(f"Refusing to overwrite existing extracted folder: {target_dir}")
        if target_dir.is_dir():
            shutil.rmtree(target_dir)
        else:
            target_dir.unlink()

    target_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(candidate) as archive:
        archive.extractall(target_dir)
    candidate.unlink()

    for nested_zip in sorted(target_dir.rglob("*.zip")):
        if nested_zip.is_file() and zipfile.is_zipfile(nested_zip):
            _expand_nested_archive(nested_zip, force=force)

    return str(target_dir)


def _expand_nested_archive(path: Path, *, force: bool) -> None:
    target_dir = path.with_suffix("")
    if target_dir.exists():
        if not force:
            raise RuntimeError(f"Refusing to overwrite existing extracted folder: {target_dir}")
        if target_dir.is_dir():
            shutil.rmtree(target_dir)
        else:
            target_dir.unlink()

    target_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path) as archive:
        archive.extractall(target_dir)
    path.unlink()

    for nested_zip in sorted(target_dir.rglob("*.zip")):
        if nested_zip.is_file() and zipfile.is_zipfile(nested_zip):
            _expand_nested_archive(nested_zip, force=force)


def _serialize_submission(item: dict[str, Any]) -> dict[str, Any]:
    subtasks = item.get("subtasks") or []
    partial_scores = item.get("partialSubtaskScores") or [None] * len(subtasks)
    partial_metrics = item.get("partialSubtaskMetricValues") or [None] * len(subtasks)
    complete_scores = item.get("completeSubtaskScores") or [None] * len(subtasks)
    complete_metrics = item.get("completeSubtaskMetricValues") or [None] * len(subtasks)

    return {
        "id": item.get("id") or item.get("submissionID") or item.get("submissionId"),
        "state": item.get("state") or "unknown",
        "createdAt": item.get("createdAt")
        or item.get("creationTime")
        or item.get("created_at"),
        "partialScore": item.get("partialTaskScore"),
        "completeScore": item.get("completeTaskScore"),
        "prejudgingScriptOutput": item.get("prejudgingScriptOutput")
        or item.get("prejudgingOutput"),
        "subtasks": [
            {
                "id": subtask.get("id") or index + 1,
                "title": subtask.get("title") or f"Subtask {index + 1}",
                "metricName": subtask.get("metricName") or "metric",
                "maxScore": subtask.get("maximumScore") or subtask.get("maxScore"),
                "partialScore": partial_scores[index],
                "partialMetric": partial_metrics[index],
                "completeScore": complete_scores[index],
                "completeMetric": complete_metrics[index],
            }
            for index, subtask in enumerate(subtasks)
            if isinstance(subtask, dict)
        ],
    }


def _copy_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [dict(item) for item in items if isinstance(item, dict)]


def _is_force_enabled(value: str | None) -> bool:
    return str(value or "").lower() in {"1", "true", "yes", "on"}


def _auth_cache_key(auth: dict[str, Any]) -> str:
    state = auth.get("state") or {}
    return str(state.get("username") or auth.get("bearer") or "")


def _cache_get(
    cache: dict[Any, tuple[float, list[dict[str, Any]]]], key: Any
) -> list[dict[str, Any]] | None:
    now = time.monotonic()
    with _CACHE_LOCK:
        entry = cache.get(key)
        if not entry:
            return None
        created, items = entry
        if now - created > _CACHE_TTL_SECONDS:
            cache.pop(key, None)
            return None
        return _copy_items(items)


def _cache_set(
    cache: dict[Any, tuple[float, list[dict[str, Any]]]],
    key: Any,
    items: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    copied = _copy_items(items)
    with _CACHE_LOCK:
        cache[key] = (time.monotonic(), copied)
    return _copy_items(copied)


def _is_login_redirect_error(error: Exception) -> bool:
    message = str(error)
    return "SingleFetchRedirect" in message and '"/login"' in message


def _load_accessible_competitions(auth: dict[str, Any]) -> list[dict[str, Any]]:
    page = 1
    page_size = 100
    items: list[dict[str, Any]] = []

    while True:
        status, body, _ = nitro_api.api_request_text(
            path="/competitions",
            bearer=auth["bearer"],
            params={"page": page, "page_size": page_size},
        )
        if status != 200:
            if status in {401, 403}:
                raise tornado.web.HTTPError(401, "Nitro AI Judge login expired")
            break

        data = nitro_api.body_json(body)
        parsed = nitro_api.list_payload(data, "competitions", "items", "data")
        if parsed is None:
            if isinstance(data, list):
                return [
                    {**item, "_nitroHasAccess": True}
                    for item in data
                    if isinstance(item, dict)
                ]
            break

        items.extend(
            {**item, "_nitroHasAccess": True}
            for item in parsed
            if isinstance(item, dict)
        )
        last_page = nitro_api.int_payload(
            data,
            "lastPage",
            "last_page",
            "totalPages",
            "total_pages",
            default=page,
        )
        if page >= last_page:
            return items
        page += 1

    # Older deployments may not expose the access-scoped API endpoint.
    return [
        item
        for item in nitro_contests.load_competitions(
            auth["cookies"],
            auth["bearer"],
            page=None,
            page_size=100,
            featured=None,
            all_pages=True,
        )
        if isinstance(item, dict)
    ]


def _load_competitions_cached(auth: dict[str, Any], force: bool) -> list[dict[str, Any]]:
    key = _auth_cache_key(auth)
    if not force:
        cached = _cache_get(_CONTEST_CACHE, key)
        if cached is not None:
            return cached

    try:
        items = _load_accessible_competitions(auth)
    except RuntimeError as exc:
        if _is_login_redirect_error(exc):
            raise tornado.web.HTTPError(401, "Nitro AI Judge login expired") from exc
        raise
    return _cache_set(_CONTEST_CACHE, key, items)


def _load_tasks_cached(
    auth: dict[str, Any], org: str, comp: str, force: bool
) -> list[dict[str, Any]]:
    key = (_auth_cache_key(auth), org, comp)
    if not force:
        cached = _cache_get(_TASK_CACHE, key)
        if cached is not None:
            return cached

    try:
        items = nitro_contests.load_tasks(
            auth["cookies"], auth["bearer"], org, comp
        )
    except RuntimeError as exc:
        if _is_login_redirect_error(exc):
            raise tornado.web.HTTPError(401, "Nitro AI Judge login expired") from exc
        raise
    return _cache_set(_TASK_CACHE, key, items)


def _create_submission_through_proxy(
    bearer: str,
    task_id: str,
    output_path: str,
    source_path: str,
    note: str,
) -> dict[str, Any]:
    proxy_url = str(os.environ.get("NITRO_SUBMISSION_PROXY_URL") or "").strip()
    if not proxy_url:
        raise tornado.web.HTTPError(
            500, "NITRO_SUBMISSION_PROXY_URL is not configured"
        )

    payload: dict[str, Any] = {
        "outputPath": output_path,
        "sourceCodePath": source_path,
    }
    note = note.strip()
    if note:
        payload["note"] = note

    request = urllib.request.Request(
        f"{proxy_url.rstrip('/')}/task/{task_id}/submit",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {bearer}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            status = response.status
            body = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        status = exc.code
        body = exc.read().decode("utf-8", errors="replace")
    except urllib.error.URLError as exc:
        raise tornado.web.HTTPError(
            502, f"Nitro AI Judge submission proxy request failed: {exc.reason}"
        ) from exc

    parsed = nitro_api.body_json(body)

    if status not in {200, 201}:
        message = "Nitro AI Judge submission proxy failed"
        if isinstance(parsed, dict):
            message = parsed.get("error") or parsed.get("message") or message
            prejudging_output = parsed.get("prejudgingScriptOutput") or parsed.get(
                "prejudgingOutput"
            )
            if prejudging_output:
                message = f"{message}\n\nPre-judging output:\n{prejudging_output}"
        raise tornado.web.HTTPError(502, message)

    if not isinstance(parsed, dict):
        raise tornado.web.HTTPError(
            502, "Nitro AI Judge submission proxy returned an invalid response"
        )

    if "prejudgingScriptOutput" not in parsed and "prejudgingOutput" in parsed:
        parsed["prejudgingScriptOutput"] = parsed["prejudgingOutput"]

    return parsed


def _poll_submission_feedback(
    cookies: tuple[str, str],
    bearer: str,
    submission_id: str,
    org: str,
    comp: str,
    task_id: str,
) -> dict[str, Any]:
    return nitro_submissions.poll_submission_feedback(
        cookies,
        bearer,
        submission_id,
        org=org,
        comp=comp,
        task_id=task_id,
        interval=3,
        timeout=180,
    )


class NitroBaseHandler(APIHandler):
    @property
    def contents_manager(self) -> Any:
        return self.settings["contents_manager"]

    def write_json(self, payload: dict[str, Any]) -> None:
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(payload))


class StatusHandler(NitroBaseHandler):
    @tornado.web.authenticated
    async def get(self) -> None:
        try:
            auth = await asyncio.to_thread(_load_auth)
        except Exception:
            auth = {}
        logged_in = bool(auth.get("cookies") or auth.get("bearer"))

        self.write_json(
            {
                "loggedIn": logged_in,
                "username": (auth.get("state") or {}).get("username"),
                "tokenLogin": True,
                "authenticated": logged_in,
            }
        )


class LoginHandler(NitroBaseHandler):
    @tornado.web.authenticated
    async def post(self) -> None:
        data = self.get_json_body() or {}
        auth = await asyncio.to_thread(
            _login, data.get("username", ""), data.get("password", "")
        )
        self.write_json(
            {
                "loggedIn": True,
                "username": auth["state"].get("username"),
            }
        )


class ContestsHandler(NitroBaseHandler):
    @tornado.web.authenticated
    async def get(self) -> None:
        auth = await asyncio.to_thread(_load_auth)
        force = _is_force_enabled(self.get_argument("force", ""))
        items = await asyncio.to_thread(_load_competitions_cached, auth, force)
        self.write_json({"items": [_serialize_competition(item) for item in items]})


class TasksHandler(NitroBaseHandler):
    @tornado.web.authenticated
    async def get(self) -> None:
        org = self.get_argument("org", "").strip()
        comp = self.get_argument("comp", "").strip()
        if not org or not comp:
            raise tornado.web.HTTPError(400, "Missing org or comp")

        auth = await asyncio.to_thread(_load_auth)
        force = _is_force_enabled(self.get_argument("force", ""))
        items = await asyncio.to_thread(_load_tasks_cached, auth, org, comp, force)
        self.write_json({"items": [_serialize_task(item) for item in items]})


class TaskDataOptionsHandler(NitroBaseHandler):
    @tornado.web.authenticated
    async def get(self) -> None:
        org = self.get_argument("org", "").strip()
        comp = self.get_argument("comp", "").strip()
        task_id = str(self.get_argument("taskId", "")).strip()
        if not org or not comp or not task_id:
            raise tornado.web.HTTPError(400, "Missing org, comp, or task")

        auth = await asyncio.to_thread(_load_auth)
        items = await asyncio.to_thread(_load_task_data_options, auth, org, comp, task_id)
        self.write_json({"items": items})


class SubmitHandler(NitroBaseHandler):
    @tornado.web.authenticated
    async def post(self) -> None:
        data = self.get_json_body() or {}
        org = data.get("org", "").strip()
        comp = data.get("comp", "").strip()
        task_id = str(data.get("taskId", "")).strip()
        output_path = _string_field(data.get("outputPath", ""))
        source_path_raw = _string_field(data.get("sourcePath", ""))
        source_path = source_path_raw if source_path_raw else None
        source_content = data.get("sourceContent")
        if source_content is not None:
            source_content = str(source_content)
        source_filename = str(data.get("sourceFilename") or "notebook_export.py")
        source_mode = str(data.get("sourceMode") or "").strip().lower() or (
            "file" if source_path else "notebook"
        )
        submission_proxy = bool(data.get("submissionProxy", False))
        note = data.get("note", "")
        if note is None:
            note = ""
        note = str(note)

        if not org or not comp or not task_id or not output_path:
            raise tornado.web.HTTPError(
                400, "Contest, task, and output file are required"
            )
        if source_mode not in {"notebook", "file", "none"}:
            raise tornado.web.HTTPError(400, "Invalid source mode")
        if submission_proxy and (
            source_mode != "file" or not source_path or source_content is not None
        ):
            raise tornado.web.HTTPError(
                400, "Submission proxy requires a saved Python source file"
            )
        if submission_proxy and not source_path.lower().endswith(".py"):
            raise tornado.web.HTTPError(
                400, "Submission proxy requires a saved Python source file"
            )
        if source_mode == "file":
            if not source_path:
                raise tornado.web.HTTPError(400, "Source code is required")
            if not source_path.lower().endswith(".py"):
                raise tornado.web.HTTPError(400, "Source file must be a .py file")
        elif source_mode == "notebook" and source_content is None:
            raise tornado.web.HTTPError(400, "Source code is required")
        elif source_mode == "none" and submission_proxy:
            raise tornado.web.HTTPError(
                400, "Submission proxy requires a saved Python source file"
            )

        auth = await asyncio.to_thread(_load_auth)
        temp_source_path: str | None = None
        prejudging_output: Any = None

        try:
            if submission_proxy:
                submission = await asyncio.to_thread(
                    _create_submission_through_proxy,
                    auth["bearer"],
                    task_id,
                    output_path,
                    source_path or "",
                    note,
                )
                prejudging_output = submission.get(
                    "prejudgingScriptOutput"
                ) or submission.get("prejudgingOutput")
            else:
                output_fs_path = self.contents_manager._get_os_path(output_path)
                source_fs_path = None
                if source_mode == "file" and source_path:
                    source_fs_path = self.contents_manager._get_os_path(source_path)

                if source_mode == "notebook" and source_content is not None:
                    suffix = os.path.splitext(source_filename)[1] or ".py"
                    with tempfile.NamedTemporaryFile(
                        "w", suffix=suffix, delete=False, encoding="utf-8"
                    ) as handle:
                        handle.write(source_content)
                        temp_source_path = handle.name
                    source_fs_path = temp_source_path

                if source_mode != "none" and not source_fs_path:
                    raise tornado.web.HTTPError(400, "Source code is required")

                submission = await asyncio.to_thread(
                    nitro_submissions.create_submission,
                    auth["cookies"],
                    auth["bearer"],
                    org,
                    comp,
                    task_id,
                    output_fs_path,
                    source_fs_path,
                    note,
                )

            submission_id = submission.get("submissionID") or submission.get(
                "submissionId"
            ) or submission.get(
                "id"
            )
            if not submission_id:
                raise tornado.web.HTTPError(
                    500, "Nitro AI Judge did not return a submission ID"
                )

            feedback = await asyncio.to_thread(
                _poll_submission_feedback,
                auth["cookies"],
                auth["bearer"],
                submission_id,
                org,
                comp,
                task_id,
            )
            if prejudging_output and isinstance(feedback, dict):
                feedback["prejudgingScriptOutput"] = prejudging_output
        finally:
            if temp_source_path and os.path.exists(temp_source_path):
                os.unlink(temp_source_path)

        self.write_json(
            {
                "submission": _serialize_submission(feedback),
                "submissionCount": submission.get("submissionConsumptionIndex"),
            }
        )


class DownloadDataHandler(NitroBaseHandler):
    @tornado.web.authenticated
    async def post(self) -> None:
        data = self.get_json_body() or {}
        org = data.get("org", "").strip()
        comp = data.get("comp", "").strip()
        task_id = str(data.get("taskId", "")).strip()
        categories = data.get("categories")
        output_dir = _string_field(data.get("outputDir", ""))
        force = bool(data.get("force", False))

        if not org or not comp or not task_id:
            raise tornado.web.HTTPError(400, "Contest and task are required")
        if categories is not None and not isinstance(categories, list):
            raise tornado.web.HTTPError(400, "Categories must be a list")

        auth = await asyncio.to_thread(_load_auth)
        output_fs_dir = self.contents_manager._get_os_path(output_dir)

        try:
            downloads = await asyncio.to_thread(
                _download_task_data,
                auth,
                org,
                comp,
                task_id,
                categories,
                output_fs_dir,
                force,
            )
        except ValueError as exc:
            raise tornado.web.HTTPError(400, str(exc)) from exc
        except RuntimeError as exc:
            raise tornado.web.HTTPError(502, str(exc)) from exc

        api_paths = []
        for item in downloads:
            filename = os.path.basename(item["path"])
            api_paths.append(
                {
                    "category": item["category"],
                    "path": os.path.join(output_dir, filename) if output_dir else filename,
                    "bytes": item["bytes"],
                }
            )

        self.write_json({"items": api_paths})


def setup_handlers(web_app: Any) -> None:
    base_url = web_app.settings["base_url"]
    handlers = [
        (url_path_join(base_url, "nitro-ai-judge", "status"), StatusHandler),
        (url_path_join(base_url, "nitro-ai-judge", "login"), LoginHandler),
        (url_path_join(base_url, "nitro-ai-judge", "contests"), ContestsHandler),
        (url_path_join(base_url, "nitro-ai-judge", "tasks"), TasksHandler),
        (url_path_join(base_url, "nitro-ai-judge", "task-data-options"), TaskDataOptionsHandler),
        (url_path_join(base_url, "nitro-ai-judge", "download-data"), DownloadDataHandler),
        (url_path_join(base_url, "nitro-ai-judge", "submit"), SubmitHandler),
    ]
    web_app.add_handlers(".*$", handlers)
