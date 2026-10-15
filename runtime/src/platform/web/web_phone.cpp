#include "web_phone.h"

#include <cstddef>

// web/js/library_wsr_phone.js: remembers where each slot's ring lives so the page can write into it.
extern "C" void wsr_phone_attach(uint32_t slot, void* state, uint32_t size, uint32_t reportsOffset, uint32_t ringSize);

namespace WebPhone {
namespace detail {

namespace {
State g_state[kSlots]{};
bool g_attached = false;
} // namespace

State& Get(uint32_t slot) noexcept {
    if (!g_attached) {
        g_attached = true;
        for (uint32_t i = 0; i < kSlots; ++i) {
            g_state[i].version = 1;
            wsr_phone_attach(i, &g_state[i], sizeof(State), offsetof(State, reports), kRingSize);
        }
    }
    return g_state[slot < kSlots ? slot : 0];
}

} // namespace detail

bool Connected(uint32_t slot) noexcept { return slot < kSlots && detail::Get(slot).connected != 0; }
uint32_t Generation(uint32_t slot) noexcept { return detail::Get(slot).generation; }
uint32_t Buttons(uint32_t slot) noexcept { return detail::Get(slot).buttons; }
uint32_t Flags(uint32_t slot) noexcept { return detail::Get(slot).flags; }
void NoteSample(const DebugSample& sample, uint32_t slot) noexcept { detail::Get(slot).debug = sample; }
void Orientation(double q[4], double& halfX, double& halfY, uint32_t slot) noexcept {
    const auto& s = detail::Get(slot);
    for (int i = 0; i < 4; ++i) q[i] = s.orientation[i];
    halfX = s.halfX;
    halfY = s.halfY;
}
void Stick(double& x, double& y, uint32_t slot) noexcept {
    const auto& s = detail::Get(slot);
    x = s.stickX / 1000.0;
    y = s.stickY / 1000.0;
}

} // namespace WebPhone
