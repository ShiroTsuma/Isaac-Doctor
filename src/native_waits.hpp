#pragma once
#include "stream.hpp"
#include <vector>

namespace ip {
void installWaitHooks();
void configureWaits(bool enabled);
void setWaitClock(bool active, long long origin);
void observeWaitThread(DWORD thread, bool rendering);
unsigned waitHookMask();
std::vector<StreamWait> drainWaits(std::uint64_t& omitted);
}
