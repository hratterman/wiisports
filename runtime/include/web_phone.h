#pragma once

// [web] Phone-as-Wii-Remote input (runtime/src/platform/web/web_phone.cpp, web/js/library_wsr_phone.js).
// The page receives the phone's motion sensors and buttons over the network (web/site/phone-link.js)
// and writes them into a ring in wasm memory; the virtual Wii Remote (resort_wiimote_kbm.cpp) drains
// that ring on its own schedule. Nothing here runs guest code and no JS callback enters wasm.
//
// Sensor frame is SDL3's fixed device axes, which match a phone held upright in portrait with the
// screen facing you: +X right, +Y towards the top of the phone, +Z out of the screen. The phone's top
// edge is the remote's tip. Gyro is rad/s, acceleration is m/s^2 support force (+9.81 on the axis
// pointing up when still), as SDL reports both.

#include <cstdint>

namespace WebPhone {

struct Report {
    uint64_t timeNs;   // phone sensor time, monotonic per connection
    float gyro[3];
    float acc[3];
    uint32_t pad;
};
static_assert(sizeof(Report) == 40);

// Wii Remote button bits as the page sends them; the same values as resort_wiimote_kbm.cpp's kBtn*.
enum Button : uint32_t {
    kLeft = 0x0001, kRight = 0x0002, kDown = 0x0004, kUp = 0x0008, kPlus = 0x0010,
    k2 = 0x0100, k1 = 0x0200, kB = 0x0400, kA = 0x0800, kMinus = 0x1000, kHome = 0x8000,
    kZ = 0x2000, kC = 0x4000,   // Nunchuk
};

// Extra controls the page sends next to the Wii Remote buttons.
enum Flag : uint32_t {
    kFlagRecenter = 0x1,   // hold to recenter the pointer (like the DualSense right-stick click)
    kFlagShake = 0x2,      // on-screen shake button for phones whose accelerometer is too noisy
    kFlagNunchuk = 0x4,    // a Nunchuk is attached (Archery, Cycling, anything that asks for one)
    kFlagNunchukShake = 0x8,  // shake the Nunchuk hand
    kFlagPedal = 0x10,     // the Nunchuk mirrors the phone's motion in the opposite direction (Cycling)
};

// True while a phone is linked and has sent a report recently (the page clears it on disconnect).
bool Connected() noexcept;
// A new value whenever the page links a different phone or relinks; resets the remote's state.
uint32_t Generation() noexcept;
uint32_t Buttons() noexcept;
uint32_t Flags() noexcept;
// Nunchuk stick, -1..1 each, up positive.
void Stick(double& x, double& y) noexcept;

// Calls `sink` for every report written since the previous drain, oldest first. When the ring
// overflowed in between, the oldest reports are dropped.
template <typename Sink>
void Drain(Sink&& sink) noexcept;

namespace detail {
static constexpr uint32_t kRingSize = 256;
struct State {
    uint32_t version;      // 1
    uint32_t connected;
    uint32_t generation;
    uint32_t buttons;
    uint32_t flags;
    uint32_t writeCount;   // written by JS after the report itself
    uint32_t readCount;    // C++ only
    int16_t stickX;        // Nunchuk stick, -1000..1000, up positive
    int16_t stickY;
    Report reports[kRingSize];
};
State& Get() noexcept;
} // namespace detail

template <typename Sink>
void Drain(Sink&& sink) noexcept {
    auto& s = detail::Get();
    const uint32_t write = s.writeCount;
    if (write - s.readCount > detail::kRingSize) s.readCount = write - detail::kRingSize;
    for (; s.readCount != write; ++s.readCount) sink(s.reports[s.readCount % detail::kRingSize]);
}

} // namespace WebPhone
