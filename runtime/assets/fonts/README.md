# IPL replacement fonts

`font_western.bin` and `font_japanese.bin` are Dolphin's replacement system fonts, from
`Data/Sys/GC/` in https://github.com/dolphin-emu/dolphin (GPL-2.0-or-later). Wii Sports Resort reads
the console's system font from the IPL ROM; `runtime/src/resort_ipl_rom.cpp` serves these instead of
Nintendo's ROM data. ResortCompiled downloads the same files in its setup.sh.

| File | Bytes | SHA-256 |
| --- | --- | --- |
| font_western.bin | 6478 | 4ad991be2b0aa305f09b90a79fc50f57833b30b008890b5ef1336cc3d9d0bae0 |
| font_japanese.bin | 259626 | 38f9f59d505bc4e2d86b0196706195f33ad72b7fe9d029cf263072cde19d044f |
