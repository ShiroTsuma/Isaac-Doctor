#include "native_waits.hpp"
#include <MinHook.h>
#include <intrin.h>
#include <array>
#include <atomic>
#include <mutex>

namespace ip {
namespace {
std::atomic<bool> enabled{false}, active{false};
std::atomic<unsigned> generation{0};
std::atomic<long long> origin{0};
std::atomic<DWORD> luaThread{0}, renderThread{0};
std::atomic<std::uint64_t> dropped{0};
std::mutex mutex;
std::array<StreamWait, 4096> records;
size_t count = 0;
unsigned hookMask = 0;
thread_local bool observing = false;
bool shouldObserve() {
    return !observing && enabled.load(std::memory_order_relaxed) &&
        active.load(std::memory_order_relaxed);
}
decltype(&Sleep) sleepOriginal = nullptr;
decltype(&SleepEx) sleepExOriginal = nullptr;
decltype(&WaitForSingleObject) singleOriginal = nullptr;
decltype(&WaitForSingleObjectEx) singleExOriginal = nullptr;
decltype(&WaitForMultipleObjects) multipleOriginal = nullptr;
decltype(&WaitForMultipleObjectsEx) multipleExOriginal = nullptr;

long long ticks() {
    LARGE_INTEGER value{};
    QueryPerformanceCounter(&value);
    return value.QuadPart;
}

// Nested forwarding implementations must not count the same wait twice.
// The profiler worker and unrelated engine threads are deliberately excluded.
struct Observation {
    bool measured = false;
    unsigned capture = 0;
    long long start = 0;
    std::uint64_t caller = 0;
    DWORD thread = 0;

    explicit Observation(void* address) {
        thread = GetCurrentThreadId();
        if (!observing && enabled.load(std::memory_order_relaxed) &&
            active.load(std::memory_order_relaxed) &&
            (thread == luaThread.load() || thread == renderThread.load())) {
            observing = true;
            measured = true;
            capture = generation.load();
            caller = reinterpret_cast<std::uintptr_t>(address);
            start = ticks();
        }
    }

    ~Observation() { if (measured) observing = false; }

