#pragma once
#include <cstdint>
#include <vector>

namespace ip {
struct Screenshot { double timeNs; std::uint16_t width, height; std::vector<unsigned char> png; };
struct ScreenshotSnapshot {
    std::uint32_t intervalMs = 0, omitted = 0;
    std::uint64_t overheadNs = 0;
    std::vector<Screenshot> images;
};
// GPU readback runs only in the owning GL context; PNG encoding runs in the worker.
void installScreenshotHook();
void configureScreenshots(bool enabled, unsigned intervalMs);
void setScreenshotClock(bool recording, long long start, long long frequency);
void processScreenshots();
ScreenshotSnapshot screenshotSnapshot();
}
