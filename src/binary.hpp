#pragma once
#include <cstdint>
#include <istream>
#include <ostream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <type_traits>

namespace ip {
constexpr std::string_view captureMagic = "ISAACPRF";
constexpr std::uint32_t captureVersion = 2;
// Windows x86 is little-endian. Fields are written individually, never as
// compiler-dependent padded structs. See docs/FORMAT.md for the wire layout.
struct Writer {
    std::ostream& out;
    template<class T> void put(T value) {
        static_assert(std::is_arithmetic_v<T>);
        out.write(reinterpret_cast<const char*>(&value), sizeof(value));
    }
    void string(const std::string& value) {
        put(static_cast<std::uint32_t>(value.size()));
        out.write(value.data(), value.size());
    }
};
struct Reader {
    std::istream& in;
    template<class T> T get() {
        static_assert(std::is_arithmetic_v<T>);
        T value{};
        if (!in.read(reinterpret_cast<char*>(&value), sizeof(value))) throw std::runtime_error("Truncated capture file.");
        return value;
    }
    std::string string() {
        const auto size = get<std::uint32_t>();
        if (size > 1048576) throw std::runtime_error("Invalid capture string length.");
        std::string value(size, '\0');
        if (!in.read(value.data(), size)) throw std::runtime_error("Truncated capture string.");
        return value;
    }
    std::uint32_t header() {
        char magic[8];
        if (!in.read(magic, 8) || std::string_view(magic, 8) != captureMagic)
            throw std::runtime_error("Unsupported binary capture format/version.");
        const auto version = get<std::uint32_t>();
        if (version != 1 && version != 2 && version != 3) throw std::runtime_error("Unsupported binary capture format/version.");
        return version;
    }
};
}
