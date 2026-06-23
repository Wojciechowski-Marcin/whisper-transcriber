from app.subtitles import to_srt, to_text, to_vtt

SEGMENTS = [
    {"start": 0.0, "end": 2.5, "text": " Hello world "},
    {"start": 2.5, "end": 3661.25, "text": "Way later"},
]

SPEAKER_SEGMENTS = [
    {"start": 0.0, "end": 1.0, "text": "Hi", "speaker": "Speaker 1"},
    {"start": 1.0, "end": 2.0, "text": "there", "speaker": "Speaker 1"},
    {"start": 2.0, "end": 3.0, "text": "Hello", "speaker": "Speaker 2"},
]


def test_srt_format():
    out = to_srt(SEGMENTS)
    lines = out.splitlines()
    assert lines[0] == "1"
    assert lines[1] == "00:00:00,000 --> 00:00:02,500"
    assert lines[2] == "Hello world"
    assert lines[3] == ""
    assert lines[4] == "2"
    # 3661.25s -> 01:01:01,250
    assert lines[5] == "00:00:02,500 --> 01:01:01,250"
    assert lines[6] == "Way later"


def test_vtt_format():
    out = to_vtt(SEGMENTS)
    assert out.startswith("WEBVTT\n\n")
    assert "00:00:00.000 --> 00:00:02.500" in out
    assert "01:01:01.250" in out  # VTT uses a dot separator
    assert "Hello world" in out


def test_empty_segments():
    assert to_srt([]) == ""
    assert to_vtt([]).strip() == "WEBVTT"


def test_srt_with_speakers():
    out = to_srt(SPEAKER_SEGMENTS)
    assert "Speaker 1: Hi" in out
    assert "Speaker 2: Hello" in out


def test_vtt_with_speakers():
    out = to_vtt(SPEAKER_SEGMENTS)
    assert "<v Speaker 1>Hi" in out
    assert "<v Speaker 2>Hello" in out


def test_text_groups_speaker_turns():
    out = to_text(SPEAKER_SEGMENTS, fallback="ignored")
    # Consecutive same-speaker segments merge into one turn.
    assert "Speaker 1: Hi there" in out
    assert "Speaker 2: Hello" in out
    assert "ignored" not in out


def test_text_falls_back_without_speakers():
    assert to_text(SEGMENTS, fallback="plain transcript") == "plain transcript"
