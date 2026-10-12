#include "control.hpp"
#include <tlhelp32.h>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <vector>

namespace {
struct Handle {
    HANDLE value = nullptr;
    explicit Handle(HANDLE h = nullptr) : value(h) {}
    ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
};
void require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(std::string(message) + " (Windows error " + std::to_string(GetLastError()) + ")");
}
DWORD defaultPid() {
    Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
    require(snapshot.value != INVALID_HANDLE_VALUE, "Cannot enumerate processes");
    PROCESSENTRY32W entry{sizeof(entry)};
    std::vector<DWORD> found;
    if (Process32FirstW(snapshot.value, &entry)) do {
        if (_wcsicmp(entry.szExeFile, L"isaac-ng.exe") == 0) found.push_back(entry.th32ProcessID);
    } while (Process32NextW(snapshot.value, &entry));
    if (found.size() != 1) throw std::runtime_error("Expected one running isaac-ng.exe; use --pid to choose a process.");
    return found.front();
}
std::uintptr_t moduleBase(DWORD pid, const std::wstring& name) {
    Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid));
    require(snapshot.value != INVALID_HANDLE_VALUE, "Cannot enumerate target modules");
    MODULEENTRY32W entry{sizeof(entry)};
    if (Module32FirstW(snapshot.value, &entry)) do {
        if (_wcsicmp(entry.szModule, name.c_str()) == 0) return reinterpret_cast<std::uintptr_t>(entry.modBaseAddr);
    } while (Module32NextW(snapshot.value, &entry));
    throw std::runtime_error("Required module was not found in target process.");
}
bool mappingExists(DWORD pid) {
    Handle mapping(OpenFileMappingW(FILE_MAP_READ, FALSE, ip::mapping_name(pid).c_str()));
    return mapping.value != nullptr;
}
void attach(DWORD pid, const std::filesystem::path& dll) {
    Handle process(OpenProcess(PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION | PROCESS_VM_OPERATION |
        PROCESS_VM_WRITE | PROCESS_VM_READ, FALSE, pid));
    require(process.value != nullptr, "Cannot open target process");
    BOOL targetWow = FALSE, selfWow = FALSE;
    require(IsWow64Process(process.value, &targetWow) && IsWow64Process(GetCurrentProcess(), &selfWow), "Cannot check architecture");
    if (targetWow != selfWow) throw std::runtime_error("Target must be x86, matching this injector.");
    if (mappingExists(pid)) return;
    if (!std::filesystem::is_regular_file(dll)) throw std::runtime_error("Profiler DLL does not exist.");
    // LoadLibraryW may be forwarded to KernelBase: resolve its actual owner and
    // use the target module base plus RVA, rather than assuming equal ASLR bases.
    auto load = GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "LoadLibraryW");
    require(load != nullptr, "Cannot resolve LoadLibraryW");
    HMODULE owner = nullptr;
    require(GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        reinterpret_cast<LPCWSTR>(load), &owner), "Cannot resolve LoadLibraryW owner");
    wchar_t ownerPath[32768]{}; GetModuleFileNameW(owner, ownerPath, 32768);
    const auto remote = moduleBase(pid, std::filesystem::path(ownerPath).filename().wstring()) +
        (reinterpret_cast<std::uintptr_t>(load) - reinterpret_cast<std::uintptr_t>(owner));
    const auto wide = dll.wstring();
    const SIZE_T bytes = (wide.size() + 1) * sizeof(wchar_t);
    void* argument = VirtualAllocEx(process.value, nullptr, bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    require(argument != nullptr, "Cannot allocate DLL path in target");
    SIZE_T written = 0;
    if (!WriteProcessMemory(process.value, argument, wide.c_str(), bytes, &written) || written != bytes) {
        VirtualFreeEx(process.value, argument, 0, MEM_RELEASE);
        require(false, "Cannot write DLL path");
    }
    Handle thread(CreateRemoteThread(process.value, nullptr, 0, reinterpret_cast<LPTHREAD_START_ROUTINE>(remote), argument, 0, nullptr));
    if (!thread.value) { VirtualFreeEx(process.value, argument, 0, MEM_RELEASE); require(false, "Cannot create load thread"); }
    const auto wait = WaitForSingleObject(thread.value, 15000);
    if (wait != WAIT_OBJECT_0) {
        // The target thread may still be reading the path; do not free live memory.
        throw std::runtime_error("Load thread did not finish within 15 seconds; restart the target before retrying.");
    }
    DWORD result = 0;
    const bool gotCode = GetExitCodeThread(thread.value, &result) != 0;
    VirtualFreeEx(process.value, argument, 0, MEM_RELEASE);
    require(gotCode && result != 0, "LoadLibraryW failed in target");
    for (int i = 0; i < 100 && !mappingExists(pid); ++i) Sleep(100);
    if (!mappingExists(pid)) throw std::runtime_error("DLL loaded but control channel did not initialize.");
}
const char* stateName(LONG state) {
    switch (state) {
    case ip::loading: return "loading";
    case ip::waiting_lua: return "waiting-lua";
    case ip::ready: return "ready";
    case ip::recording: return "recording";
    case ip::failed: return "failed";
    case ip::armed: return "armed";
    default: return "unknown";
    }
}
}

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc < 2) {
            std::cout << "IsaacProf 0.11\nCommands: attach | status | record | stop | catalog\n"
                "Options: --pid PID (default: isaac-ng.exe), --dll PATH, --seconds 15\n"
                "Timeline: --trace [--events 250000 (pending ring capacity)] [--min-us 0]\n"
                "Minimum: 1000 us = 1 ms; shorter calls remain in aggregate totals.\n"
                "Triggers: --start-on immediate|run-load|room-entry|level-entry|projectile|tear|effect|npc|damage|run-end|game-exit\n"
                "         --stop-on duration|manual|run-load|room-entry|level-entry|projectile|tear|effect|npc|damage|run-end|game-exit\n"
                "         --start-delay-ms 0..3600000 --stop-delay-ms 0..3600000; --after-load aliases --start-on run-load\n"
                "         --max-duration-ms 0..3600000: independent hard limit after collection begins; 0 disables it\n"
                "Scope: --channels MASK (default 8191), repeated --mod NAME and --hook NAME/ID; empty filters select all.\n"
                "Filmstrip: --screenshots [--screenshot-ms 500] (320x180 PNG, max 240)\n"
                "Examples:\n  isaacprof-injector attach\n  isaacprof-injector record --seconds 15\n";
            return 0;
        }
        const std::wstring command = argv[1];
        DWORD pid = 0;
        LONG seconds = 15;
        LONG eventLimit = 250000, minimumUs = 0;
        bool trace = false, afterLoad = false, screenshots = false;
        LONG screenshotMs = 500;
        LONG startOn = ip::immediate, stopOn = ip::duration, startDelayMs = 0, stopDelayMs = 0;
        LONG maxDurationMs = 0;
        bool startSpecified = false; LONG channels = ip::allChannels; std::string selectedMods, selectedHooks;
        wchar_t exe[32768]{}; GetModuleFileNameW(nullptr, exe, 32768);
        auto dll = std::filesystem::path(exe).parent_path() / "isaacprof.dll";
        for (int i = 2; i < argc; ++i) {
            const std::wstring option = argv[i];
            if (option == L"--trace") { trace = true; continue; }
            if (option == L"--after-load") { afterLoad = true; continue; }
            if (option == L"--screenshots") { screenshots = true; continue; }
            if (i + 1 >= argc) throw std::runtime_error("Option needs a value.");
            const std::wstring value = argv[++i];
            size_t consumed = 0;
            if (option == L"--pid") {
                const auto number = std::stoul(value, &consumed);
                if (consumed != value.size() || number == 0) throw std::runtime_error("Invalid PID.");
                pid = number;
            } else if (option == L"--seconds") {
                seconds = std::stol(value, &consumed);
                if (consumed != value.size() || seconds < 1 || seconds > 3600) throw std::runtime_error("Duration must be 1..3600 seconds.");
            } else if (option == L"--events") {
                eventLimit = std::stol(value, &consumed);
                if (consumed != value.size() || eventLimit < 1 || eventLimit > 2000000) throw std::runtime_error("Pending event capacity must be 1..2000000.");
            } else if (option == L"--min-us") {
                minimumUs = std::stol(value, &consumed);
                if (consumed != value.size() || minimumUs < 0 || minimumUs > 1000000) throw std::runtime_error("Minimum duration must be 0..1000000 us.");
            } else if (option == L"--screenshot-ms") {
                screenshotMs = std::stol(value, &consumed);
                if (consumed != value.size() || screenshotMs < 250 || screenshotMs > 10000) throw std::runtime_error("Screenshot interval must be 250..10000 ms.");
            } else if (option == L"--start-on" || option == L"--stop-on") {
                LONG trigger = -1;
                for (LONG j = ip::immediate; j <= ip::manual; ++j) {
                    const std::string key = ip::triggerNames[j];
                    if (value == std::wstring(key.begin(), key.end())) trigger = j;
                }
                if (trigger < 0 || (option == L"--start-on" && trigger > ip::game_exit) || (option == L"--stop-on" && trigger == ip::immediate))
                    throw std::runtime_error("Invalid capture trigger; see --help.");
                if (option == L"--start-on") { startOn = trigger; startSpecified = true; } else stopOn = trigger;
            } else if (option == L"--max-duration-ms") {
                maxDurationMs = std::stol(value, &consumed);
                if (consumed != value.size() || maxDurationMs < 0 || maxDurationMs > 3600000) throw std::runtime_error("Maximum duration must be 0..3600000 ms; 0 disables it.");
            } else if (option == L"--start-delay-ms" || option == L"--stop-delay-ms") {
                const auto delay = std::stol(value, &consumed);
                if (consumed != value.size() || delay < 0 || delay > 3600000) throw std::runtime_error("Trigger delay must be 0..3600000 ms.");
                if (option == L"--start-delay-ms") startDelayMs = delay; else stopDelayMs = delay;
            } else if (option == L"--channels") {
                channels = std::stol(value, &consumed);
                if (consumed != value.size() || channels < 0 || (channels & ~ip::allChannels)) throw std::runtime_error("Invalid channel mask.");
            } else if (option == L"--mod" || option == L"--hook") {
                if (value.empty() || value.find_first_of(L"\r\n") != std::wstring::npos) throw std::runtime_error("Invalid scope name.");
                const auto bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
                if (!bytes) throw std::runtime_error("Invalid Unicode scope name.");
                std::string name(static_cast<size_t>(bytes), '\0');
                WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), name.data(), bytes, nullptr, nullptr);
                auto& scope = option == L"--mod" ? selectedMods : selectedHooks;
                if (scope.size() + name.size() + 1 >= 4096) throw std::runtime_error("Scope exceeds 4095 UTF-8 bytes.");
                scope += name + "\n";
            } else if (option == L"--dll") dll = std::filesystem::absolute(value);
            else throw std::runtime_error("Unknown option.");
        }
        if (command != L"attach" && command != L"status" && command != L"record" && command != L"stop" && command != L"catalog")
            throw std::runtime_error("Unknown command.");
        if (afterLoad) {
            if (startSpecified && startOn != ip::run_load) throw std::runtime_error("--after-load conflicts with --start-on.");
            startOn = ip::run_load;
        }
        if (!pid) pid = defaultPid();
        // A named mutex serializes all controller clients for this PID.
        const auto mutexName = ip::mapping_name(pid) + L"-controller";
        Handle controllerMutex(CreateMutexW(nullptr, FALSE, mutexName.c_str()));
        require(controllerMutex.value != nullptr, "Cannot create controller mutex");
        const auto acquired = WaitForSingleObject(controllerMutex.value, 15000);
        if (acquired != WAIT_OBJECT_0 && acquired != WAIT_ABANDONED) throw std::runtime_error("Another controller is busy.");
        struct Unlock { HANDLE h; ~Unlock() { ReleaseMutex(h); } } unlock{controllerMutex.value};
        if (command == L"attach") attach(pid, std::filesystem::absolute(dll));
        Handle mapping(OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, ip::mapping_name(pid).c_str()));
        require(mapping.value != nullptr, "Profiler is not attached; run attach first");
        auto* control = static_cast<ip::Control*>(MapViewOfFile(mapping.value, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(ip::Control)));
        require(control != nullptr, "Cannot open control channel");
        struct Unmap { void* p; ~Unmap() { UnmapViewOfFile(p); } } unmap{control};
        if (control->version != ip::protocol) throw std::runtime_error("Controller and game protocol versions differ. Restart the game through REPENTOGONLauncher.");
        if (command == L"record" || command == L"stop" || command == L"catalog") {
            if (command == L"catalog") control->catalogJson[0] = '\0';
            if (command == L"record") {
            InterlockedExchange(&control->channels, channels);
            strcpy_s(control->selectedMods, selectedMods.c_str()); strcpy_s(control->selectedHooks, selectedHooks.c_str());
            InterlockedExchange(&control->seconds, seconds);
            InterlockedExchange(&control->trace, trace ? 1 : 0);
            InterlockedExchange(&control->eventLimit, eventLimit);
            InterlockedExchange(&control->minimumUs, minimumUs);
            InterlockedExchange(&control->afterLoad, afterLoad ? 1 : 0);
            InterlockedExchange(&control->screenshots, screenshots ? 1 : 0);
            InterlockedExchange(&control->screenshotMs, screenshotMs);
            InterlockedExchange(&control->startTrigger, startOn);
            InterlockedExchange(&control->stopTrigger, stopOn);
            InterlockedExchange(&control->startDelayMs, startDelayMs);
            InterlockedExchange(&control->stopDelayMs, stopDelayMs);
            InterlockedExchange(&control->maxDurationMs, maxDurationMs);
            }
            InterlockedExchange(&control->command, command == L"catalog" ? ip::catalog : command == L"record" ? ip::start : ip::stop);
            const auto request = InterlockedIncrement(&control->request);
            for (int i = 0; i < 100 && ip::read(&control->acknowledged) != request; ++i) Sleep(100);
            if (ip::read(&control->acknowledged) != request) throw std::runtime_error("Controller timed out waiting for the DLL.");
        }
        if (command == L"catalog") {
            if (control->commandError[0]) throw std::runtime_error(control->commandError);
            if (!control->catalogJson[0]) throw std::runtime_error(control->message);
            std::cout << control->catalogJson << '\n'; return 0;
        }
        const bool commandFailed = (command == L"record" || command == L"stop") && control->commandError[0];
        const std::string message = commandFailed ? std::string("ERROR: ") + control->commandError : control->message;
        std::cout << "PID " << pid << " | " << stateName(ip::read(&control->state)) << " | "
            << ip::read(&control->wrapped) << " registered metrics\n" << message << '\n';
        if (control->report[0]) { const auto path = std::filesystem::path(control->report).u8string();
            std::cout << "Report: " << std::string(reinterpret_cast<const char*>(path.data()), path.size()) << '\n'; }
        std::cout << "Triggers: "; bool firstTrigger = true;
        for (LONG i = ip::immediate; i <= ip::manual; ++i) if (ip::read(&control->availableTriggers) & (1L << i)) {
            std::cout << (firstTrigger ? "" : ",") << ip::triggerNames[i]; firstTrigger = false;
        }
        std::cout << '\n';
        return ip::read(&control->state) == ip::failed || commandFailed || message.starts_with("ERROR:") ? 1 : 0;
    } catch (const std::exception& error) { std::cerr << "Error: " << error.what() << '\n'; return 1; }
}
