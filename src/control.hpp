#pragma once
#include <windows.h>
#include <string>

namespace ip {
constexpr LONG protocol = 9;
enum Channel : LONG { callbacks = 1, timeline = 2, renderFrames = 4, updateFrames = 8, counters = 16, heap = 32, context = 64, markers = 128, overhead = 256, errors = 512, sources = 1024 };
constexpr LONG allChannels = 2047;
enum Trigger : LONG { immediate, run_load, room_entry, level_entry, projectile, tear, effect, npc, damage, run_end, game_exit, duration, manual };
inline constexpr const char* triggerNames[] = {"immediate","run-load","room-entry","level-entry","projectile","tear","effect","npc","damage","run-end","game-exit","duration","manual"};
enum Command : LONG { none = 0, start = 1, stop = 2, catalog = 3 };
enum State : LONG { loading = 0, waiting_lua = 1, ready = 2, recording = 3, failed = 4, armed = 5 };
// Only LONG fields are shared atomically. Strings are read after acknowledgement.
struct Control {
    LONG version;
    volatile LONG state;
    volatile LONG command;
    volatile LONG seconds;
    volatile LONG request;
    volatile LONG acknowledged;
    volatile LONG wrapped;
    volatile LONG trace;
    volatile LONG eventLimit;
    volatile LONG minimumUs;
    volatile LONG afterLoad;
    volatile LONG screenshots;
    volatile LONG screenshotMs;
    volatile LONG startTrigger;
    volatile LONG stopTrigger;
    volatile LONG startDelayMs;
    volatile LONG stopDelayMs;
    volatile LONG availableTriggers;
    volatile LONG channels;
    volatile LONG maxDurationMs;
    char selectedMods[4096];
    char selectedHooks[4096];
    char catalogJson[131072];
    char message[512];
    wchar_t report[MAX_PATH * 4];
    char commandError[512];
};
inline std::wstring mapping_name(DWORD pid) { return L"Local\\IsaacProf-" + std::to_wstring(pid); }
inline LONG read(volatile LONG* value) { return InterlockedCompareExchange(value, 0, 0); }
}
