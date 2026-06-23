import httpx
import pytest

from app.config import Settings
from app.transcribe import ConversionError, _parse_response, convert_to_wav, transcribe_upload


def test_parse_verbose_json_with_segments():
    payload = {
        "text": "hello there",
        "language": "en",
        "duration": 3.2,
        "segments": [
            {"start": 0.0, "end": 1.5, "text": "hello"},
            {"start": 1.5, "end": 3.2, "text": "there"},
        ],
    }
    result = _parse_response(payload)
    assert result.has_segments
    assert result.language == "en"
    assert result.duration == 3.2
    assert len(result.segments) == 2


def test_parse_text_only_fallback():
    result = _parse_response({"text": "just text"})
    assert not result.has_segments
    assert result.text == "just text"


def test_parse_speakers():
    payload = {
        "text": "hi there",
        "segments": [
            {"start": 0.0, "end": 1.0, "text": "hi", "speaker": "Speaker 1"},
            {"start": 1.0, "end": 2.0, "text": "there", "speaker": "Speaker 2"},
        ],
    }
    result = _parse_response(payload)
    assert result.has_segments
    assert result.has_speakers
    assert result.segments[0]["speaker"] == "Speaker 1"


def test_parse_no_speakers_when_absent():
    payload = {"segments": [{"start": 0.0, "end": 1.0, "text": "hi"}]}
    result = _parse_response(payload)
    assert result.has_segments
    assert not result.has_speakers


def test_parse_plain_string():
    result = _parse_response("raw text body")
    assert result.text == "raw text body"
    assert not result.has_segments


@pytest.mark.asyncio
async def test_convert_raises_when_ffmpeg_missing(monkeypatch):
    async def boom(*args, **kwargs):
        raise FileNotFoundError("ffmpeg")

    monkeypatch.setattr("app.transcribe.asyncio.create_subprocess_exec", boom)
    with pytest.raises(ConversionError):
        await convert_to_wav("/nonexistent.mp4")


@pytest.mark.asyncio
async def test_transcribe_upload_mocks_ffmpeg_and_upstream(monkeypatch):
    async def fake_convert(input_path: str, on_progress=None):
        # pretend ffmpeg produced a wav
        import tempfile, os
        fd, path = tempfile.mkstemp(suffix=".wav")
        os.write(fd, b"RIFFfakewav")
        os.close(fd)
        return path, 1.0

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "text": "mocked transcript",
                "language": "en",
                "duration": 1.0,
                "segments": [{"start": 0.0, "end": 1.0, "text": "mocked transcript"}],
            },
        )

    monkeypatch.setattr("app.transcribe.convert_to_wav", fake_convert)
    transport = httpx.MockTransport(handler)

    real_client = httpx.AsyncClient

    def client_factory(*args, **kwargs):
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    monkeypatch.setattr("app.transcribe.httpx.AsyncClient", client_factory)

    settings = Settings(whisper_api_url="http://upstream/v1/audio/transcriptions")
    result = await transcribe_upload(
        data=b"fake-media-bytes", filename="clip.mp4", settings=settings
    )
    assert result.text == "mocked transcript"
    assert result.has_segments
