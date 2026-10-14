# Provenance

This repo combines two GPLv3 forks of WiiCompiled into a browser build of Wii Sports Resort.
Every vendored file came from one of these exact commits.

| Upstream | Commit | Date | Used for |
| --- | --- | --- | --- |
| [dynamiteswag81/webcompiled](https://github.com/dynamiteswag81/webcompiled) | `b19270fb9c1590673528a52d34ce4afb780cbee5` | 2026-10-10 | Base tree: translator, aurora, web pipeline, web runtime layer |
| [redluigi323/ResortCompiled](https://github.com/redluigi323/ResortCompiled) | `604878918c5384cbc0b3928c6bc58877ff3c3128` | 2026-10-04 | Wii Sports Resort runtime (`runtime/wsr`), project files, patches |
| [patchzyy/Wiicompiled](https://github.com/patchzyy/Wiicompiled) | `a88b7b502b620d38384e39aa7813c4ebae9a1f0c` | 2026-09-29 | Merge base: the commit ResortCompiled's runtime was re-keyed from |
| [patchzyy/Wiicompiled](https://github.com/patchzyy/Wiicompiled) | `bd219e38a3e9a1a5047ce41d8cd01210bef3af43` | 2026-10-09 | The commit webcompiled forked from |

Left out of the webcompiled snapshot: the native `Launcher/`, `projects/mkwii/`, the Windows
batch files and `web/prebuilt/web-prebuilt.tar.xz` (prebuilt wasm libraries; rebuilt from source
here instead).

No game data is in this repo. The disc, `main.dol`, extracted files and anything the translator
generates from them stay on the machine that runs the build.
