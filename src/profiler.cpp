#include "control.hpp"
#include "lua_api.hpp"
#include "native_waits.hpp"
#include "instruction_samples.hpp"
#include "bootstrap.hpp"
#include "binary.hpp"
#include "screenshots.hpp"
#include "stream.hpp"
#include "session_info.hpp"
#include <set>
#include <MinHook.h>
#include <objbase.h>
#include <psapi.h>
#include <atomic>
#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <vector>
#include <sstream>
#include <iomanip>

namespace {
LuaApi api;
HMODULE selfModule = nullptr;
ip::Control* control = nullptr;
std::atomic<lua_State*> mainState{nullptr};
std::atomic<DWORD> luaThread{0};
std::atomic<bool> active{false};
std::atomic<LONG> channels{ip::defaultChannels};
std::set<std::string> selectedMods, selectedHooks;
std::set<unsigned> sampledMetricIds; // Recorder-worker ownership only.
bool enabled(ip::Channel channel) { return (channels.load(std::memory_order_relaxed) & channel) != 0; }
std::set<std::string> readScope(const char* value, size_t capacity) {
    const auto length = strnlen_s(value, capacity);
    if (length == capacity) throw std::runtime_error("Invalid capture scope.");
    std::set<std::string> result; std::istringstream input(std::string(value, length)); std::string name;
    while (std::getline(input, name)) { if (!name.empty()) result.insert(name); }
    if (result.size() > 128) throw std::runtime_error("Scope exceeds 128 names.");
    return result;
}

std::atomic<bool> hooksReady{false};
std::atomic<bool> pendingStart{false}, lifecycleAvailable{false};
std::atomic<LONG> startTrigger{ip::immediate}, stopTrigger{ip::duration};
std::atomic<long long> startDeadline{0}, stopDeadline{0}, startDelayTicks{0}, stopDelayTicks{0}, durationTicks{0};
std::atomic<long long> maxDurationTicks{0}, captureDeadline{0};
std::atomic<unsigned long long> skippedCoroutines{0}, dropped{0}, hostCalls{0};
decltype(&lua_pcallk) originalPcall = nullptr;
decltype(&lua_callk) originalCall = nullptr;
decltype(&lua_close) originalClose = nullptr;
thread_local bool installing = false;
LARGE_INTEGER frequency{};
long long now() { LARGE_INTEGER value; QueryPerformanceCounter(&value); return value.QuadPart; }
double ns(long long ticks) { return static_cast<double>(ticks) * 1e9 / static_cast<double>(frequency.QuadPart); }
std::string captureName() {
    SYSTEMTIME utc{}; GetSystemTime(&utc);
    std::ostringstream name;
    name << "capture-" << std::setfill('0') << std::setw(4) << utc.wYear << '-' << std::setw(2) << utc.wMonth << '-'
         << std::setw(2) << utc.wDay << '_' << std::setw(2) << utc.wHour << '-' << std::setw(2) << utc.wMinute << '-'
         << std::setw(2) << utc.wSecond << '-' << std::setw(3) << utc.wMilliseconds << "Z-pid"
         << GetCurrentProcessId() << '-' << GetTickCount64() << ".isaacprof";
    return name.str();
}
std::mutex metricsMutex, logMutex;
std::atomic<unsigned long long> generation{0};
std::atomic<size_t> registeredCount{0};
std::atomic<unsigned> finishWriters{0};
std::atomic<unsigned long long> tokenCounter{1};
std::atomic<unsigned long long> instrumentedCalls{0}, overheadSamples{0}, wrapperTicks{0}, observerTicks{0}, auxiliaryDropped{0}, contextFailures{0}, errorsOmitted{0};
std::mutex auxiliaryMutex;
std::vector<std::pair<unsigned, std::string>> auxiliaryPackets;
void queueAuxiliary(unsigned type, std::string bytes) {
    std::lock_guard lock(auxiliaryMutex);
    if (auxiliaryPackets.size() >= 128) { ++auxiliaryDropped; return; }
    auxiliaryPackets.emplace_back(type, std::move(bytes));
}
std::atomic<long long> sessionStart{0}, sessionStop{0};
std::filesystem::path directory, reportPath;
std::string luaModulePath;
struct Metric {
    std::string mod, callback, name, source, function;
    int line = 0;
    std::atomic<bool> selected{true};
    std::atomic<unsigned long long> calls{0}, errors{0};
    std::atomic<long long> inclusive{0}, exclusive{0}, maximum{0};
    Metric() = default;
    Metric(const Metric& m) : mod(m.mod), callback(m.callback), name(m.name), source(m.source), function(m.function), line(m.line),
        selected(m.selected.load()), calls(m.calls.load()), errors(m.errors.load()), inclusive(m.inclusive.load()), exclusive(m.exclusive.load()), maximum(m.maximum.load()) {}
};
std::vector<Metric> metrics;
bool selectMetric(const Metric& metric) {
    return enabled(ip::callbacks) && (selectedMods.empty() || selectedMods.contains(metric.mod)) &&
        (selectedHooks.empty() || selectedHooks.contains(metric.callback) || selectedHooks.contains(metric.name));
}
std::string jsonString(const std::string& value) {
    std::ostringstream out; out << '"';
    for (const unsigned char c : value) {
        if (c == '"' || c == '\\') out << '\\' << static_cast<char>(c);
        else if (c < 32) out << "\\u00" << std::hex << std::setfill('0') << std::setw(2) << static_cast<unsigned>(c);
        else out << static_cast<char>(c);
    }
    out << '"'; return out.str();
}
void publishCatalog() {
    std::set<std::string> mods, hooks;
    { std::lock_guard lock(metricsMutex); for (const auto& m : metrics) { mods.insert(m.mod); hooks.insert(m.name.empty() ? m.callback : m.name); } }
    std::ostringstream out; out << "{\"mods\":["; bool first = true;
    for (const auto& mod : mods) { if (!first) out << ','; first = false; out << jsonString(mod); }
    out << "],\"hooks\":["; first = true;
    for (const auto& hook : hooks) { if (!first) out << ','; first = false; out << jsonString(hook); }
    out << "]}"; const auto result = out.str();
    if (result.size() >= sizeof(control->catalogJson)) throw std::runtime_error("Callback catalog exceeds control capacity.");
    strcpy_s(control->catalogJson, result.c_str());
}

void startStreamClock();
// The bounded event ring is allocated once at capture start.
ip::StreamHeader* stream = nullptr;
HANDLE streamMapping = nullptr, collectorProcess = nullptr;
size_t streamedScreenshots = 0;
std::atomic<unsigned long long> traceDropped{0}, traceFiltered{0};
std::atomic<long long> firstLoss{0}, lastLoss{0};
unsigned long long reportedLoss = 0;
bool traceEnabled = false;
long long minimumTicks = 0;
struct Frame {
    unsigned long long token, generation;
    size_t metric;
    long long start, children = 0;
    unsigned depth = 0;
    unsigned long long parent = 0;
    unsigned parentMetric = 0;
};
thread_local std::vector<Frame> frames;

void log(const std::string& message) {
    std::lock_guard lock(logMutex);
    std::ofstream out(directory / "isaacprof.log", std::ios::app);
    out << GetTickCount64() << " " << message << '\n';
}
void status(ip::State state, const std::string& message) {
    if (!control) return;
    strncpy_s(control->message, message.c_str(), _TRUNCATE);
    InterlockedExchange(&control->state, state);
}

int callbackIds(lua_State* L) {
    api.lua_createtable(L, 0, 0);
    const int result = api.lua_gettop(L);
    if (api.lua_type(L, 1) == LUA_TFUNCTION) {
        for (int i = 1; i <= 100; ++i) {
            const char* name = api.lua_getupvalue(L, 1, i);
            if (!name) break;
            if (strcmp(name, "Callbacks") == 0 && api.lua_type(L, -1) == LUA_TTABLE) {
                const int registry = api.lua_gettop(L);
                api.lua_pushnil(L);
                lua_Integer count = 0;
                while (api.lua_next(L, registry)) {
                    api.lua_pushvalue(L, -2);
                    api.lua_rawseti(L, result, ++count);
                    api.lua_settop(L, api.lua_gettop(L) - 1);
                }
                api.lua_settop(L, result);
                break;
            }
            api.lua_settop(L, result);
        }
    }
    return 1;
}
int nativeCallback(lua_State* L);
int wrapCallback(lua_State* L) {
    try {
        Metric metric;
        metric.mod = api.string(L, 1);
        metric.callback = api.string(L, 2);
        metric.name = api.string(L, 3);
        if (api.lua_type(L, 4) != LUA_TFUNCTION) { api.lua_pushvalue(L, 4); return 1; }
        char pointer[32];
        sprintf_s(pointer, "%p", api.lua_topointer(L, 4));
        metric.function = pointer;
        // lua_Debug uses the pinned REPENTOGON Lua 5.4 header layout.
        lua_Debug debug{};
        api.lua_pushvalue(L, 4);
        if (api.lua_getinfo(L, ">S", &debug)) {
            metric.source = debug.source ? std::string(debug.source, debug.srclen) : "";
            metric.line = debug.linedefined;
            ip::validateLuaSourceLayout(api.lua_topointer(L, 4), debug.source, debug.srclen, debug.linedefined, debug.lastlinedefined);
        }
        lua_Integer id = 0;
        {
            std::lock_guard lock(metricsMutex);
            if (metrics.size() < 100000) {
                metric.selected = selectMetric(metric);
                metrics.push_back(std::move(metric));
                id = static_cast<lua_Integer>(metrics.size());
                registeredCount.store(metrics.size(), std::memory_order_release);
                if (control) InterlockedExchange(&control->wrapped, static_cast<LONG>(metrics.size()));
            }
        }
        if (!id) { ++dropped; api.lua_pushvalue(L, 4); return 1; }
        // Original function and metric ID live in a native C closure. There is
        // no Lua measurement function or table.pack allocation per invocation.
        api.lua_pushvalue(L, 4);
        api.lua_pushinteger(L, id);
        api.lua_pushcclosure(L, nativeCallback, 2);
        ip::validateLuaInstructionLayout(L, api.lua_topointer(L, -1), reinterpret_cast<const void*>(nativeCallback), static_cast<unsigned>(id), api.lua_gettop(L));
        return 1;
    } catch (...) { ++dropped; api.lua_pushvalue(L, 4); return 1; }
}
unsigned long long beginMetric(lua_State* L, lua_Integer id) {
    const auto captureGeneration = generation.load();
    if (!active.load(std::memory_order_relaxed) || !enabled(ip::callbacks) || id < 1 ||
        static_cast<size_t>(id) > registeredCount.load(std::memory_order_acquire) || !metrics[static_cast<size_t>(id - 1)].selected.load(std::memory_order_relaxed)) return 0;
    // Yielding coroutine wall time is misleading: deliberately omit coroutines.
    const int top = api.lua_gettop(L);
    const bool isMain = api.lua_pushthread(L) != 0;
    api.lua_settop(L, top);
    if (!isMain) { ++skippedCoroutines; return 0; }
    try {
        if (!active.load() || id < 1 || static_cast<size_t>(id) > registeredCount.load(std::memory_order_acquire)) {
            return 0;
        }
        const auto token = tokenCounter.fetch_add(1);
        unsigned depth = 0;
        unsigned long long parent = 0; unsigned parentMetric = 0;
        for (auto it = frames.rbegin(); it != frames.rend(); ++it) {
            if (it->generation == captureGeneration) { depth = it->depth + 1; parent = it->token; parentMetric = static_cast<unsigned>(it->metric + 1); break; }
        }
        if (depth > 1024 || captureGeneration != generation.load() || !active.load()) { ++dropped; return 0; }
        frames.push_back({token, captureGeneration, static_cast<size_t>(id - 1), now(), 0, depth, parent, parentMetric});
        return token;
    } catch (...) { ++dropped; return 0; }
}
void finishMetric(unsigned long long token, bool success) {
    ++finishWriters;
    struct FinishGuard { ~FinishGuard() { --finishWriters; } } guard;
    const auto end = now();
    if (frames.empty() || frames.back().token != token) { ++dropped; return; }
    const auto frame = frames.back();
    frames.pop_back();
    try {
        if (frame.generation != generation || frame.metric >= registeredCount.load()) { ++dropped; return; }
        // Exclude callbacks crossing stop/deadline rather than charging another session.
        if (!active.load()) { ++dropped; return; }
        const auto elapsed = std::max(0LL, end - frame.start);
        auto& metric = metrics[frame.metric];
        ++metric.calls;
        if (!success) ++metric.errors;
        metric.inclusive += elapsed;
        metric.exclusive += std::max(0LL, elapsed - frame.children);
        auto maximum = metric.maximum.load(); while (maximum < elapsed && !metric.maximum.compare_exchange_weak(maximum, elapsed)) {}
        if (traceEnabled) {
            if (elapsed < minimumTicks) ++traceFiltered;
            else if (!ip::publish(stream, {static_cast<std::uint32_t>(frame.metric + 1), GetCurrentThreadId(), static_cast<std::uint16_t>(frame.depth),
                static_cast<std::uint16_t>(!success), frame.parentMetric, token, frame.parent, static_cast<std::uint64_t>(frame.start - sessionStart),
                static_cast<std::uint64_t>(elapsed), static_cast<std::uint64_t>(std::max(0LL, elapsed - frame.children)), 0})) {
                ++traceDropped; auto expected = 0LL; firstLoss.compare_exchange_strong(expected, frame.start - sessionStart);
                lastLoss.store(end - sessionStart);
            }
        }
        if (!frames.empty() && frames.back().generation == generation) frames.back().children += elapsed;
    } catch (...) { ++dropped; }
}
int forwardResults(lua_State* L, int, lua_KContext) {
    return api.lua_gettop(L);
}
int errorObserver(lua_State* L) {
    // pcall's handler runs before the failing Lua stack is unwound. Leave the
    // original object unchanged, including table errors and their identity.
    if (!active.load() || !enabled(ip::errors)) return 1;
    try {
        static unsigned long long errorGeneration = 0; static unsigned errorCount = 0;
        const auto capture = generation.load();
        if (errorGeneration != capture) { errorGeneration = capture; errorCount = 0; }
        if (++errorCount > 1000) { ++errorsOmitted; return 1; }
        const auto timestamp = static_cast<unsigned long long>(std::max(0LL, now() - sessionStart.load()));
        const char* message = api.lua_type(L, 1) == LUA_TSTRING ? api.lua_tolstring(L, 1, nullptr) : "Non-string Lua error object";
        api.luaL_traceback(L, L, message, 1);
        const char* traceback = api.lua_tolstring(L, -1, nullptr);
        std::ostringstream out(std::ios::binary); ip::Writer writer{out};
        writer.put(timestamp); writer.put<std::uint32_t>(frames.empty() ? 0 : static_cast<std::uint32_t>(frames.back().metric + 1));
        writer.put<std::uint32_t>(GetCurrentThreadId()); writer.put<std::uint64_t>(frames.empty() ? 0 : frames.back().token);
        writer.string(std::string(message).substr(0, 4096)); writer.string(traceback ? std::string(traceback).substr(0, 16384) : "");
        queueAuxiliary(ip::errorChunk, out.str());
        api.lua_settop(L, 1);
    } catch (...) { ++errorsOmitted; api.lua_settop(L, 1); }
    return 1;
}
int nativeCallback(lua_State* L) {
    const auto id = api.lua_tointegerx(L, lua_upvalueindex(2), nullptr);
    const bool recording = active.load(std::memory_order_relaxed) && enabled(ip::callbacks) && id > 0 &&
        static_cast<size_t>(id) <= registeredCount.load(std::memory_order_acquire) && metrics[static_cast<size_t>(id - 1)].selected.load(std::memory_order_relaxed);
    const bool sample = recording && enabled(ip::overhead) && (instrumentedCalls.fetch_add(1, std::memory_order_relaxed) % 1024 == 0);
    const auto entry = sample ? now() : 0;
    const int arguments = api.lua_gettop(L);
    // Place the original function before all arguments, preserving the exact
    // stack/result layout without allocating a Lua table for return values.
    api.lua_pushvalue(L, lua_upvalueindex(1));
    api.lua_rotate(L, 1, 1);
    const auto token = recording ? beginMetric(L, id) : 0;
    if (!token) {
        // Continuation preserves yield/resume semantics of skipped coroutines.
        originalCall(L, arguments, LUA_MULTRET, 0, forwardResults);
        return api.lua_gettop(L);
    }
    // Main-thread callbacks cannot yield. No C++ objects with destructors live
    // across this call or lua_error's longjmp.
    api.lua_pushcclosure(L, errorObserver, 0); api.lua_rotate(L, 1, 1);
    const auto callStart = sample ? now() : 0;
    const int result = originalPcall(L, arguments, LUA_MULTRET, 1, 0, nullptr);
    const auto callEnd = sample ? now() : 0;
    finishMetric(token, result == LUA_OK);
    // Remove the message handler; result counts and error objects remain exact.
    api.lua_rotate(L, 1, -1); api.lua_settop(L, api.lua_gettop(L) - 1);
    if (sample) { wrapperTicks += static_cast<unsigned long long>(callStart - entry + now() - callEnd); ++overheadSamples; }
    if (result != LUA_OK) return api.lua_error(L); // rethrow original error object
    return api.lua_gettop(L);
}
void triggerAvailable(ip::Trigger trigger) { InterlockedOr(&control->availableTriggers, 1L << trigger); }
void beginPendingCapture(long long timestamp) {
    if (!pendingStart.load() || !startDeadline.load() || timestamp < startDeadline.load()) return;
    std::lock_guard lock(metricsMutex);
    if (!pendingStart.load() || timestamp < startDeadline.load()) return;
    sessionStart = timestamp; sessionStop = 0;
    startStreamClock(); ip::setScreenshotClock(true, sessionStart, frequency.QuadPart);
    stopDeadline = stopTrigger.load() == ip::duration ? timestamp + durationTicks.load() + stopDelayTicks.load() : 0;
    captureDeadline = maxDurationTicks.load() ? timestamp + maxDurationTicks.load() : 0;
    active.store(true); pendingStart.store(false);
    status(ip::recording, "Recording callback timeline and aggregate timings.");
}
void observeTrigger(ip::Trigger trigger) {
    const auto timestamp = now(); const bool wasActive = active.load();
    if (pendingStart.load() && startTrigger.load() == trigger) {
        auto unmatched = 0LL; startDeadline.compare_exchange_strong(unmatched, timestamp + startDelayTicks.load());
    }
    beginPendingCapture(timestamp);
    // When start and stop use the same event, stop waits for its next occurrence.
    if (wasActive && stopTrigger.load() == trigger) {
        auto unmatched = 0LL; stopDeadline.compare_exchange_strong(unmatched, timestamp + stopDelayTicks.load());
    }
}
int nativeLifecycleAvailable(lua_State*) { lifecycleAvailable.store(true); triggerAvailable(ip::run_load); return 0; }
int nativeTrigger(lua_State* L) { observeTrigger(static_cast<ip::Trigger>(api.lua_tointegerx(L, lua_upvalueindex(1), nullptr))); return 0; }
int makeTrigger(lua_State* L) {
    const auto trigger = static_cast<ip::Trigger>(api.lua_tointegerx(L, 1, nullptr)); triggerAvailable(trigger);
    api.lua_pushvalue(L, 1); api.lua_pushcclosure(L, nativeTrigger, 1); return 1;
}
// Lifecycle state lives on the Lua thread, including while capture is inactive.
unsigned long long runNumber = 0, roomNumber = 0, levelNumber = 0;
unsigned runFlags = 0;
void publishAux(const ip::StreamEvent& event) {
    if (!ip::publish(stream, event)) { ++traceDropped; auto expected = 0LL; firstLoss.compare_exchange_strong(expected, static_cast<long long>(event.start)); lastLoss.store(static_cast<long long>(event.start)); }
}
void marker(unsigned kind) {
    if (!enabled(ip::markers)) return;
    const auto timestamp = static_cast<unsigned long long>(std::max(0LL, now() - sessionStart.load()));
    publishAux({0, GetCurrentThreadId(), 0, ip::markerFlag, kind, runNumber, roomNumber, timestamp, levelNumber, runFlags, 0});
}
void sampleLua(lua_State* L) {
    ++finishWriters; struct Guard { ~Guard() { --finishWriters; } } guard;
    if (!active.load() || (!enabled(ip::heap) && !enabled(ip::markers)) || L != mainState.load()) return;
    static unsigned long long lastGeneration = 0; static long long nextHeap = 0;
    const auto capture = generation.load(); const auto timestamp = now();
    if (lastGeneration != capture) { lastGeneration = capture; nextHeap = 0; marker(1); }
    if (!enabled(ip::heap) || timestamp < nextHeap) return;
    nextHeap = timestamp + frequency.QuadPart / 4;
    const int kb = api.lua_gc(L, LUA_GCCOUNT), remainder = api.lua_gc(L, LUA_GCCOUNTB);
    if (kb < 0 || remainder < 0 || remainder > 1023) return;
    const auto bytes = static_cast<unsigned long long>(kb) * 1024 + static_cast<unsigned>(remainder);
    publishAux({0, GetCurrentThreadId(), 0, ip::heapFlag, 0, bytes, 0, static_cast<unsigned long long>(timestamp - sessionStart.load()), 0, 0, 0});
}
// Invoked inside a protected call: game methods may raise Lua errors. This C
// function holds only POD values across those calls, never a C++ RAII object.
void contextMethod(lua_State* L, int object, const char* name) {
    api.lua_getfield(L, object, name); api.lua_pushvalue(L, object);
    originalCall(L, 1, 1, 0, nullptr);
}
unsigned contextNumber(lua_State* L, int object, const char* name) {
    contextMethod(L, object, name); const auto value = static_cast<unsigned>(api.lua_tointegerx(L, -1, nullptr));
    api.lua_settop(L, api.lua_gettop(L) - 1); return value;
}
thread_local ip::StreamContext contextSample{};
thread_local ip::StreamContext roomDescription{};
thread_local unsigned long long descriptionGeneration = 0, descriptionTransition = ~0ull;
int readContext(lua_State* L) {
    api.lua_getglobal(L, "Game"); originalCall(L, 0, 1, 0, nullptr); const int game = api.lua_gettop(L);
    contextMethod(L, game, "GetRoom"); const int room = api.lua_gettop(L);
    contextMethod(L, game, "GetLevel"); const int level = api.lua_gettop(L);
    contextMethod(L, level, "GetCurrentRoomDesc"); const int desc = api.lua_gettop(L);
    api.lua_getfield(L, desc, "ListIndex"); contextSample.room = static_cast<std::int32_t>(api.lua_tointegerx(L, -1, nullptr)); api.lua_settop(L, desc - 1);
    contextSample.stage = static_cast<std::int32_t>(contextNumber(L, level, "GetStage"));
    contextSample.stageType = static_cast<std::int32_t>(contextNumber(L, level, "GetStageType"));
    if (descriptionGeneration != generation.load() || descriptionTransition != roomNumber ||
        roomDescription.room != contextSample.room || roomDescription.stage != contextSample.stage || roomDescription.stageType != contextSample.stageType) {
        contextSample.roomType = static_cast<std::int32_t>(contextNumber(L, room, "GetType"));
        contextSample.width = contextNumber(L, room, "GetGridWidth"); contextSample.height = contextNumber(L, room, "GetGridHeight");
        contextSample.gridSlots = contextNumber(L, room, "GetGridSize");
        roomDescription = contextSample; descriptionGeneration = generation.load(); descriptionTransition = roomNumber;
    } else {
        contextSample.roomType = roomDescription.roomType; contextSample.width = roomDescription.width;
        contextSample.height = roomDescription.height; contextSample.gridSlots = roomDescription.gridSlots;
    }
    if (contextSample.gridSlots > 4096) return 0;
    contextSample.valid |= 1;
    for (unsigned i = 0; i < contextSample.gridSlots; ++i) {
        api.lua_getfield(L, room, "GetGridEntity"); api.lua_pushvalue(L, room); api.lua_pushinteger(L, i); originalCall(L, 2, 1, 0, nullptr);
        if (api.lua_type(L, -1) != LUA_TNIL) ++contextSample.grids;
        api.lua_settop(L, api.lua_gettop(L) - 1);
    }
    contextSample.valid |= 2;
    api.lua_getglobal(L, "Isaac"); const int isaac = api.lua_gettop(L); api.lua_getfield(L, isaac, "GetRoomEntities"); originalCall(L, 0, 1, 0, nullptr);
    const int entities = api.lua_gettop(L); api.lua_pushnil(L);
    while (api.lua_next(L, entities)) {
        if (++contextSample.entities > 8192) return 0;
        const int entity = api.lua_gettop(L); api.lua_getfield(L, entity, "Type");
        const auto type = api.lua_tointegerx(L, -1, nullptr); api.lua_settop(L, entity);
        if (type == 2) ++contextSample.tears;
        if (type == 9) ++contextSample.projectiles;
        if (type == 1000) ++contextSample.effects;
        if (type == 5) ++contextSample.pickups;
        api.lua_getfield(L, entity, "IsActiveEnemy"); api.lua_pushvalue(L, entity); api.lua_pushboolean(L, false); originalCall(L, 2, 1, 0, nullptr);
        if (api.lua_toboolean(L, -1)) ++contextSample.enemies;
        api.lua_settop(L, entity - 1);
    }
    contextSample.valid |= 4; return 0;
}
void sampleContext(lua_State* L) {
    if (!enabled(ip::context) || !active.load() || L != mainState.load()) return;
    static unsigned long long lastGeneration = 0; static long long next = 0;
    const auto capture = generation.load(); const auto timestamp = now();
    if (lastGeneration != capture) { lastGeneration = capture; next = 0; }
    if (timestamp < next) return;
    next = timestamp + frequency.QuadPart / 4;
    const int top = api.lua_gettop(L); api.lua_getglobal(L, "Game"); const bool available = api.lua_type(L, -1) == LUA_TFUNCTION; api.lua_settop(L, top);
    if (!available) return;
    contextSample = {}; contextSample.timestamp = static_cast<std::uint64_t>(timestamp - sessionStart.load());
    api.lua_pushcclosure(L, readContext, 0); const int result = originalPcall(L, 0, 0, 0, 0, nullptr); api.lua_settop(L, top);
    if (result != LUA_OK || contextSample.valid != 7) { ++contextFailures; return; }
    try { queueAuxiliary(ip::contextChunk, std::string(reinterpret_cast<const char*>(&contextSample), sizeof(contextSample))); } catch (...) { ++auxiliaryDropped; }
}
int nativeMarker(lua_State* L) {
    const auto kind = static_cast<unsigned>(api.lua_tointegerx(L, lua_upvalueindex(1), nullptr));
    if (kind == 3) observeTrigger(ip::room_entry);
    if (kind == 4) observeTrigger(ip::level_entry);
    if (kind == 5) observeTrigger(ip::run_end);
    if (kind == 6) observeTrigger(ip::game_exit);
    if (kind == 2) { ++runNumber; runFlags = 6u | (api.lua_toboolean(L, 2) ? 1u : 0u); }
    if (kind == 3) ++roomNumber;
    if (kind == 4) ++levelNumber;
    if (kind == 5 || kind == 6) runFlags &= ~2u;
    ++finishWriters; struct Guard { ~Guard() { --finishWriters; } } guard;
    if (active.load()) marker(kind);
    return 0;
}
int makeMarker(lua_State* L) {
    const auto kind = api.lua_tointegerx(L, 1, nullptr);
    if (kind == 3) triggerAvailable(ip::room_entry);
    if (kind == 4) triggerAvailable(ip::level_entry);
    if (kind == 5) triggerAvailable(ip::run_end);
    if (kind == 6) triggerAvailable(ip::game_exit);
    api.lua_pushvalue(L, 1); api.lua_pushcclosure(L, nativeMarker, 1); return 1;
}
void observeInterval(unsigned kind) {
    ++finishWriters;
    struct Guard { ~Guard() { --finishWriters; } } guard;
    if (!active.load() || !enabled(kind == 2 ? ip::renderFrames : ip::updateFrames)) return;
    struct Clock { unsigned long long generation = 0, id = 0; long long previous = 0; };
    thread_local Clock clocks[2];
    auto& clock = clocks[kind - 1];
    const auto capture = generation.load();
    const auto timestamp = now();
    if (clock.generation == capture && clock.previous >= sessionStart.load()) {
        const auto start = static_cast<unsigned long long>(clock.previous - sessionStart.load());
        const auto duration = static_cast<unsigned long long>(timestamp - clock.previous);
        if (!ip::publish(stream, {0, GetCurrentThreadId(), 0, ip::intervalFlag, kind, clock.id, 0, start, duration, 0, 0})) {
            ++traceDropped; auto expected = 0LL; firstLoss.compare_exchange_strong(expected, static_cast<long long>(start));
            lastLoss.store(timestamp - sessionStart.load());
        }
    } else clock.id = 0;
    clock.generation = capture; clock.previous = timestamp; ++clock.id;
}
int nativeRunRender(lua_State* L) {
    const bool sample = active.load() && enabled(ip::overhead); const auto start = sample ? now() : 0;
    if (pendingStart.load()) beginPendingCapture(now());
    observeInterval(2); sampleLua(L); if (sample && active.load()) observerTicks += static_cast<unsigned long long>(now() - start); return 0;
}
int nativeRunUpdate(lua_State* L) {
    observeTrigger(ip::run_load);
    const bool sample = active.load() && enabled(ip::overhead); const auto start = sample ? now() : 0; observeInterval(1);
    runFlags |= 2u;
    sampleLua(L);
    sampleContext(L);
    if (sample && active.load()) observerTicks += static_cast<unsigned long long>(now() - start);
    return 0;
}
void install(lua_State* L) {
    if (mainState.load() || installing || !hooksReady.load()) return;
    installing = true;
    const int top = api.lua_gettop(L);
    // Do not mutate Lua until the game's callback API exists.
    api.lua_getglobal(L, "Isaac");
    const bool hasIsaac = api.lua_type(L, -1) == LUA_TTABLE;
    api.lua_settop(L, top);
    if (hasIsaac) {
        api.lua_createtable(L, 0, 4);
        api.lua_pushcclosure(L, callbackIds, 0); api.lua_setfield(L, -2, "callback_ids");
        api.lua_pushcclosure(L, wrapCallback, 0); api.lua_setfield(L, -2, "wrap");
        api.lua_pushcclosure(L, nativeRunUpdate, 0); api.lua_setfield(L, -2, "run_update");
        api.lua_pushcclosure(L, nativeRunRender, 0); api.lua_setfield(L, -2, "run_render");
        api.lua_pushcclosure(L, nativeLifecycleAvailable, 0); api.lua_setfield(L, -2, "lifecycle_available");
        api.lua_pushcclosure(L, makeMarker, 0); api.lua_setfield(L, -2, "marker");
        api.lua_pushcclosure(L, makeTrigger, 0); api.lua_setfield(L, -2, "trigger");
        api.lua_setglobal(L, "_IsaacProfNative");
        int result = api.luaL_loadbufferx(L, bootstrap_script, sizeof(bootstrap_script) - 1, "@isaacprof/bootstrap.lua", "t");
        if (result == LUA_OK) result = originalPcall(L, 0, 1, 0, 0, nullptr);
        if (result == LUA_OK && api.lua_toboolean(L, -1)) {
            mainState.store(L);
            ip::setLuaInstructionState(L);
            luaThread.store(GetCurrentThreadId());
            ip::observeWaitThread(GetCurrentThreadId(), false);
            log("Callback instrumentation installed on Lua thread " + std::to_string(GetCurrentThreadId()));
        } else if (result != LUA_OK) {
            log("Bootstrap failed: " + api.string(L, -1));
            status(ip::failed, "Lua bootstrap failed; see isaacprof.log. Restart the host before retrying.");
            // A partially installed bootstrap must not be blindly executed again.
            hooksReady.store(false);
        }
        api.lua_settop(L, top);
    }
    installing = false;
}
int hookedPcall(lua_State* L, int nargs, int nresults, int errfunc, lua_KContext ctx, lua_KFunction continuation) {
    install(L);
    if (active.load() && !installing) ++hostCalls;
    return originalPcall(L, nargs, nresults, errfunc, ctx, continuation);
}
void hookedCall(lua_State* L, int nargs, int nresults, lua_KContext ctx, lua_KFunction continuation) {
    install(L);
    if (active.load() && !installing) ++hostCalls;
    originalCall(L, nargs, nresults, ctx, continuation);
}
void hookedClose(lua_State* L) {
    if (mainState.load() == L) {
        mainState.store(nullptr);
        ip::setLuaInstructionState(nullptr);
        active.store(false);
        pendingStart.store(false);
        lifecycleAvailable.store(false);
        ip::setScreenshotClock(false, 0, frequency.QuadPart);
        if (control) status(ip::waiting_lua, "Lua state closed; restart capture after reinitialization.");
    }
    originalClose(L);
}
void closeStream() {
    if (stream) { InterlockedExchange(&stream->done, 1); if (collectorProcess) WaitForSingleObject(collectorProcess, 5000); UnmapViewOfFile(stream); stream = nullptr; }
    if (streamMapping) { CloseHandle(streamMapping); streamMapping = nullptr; }
    if (collectorProcess) { CloseHandle(collectorProcess); collectorProcess = nullptr; }
}
void startStream(size_t capacity, bool tracing) {
    closeStream();
    const auto name = ip::streamName(GetCurrentProcessId(), GetTickCount64());
    const auto bytes = sizeof(ip::StreamHeader) + capacity * sizeof(ip::StreamEvent);
    streamMapping = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, static_cast<DWORD>(bytes), name.c_str());
    if (!streamMapping) throw std::runtime_error("Cannot create streaming buffer.");
    stream = static_cast<ip::StreamHeader*>(MapViewOfFile(streamMapping, FILE_MAP_ALL_ACCESS, 0, 0, bytes));
    if (!stream) throw std::runtime_error("Cannot map streaming buffer.");
    stream->version = ip::streamVersion; stream->capacity = static_cast<std::uint32_t>(capacity); stream->pid = GetCurrentProcessId();
    stream->flags = tracing ? 2 : 0; stream->frequency = static_cast<std::uint64_t>(frequency.QuadPart);
    const auto collector = directory / "isaacprof-collector.exe";
    std::wstring command = L"\"" + collector.wstring() + L"\" \"" + name + L"\" \"" + reportPath.wstring() + L"\" " + std::to_wstring(GetCurrentProcessId());
    STARTUPINFOW startup{sizeof(startup)}; PROCESS_INFORMATION process{};
    if (!CreateProcessW(collector.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, directory.c_str(), &startup, &process))
        throw std::runtime_error("Cannot start x64 collector; rebuild and keep isaacprof-collector.exe beside the DLL.");
    CloseHandle(process.hThread); collectorProcess = process.hProcess;
    for (int i = 0; i < 500 && !ip::read(&stream->ready) && !ip::read(&stream->failed); ++i) {
        if (WaitForSingleObject(collectorProcess, 0) == WAIT_OBJECT_0) break;
        Sleep(10);
    }
    if (ip::read(&stream->failed) || !ip::read(&stream->ready)) throw std::runtime_error("Collector initialization failed.");
    streamedScreenshots = 0;
    reportedLoss = 0;
}
void startStreamClock() {
    if (stream) { stream->start = static_cast<std::uint64_t>(sessionStart); InterlockedExchange(&stream->started, 1); }
}
void sendPacket(unsigned type, const std::string& bytes) {
    for (int i = 0; i < 500; ++i) {
        if (!stream || ip::read(&stream->failed) || WaitForSingleObject(collectorProcess, 0) == WAIT_OBJECT_0)
            throw std::runtime_error("Collector stopped or storage failed.");
        if (ip::packet(stream, type, bytes)) return;
        Sleep(2); // Only the control worker can wait, never a game callback.
    }
    throw std::runtime_error("Collector metadata queue stalled.");
}
void sampleCounters() {
    std::uint64_t waitsOmitted = 0;
    const auto waits = ip::drainWaits(waitsOmitted);
    ip::StreamSamplingStats sampling{};
    const auto instructions = ip::drainInstructionSamples(sampling);
    const auto luaInstructions = ip::drainLuaInstructionSamples();
    for (const auto& definition : ip::drainLuaInstructionSources()) sendPacket(ip::luaInstructionSourceChunk, definition);
    for (const auto& context : luaInstructions) for (unsigned i = 0; i < context.depth; ++i) sampledMetricIds.insert(context.metrics[i]);
    if (!instructions.empty()) sendPacket(ip::instructionChunk, std::string(reinterpret_cast<const char*>(instructions.data()), instructions.size() * sizeof(ip::StreamInstruction)));
    if (!luaInstructions.empty()) sendPacket(ip::luaInstructionChunk, std::string(reinterpret_cast<const char*>(luaInstructions.data()), luaInstructions.size() * sizeof(ip::StreamLuaInstruction)));
    if (channels.load() & ip::instructions) sendPacket(ip::samplingStatsChunk, std::string(reinterpret_cast<const char*>(&sampling), sizeof(sampling)));
    auxiliaryDropped += waitsOmitted;
    if (!waits.empty()) sendPacket(ip::waitChunk, std::string(
        reinterpret_cast<const char*>(waits.data()), waits.size() * sizeof(ip::StreamWait)));
    static unsigned long long moduleGeneration = 0;
    static std::set<std::uintptr_t> waitModules;
    if (moduleGeneration != generation.load()) {
        waitModules.clear(); moduleGeneration = generation.load();
    }
    std::vector<std::uint64_t> addresses;
    for (const auto& wait : waits) addresses.push_back(wait.caller);
    for (const auto& sample : instructions) {
        addresses.push_back(sample.address);
        for (unsigned i = 0; i < sample.returnCount; ++i) addresses.push_back(sample.returns[i]);
    }
    for (const auto address : addresses) {
        MEMORY_BASIC_INFORMATION memory{};
        if (!VirtualQuery(reinterpret_cast<void*>(static_cast<std::uintptr_t>(address)), &memory, sizeof(memory)) || memory.Type != MEM_IMAGE) continue;
        const auto base = reinterpret_cast<std::uintptr_t>(memory.AllocationBase);
        if (waitModules.contains(base) || waitModules.size() >= 2000) continue;
        MODULEINFO module{}; wchar_t name[32768]{};
        const auto handle = static_cast<HMODULE>(memory.AllocationBase);
        if (!GetModuleInformation(GetCurrentProcess(), handle, &module, sizeof(module)) ||
            !GetModuleFileNameW(handle, name, 32768)) continue;
        const auto path = std::filesystem::path(name).u8string();
        std::ostringstream out(std::ios::binary); ip::Writer writer{out};
        writer.put<std::uint64_t>(base); writer.put<std::uint64_t>(module.SizeOfImage);
        writer.string(std::string(reinterpret_cast<const char*>(path.data()), path.size()).substr(0, 32768));
        sendPacket(ip::nativeModuleChunk, out.str()); waitModules.insert(base);
    }
    for (const auto& state : ip::drainRenderStates()) sendPacket(ip::renderStateChunk, state);
    std::uint64_t omitted=0;const auto presentations=ip::drainPresentationSamples(omitted);auxiliaryDropped+=omitted;
    if(!presentations.empty())sendPacket(ip::presentationChunk,std::string(reinterpret_cast<const char*>(presentations.data()),presentations.size()*sizeof(ip::StreamPresentation)));
    ip::StreamCounters sample{}; sample.timestamp = static_cast<unsigned long long>(std::max(0LL, now() - sessionStart.load()));
    if (enabled(ip::counters)) {
    PROCESS_MEMORY_COUNTERS_EX memory{}; memory.cb = sizeof(memory);
    if (GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&memory), sizeof(memory))) {
        sample.workingSet = memory.WorkingSetSize; sample.privateBytes = memory.PrivateUsage; sample.pageFaults = memory.PageFaultCount; sample.valid |= 1;
    }
    auto ticks = [](FILETIME value) { return (static_cast<unsigned long long>(value.dwHighDateTime) << 32) | value.dwLowDateTime; };
    FILETIME created{}, exited{}, kernel{}, user{};
    if (GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user)) { sample.processUser = ticks(user); sample.processKernel = ticks(kernel); sample.valid |= 2; }
    sample.thread = luaThread.load(); const auto thread = OpenThread(THREAD_QUERY_LIMITED_INFORMATION, FALSE, sample.thread);
    if (thread) { if (GetThreadTimes(thread, &created, &exited, &kernel, &user)) { sample.threadUser = ticks(user); sample.threadKernel = ticks(kernel); sample.valid |= 4; } CloseHandle(thread); }
    sendPacket(ip::countersChunk, std::string(reinterpret_cast<const char*>(&sample), sizeof(sample)));
    }
    if (!enabled(ip::overhead)) return;
    const ip::StreamOverhead overhead{sample.timestamp, instrumentedCalls.load(), overheadSamples.load(), wrapperTicks.load(), observerTicks.load(), auxiliaryDropped.load(), contextFailures.load(), errorsOmitted.load()};
    sendPacket(ip::overheadChunk, std::string(reinterpret_cast<const char*>(&overhead), sizeof(overhead)));
}
void flushAuxiliary() {
    std::vector<std::pair<unsigned, std::string>> packets;
    { std::lock_guard lock(auxiliaryMutex); packets.swap(auxiliaryPackets); }
    for (const auto& [type, bytes] : packets) sendPacket(type, bytes);
}
void captureConfiguration() {
    std::ostringstream out(std::ios::binary); ip::Writer w{out};
    w.put<std::uint32_t>(2); w.put<std::uint32_t>(channels.load());
    w.put<std::uint32_t>(startTrigger.load()); w.put<std::uint32_t>(stopTrigger.load());
    w.put<std::uint32_t>(static_cast<std::uint32_t>(startDelayTicks.load() * 1000 / frequency.QuadPart));
    w.put<std::uint32_t>(static_cast<std::uint32_t>(stopDelayTicks.load() * 1000 / frequency.QuadPart));
    w.put<std::uint32_t>(static_cast<std::uint32_t>(maxDurationTicks.load() * 1000 / frequency.QuadPart));
    for (const auto* scope : {&selectedMods, &selectedHooks}) { w.put<std::uint32_t>(static_cast<std::uint32_t>(scope->size())); for (const auto& name : *scope) w.string(name); }
    sendPacket(ip::configurationChunk, out.str());
}
void captureInventory() {
    if (!enabled(ip::sources)) return;
    std::set<std::pair<std::string,std::string>> sources;
    { std::lock_guard lock(metricsMutex); for (const auto& m:metrics) sources.emplace(m.mod,m.source); }
    wchar_t exe[32768]{}; GetModuleFileNameW(nullptr,exe,32768);
    const auto root=std::filesystem::path(exe).parent_path(); std::uint64_t budget=64*1024*1024;
    auto it=sources.begin(); do {
        std::ostringstream out(std::ios::binary);ip::Writer w{out};w.put<std::uint32_t>(250);w.string(ip::fileVersion(exe));w.string(ip::windowTitle());w.string(luaModulePath);
        const auto count=static_cast<std::uint32_t>(std::min<size_t>(300,static_cast<size_t>(std::distance(it,sources.end()))));w.put(count);
        for (unsigned i=0;i<count;++i,++it) {
            const auto& [mod,source]=*it; std::filesystem::path resolved; unsigned status=0;std::string digest;
            if (!source.empty() && source[0]=='@') {
                auto path=std::filesystem::path(std::u8string(reinterpret_cast<const char8_t*>(source.data()+1),source.size()-1));if(path.is_relative())path=root/path;
                std::error_code error;if(std::filesystem::is_regular_file(path,error) && !error){resolved=path;digest=ip::sha256(path,budget,status);}
            }
            w.string(mod);w.string(source);w.string(ip::utf8(resolved));w.string(digest);w.put<std::uint32_t>(status);
        }
        sendPacket(ip::inventoryChunk,out.str());
    } while(it!=sources.end());
}
void snapshot(bool complete) {
    if (complete) while (finishWriters.load()) Sleep(1);
    flushAuxiliary();
    std::vector<std::pair<size_t, Metric>> savedMetrics;
    {
        std::lock_guard lock(metricsMutex);
        for (size_t i = 0; i < metrics.size(); ++i) if (metrics[i].calls.load() || sampledMetricIds.contains(static_cast<unsigned>(i + 1))) savedMetrics.emplace_back(i, metrics[i]);
    }
    wchar_t exe[32768]{}; GetModuleFileNameW(nullptr, exe, 32768);
    std::ostringstream out(std::ios::binary); ip::Writer writer{out};
    // A metadata block embeds the existing v2 aggregate layout with zero events/images.
    out.write(ip::captureMagic.data(), 8); writer.put<std::uint32_t>(2);
    writer.put<std::uint32_t>((complete ? 1 : 0) | (traceEnabled ? 2 : 0));
    writer.put<std::uint32_t>(GetCurrentProcessId()); writer.put<std::uint32_t>(504);
    writer.put(ns((sessionStop.load() ? sessionStop.load() : now()) - sessionStart.load())); writer.put<std::uint64_t>(frequency.QuadPart);
    writer.put<std::uint32_t>(registeredCount.load()); writer.put<std::uint32_t>(savedMetrics.size());
    writer.put<std::uint32_t>(0); writer.put<std::uint32_t>(stream->capacity);
    writer.put<std::uint64_t>(dropped.load()); writer.put<std::uint64_t>(skippedCoroutines.load()); writer.put<std::uint64_t>(hostCalls.load());
    writer.put<std::uint64_t>(traceDropped.load()); writer.put<std::uint64_t>(traceFiltered.load()); writer.put(ns(minimumTicks)); writer.string("0.11.11");
    const auto exeUtf8 = std::filesystem::path(exe).u8string();
    writer.string(std::string(reinterpret_cast<const char*>(exeUtf8.data()), exeUtf8.size())); writer.string(luaModulePath);
    for (const auto& [id, m] : savedMetrics) {
        const auto calls = m.calls.load();
        const auto inclusive = m.inclusive.load(), exclusive = std::min(inclusive, m.exclusive.load());
        writer.put<std::uint32_t>(id + 1); writer.put<std::int32_t>(m.line); writer.put<std::uint64_t>(calls); writer.put<std::uint64_t>(std::min(calls, m.errors.load()));
        writer.put(ns(inclusive)); writer.put(ns(exclusive)); writer.put(calls ? ns(inclusive) / static_cast<double>(calls) : 0.0); writer.put(ns(m.maximum.load()));
        writer.string(m.mod); writer.string(m.callback); writer.string(m.name); writer.string(m.source); writer.string(m.function);
    }
    const auto filmstrip = ip::screenshotSnapshot();
    writer.put<std::uint32_t>(0); writer.put(filmstrip.intervalMs); writer.put(filmstrip.omitted); writer.put(filmstrip.overheadNs);
    sendPacket(ip::metadataChunk, out.str());
    const auto lost = traceDropped.load();
    if (lost != reportedLoss) {
        std::ostringstream loss(std::ios::binary); ip::Writer w{loss}; w.put<std::uint64_t>(lost - reportedLoss); w.put<std::uint64_t>(firstLoss.load()); w.put<std::uint64_t>(lastLoss.load());
        sendPacket(ip::lossChunk, loss.str()); reportedLoss = lost;
    }
    while (streamedScreenshots < filmstrip.images.size()) {
        const auto& image = filmstrip.images[streamedScreenshots++]; std::ostringstream shot(std::ios::binary); ip::Writer w{shot};
        w.put(image.timeNs); w.put(image.width); w.put(image.height); w.put<std::uint32_t>(1); w.put<std::uint32_t>(image.png.size());
        shot.write(reinterpret_cast<const char*>(image.png.data()), image.png.size()); sendPacket(ip::screenshotChunk, shot.str());
    }
    if (complete) {
        InterlockedExchange(&stream->done, 1);
        if (WaitForSingleObject(collectorProcess, 10000) != WAIT_OBJECT_0 || ip::read(&stream->failed) || ip::read(&stream->ready) != 2)
            throw std::runtime_error("Collector could not finish capture; the valid file prefix remains recoverable.");
    }
}
DWORD WINAPI worker(void*) {
    try {
        wchar_t path[32768]{}; GetModuleFileNameW(selfModule, path, 32768);
        directory = std::filesystem::path(path).parent_path();
        QueryPerformanceFrequency(&frequency);
        metrics.reserve(100000);
        CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        HANDLE mapping = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0,
            sizeof(ip::Control), ip::mapping_name(GetCurrentProcessId()).c_str());
        if (!mapping) throw std::runtime_error("Cannot create control mapping.");
        control = static_cast<ip::Control*>(MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(ip::Control)));
        if (!control) throw std::runtime_error("Cannot map control memory.");
        control->version = ip::protocol;
        control->availableTriggers = (1L << ip::immediate) | (1L << ip::duration) | (1L << ip::manual);
        status(ip::loading, "Waiting for a loaded Lua 5.4-compatible module.");
        HMODULE lua = nullptr;
        for (int i = 0; i < 600 && !lua; ++i) {
            for (const auto name : {L"Lua5.4.dll", L"Lua5.3.3r.dll", L"Lua5.3.3f.dll"}) {
                HMODULE candidate = GetModuleHandleW(name);
                // Lua 5.3's lua_version has a different return ABI. Check 5.4
                // exports before calling it with our pinned 5.4 headers.
                if (candidate && GetProcAddress(candidate, "lua_newuserdatauv") && GetProcAddress(candidate, "lua_resetthread")) {
                    lua = candidate; break;
                }
            }
            if (!lua) Sleep(100);
        }
        if (!lua) throw std::runtime_error("No compatible Lua module found within 60 seconds. Launch Isaac through REPENTOGONLauncher.");
        api.bind(lua);
        wchar_t luaPath[32768]{}; GetModuleFileNameW(lua, luaPath, 32768);
        const auto utf8 = std::filesystem::path(luaPath).u8string();
        luaModulePath.assign(reinterpret_cast<const char*>(utf8.data()), utf8.size());
        if (MH_Initialize() != MH_OK) throw std::runtime_error("MinHook initialization failed.");
        ip::installScreenshotHook();
        ip::installWaitHooks();
        if (MH_CreateHook(reinterpret_cast<void*>(api.lua_pcallk), hookedPcall, reinterpret_cast<void**>(&originalPcall)) != MH_OK ||
            MH_CreateHook(reinterpret_cast<void*>(api.lua_callk), hookedCall, reinterpret_cast<void**>(&originalCall)) != MH_OK ||
            MH_CreateHook(reinterpret_cast<void*>(api.lua_close), hookedClose, reinterpret_cast<void**>(&originalClose)) != MH_OK)
            throw std::runtime_error("Cannot create Lua hooks.");
        if (MH_EnableHook(MH_ALL_HOOKS) != MH_OK) throw std::runtime_error("Cannot enable Lua hooks.");
        hooksReady.store(true);
        status(ip::waiting_lua, "Hooks installed; waiting for the next Lua call with Isaac API available.");
        log("Lua 5.4 hooks enabled, PID " + std::to_string(GetCurrentProcessId()));
        LONG handled = 0;
        ULONGLONG nextSnapshot = 0, nextCounters = 0;
        bool everCaptured = false, inventoryPending = false;
        for (;;) {
            const LONG request = ip::read(&control->request);
            if (request != handled) {
                control->commandError[0] = '\0';
                const LONG command = ip::read(&control->command);
                try {
                    if (command == ip::start) {
                        if (!mainState.load()) throw std::runtime_error("Instrumentation is not ready; wait for Lua callbacks and retry.");
                        if (active.load() || pendingStart.load()) throw std::runtime_error("A capture is already running or armed; stop it first.");
                        const LONG mask = ip::read(&control->channels);
                        if (mask < 0 || (mask & ~ip::allChannels)) throw std::runtime_error("Invalid capture channels.");
                        const auto mods = readScope(control->selectedMods, sizeof(control->selectedMods));
                        const auto hooks = readScope(control->selectedHooks, sizeof(control->selectedHooks));
                        const LONG seconds = ip::read(&control->seconds);
                        if (seconds < 1 || seconds > 3600) throw std::runtime_error("Duration must be 1..3600 seconds.");
                        const bool tracing = ip::read(&control->trace) != 0;
                        const LONG startOn = ip::read(&control->startTrigger), stopOn = ip::read(&control->stopTrigger);
                        const LONG startDelay = ip::read(&control->startDelayMs), stopDelay = stopOn == ip::manual ? 0 : ip::read(&control->stopDelayMs);
                        const LONG maxDuration = ip::read(&control->maxDurationMs);
                        if (startOn < ip::immediate || startOn > ip::game_exit || stopOn < ip::run_load || stopOn > ip::manual ||
                            startDelay < 0 || startDelay > 3600000 || stopDelay < 0 || stopDelay > 3600000 || maxDuration < 0 || maxDuration > 3600000)
                            throw std::runtime_error("Invalid capture trigger or delay (0..3600000 ms).");
                        const auto available = ip::read(&control->availableTriggers);
                        if (!(available & (1L << startOn)) || !(available & (1L << stopOn)))
                            throw std::runtime_error("Selected capture trigger is unavailable in this host.");
                        const LONG screenshotMs = ip::read(&control->screenshotMs);
                        if (screenshotMs < 250 || screenshotMs > 10000) throw std::runtime_error("Screenshot interval must be 250..10000 ms.");
                        const LONG limit = ip::read(&control->eventLimit), minimum = ip::read(&control->minimumUs);
                        if (limit < 1 || limit > 2000000 || minimum < 0 || minimum > 1000000)
                            throw std::runtime_error("Invalid timeline configuration.");
                        
                        std::filesystem::create_directories(directory / "captures");
                        reportPath = directory / "captures" / captureName();
                        startStream(static_cast<size_t>(limit), tracing);
                        ip::configureScreenshots(ip::read(&control->screenshots) != 0, static_cast<unsigned>(screenshotMs));
                        ip::configurePresentation((mask & ip::presentation)!=0);
                        ip::configureWaits((mask & ip::waits)!=0);
                        ip::configureInstructionSamples((mask & ip::instructions)!=0);
                        sampledMetricIds.clear();
                        {
                            std::lock_guard lock(metricsMutex);
                            channels = mask; selectedMods = mods; selectedHooks = hooks;
                            for (auto& m : metrics) { m.selected = selectMetric(m); m.calls = 0; m.errors = 0; m.inclusive = 0; m.exclusive = 0; m.maximum = 0; }
                            ++generation; sessionStart = 0; sessionStop = 0;
                            
                            traceEnabled = tracing && enabled(ip::timeline) && enabled(ip::callbacks); traceDropped = 0; traceFiltered = 0; firstLoss = 0; lastLoss = 0;
                            minimumTicks = static_cast<long long>(static_cast<double>(minimum) * frequency.QuadPart / 1e6);
                            skippedCoroutines = 0; dropped = 0; hostCalls = 0;
                            instrumentedCalls = 0; overheadSamples = 0; wrapperTicks = 0; observerTicks = 0;
                            auxiliaryDropped = 0; contextFailures = 0; errorsOmitted = 0;
                            { std::lock_guard auxiliaryLock(auxiliaryMutex); auxiliaryPackets.clear(); }
                            startTrigger = startOn; stopTrigger = stopOn; startDeadline = 0; stopDeadline = 0;
                            captureDeadline = 0; maxDurationTicks = static_cast<long long>(maxDuration) * frequency.QuadPart / 1000;
                            startDelayTicks = static_cast<long long>(startDelay) * frequency.QuadPart / 1000;
                            stopDelayTicks = static_cast<long long>(stopDelay) * frequency.QuadPart / 1000;
                            durationTicks = static_cast<long long>(seconds) * frequency.QuadPart;
                            ip::setScreenshotClock(false, 0, frequency.QuadPart);
                            active.store(false); pendingStart.store(true);
                        }
                        wcsncpy_s(control->report, reportPath.c_str(), _TRUNCATE);
                        nextSnapshot = 0; nextCounters = 0; everCaptured = true; inventoryPending = true;
                        observeTrigger(ip::immediate);
                        if (pendingStart.load()) status(ip::armed, std::string("Armed: waiting for ") + ip::triggerNames[startOn] + ".");
                    } else if (command == ip::catalog) {
                        publishCatalog();
                    } else if (command == ip::stop) {
                        {
                            std::lock_guard lock(metricsMutex);
                            active.store(false); pendingStart.store(false); startDeadline = 0; stopDeadline = 0; captureDeadline = 0; sessionStop = sessionStart ? now() : 0;
                            ip::setScreenshotClock(false, sessionStart, frequency.QuadPart);
                        }
                        ip::processScreenshots();
                        if (everCaptured && sessionStart) { if (inventoryPending) { captureConfiguration(); captureInventory(); inventoryPending=false; } sampleCounters(); snapshot(true); }
                        else { closeStream(); control->report[0] = L'\0'; }
                        status(ip::ready, sessionStart ? "Capture stopped; report saved." : "Armed capture cancelled; no report created.");
                    } else throw std::runtime_error("Unknown command.");
                } catch (const std::exception& error) {
                    // Command errors are recoverable; state still describes actual recording.
                    // Keep the acknowledged result separate from live progress:
                    // the collecting update below can replace the status message.
                    strncpy_s(control->commandError, error.what(), _TRUNCATE);
                    status(active.load() ? ip::recording : (pendingStart.load() ? ip::armed : (mainState.load() ? ip::ready : ip::waiting_lua)), std::string("ERROR: ") + error.what());
                }
                handled = request;
                InterlockedExchange(&control->acknowledged, handled);
            }
            if (pendingStart.load()) {
                beginPendingCapture(now());
                const auto deadline = startDeadline.load();
                if (pendingStart.load() && deadline && GetTickCount64() >= nextCounters) {
                    status(ip::armed, "Start delay: " + std::to_string(std::max(0LL, (deadline - now()) * 1000 / frequency.QuadPart)) + " ms remaining; trigger " + ip::triggerNames[startTrigger.load()]);
                    nextCounters = GetTickCount64() + 100;
                }
            }
            if (active.load()) {
                if (!stream || ip::read(&stream->failed) || WaitForSingleObject(collectorProcess, 0) == WAIT_OBJECT_0) throw std::runtime_error("Collector failed; recording stopped, partial file retained.");
                if (ip::read(&control->state) == ip::armed) status(ip::recording, "Run loaded; recording started.");
                ip::processScreenshots();
                flushAuxiliary();
                if (inventoryPending) { captureConfiguration(); captureInventory(); inventoryPending=false; }
                if (GetTickCount64() >= nextCounters) { sampleCounters(); nextCounters = GetTickCount64() + 250; }
                const bool maximumReached = captureDeadline.load() && now() >= captureDeadline.load();
                if (maximumReached || (stopDeadline.load() && now() >= stopDeadline.load())) {
                    { std::lock_guard lock(metricsMutex); active.store(false); sessionStop = now(); }
                    ip::setScreenshotClock(false, sessionStart, frequency.QuadPart);
                    sampleCounters();
                    Sleep(50); ip::processScreenshots(); snapshot(true);
                    startDeadline = 0; stopDeadline = 0; captureDeadline = 0;
                    status(ip::ready, maximumReached ? "Maximum duration reached; report saved." : "Capture complete; report saved.");
                } else if (GetTickCount64() >= nextSnapshot) {
                    snapshot(false); nextSnapshot = GetTickCount64() + 1000;
                }
                if (active.load()) {
                    const auto planned = stopTrigger.load() == ip::duration ? durationTicks.load() + stopDelayTicks.load() : 0;
                    const auto maximum = maxDurationTicks.load();
                    const auto limit = (maximum ? (planned ? std::min(planned, maximum) : maximum) : planned) * 1000 / frequency.QuadPart;
                    auto message = "Collecting profile: " + std::to_string((now() - sessionStart) * 1000 / frequency.QuadPart) + " ms / " + std::to_string(limit) + " ms; stop " + ip::triggerNames[stopTrigger.load()];
                    if (stopTrigger.load() != ip::duration && stopDeadline.load()) message += "; Stop delay: " + std::to_string(std::max(0LL, (stopDeadline.load() - now()) * 1000 / frequency.QuadPart)) + " ms remaining";
                    status(ip::recording, message);
                }
            } else if (mainState.load() && ip::read(&control->state) == ip::waiting_lua) {
                status(ip::ready, "Callback instrumentation ready.");
            }
            ip::processScreenshots();
            ip::sampleInstructions();
            const auto sampleDelay = ip::instructionPollDelay();
            Sleep(sampleDelay ? sampleDelay : ((pendingStart.load() && startDeadline.load()) || stopDeadline.load() || captureDeadline.load() ? 10 : 50));
        }
    } catch (const std::exception& error) {
        active.store(false); pendingStart.store(false); ip::setScreenshotClock(false, 0, frequency.QuadPart);
        closeStream();
        status(ip::failed, error.what());
        log(std::string("FAILED: ") + error.what());
    }
    return 0;
}
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        selfModule = instance;
        // No filesystem, Lua calls or hook installation under the loader lock.
        HANDLE thread = CreateThread(nullptr, 0, worker, nullptr, 0, nullptr);
        if (!thread) return FALSE;
        CloseHandle(thread);
    }
    // DLL stays resident until host exit; live unloading is intentionally unsupported.
    return TRUE;
}
