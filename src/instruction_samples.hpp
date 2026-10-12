#pragma once
#include "stream.hpp"

namespace ip {
void configureInstructionSamples(bool enabled);
void setInstructionClock(bool active, long long origin);
void observeInstructionThread(DWORD thread, bool rendering);
void sampleInstructions();
unsigned instructionPollDelay();
std::vector<StreamInstruction> drainInstructionSamples(StreamSamplingStats& stats);
void validateLuaInstructionLayout(void* state, const void* closure, const void* callback, unsigned metric, int top);
void setLuaInstructionState(void* state);
std::vector<StreamLuaInstruction> drainLuaInstructionSamples();
void validateLuaSourceLayout(const void* closure, const char* source, size_t length, int line, int lastLine);
std::vector<std::string> drainLuaInstructionSources();
}
