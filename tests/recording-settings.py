"""Real filesystem preferences: restart, invalid writes and explicit sampling opt-in."""
import copy
import json
import pathlib
import sys
import tempfile
root = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'tools'))
from recording_settings import DEFAULTS, read_settings, write_settings

with tempfile.TemporaryDirectory() as directory:
    path = pathlib.Path(directory) / 'isaac-doctor.settings.json'
    assert read_settings(path) is None
    value = {'version': 1, 'recording': copy.deepcopy(DEFAULTS)}
    assert not value['recording']['channels'] & 8192
    value['recording'].update(channels=12288, seconds=6, stopOn='manual', screenshots=False,
                              startDelayMs=123, maxDurationMs=15000,
                              selectedMods=['Mod 日本語'], selectedHooks=['MC_POST_RENDER'])
    write_settings(path, value)
    original = path.read_bytes()
    assert read_settings(path) == value
    assert b'\n  "recording"' in original and b'\n    "seconds"' in original
    for key, bad in [('channels', 16384), ('channels', True), ('startOn', []),
                     ('stopOn', 'immediate'), ('minimumUs', -1), ('maxDurationMs', 999),
                     ('screenshots', 1), ('selectedMods', ['bad\nname'])]:
        invalid = copy.deepcopy(value)
        invalid['recording'][key] = bad
        try:
            write_settings(path, invalid)
            raise AssertionError(f'Accepted invalid {key}')
        except ValueError:
            pass
        assert path.read_bytes() == original, 'Invalid write replaced working settings'
    assert len(list(path.parent.iterdir())) == 1, 'Temporary files were left behind'
    path.write_text('{bad', encoding='utf8')
    try:
        read_settings(path)
        raise AssertionError('Accepted corrupt JSON')
    except ValueError:
        pass
    assert path.read_text() == '{bad'
print('PASS: readable atomic JSON, default sampler off, exact Unicode/scope/preferences restored, invalid saves preserve file, corrupt JSON not overwritten')
