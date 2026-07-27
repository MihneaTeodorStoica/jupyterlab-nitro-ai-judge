from __future__ import annotations

import json
import urllib.request
import zipfile
from pathlib import Path

import pytest
import jupyterlab_nitro_ai_judge.handlers as handlers


def test_load_auth_uses_naij_state_api(monkeypatch: pytest.MonkeyPatch) -> None:
    state = {
        "cookies": [{"name": "Cookie", "value": "sess"}],
        "access_token": "tok",
        "username": "u",
    }
    monkeypatch.setattr(handlers.nitro_state, "load_state", lambda: state)
    monkeypatch.setattr(handlers.nitro_api, "ensure_fresh_state", lambda loaded: loaded)
    monkeypatch.setattr(
        handlers.nitro_api,
        "get_auth",
        lambda loaded: ("cf", "sess", "tok") if loaded == state else None,
    )

    auth = handlers._load_auth()

    assert auth["bearer"] == "tok"
    assert auth["cookies"] == ("cf", "sess")
    assert auth["state"] == state


def test_expand_downloaded_archive_unzips_and_removes_zip(tmp_path: Path) -> None:
    inner_payload = tmp_path / "payload.txt"
    inner_payload.write_text("hello", encoding="utf-8")

    inner_zip = tmp_path / "inner.zip"
    with zipfile.ZipFile(inner_zip, "w") as archive:
        archive.write(inner_payload, arcname="payload.txt")

    outer_zip = tmp_path / "outer.zip"
    with zipfile.ZipFile(outer_zip, "w") as archive:
        archive.write(inner_zip, arcname="inner.zip")

    extracted = handlers._expand_downloaded_archive(str(outer_zip), force=True)

    assert extracted == str(tmp_path / "outer")
    assert not outer_zip.exists()
    assert not (tmp_path / "outer.zip").exists()
    assert not (tmp_path / "outer" / "inner.zip").exists()
    assert (tmp_path / "outer" / "inner" / "payload.txt").read_text(encoding="utf-8") == "hello"


def test_create_submission_through_proxy_uses_proxy_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[urllib.request.Request] = []

    class FakeResponse:
        status = 201

        def __enter__(self) -> "FakeResponse":
            return self

        def __exit__(self, exc_type, exc, tb) -> None:
            return None

        def read(self) -> bytes:
            return b'{"submissionID":"sub-1"}'

    def fake_urlopen(request: urllib.request.Request, timeout: int) -> FakeResponse:
        requests.append(request)
        assert timeout == 120
        return FakeResponse()

    monkeypatch.setenv("NITRO_SUBMISSION_PROXY_URL", "http://127.0.0.1:9000/")
    monkeypatch.setattr(handlers.urllib.request, "urlopen", fake_urlopen)

    submission = handlers._create_submission_through_proxy(
        "token",
        "42",
        "outputs/sample.csv",
        "src/solution.py",
        "note",
    )

    assert submission["submissionID"] == "sub-1"
    assert requests[0].full_url == "http://127.0.0.1:9000/task/42/submit"
    assert requests[0].get_method() == "POST"
    assert requests[0].headers["Authorization"] == "Bearer token"
    assert json.loads(requests[0].data.decode("utf-8")) == {
        "outputPath": "outputs/sample.csv",
        "sourceCodePath": "src/solution.py",
        "note": "note",
    }


def test_download_data_handler_preserves_output_dir_spaces(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recorded: dict[str, object] = {}

    async def fake_to_thread(func, *args):
        if func is handlers._load_auth:
            return {"bearer": "tok", "cookies": ("", "")}
        if func is handlers._download_task_data:
            recorded["output_dir"] = args[5]
            return [{"category": "statement", "path": args[5], "bytes": 1}]
        raise AssertionError(func)

    class DummyContentsManager:
        def _get_os_path(self, path: str) -> str:
            recorded["requested_path"] = path
            return f"/workspace/{path}"

    class DummyHandler:
        settings = {"contents_manager": DummyContentsManager()}
        contents_manager = settings["contents_manager"]

        def get_json_body(self) -> dict[str, object]:
            return {
                "org": "org",
                "comp": "comp",
                "taskId": "1",
                "categories": ["statement"],
                "outputDir": "Fake it until you make it ",
                "force": True,
            }

        def write_json(self, payload: dict[str, object]) -> None:
            recorded["payload"] = payload

    monkeypatch.setattr(handlers.asyncio, "to_thread", fake_to_thread)

    import asyncio

    asyncio.run(handlers.DownloadDataHandler.post.__wrapped__(DummyHandler()))

    assert recorded["requested_path"] == "Fake it until you make it "
    assert recorded["output_dir"] == "/workspace/Fake it until you make it "
    assert recorded["payload"] == {
        "items": [
            {
                "category": "statement",
                "path": "Fake it until you make it /Fake it until you make it ",
                "bytes": 1,
            }
        ]
    }
