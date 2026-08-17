from backend.updates import is_newer, parse_version


def test_parse_version():
    assert parse_version("v1.2.3") == (1, 2, 3)
    assert parse_version("1.0.0") == (1, 0, 0)
    assert is_newer("1.1.0", "1.0.0")
    assert is_newer("v2.0.0", "1.9.9")
    assert not is_newer("1.0.0", "1.0.0")
    assert not is_newer("1.0.0", "1.1.0")
