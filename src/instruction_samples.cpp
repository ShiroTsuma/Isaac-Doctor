#include "instruction_samples.hpp"
#include <atomic>
#include <array>
#include <algorithm>
#include <map>
#include <sstream>
#include "binary.hpp"
extern "C" {
#include "lstate.h"
}

namespace ip {
namespace {
std::atomic<bool> enabled{false}, active{false};
std::atomic<long long> origin{0};
std::atomic<unsigned> generation{0};
std::array<std::atomic<DWORD>, 2> identities{};
struct Target { DWORD id = 0; HANDLE handle = nullptr; };
std::array<Target, 2> targets{};
std::vector<StreamInstruction> samples;
std::vector<StreamLuaInstruction> luaSamples;
std::atomic<void*> verifiedLuaState{nullptr}, samplingLuaState{nullptr};
std::atomic<const void*> wrapperCallback{nullptr};
std::atomic<bool> sourceLayoutVerified{false};
struct LuaSource { int line = 0; size_t length = 0; char text[1024]{}; };
std::map<std::pair<std::string, int>, unsigned> sourceIds;
std::vector<std::string> sourceDefinitions;
StreamSamplingStats totals{};
unsigned poll = 0;

template<class T> bool copyMemory(const void* address, T& value) {
    SIZE_T read = 0;
    return address && ReadProcessMemory(GetCurrentProcess(), address, &value, sizeof(value), &read) && read == sizeof(value);
}

bool readLuaSource(const void* address, LuaSource& result, int* lastLine = nullptr) {
    LClosure closure{};
    Proto proto{};
    TString source{};
    if (!copyMemory(address, closure) || closure.tt != LUA_VLCL ||
        !copyMemory(closure.p, proto) || proto.tt != LUA_VPROTO ||
        proto.linedefined < 0 || proto.lastlinedefined < proto.linedefined ||
        !copyMemory(proto.source, source) || (source.tt != LUA_VSHRSTR && source.tt != LUA_VLNGSTR)) return false;
    const size_t length = source.tt == LUA_VSHRSTR ? source.shrlen : source.u.lnglen;
    if (!length || length >= sizeof(result.text)) return false;
    SIZE_T read = 0;
    const auto text = reinterpret_cast<const void*>(reinterpret_cast<std::uintptr_t>(proto.source) + offsetof(TString, contents));
    if (!ReadProcessMemory(GetCurrentProcess(), text, result.text, length, &read) || read != length) return false;
    result.line = proto.linedefined; result.length = length; result.text[length] = 0;
    if (lastLine) *lastLine = proto.lastlinedefined;
    return true;
}

StreamLuaInstruction readLuaContext(LuaSource& source) {
    StreamLuaInstruction result{};
    const auto address = samplingLuaState.load(std::memory_order_acquire);
    if (!address || address != verifiedLuaState.load(std::memory_order_acquire)) return result;
    result.flags = 1; // Independently verified pinned Lua 5.4 layout.
    lua_State state{};
    if (!copyMemory(address, state)) { result.flags |= 4; return result; }
    auto ci = state.ci;
    const auto base = reinterpret_cast<const CallInfo*>(reinterpret_cast<std::uintptr_t>(address) + offsetof(lua_State, base_ci));
    unsigned walked = 0;
    for (; ci && ci != base && walked < 32 && result.depth < 4; ++walked) {
        CallInfo frame{};
        StackValue function{};
        if (!copyMemory(ci, frame) || !copyMemory(frame.func.p, function)) { result.flags |= 4; break; }
        if (!source.length && ttisLclosure(&function.val) && sourceLayoutVerified.load(std::memory_order_relaxed)) {
            if (!readLuaSource(function.val.value_.gc, source)) result.flags |= 8;
        }
        if (ttisCclosure(&function.val)) {
            CClosure closure{};
            if (!copyMemory(function.val.value_.gc, closure)) { result.flags |= 4; break; }
            if (closure.tt == LUA_VCCL && closure.nupvalues == 2 && reinterpret_cast<const void*>(closure.f) == wrapperCallback.load(std::memory_order_relaxed)) {
                TValue values[2]{};
                const auto upvalues = reinterpret_cast<const void*>(reinterpret_cast<std::uintptr_t>(function.val.value_.gc) + offsetof(CClosure, upvalue));
                if (!copyMemory(upvalues, values)) { result.flags |= 4; break; }
                if (!ttisinteger(&values[1]) || values[1].value_.i <= 0 || values[1].value_.i > 100000) { result.flags |= 4; break; }
                result.metrics[result.depth++] = static_cast<std::uint32_t>(values[1].value_.i);
            }
        }
        if (frame.previous == ci) { result.flags |= 4; break; }
        ci = frame.previous;
    }
    if (ci && ci != base) result.flags |= 2; // Bounded partial context.
    // An interrupted/inconsistent read cannot assign a guessed owner.
    if (result.flags & 4) { result.depth = 0; source = {}; std::fill(std::begin(result.metrics), std::end(result.metrics), 0u); }
    return result;
}

long long ticks() { LARGE_INTEGER value{}; QueryPerformanceCounter(&value); return value.QuadPart; }
struct Resume {
    HANDLE thread;
    DWORD result = ~0u;
    explicit Resume(HANDLE handle) : thread(handle) {}
    void finish() { if (thread) { result = ResumeThread(thread); thread = nullptr; } }
    ~Resume() { finish(); }
};
}

void configureInstructionSamples(bool use) {
    enabled.store(false);
    ++generation;
    samples.clear(); samples.reserve(1024);
    luaSamples.clear(); luaSamples.reserve(1024);
    sourceIds.clear(); sourceDefinitions.clear();
    totals = {}; poll = 0;
    enabled.store(use);
}
void validateLuaSourceLayout(const void* closure, const char* expected, size_t length, int line, int lastLine) {
    if (sourceLayoutVerified.load() || !expected || !length || line < 0) return;
    LuaSource source{}; int last = 0;
    if (readLuaSource(closure, source, &last) && source.length == length && source.line == line && last == lastLine && !memcmp(source.text, expected, length)) sourceLayoutVerified.store(true, std::memory_order_release);
}
void validateLuaInstructionLayout(void* address, const void* closureAddress, const void* callback, unsigned metric, int top) {
    if (verifiedLuaState.load(std::memory_order_acquire) == address) return;
    // Run on the Lua thread during registration, not while another thread is paused.
    // Cross-check internal fields against public API values and our known C closure.
    lua_State state{};
    CallInfo frame{};
    CClosure closure{};
    TValue values[2]{};
    StackValue last{};
    if (!copyMemory(address, state) || state.tt != LUA_VTHREAD || !copyMemory(state.ci, frame) ||
        !state.top.p || top < 1 ||
        reinterpret_cast<std::uintptr_t>(state.top.p) != reinterpret_cast<std::uintptr_t>(frame.func.p) + static_cast<std::uintptr_t>(top + 1) * sizeof(StackValue) ||
        !copyMemory(state.top.p - 1, last) || !ttisCclosure(&last.val) || last.val.value_.gc != closureAddress ||
        !copyMemory(closureAddress, closure) || closure.tt != LUA_VCCL || closure.nupvalues != 2 || reinterpret_cast<const void*>(closure.f) != callback ||
        !copyMemory(reinterpret_cast<const void*>(reinterpret_cast<std::uintptr_t>(closureAddress) + offsetof(CClosure, upvalue)), values) ||
        !ttisinteger(&values[1]) || values[1].value_.i != metric) return;
    wrapperCallback.store(callback, std::memory_order_relaxed);
    verifiedLuaState.store(address, std::memory_order_release);
}
void setLuaInstructionState(void* state) {
    samplingLuaState.store(state, std::memory_order_release);
    if (!state) { verifiedLuaState.store(nullptr, std::memory_order_release); sourceLayoutVerified.store(false); }
}
void setInstructionClock(bool use, long long start) { origin.store(start); active.store(use); }
void observeInstructionThread(DWORD thread, bool rendering) { identities[rendering ? 1 : 0].store(thread); }
unsigned instructionPollDelay() {
    if (!enabled.load() || !active.load()) return 0;
    constexpr unsigned delays[]{4, 7, 5, 9, 6};
    return delays[poll++ % 5];
}

void sampleInstructions() {
    if (!enabled.load() || !active.load()) return;
    const auto capture = generation.load();
    const auto base = origin.load();
    for (size_t i = 0; i < targets.size(); ++i) {
        const auto id = identities[i].load();
        if (!id || id == GetCurrentThreadId() || (i && id == identities[0].load())) continue;
        auto& target = targets[i];
        DWORD exitCode = 0;
        if (target.handle && (!GetExitCodeThread(target.handle, &exitCode) || exitCode != STILL_ACTIVE)) {
            CloseHandle(target.handle); target = {};
        }
        if (id != target.id) {
            if (target.handle) CloseHandle(target.handle);
            target = {id, OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION, FALSE, id)};
            if (target.handle && GetProcessIdOfThread(target.handle) != GetCurrentProcessId()) {
                CloseHandle(target.handle); target.handle = nullptr;
            }
        }
        ++totals.attempts;
        if (!target.handle) { ++totals.failed; continue; }
        const auto previous = SuspendThread(target.handle);
        if (previous == ~0u) { ++totals.failed; continue; }
        // While paused: only kernel context/counter reads, no allocation,
        // locks, module lookup, symbol resolution, Lua or logging.
        Resume resume(target.handle);
        const auto stamp = ticks();
        CONTEXT context{}; context.ContextFlags = CONTEXT_CONTROL;
        ULONG64 cycles = 0;
        const bool contextValid = previous == 0 && GetThreadContext(target.handle, &context);
        const bool cycleValid = contextValid && QueryThreadCycleTime(target.handle, &cycles);
        StreamInstruction record{};
        StreamLuaInstruction lua{};
        LuaSource source{};
        if (contextValid) {
            auto frame = context.Ebp;
            for (; record.returnCount < 4; ++record.returnCount) {
                if (frame < context.Esp || static_cast<std::uint64_t>(frame) + 8 > static_cast<std::uint64_t>(context.Esp) + 8 * 1024 * 1024 || frame % 4) break;
                DWORD pair[2]{}; SIZE_T read = 0;
                if (!ReadProcessMemory(GetCurrentProcess(), reinterpret_cast<void*>(frame), pair, sizeof(pair), &read) || read != sizeof(pair) || !pair[1]) break;
                record.returns[record.returnCount] = pair[1];
                if (pair[0] <= frame) { ++record.returnCount; break; }
                frame = pair[0];
            }
            if (id == identities[0].load()) lua = readLuaContext(source);
        }
        resume.finish();
        const auto end = ticks();
        const auto pause = static_cast<std::uint64_t>(end - stamp);
        totals.pauseTotal += pause;
        totals.pauseMaximum = (std::max)(totals.pauseMaximum, pause);
        if (resume.result == ~0u) { ++totals.failed; enabled.store(false); return; }
        if (previous) { ++totals.skipped; continue; }
        if (!contextValid || !context.Eip) { ++totals.failed; continue; }
        if (!active.load() || generation.load() != capture || stamp < base) continue;
        totals.timestamp = static_cast<std::uint64_t>(stamp - base);
        ++totals.successes;
        if (samples.size() == 1024) { ++totals.omitted; continue; }
        const unsigned roles = (id == identities[0].load() ? 2u : 0u) | (id == identities[1].load() ? 4u : 0u);
        record.timestamp = static_cast<std::uint64_t>(stamp - base); record.address = context.Eip; record.cycles = cycles; record.pause = pause;
        record.thread = id; record.flags = roles | (cycleValid ? 1u : 0u);
        samples.push_back(record);
        if (id == identities[0].load()) {
            lua.timestamp = record.timestamp; lua.thread = id;
            if (source.length) {
                const auto key = std::make_pair(std::string(source.text, source.length), source.line);
                auto found = sourceIds.find(key);
                if (found == sourceIds.end() && sourceIds.size() < 5000) {
                    const auto sourceId = static_cast<unsigned>(sourceIds.size() + 1);
                    std::ostringstream out(std::ios::binary); Writer writer{out};
                    writer.put<std::uint32_t>(sourceId); writer.put<std::int32_t>(source.line); writer.string(key.first);
                    sourceDefinitions.push_back(out.str());
                    found = sourceIds.emplace(key, sourceId).first;
                }
                if (found != sourceIds.end()) lua.source = found->second;
                else lua.flags |= 2;
            }
            luaSamples.push_back(lua);
        }
    }
}

std::vector<StreamInstruction> drainInstructionSamples(StreamSamplingStats& stats) {
    stats = totals;
    std::vector<StreamInstruction> result; result.swap(samples); samples.reserve(1024);
    return result;
}
std::vector<StreamLuaInstruction> drainLuaInstructionSamples() {
    std::vector<StreamLuaInstruction> result;
    result.swap(luaSamples); luaSamples.reserve(1024);
    return result;
}
std::vector<std::string> drainLuaInstructionSources() {
    std::vector<std::string> result;
    result.swap(sourceDefinitions);
    return result;
}
}
