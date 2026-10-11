#include "stream.hpp"
#include <algorithm>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <map>
#include <tuple>

int wmain(int argc, wchar_t** argv) {
    ip::StreamHeader* shared = nullptr; HANDLE mapping = nullptr, process = nullptr;
    try {
        if (argc != 4) throw std::runtime_error("Usage: isaacprof-collector MAPPING OUTPUT PID");
        const auto pid = static_cast<DWORD>(std::stoul(argv[3]));
        mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, argv[1]);
        if (!mapping) throw std::runtime_error("Cannot open producer mapping.");
        shared = static_cast<ip::StreamHeader*>(MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, 0));
        if (!shared || shared->version != ip::streamVersion || !shared->capacity || shared->capacity > 2000000 || !shared->frequency)
            throw std::runtime_error("Unsupported producer mapping.");
        process = OpenProcess(SYNCHRONIZE, FALSE, pid);
        if (!process) throw std::runtime_error("Cannot monitor producer process.");
        // Verify the destination before reporting readiness; armed captures create no file.
        const std::filesystem::path path(argv[2]);
        if (!std::filesystem::is_directory(path.parent_path())) throw std::runtime_error("Capture directory is missing.");
        InterlockedExchange(&shared->ready, 1);
        while (!ip::read(&shared->done) && !ip::read(&shared->started) && WaitForSingleObject(process, 0) != WAIT_OBJECT_0) Sleep(2);
        if (!ip::read(&shared->started)) { UnmapViewOfFile(shared); CloseHandle(mapping); CloseHandle(process); return 0; }
        std::ofstream out(path, std::ios::binary | std::ios::trunc);
        if (!out) throw std::runtime_error("Cannot open streaming capture file.");
        ip::Writer writer{out}; out.write(ip::captureMagic.data(), 8); writer.put(ip::streamVersion); writer.put<std::uint32_t>(40);
        writer.put(shared->pid); writer.put(shared->flags); writer.put(shared->frequency); writer.put(shared->start);
        std::vector<ip::IndexEntry> index;
        std::uint64_t sequence = 0; ULONGLONG flushed = 0;
        std::vector<ip::StreamEvent> batch; batch.reserve(4096);
        for (;;) {
            auto r = static_cast<std::uint32_t>(ip::read(&shared->read));
            const auto w = static_cast<std::uint32_t>(ip::read(&shared->write));
            const auto available = w - r;
            if (available > shared->capacity) throw std::runtime_error("Invalid producer ring state.");
            if (available) {
                const auto count = std::min(available, 4096u); batch.resize(count);
                for (std::uint32_t i = 0; i < count; ++i) batch[i] = ip::streamEvents(shared)[(r + i) % shared->capacity];
                InterlockedExchange(&shared->read, static_cast<LONG>(r + count));
                std::vector<ip::StreamHeap> heaps;
                std::vector<ip::StreamMarker> markers;
                for (const auto& e : batch) {
                    if (e.flags == ip::heapFlag) heaps.push_back({e.start, e.span});
                    if (e.flags == ip::markerFlag) markers.push_back({e.start, e.span, e.parent, e.duration, e.parentMetric, static_cast<std::uint32_t>(e.self), 0});
                }
                if (!heaps.empty()) index.push_back(ip::writeChunk(out, sequence++, ip::heapChunk, reinterpret_cast<const char*>(heaps.data()), static_cast<std::uint32_t>(heaps.size() * sizeof(ip::StreamHeap)), static_cast<std::uint32_t>(heaps.size()), heaps.front().timestamp, heaps.back().timestamp));
                if (!markers.empty()) index.push_back(ip::writeChunk(out, sequence++, ip::markersChunk, reinterpret_cast<const char*>(markers.data()), static_cast<std::uint32_t>(markers.size() * sizeof(ip::StreamMarker)), static_cast<std::uint32_t>(markers.size()), markers.front().timestamp, markers.back().timestamp));
                batch.erase(std::remove_if(batch.begin(), batch.end(), [](const auto& e) { return e.flags == ip::heapFlag || e.flags == ip::markerFlag; }), batch.end());
                std::vector<ip::StreamInterval> intervals;
                for (const auto& e : batch) if (e.flags == ip::intervalFlag) {
                    if (e.metric || (e.parentMetric != 1 && e.parentMetric != 2)) throw std::runtime_error("Invalid interval record.");
                    intervals.push_back({e.span, e.start, e.duration, e.parentMetric, e.thread});
                }
                if (!intervals.empty()) {
                    std::uint64_t minimum = intervals.front().start, maximum = 0;
                    for (const auto& e : intervals) { minimum = std::min(minimum, e.start); maximum = std::max(maximum, e.start + e.duration); }
                    index.push_back(ip::writeChunk(out, sequence++, ip::frameChunk, reinterpret_cast<const char*>(intervals.data()),
                        static_cast<std::uint32_t>(intervals.size() * sizeof(ip::StreamInterval)), static_cast<std::uint32_t>(intervals.size()), minimum, maximum));
                }
                batch.erase(std::remove_if(batch.begin(), batch.end(), [](const auto& e) { return e.flags == ip::intervalFlag; }), batch.end());
                if (!batch.empty()) {
                std::sort(batch.begin(), batch.end(), [](const auto& a, const auto& b) { return a.start == b.start ? a.depth < b.depth : a.start < b.start; });
                std::uint64_t minimum = batch.front().start, maximum = 0, self = 0;
                for (const auto& e : batch) { maximum = std::max(maximum, e.start + e.duration); self += e.self; }
                std::string payload(sizeof(self) + batch.size() * sizeof(ip::StreamEvent), '\0');
                memcpy(payload.data(), &self, sizeof(self)); memcpy(payload.data() + sizeof(self), batch.data(), batch.size() * sizeof(ip::StreamEvent));
                index.push_back(ip::writeChunk(out, sequence++, ip::eventsChunk, payload.data(), static_cast<std::uint32_t>(payload.size()), static_cast<std::uint32_t>(batch.size()), minimum, maximum));
                // At most 16 representatives per thread/depth. Raw records remain authoritative.
                std::map<std::tuple<std::uint32_t, std::uint16_t, unsigned>, ip::StreamEvent> representatives;
                for (const auto& e : batch) {
                    const auto bucket = static_cast<unsigned>(std::min<std::uint64_t>(15, (e.start - minimum) * 16 / std::max<std::uint64_t>(1, maximum - minimum)));
                    const auto key = std::make_tuple(e.thread, e.depth, bucket);
                    const auto found = representatives.find(key);
                    if (found == representatives.end() || e.duration > found->second.duration) representatives[key] = e;
                }
                std::string preview(sizeof(self) + representatives.size() * sizeof(ip::StreamEvent), '\0'); memcpy(preview.data(), &self, sizeof(self));
                size_t position = sizeof(self); for (const auto& [key, e] : representatives) { memcpy(preview.data() + position, &e, sizeof(e)); position += sizeof(e); }
                index.push_back(ip::writeChunk(out, sequence++, ip::previewChunk, preview.data(), static_cast<std::uint32_t>(preview.size()), static_cast<std::uint32_t>(representatives.size()), minimum, maximum));
                }
            }
            auto pr = static_cast<std::uint32_t>(ip::read(&shared->packetRead));
            const auto pw = static_cast<std::uint32_t>(ip::read(&shared->packetWrite));
            if (pw - pr > ip::packetSlots) throw std::runtime_error("Invalid producer packet state.");
            while (pr != pw) {
                const auto& p = shared->packets[pr % ip::packetSlots];
                if (p.size > ip::packetBytes) throw std::runtime_error("Invalid producer packet size.");
                const bool counter = p.type == ip::countersChunk || p.type == ip::contextChunk || p.type == ip::overheadChunk || p.type == ip::errorChunk;
                if ((p.type == ip::countersChunk && p.size != sizeof(ip::StreamCounters)) ||
                    (p.type == ip::contextChunk && p.size != sizeof(ip::StreamContext)) ||
                    (p.type == ip::overheadChunk && p.size != sizeof(ip::StreamOverhead)) ||
                    (p.type == ip::errorChunk && (p.size < 32 || p.size > 20600))) throw std::runtime_error("Invalid diagnostic packet.");
                std::uint64_t timestamp = 0; if (counter) memcpy(&timestamp, p.bytes.data(), sizeof(timestamp));
                index.push_back(ip::writeChunk(out, sequence++, static_cast<std::uint16_t>(p.type), p.bytes.data(), p.size, counter ? 1u : 0u, timestamp, timestamp));
                InterlockedExchange(&shared->packetRead, static_cast<LONG>(++pr));
            }
            const bool dead = WaitForSingleObject(process, 0) == WAIT_OBJECT_0;
            if ((ip::read(&shared->done) || dead) && ip::read(&shared->read) == ip::read(&shared->write) && ip::read(&shared->packetRead) == ip::read(&shared->packetWrite)) {
                const auto indexOffset = static_cast<std::uint64_t>(out.tellp());
                ip::writeChunk(out, sequence++, ip::indexChunk, reinterpret_cast<const char*>(index.data()), static_cast<std::uint32_t>(index.size() * sizeof(ip::IndexEntry)), static_cast<std::uint32_t>(index.size()));
                out.write("IPEND003", 8); writer.put(indexOffset); writer.put<std::uint32_t>(static_cast<std::uint32_t>(index.size() * sizeof(ip::IndexEntry))); writer.put<std::uint32_t>(0); writer.put(sequence);
                out.flush(); if (!out) throw std::runtime_error("Cannot finish streaming capture."); break;
            }
            if (GetTickCount64() - flushed >= 1000) { out.flush(); if (!out) throw std::runtime_error("Cannot flush streaming capture."); flushed = GetTickCount64(); }
            if (!available) Sleep(2);
        }
        InterlockedExchange(&shared->ready, 2);
        UnmapViewOfFile(shared); CloseHandle(mapping); CloseHandle(process); return 0;
    } catch (const std::exception& error) {
        if (shared) { strncpy_s(shared->error, error.what(), _TRUNCATE); InterlockedExchange(&shared->failed, 1); }
        std::cerr << error.what() << '\n'; if (shared) UnmapViewOfFile(shared); if (mapping) CloseHandle(mapping); if (process) CloseHandle(process); return 1;
    }
}
