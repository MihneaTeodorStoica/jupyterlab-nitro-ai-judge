from __future__ import annotations

import json
import types
import zipfile
from pathlib import Path

import pytest

import jupyterlab_nitro_ai_judge.handlers as handlers


def test_load_auth_recovers_from_trailing_state_data(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    state = {
        "cookies": [{"name": "Cookie", "value": "sess"}],
        "access_token": "tok",
        "username": "u",
    }
    state_file = tmp_path / "state.json"
    state_file.write_text(json.dumps(state) + "\nTRAILING", encoding="utf-8")

    fake_cli = types.SimpleNamespace(
        load_state=lambda: (_ for _ in ()).throw(json.JSONDecodeError("extra", "x", 1)),
        get_auth=lambda loaded: ("cf", "sess", "tok") if loaded == state else None,
        ensure_fresh_state=lambda loaded: loaded,
        token_is_expired=lambda *args, **kwargs: False,
        refresh_saved_tokens=None,
        STATE_FILE=str(state_file),
    )
    monkeypatch.setattr(handlers, "nitro_cli", fake_cli)

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
