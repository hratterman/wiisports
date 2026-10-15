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
//
// Two phones can be linked at once, one per slot: slot 0 is player 1's remote (WPAD channel 0) and
// slot 1 is player 2's (channel 1). Each slot has its own ring.

#include <cstddef>
#include <cstdint>

namespace WebPhone {

inline constexpr uint32_t kSlots = 2;

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
    kFlagAbsolute = 0x20,  // calibrated absolute orientation is valid (Orientation() below)
};

// True while a phone is linked and has sent a report recently (the page clears it on disconnect).
bool Connected(uint32_t slot = 0) noexcept;
// A new value whenever the page links a different phone or relinks; resets the remote's state.
uint32_t Generation(uint32_t slot = 0) noexcept;
uint32_t Buttons(uint32_t slot = 0) noexcept;
uint32_t Flags(uint32_t slot = 0) noexcept;
// Nunchuk stick, -1..1 each, up positive.
void Stick(double& x, double& y, uint32_t slot = 0) noexcept;

// The phone's calibrated orientation, already in the virtual remote's frame: a unit quaternion
// (w, x, y, z) taking remote-body vectors (X right, Y out of the phone's face, Z towards the player,
// so the tip points along -Z) to the screen frame (X right, Y up, Z out of the screen towards the
// player). Identity is the phone held screen up, pointing at the middle of the screen. halfX/halfY
// are the calibrated half-angles (radians) from the screen's middle to its right and top edges.
// Valid while Flags() has kFlagAbsolute.
void Orientation(double q[4], double& halfX, double& halfY, uint32_t slot = 0) noexcept;

// What the virtual remote last handed the game, for the page's debug readout (Module.wsrPhone.debug()).
struct DebugSample {
    float posX, posY;        // pointer, -1..1 (valid only when pointerValid)
    float roll;              // radians
    float gyro[3];           // body rad/s after bias correction
    float acc[3];            // KPAD g
    float stick[2];
    float nunchukAcc[3];
    uint32_t hold;
    uint8_t pointerValid, nunchuk, devType, mplsMode;
};
void NoteSample(const DebugSample& sample, uint32_t slot = 0) noexcept;
// The game's own MotionPlus solver output for the newest sample (KPADStatus 0xB0..0xEC: rate,
// angle, dirX, dirY, dirZ, 15 floats), for the debug readout. valid is false while MotionPlus is off.
void NoteMpls(const float mpls[15], bool valid, uint32_t slot = 0) noexcept;

// Calls `sink` for every report written since the previous drain, oldest first. When the ring
// overflowed in between, the oldest reports are dropped.
template <typename Sink>
void Drain(uint32_t slot, Sink&& sink) noexcept;

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
    DebugSample debug;     // offset 32, written by C++ only
    float orientation[4];  // offset 96: w, x, y, z (see Orientation())
    float halfX, halfY;    // offset 112, 116: radians
    Report reports[kRingSize];
    float mpls[15];        // after the ring, written by C++ only (NoteMpls)
    uint32_t mplsValid;
};
State& Get(uint32_t slot = 0) noexcept;
// web/js/library_wsr_phone.js hardcodes these.
static_assert(sizeof(DebugSample) == 64);
static_assert(offsetof(State, stickX) == 28 && offsetof(State, debug) == 32);
static_assert(offsetof(State, orientation) == 96 && offsetof(State, halfX) == 112);
} // namespace detail

template <typename Sink>
void Drain(uint32_t slot, Sink&& sink) noexcept {
    auto& s = detail::Get(slot);
    const uint32_t write = s.writeCount;
    if (write - s.readCount > detail::kRingSize) s.readCount = write - detail::kRingSize;
    for (; s.readCount != write; ++s.readCount) sink(s.reports[s.readCount % detail::kRingSize]);
}

} // namespace WebPhone
