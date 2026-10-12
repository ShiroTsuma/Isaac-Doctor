#include "instruction_samples.hpp"
#include <atomic>
#include <array>
#include <algorithm>

namespace ip {
namespace {
std::atomic<bool> enabled{false}, active{false};
std::atomic<long long> origin{0};
std::atomic<unsigned> generation{0};
std::array<std::atomic<DWORD>, 2> identities{};
struct Target { DWORD id = 0; HANDLE handle = nullptr; };
std::array<Target, 2> targets{};
std::vector<StreamInstruction> samples;
StreamSamplingStats totals{};
unsigned poll = 0;

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
    totals = {}; poll = 0;
    enabled.store(use);
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
    }
}

std::vector<StreamInstruction> drainInstructionSamples(StreamSamplingStats& stats) {
    stats = totals;
    std::vector<StreamInstruction> result; result.swap(samples); samples.reserve(1024);
    return result;
}
}
