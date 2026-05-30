from __future__ import annotations

import asyncio
import inspect
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any

import tornado.web
from jupyter_server.base.handlers import APIHandler
from jupyter_server.utils import url_path_join

import nitro_cli


_PLAYWRIGHT_READY = False
_CACHE_TTL_SECONDS = 300.0
_CACHE_LOCK = threading.Lock()
_CONTEST_CACHE: dict[Any, tuple[float, list[dict[str, Any]]]] = {}
_TASK_CACHE: dict[Any, tuple[float, list[dict[str, Any]]]] = {}


def _nitro_cli_uses_token_login() -> bool:
    try:
        return len(inspect.signature(nitro_cli.do_login).parameters) == 2
    except (TypeError, ValueError):
        return hasattr(nitro_cli, "save_token_state")


def _ensure_playwright_browser() -> None:
    global _PLAYWRIGHT_READY
    if _PLAYWRIGHT_READY:
        return

    command = [sys.executable, "-m", "playwright", "install", "chromium"]
    subprocess.run(command, check=True)
    _PLAYWRIGHT_READY = True


def _serialize_competition(item: dict[str, Any]) -> dict[str, Any]:
    raw_start = item.get("competitionStart")
    start = raw_start
    if isinstance(raw_start, str):
        try:
            start = int(raw_start)
        except ValueError:
            start = raw_start

    has_started = True
    if isinstance(start, (int, float)):
        has_started = start <= int(time.time() * 1000)

    return {
        "org": item.get("organizationSlug") or "",
        "slug": item.get("competitionSlug") or "",
        "title": item.get("title") or "",
        "competitionStart": start,
        "hasStarted": has_started,
    }


def _serialize_task(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(item.get("id") or ""),
        "title": item.get("title") or "",
        "synopsis": item.get("synopsis") or "",
    }


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


def _load_competitions_cached(auth: dict[str, Any], force: bool) -> list[dict[str, Any]]:
    key = _auth_cache_key(auth)
    if not force:
        cached = _cache_get(_CONTEST_CACHE, key)
        if cached is not None:
            return cached

    items = nitro_cli.load_competitions(
        auth["cookies"],
        auth["bearer"],
        page=None,
        page_size=100,
        featured=None,
        all_pages=True,
    )
    return _cache_set(_CONTEST_CACHE, key, items)


def _load_tasks_cached(
    auth: dict[str, Any], org: str, comp: str, force: bool
) -> list[dict[str, Any]]:
    key = (_auth_cache_key(auth), org, comp)
    if not force:
        cached = _cache_get(_TASK_CACHE, key)
        if cached is not None:
            return cached

    items = nitro_cli.load_tasks(auth["cookies"], auth["bearer"], org, comp)
    return _cache_set(_TASK_CACHE, key, items)


def _load_submission_history(
    cookies: tuple[str, str],
    bearer: str,
    org: str,
    comp: str,
    task_id: str,
) -> list[dict[str, Any]]:
    items, _ = nitro_cli.load_submissions(
        cookies,
        bearer,
        org,
        comp,
        task_id,
        author=None,
        page=1,
        page_size=100,
        mode="partial",
    )
    return [item for item in items if isinstance(item, dict)]


def _create_submission_through_proxy(
    bearer: str,
    task_id: str,
    output_path: str,
    source_path: str,
    note: str,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "outputPath": output_path,
        "sourceCodePath": source_path,
    }
    note = note.strip()
    if note:
        payload["note"] = note

    status, body, _ = nitro_cli.api_request_text(
        path=f"/task/{task_id}/submit",
        bearer=bearer,
        method="POST",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    parsed = nitro_cli.body_json(body)

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
    return nitro_cli.poll_submission_feedback(
        cookies,
        bearer,
        submission_id,
        org=org,
        comp=comp,
        task_id=task_id,
        interval=3,
        timeout=180,
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
        items = await asyncio.to_thread(
            nitro_cli.get_task_data_options,
            auth["cookies"],
            auth["bearer"],
            org,
            comp,
            task_id,
        )
        self.write_json({"items": items})


class SubmissionHistoryHandler(NitroBaseHandler):
    @tornado.web.authenticated
    async def get(self) -> None:
        org = self.get_argument("org", "").strip()
        comp = self.get_argument("comp", "").strip()
        task_id = str(self.get_argument("taskId", "")).strip()
        if not org or not comp or not task_id:
            raise tornado.web.HTTPError(400, "Missing org, comp, or task")

        auth = await asyncio.to_thread(_load_auth)
        items = await asyncio.to_thread(
            _load_submission_history,
            auth["cookies"],
            auth["bearer"],
            org,
            comp,
            task_id,
        )
        submissions = [_serialize_submission(item) for item in items]
        self.write_json({"items": submissions, "count": len(submissions)})


class SubmitHandler(NitroBaseHandler):
    @tornado.web.authenticated
    async def post(self) -> None:
        data = self.get_json_body() or {}
        org = data.get("org", "").strip()
        comp = data.get("comp", "").strip()
        task_id = str(data.get("taskId", "")).strip()
        output_path = data.get("outputPath", "").strip()
        source_path = data.get("sourcePath", "").strip() or None
        source_content = data.get("sourceContent")
        source_filename = data.get("sourceFilename", "notebook_export.py")
        submission_proxy = bool(data.get("submissionProxy", False))
        note = data.get("note", "")
        if note is None:
            note = ""
        note = str(note)

        if not org or not comp or not task_id or not output_path:
            raise tornado.web.HTTPError(
                400, "Contest, task, and output file are required"
            )
        if submission_proxy and (not source_path or source_content is not None):
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
                source_fs_path = (
                    self.contents_manager._get_os_path(source_path)
                    if source_path
                    else None
                )

                if source_content is not None:
                    suffix = os.path.splitext(source_filename)[1] or ".py"
                    with tempfile.NamedTemporaryFile(
                        "w", suffix=suffix, delete=False, encoding="utf-8"
                    ) as handle:
                        handle.write(source_content)
                        temp_source_path = handle.name
                    source_fs_path = temp_source_path

                if not source_fs_path:
                    raise tornado.web.HTTPError(400, "Source code is required")

                submission = await asyncio.to_thread(
                    nitro_cli.create_submission,
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
        output_dir = data.get("outputDir", "").strip()
        force = bool(data.get("force", False))

        if not org or not comp or not task_id:
            raise tornado.web.HTTPError(400, "Contest and task are required")
        if categories is not None and not isinstance(categories, list):
            raise tornado.web.HTTPError(400, "Categories must be a list")

        auth = await asyncio.to_thread(_load_auth)
        output_fs_dir = self.contents_manager._get_os_path(output_dir)

        try:
            downloads = await asyncio.to_thread(
                nitro_cli.download_task_data,
                auth["cookies"],
                auth["bearer"],
                org,
                comp,
                task_id,
                categories=categories,
                output_dir=output_fs_dir,
                force=force,
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
        (url_path_join(base_url, "nitro-ai-judge", "submission-history"), SubmissionHistoryHandler),
        (url_path_join(base_url, "nitro-ai-judge", "download-data"), DownloadDataHandler),
        (url_path_join(base_url, "nitro-ai-judge", "submit"), SubmitHandler),
    ]
    web_app.add_handlers(".*$", handlers)