    void finish(unsigned kind, DWORD requested, DWORD result, long long end) {
        if (!measured) return;
        const auto base = origin.load();
        if (active.load() && enabled.load() && generation.load() == capture &&
            start >= base && end > start) {
            // Never wait for a recorder mutex on a game thread.
            std::unique_lock lock(mutex, std::try_to_lock);
            if (!lock.owns_lock()) {
                ++dropped;
            } else if (generation.load() == capture && active.load()) {
                if (count < records.size()) {
                    records[count++] = {static_cast<std::uint64_t>(start - base),
                        static_cast<std::uint64_t>(end - start), caller,
                        requested, thread, kind, result};
                } else {
                    ++dropped;
                }
            }
        }
        observing = false;
    }
};

void WINAPI sleepHook(DWORD milliseconds) {
    if (!shouldObserve()) { sleepOriginal(milliseconds); return; }
    const DWORD before = GetLastError();
    Observation span(_ReturnAddress());
    SetLastError(before);
    sleepOriginal(milliseconds);
    const DWORD error = GetLastError();
    const auto end = span.measured ? ticks() : 0;
    span.finish(1, milliseconds, 0, end);
    SetLastError(error);
}

DWORD WINAPI sleepExHook(DWORD milliseconds, BOOL alertable) {
    if (!shouldObserve()) return sleepExOriginal(milliseconds, alertable);
    const DWORD before = GetLastError();
    Observation span(_ReturnAddress());
    SetLastError(before);
    const auto result = sleepExOriginal(milliseconds, alertable);
    const DWORD error = GetLastError();
    span.finish(2, milliseconds, result, span.measured ? ticks() : 0);
    SetLastError(error);
    return result;
}

DWORD WINAPI singleHook(HANDLE handle, DWORD milliseconds) {
    if (!shouldObserve()) return singleOriginal(handle, milliseconds);
    const DWORD before = GetLastError();
    Observation span(_ReturnAddress());
    SetLastError(before);
    const auto result = singleOriginal(handle, milliseconds);
    const DWORD error = GetLastError();
    span.finish(3, milliseconds, result, span.measured ? ticks() : 0);
    SetLastError(error);
    return result;
}

DWORD WINAPI singleExHook(HANDLE handle, DWORD milliseconds, BOOL alertable) {
    if (!shouldObserve()) return singleExOriginal(handle, milliseconds, alertable);
    const DWORD before = GetLastError();
    Observation span(_ReturnAddress());
    SetLastError(before);
    const auto result = singleExOriginal(handle, milliseconds, alertable);
    const DWORD error = GetLastError();
    span.finish(4, milliseconds, result, span.measured ? ticks() : 0);
    SetLastError(error);
    return result;
}

DWORD WINAPI multipleHook(DWORD size, const HANDLE* handles, BOOL all, DWORD milliseconds) {
    if (!shouldObserve()) return multipleOriginal(size, handles, all, milliseconds);
    const DWORD before = GetLastError();
    Observation span(_ReturnAddress());
    SetLastError(before);
    const auto result = multipleOriginal(size, handles, all, milliseconds);
    const DWORD error = GetLastError();
    span.finish(5, milliseconds, result, span.measured ? ticks() : 0);
    SetLastError(error);
    return result;
}

DWORD WINAPI multipleExHook(DWORD size, const HANDLE* handles, BOOL all, DWORD milliseconds, BOOL alertable) {
    if (!shouldObserve()) return multipleExOriginal(size, handles, all, milliseconds, alertable);
    const DWORD before = GetLastError();
    Observation span(_ReturnAddress());
    SetLastError(before);
    const auto result = multipleExOriginal(size, handles, all, milliseconds, alertable);
    const DWORD error = GetLastError();
    span.finish(6, milliseconds, result, span.measured ? ticks() : 0);
    SetLastError(error);
    return result;
}

template<class T> void install(T& original, const char* name, void* hook, unsigned bit) {
    const auto target = GetProcAddress(GetModuleHandleW(L"kernel32.dll"), name);
    if (target && MH_CreateHook(reinterpret_cast<void*>(target), hook,
        reinterpret_cast<void**>(&original)) == MH_OK) hookMask |= bit;
}
}

void installWaitHooks() {
    install(sleepOriginal, "Sleep", reinterpret_cast<void*>(sleepHook), 1);
    install(sleepExOriginal, "SleepEx", reinterpret_cast<void*>(sleepExHook), 2);
    install(singleOriginal, "WaitForSingleObject", reinterpret_cast<void*>(singleHook), 4);
    install(singleExOriginal, "WaitForSingleObjectEx", reinterpret_cast<void*>(singleExHook), 8);
    install(multipleOriginal, "WaitForMultipleObjects", reinterpret_cast<void*>(multipleHook), 16);
    install(multipleExOriginal, "WaitForMultipleObjectsEx", reinterpret_cast<void*>(multipleExHook), 32);
}

void configureWaits(bool use) {
    enabled.store(false);
    std::lock_guard lock(mutex);
    ++generation;
    count = 0;
    dropped.store(0);
    enabled.store(use);
}

void setWaitClock(bool use, long long start) { origin.store(start); active.store(use); }
void observeWaitThread(DWORD thread, bool rendering) {
    (rendering ? renderThread : luaThread).store(thread);
}
unsigned waitHookMask() { return hookMask; }
std::vector<StreamWait> drainWaits(std::uint64_t& omitted) {
    std::lock_guard lock(mutex);
    std::vector<StreamWait> result(records.begin(), records.begin() + count);
    count = 0;
    omitted = dropped.exchange(0);
    return result;
}
}
