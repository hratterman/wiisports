#include "web_phone.h"

#include <cstddef>

// web/js/library_wsr_phone.js: remembers where the ring lives so the page can write into it.
extern "C" void wsr_phone_attach(void* state, uint32_t size, uint32_t reportsOffset, uint32_t ringSize);

namespace WebPhone {
namespace detail {

namespace {
State g_state{};
bool g_attached = false;
} // namespace

State& Get() noexcept {
    if (!g_attached) {
        g_attached = true;
        g_state.version = 1;
        wsr_phone_attach(&g_state, sizeof(State), offsetof(State, reports), kRingSize);
    }
    return g_state;
}

} // namespace detail

bool Connected() noexcept { return detail::Get().connected != 0; }
uint32_t Generation() noexcept { return detail::Get().generation; }
uint32_t Buttons() noexcept { return detail::Get().buttons; }
uint32_t Flags() noexcept { return detail::Get().flags; }
void NoteSample(const DebugSample& sample) noexcept { detail::Get().debug = sample; }
void Orientation(double q[4], double& halfX, double& halfY) noexcept {
    const auto& s = detail::Get();
    for (int i = 0; i < 4; ++i) q[i] = s.orientation[i];
    halfX = s.halfX;
    halfY = s.halfY;
}
void Stick(double& x, double& y) noexcept {
    const auto& s = detail::Get();
    x = s.stickX / 1000.0;
    y = s.stickY / 1000.0;
}

} // namespace WebPhone
