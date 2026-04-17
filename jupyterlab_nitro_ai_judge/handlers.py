from __future__ import annotations

import asyncio
from functools import partial
import os
import tempfile
from typing import Any

import tornado.web
from jupyter_server.base.handlers import APIHandler
from jupyter_server.utils import url_path_join

import nitro_cli


def _serialize_competition(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "org": item.get("organizationSlug") or "",
        "slug": item.get("competitionSlug") or "",
        "title": item.get("title") or "",
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
        "partialScore": item.get("partialTaskScore"),
        "completeScore": item.get("completeTaskScore"),
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


def _load_auth(validate: bool = True) -> dict[str, Any]:
    state = nitro_cli.load_state()
    if not state:
        raise tornado.web.HTTPError(401, "Nitro AI Judge login required")

    auth = nitro_cli.get_auth(state)
    if not auth:
        raise tornado.web.HTTPError(401, "Nitro AI Judge session cookies are missing")

    cookies = (auth[0], auth[1])
    if validate and not nitro_cli.test_session(cookies[0], cookies[1]):
        raise tornado.web.HTTPError(401, "Nitro AI Judge session expired")

    return {"state": state, "cookies": cookies, "bearer": auth[2]}


def _login(username: str, password: str) -> dict[str, Any]:
    username = username.strip()
    if not username or not password:
        raise tornado.web.HTTPError(400, "Username and password are required")

    saved_cf, existing_session = nitro_cli.get_saved_login_cookies()
    cf = saved_cf

    if cf and existing_session and nitro_cli.test_session(cf, existing_session):
        nitro_cli.save_state(cf, existing_session, username)
        return _load_auth(validate=False)

    if not cf:
        try:
            cf = nitro_cli.fetch_cf_clearance()
        except Exception as exc:  # pragma: no cover - external runtime behavior
            raise tornado.web.HTTPError(
                500, f"Could not obtain Cloudflare clearance: {exc}"
            ) from exc

    result = nitro_cli.do_login(username, password, cf)
    if result.get("http_code") == 403:
        try:
            cf = nitro_cli.fetch_cf_clearance()
        except Exception as exc:  # pragma: no cover - external runtime behavior
            raise tornado.web.HTTPError(
                500, f"Could not refresh Cloudflare clearance: {exc}"
            ) from exc
        result = nitro_cli.do_login(username, password, cf)

    if not result.get("success") or not result.get("session_cookie"):
        raise tornado.web.HTTPError(
            401, result.get("error") or "Nitro AI Judge login failed"
        )

    decoded = nitro_cli.decode_session(result["session_cookie"]) or {}
    nitro_cli.save_state(
        cf, result["session_cookie"], decoded.get("username") or username
    )
    return _load_auth(validate=False)


class NitroBaseHandler(APIHandler):
    def write_json(self, payload: dict[str, Any], status: int = 200) -> None:
        self.set_status(status)
        self.set_header("Content-Type", "application/json")
        self.finish(payload)


class StatusHandler(NitroBaseHandler):
    @tornado.web.authenticated
    async def get(self) -> None:
        try:
            auth = await asyncio.to_thread(_load_auth)
        except tornado.web.HTTPError:
            self.write_json({"loggedIn": False, "username": None})
            return

        self.write_json(
            {
                "loggedIn": True,
                "username": auth["state"].get("username"),
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
        items = await asyncio.to_thread(
            partial(
                nitro_cli.load_competitions,
                auth["cookies"],
                page=None,
                page_size=100,
                featured=None,
                all_pages=True,
            )
        )
        self.write_json({"items": [_serialize_competition(item) for item in items]})


class TasksHandler(NitroBaseHandler):
    @tornado.web.authenticated
    async def get(self) -> None:
        org = self.get_argument("org", "").strip()
        comp = self.get_argument("comp", "").strip()
        if not org or not comp:
            raise tornado.web.HTTPError(400, "Missing org or comp")

        auth = await asyncio.to_thread(_load_auth)
        items = await asyncio.to_thread(
            nitro_cli.load_tasks, auth["cookies"], auth["bearer"], org, comp
        )
        self.write_json({"items": [_serialize_task(item) for item in items]})


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
        note = data.get("note", "")

        if not org or not comp or not task_id or not output_path:
            raise tornado.web.HTTPError(
                400, "Contest, task, and output CSV are required"
            )

        auth = await asyncio.to_thread(_load_auth)
        temp_source_path: str | None = None
        output_fs_path = self.contents_manager._get_os_path(output_path)
        source_fs_path = (
            self.contents_manager._get_os_path(source_path) if source_path else None
        )

        try:
            if source_content is not None:
                suffix = os.path.splitext(source_filename)[1] or ".py"
                with tempfile.NamedTemporaryFile(
                    "w", suffix=suffix, delete=False, encoding="utf-8"
                ) as handle:
                    handle.write(source_content)
                    temp_source_path = handle.name
                source_fs_path = temp_source_path

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
            )
            if not submission_id:
                raise tornado.web.HTTPError(
                    500, "Nitro AI Judge did not return a submission ID"
                )

            feedback = await asyncio.to_thread(
                partial(
                    nitro_cli.poll_submission_feedback,
                    auth["cookies"],
                    auth["bearer"],
                    submission_id,
                    org=org,
                    comp=comp,
                    task_id=task_id,
                    interval=3,
                    timeout=180,
                )
            )
        finally:
            if temp_source_path and os.path.exists(temp_source_path):
                os.unlink(temp_source_path)

        self.write_json(
            {
                "submission": _serialize_submission(feedback),
                "submissionCount": submission.get("submissionConsumptionIndex"),
            }
        )


def setup_handlers(web_app: Any) -> None:
    base_url = web_app.settings["base_url"]
    handlers = [
        (url_path_join(base_url, "nitro-ai-judge", "status"), StatusHandler),
        (url_path_join(base_url, "nitro-ai-judge", "login"), LoginHandler),
        (url_path_join(base_url, "nitro-ai-judge", "contests"), ContestsHandler),
        (url_path_join(base_url, "nitro-ai-judge", "tasks"), TasksHandler),
        (url_path_join(base_url, "nitro-ai-judge", "submit"), SubmitHandler),
    ]
    web_app.add_handlers(".*$", handlers)
