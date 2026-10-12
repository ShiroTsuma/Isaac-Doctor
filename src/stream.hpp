#pragma once
#include "control.hpp"
#include "binary.hpp"
#include <array>
#include <cstring>
#include <vector>

namespace ip {
constexpr std::uint32_t streamVersion = 3, chunkMagic = 0x4b4e4843;
constexpr std::uint32_t packetBytes = 2 * 1024 * 1024, packetSlots = 4;
enum ChunkType : std::uint16_t { metadataChunk = 1, eventsChunk = 2, screenshotChunk = 3, lossChunk = 4, indexChunk = 5, previewChunk = 6, frameChunk = 7, countersChunk = 8, heapChunk = 9, markersChunk = 10, inventoryChunk = 11, contextChunk = 12, overheadChunk = 13, errorChunk = 14, configurationChunk = 15, presentationChunk = 16 };
// QPC ticks for wall spans; raw thread CPU cycles are never converted to time.
// Interval runs from the previous SwapBuffers return to this one's return.
struct StreamPresentation {
    std::uint64_t start, duration, id, swapStart, swapDuration, readbackStart, readbackDuration, cycles, swapCycles;
    std::uint32_t thread, flags;
};
static_assert(sizeof(StreamPresentation) == 80);
struct StreamContext {
    std::uint64_t timestamp;
    std::int32_t room, stage, stageType, roomType;
    std::uint32_t width, height, gridSlots, grids, entities, enemies, tears, projectiles, effects, pickups, valid, reserved;
};
struct StreamOverhead {
    std::uint64_t timestamp, calls, samples, wrapperTicks, observerTicks, auxiliaryDropped, contextFailures, errorsOmitted;
};
static_assert(sizeof(StreamContext) == 72 && sizeof(StreamOverhead) == 64);
constexpr std::uint16_t intervalFlag = 0x8000;
constexpr std::uint16_t heapFlag = 0x4000, markerFlag = 0x2000;
struct StreamCounters { std::uint64_t timestamp, workingSet, privateBytes, pageFaults, processUser, processKernel, threadUser, threadKernel; std::uint32_t thread, valid; };
struct StreamHeap { std::uint64_t timestamp, bytes; };
struct StreamMarker { std::uint64_t timestamp, run, room, level; std::uint32_t kind, flags; std::uint64_t reserved; };
static_assert(sizeof(StreamCounters) == 72 && sizeof(StreamHeap) == 16 && sizeof(StreamMarker) == 48);
struct StreamInterval { std::uint64_t id, start, duration; std::uint32_t kind, thread; };
static_assert(sizeof(StreamInterval) == 32);
// Fixed, pointer-free Win32/Win64 ABI. Publication uses aligned 32-bit Interlocked operations.
struct alignas(8) StreamEvent {
    std::uint32_t metric, thread;
    std::uint16_t depth, flags;
    std::uint32_t parentMetric;
    std::uint64_t span, parent, start, duration, self, frame;
};
static_assert(sizeof(StreamEvent) == 64);
struct alignas(8) Packet { std::uint32_t size, type; std::array<char, packetBytes> bytes; };
struct alignas(8) StreamHeader {
    std::uint32_t version, capacity, pid, flags;
    std::uint64_t frequency, start;
    volatile LONG write, read, packetWrite, packetRead, done, ready, failed, producerBusy, started, reserved;
    std::uint64_t dropped, firstLoss, lastLoss;
    char error[256];
    Packet packets[packetSlots];
};
static_assert(offsetof(StreamHeader, packets) == 352);
inline StreamEvent* streamEvents(StreamHeader* h) { return reinterpret_cast<StreamEvent*>(reinterpret_cast<char*>(h) + sizeof(StreamHeader)); }
inline std::wstring streamName(DWORD pid, ULONGLONG session) { return mapping_name(pid) + L"-stream-" + std::to_wstring(session); }
inline bool publish(StreamHeader* h, const StreamEvent& e) {
    if (!h || read(&h->failed)) return false;
    if (InterlockedCompareExchange(&h->producerBusy, 1, 0)) return false;
    const auto w = static_cast<std::uint32_t>(read(&h->write));
    const auto r = static_cast<std::uint32_t>(read(&h->read));
    const bool room = w - r < h->capacity;
    if (room) { streamEvents(h)[w % h->capacity] = e; InterlockedExchange(&h->write, static_cast<LONG>(w + 1)); }
    InterlockedExchange(&h->producerBusy, 0);
    return room;
}
inline bool packet(StreamHeader* h, std::uint32_t type, const std::string& bytes) {
    if (bytes.size() > packetBytes) throw std::runtime_error("Stream metadata packet exceeds 2 MiB.");
    const auto w = static_cast<std::uint32_t>(read(&h->packetWrite));
    if (w - static_cast<std::uint32_t>(read(&h->packetRead)) == packetSlots) return false;
    auto& p = h->packets[w % packetSlots]; p.size = static_cast<std::uint32_t>(bytes.size()); p.type = type;
    memcpy(p.bytes.data(), bytes.data(), bytes.size()); InterlockedExchange(&h->packetWrite, static_cast<LONG>(w + 1)); return true;
}
inline std::uint32_t crc32(const char* bytes, size_t size) {
    static const auto table = [] { std::array<std::uint32_t, 256> t{}; for (std::uint32_t i = 0; i < 256; ++i) { auto c = i; for (int j = 0; j < 8; ++j) c = (c >> 1) ^ (0xedb88320u & (0u - (c & 1))); t[i] = c; } return t; }();
    std::uint32_t c = ~0u; for (size_t i = 0; i < size; ++i) c = table[(c ^ static_cast<unsigned char>(bytes[i])) & 255] ^ (c >> 8); return ~c;
}
struct IndexEntry { std::uint64_t offset, minimum, maximum; std::uint32_t count; std::uint16_t type, version; std::uint32_t bytes, crc; };
static_assert(sizeof(IndexEntry) == 40);
inline IndexEntry writeChunk(std::ostream& out, std::uint64_t sequence, std::uint16_t type, const char* bytes, std::uint32_t size,
    std::uint32_t count = 0, std::uint64_t minimum = 0, std::uint64_t maximum = 0) {
    IndexEntry e{static_cast<std::uint64_t>(out.tellp()), minimum, maximum, count, type, 1, size, crc32(bytes, size)};
    Writer w{out}; w.put(chunkMagic); w.put(type); w.put<std::uint16_t>(1); w.put(size); w.put(count);
    w.put(sequence); w.put(minimum); w.put(maximum); w.put(e.crc); w.put<std::uint32_t>(0);
    out.write(bytes, size); if (!out) throw std::runtime_error("Streaming capture write failed (disk full or unavailable)."); return e;
}
}
