"""Portable capture preferences; never contains browser directory handles."""
import json
import os
import pathlib
import tempfile

DEFAULTS = dict(seconds=25, screenshots=True, screenshotMs=500, minimumUs=0,
                startOn='run-load', stopOn='duration', startDelayMs=0,
                stopDelayMs=0, maxDurationMs=0, channels=8191,
                selectedMods=[], selectedHooks=[])
TRIGGERS = {'immediate', 'run-load', 'room-entry', 'level-entry', 'projectile',
            'tear', 'effect', 'npc', 'damage', 'run-end', 'game-exit', 'duration', 'manual'}


def validate_settings(value):
    if not isinstance(value, dict) or type(value.get('version')) is not int or value.get('version') != 1 or not isinstance(value.get('recording'), dict):
        raise ValueError('Unsupported recording settings format')
    recording = value['recording']
    if set(recording) != set(DEFAULTS):
        raise ValueError('Recording settings contain missing or unknown fields')
    for key, lower, upper in [('seconds', 1, 3600), ('screenshotMs', 250, 10000),
                              ('minimumUs', 0, 1000000), ('channels', 0, 16383),
                              ('startDelayMs', 0, 3600000), ('stopDelayMs', 0, 3600000),
                              ('maxDurationMs', 0, 3600000)]:
        if type(recording[key]) is not int or not lower <= recording[key] <= upper:
            raise ValueError(f'Invalid recording setting: {key}')
    if recording['maxDurationMs'] % 1000 or type(recording['screenshots']) is not bool:
        raise ValueError('Invalid maximum duration or screenshot setting')
    if not isinstance(recording['startOn'], str) or not isinstance(recording['stopOn'], str) or recording['startOn'] not in TRIGGERS - {'duration', 'manual'} or recording['stopOn'] not in TRIGGERS - {'immediate'}:
        raise ValueError('Invalid recording trigger')
    for key in ['selectedMods', 'selectedHooks']:
        names = recording[key]
        if not isinstance(names, list) or len(names) > 128 or any(not isinstance(name, str) or not name or any(c in name for c in '\r\n\0') for name in names):
            raise ValueError(f'Invalid {key}')
        if sum(len(name.encode('utf8')) + 1 for name in names) >= 4096:
            raise ValueError(f'{key} exceeds 4095 UTF-8 bytes')
    return {'version': 1, 'recording': dict(recording)}


def read_settings(path):
    path = pathlib.Path(path)
    if not path.exists():
        return None
    if path.stat().st_size > 65536:
        raise ValueError('Recording settings file exceeds 64 KiB')
    return validate_settings(json.loads(path.read_text(encoding='utf-8')))


def write_settings(path, value):
    validated = validate_settings(value)
    path = pathlib.Path(path)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent,
                                         prefix=path.name + '.', suffix='.tmp', delete=False) as handle:
            temporary = pathlib.Path(handle.name)
            json.dump(validated, handle, indent=2, ensure_ascii=False)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()
    return validated
