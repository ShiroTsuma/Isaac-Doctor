#include "binary.hpp"
#include "stream.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <stdexcept>
#include <vector>
#include <sstream>

struct Row {
    std::string label, location;
    unsigned long long calls = 0, errors = 0;
    double inclusive = 0, exclusive = 0, maximum = 0;
};
int wmain(int argc, wchar_t** argv) {
    try {
        if (argc < 2) {
            std::cout << "Usage: isaacprof-analyze CAPTURE.isaacprof [--callbacks] [--top N]\n"
                "Ranks by exclusive callback wall time. Native API time remains included.\n";
            return 0;
        }
        bool callbacks = false;
        size_t top = 20;
        for (int i = 2; i < argc; ++i) {
            const std::wstring option = argv[i];
            if (option == L"--callbacks") callbacks = true;
            else if (option == L"--top" && i + 1 < argc) {
                size_t consumed = 0; const std::wstring value = argv[++i];
                top = std::stoul(value, &consumed);
                if (!top || top > 100000 || consumed != value.size()) throw std::runtime_error("Invalid --top value.");
            } else throw std::runtime_error("Unknown analyzer option.");
        }
        std::ifstream input(std::filesystem::path(argv[1]), std::ios::binary);
        if (!input) throw std::runtime_error("Cannot open capture file.");
        ip::Reader outer{input}; auto version = outer.header();
        std::istringstream aggregate; std::istream* body = &input;
        std::uint32_t streamScreenshots = 0; bool finalized = false;
        if (version == 3) {
            if (outer.get<std::uint32_t>() != 40) throw std::runtime_error("Invalid streaming header.");
            std::array<char, 24> header{}; if (!input.read(header.data(), header.size())) throw std::runtime_error("Truncated streaming header.");
            std::string metadata;
            for (;;) {
                char marker[8]{}; if (!input.read(marker, 8)) break;
                if (std::string_view(marker, 8) == "IPEND003") { std::array<char, 24> tail{}; finalized = static_cast<bool>(input.read(tail.data(), tail.size())); break; }
                std::uint32_t magic; std::uint16_t type, blockVersion; memcpy(&magic, marker, 4); memcpy(&type, marker + 4, 2); memcpy(&blockVersion, marker + 6, 2);
                if (magic != ip::chunkMagic) throw std::runtime_error("Invalid streaming block magic.");
                const auto bytes = outer.get<std::uint32_t>(); outer.get<std::uint32_t>(); outer.get<std::uint64_t>(); outer.get<std::uint64_t>(); outer.get<std::uint64_t>();
                const auto crc = outer.get<std::uint32_t>(); outer.get<std::uint32_t>();
                if (bytes > 64 * 1024 * 1024 || (type <= 5 && blockVersion != 1)) throw std::runtime_error("Unsupported streaming block.");
                std::string payload(bytes, '\0'); if (!input.read(payload.data(), bytes)) break;
                if (ip::crc32(payload.data(), payload.size()) != crc) throw std::runtime_error("Streaming block checksum failed.");
                if (type == ip::metadataChunk) metadata = std::move(payload);
                if (type == ip::screenshotChunk) ++streamScreenshots;
            }
            if (metadata.empty()) throw std::runtime_error("No recoverable aggregate metadata.");
            aggregate.str(metadata); body = &aggregate; ip::Reader nested{aggregate}; version = nested.header();
        }
        ip::Reader reader{*body}; auto flags = reader.get<std::uint32_t>();
        if (body != &input && !finalized) flags &= ~1u;
        const auto pid = reader.get<std::uint32_t>(); reader.get<std::uint32_t>();
        const auto duration = reader.get<double>(); reader.get<std::uint64_t>();
        if (duration < 0 || !std::isfinite(duration)) throw std::runtime_error("Invalid capture duration.");
        reader.get<std::uint32_t>();
        const auto metricCount = reader.get<std::uint32_t>(), eventCount = reader.get<std::uint32_t>(); reader.get<std::uint32_t>();
        if (metricCount > 100000 || eventCount > 2000000) throw std::runtime_error("Invalid binary record counts.");
        const auto dropped = reader.get<std::uint64_t>(), skipped = reader.get<std::uint64_t>();
        reader.get<std::uint64_t>(); reader.get<std::uint64_t>(); reader.get<std::uint64_t>(); reader.get<double>();
        reader.string(); reader.string(); reader.string();
        std::map<std::string, Row> groups;
        double totalExclusive = 0;
        for (std::uint32_t i = 0; i < metricCount; ++i) {
            reader.get<std::uint32_t>(); const auto line = reader.get<std::int32_t>();
            const auto calls = reader.get<std::uint64_t>(), errors = reader.get<std::uint64_t>();
            const auto inclusive = reader.get<double>(), exclusive = reader.get<double>();
            reader.get<double>(); const auto maximum = reader.get<double>();
            const auto mod = reader.string(), callbackId = reader.string(), callbackName = reader.string(), source = reader.string(), function = reader.string();
            const auto location = source + ":" + std::to_string(line);
            const auto key = callbacks ? mod + " | " + (callbackName.empty() ? callbackId : callbackName) + " | " + function : mod;
            auto& row = groups[key]; row.label = key; row.location = callbacks ? location : "";
            row.calls += calls;
            row.errors += errors;
            if (!std::isfinite(inclusive) || !std::isfinite(exclusive) || !std::isfinite(maximum) ||
                exclusive < 0 || inclusive < exclusive || maximum < 0 || errors > calls)
                throw std::runtime_error("Invalid metric timing values.");
            row.inclusive += inclusive; row.exclusive += exclusive;
            row.maximum = std::max(row.maximum, maximum); totalExclusive += exclusive;
        }
        std::array<char, 36> event{};
        for (std::uint32_t i = 0; i < eventCount; ++i) if (!body->read(event.data(), event.size())) throw std::runtime_error("Truncated event block.");
        std::uint32_t screenshots = streamScreenshots;
        if (version == 2) {
            const auto storedScreenshots = reader.get<std::uint32_t>(); reader.get<std::uint32_t>(); reader.get<std::uint32_t>(); reader.get<std::uint64_t>();
            screenshots += storedScreenshots;
            if (screenshots > 240) throw std::runtime_error("Invalid screenshot count.");
            for (std::uint32_t i = 0; i < storedScreenshots; ++i) {
                const auto time = reader.get<double>(); const auto width = reader.get<std::uint16_t>(), height = reader.get<std::uint16_t>();
                const auto encoding = reader.get<std::uint32_t>(), size = reader.get<std::uint32_t>();
                if (!std::isfinite(time) || time < 0 || time > duration || !width || !height || width > 320 || height > 240 || encoding != 1 || size > 1048576 || size < 8) throw std::runtime_error("Invalid screenshot record.");
                std::vector<char> bytes(size); if (!body->read(bytes.data(), size)) throw std::runtime_error("Truncated screenshot.");
                if (std::string_view(bytes.data(), 8) != std::string_view("\x89PNG\r\n\x1a\n", 8)) throw std::runtime_error("Invalid PNG screenshot.");
            }
        }
        if (body->peek() != std::char_traits<char>::eof()) throw std::runtime_error("Trailing capture bytes.");
        std::vector<Row> rows;
        for (auto& [key, row] : groups) rows.push_back(std::move(row));
        std::sort(rows.begin(), rows.end(), [](const Row& a, const Row& b) { return a.exclusive > b.exclusive; });
        std::cout << std::fixed << std::setprecision(3) << "IsaacProf | PID " << pid << " | "
            << duration / 1e9 << " s | " << ((flags & 1) ? "complete" : "partial snapshot") << '\n'
            << "Measured callback time (nested calls subtracted): " << totalExclusive / 1e6 << " ms\n"
            << "Dropped calls: " << dropped << " | skipped coroutine calls: " << skipped << "\n\n"
            << "Screenshots: " << screenshots << "\n"
            << "Self ms      Incl ms      Max ms       Calls       Errors  Mod / callback\n";
        for (size_t i = 0; i < std::min(top, rows.size()); ++i) {
            const auto& r = rows[i];
            std::cout << std::setw(11) << r.exclusive / 1e6 << " " << std::setw(11) << r.inclusive / 1e6 << " "
                << std::setw(11) << r.maximum / 1e6 << " " << std::setw(11) << r.calls << " "
                << std::setw(6) << r.errors << "  " << r.label << '\n';
            if (callbacks) std::cout << "    " << r.location << '\n';
        }
        if (rows.empty()) std::cout << "No measured callbacks. Confirm game activity and callback coverage.\n";
        std::cout << "\nSelf subtracts only nested instrumented callbacks; native API time is included.\n"
            "This capture does not measure all engine work or establish the cause of a frame stall.\n";
        return 0;
    } catch (const std::exception& error) { std::cerr << "Error: " << error.what() << '\n'; return 1; }
}
