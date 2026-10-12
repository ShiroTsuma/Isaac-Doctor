#pragma once
#include "stream.hpp"

namespace ip {
void configureInstructionSamples(bool enabled);
void setInstructionClock(bool active, long long origin);
void observeInstructionThread(DWORD thread, bool rendering);
void sampleInstructions();
unsigned instructionPollDelay();
std::vector<StreamInstruction> drainInstructionSamples(StreamSamplingStats& stats);
}
