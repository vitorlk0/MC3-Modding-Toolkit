# MC3 Modding Toolkit

Offline desktop workspace for Midnight Club 3: DUB Edition Remix car mods, built with Tauri. It
works on a vehicle as a whole: the Player, Garage (`_g`) and Opponent (`_o`) PCKs plus the loose
`mesh.pck` files that sit beside them. The interface is available in English and Portuguese.

> **Fan-made tool.** Not affiliated with or endorsed by Rockstar Games or Take-Two Interactive.
> Midnight Club is their trademark. This repository contains no game files: you need your own copy
> of the game to use it.

## Download

Get the latest build from the **Releases** page. There are two:

- **`MC3 Modding Toolkit.exe`** (about 10 MB): for almost everyone. Windows 11 and current
  Windows 10 already have the WebView2 runtime it needs. Download and run it, nothing is installed.
- **`MC3 Modding Toolkit <version> (portable).zip`** (about 360 MB): only if the exe opens an error
  saying it "Could not find the WebView2 Runtime" (Windows Server, LTSC, N editions, debloated
  installs). Extract it to a short path such as `C:\MC3ModTool` and run the exe inside. Keep the
  `wv2` folder next to the exe.

Use **Open vehicle folder** and select the directory holding the three car PCKs to have the roles
discovered automatically; missing roles stay available as manual file slots. The folder can also be
dropped onto the window. Keep a backup of your files anyway.

## Tabs

| Tab | What it does |
| --- | --- |
| **Tools** | Loose-file tools: Visual Shop menu editor, Carcfg Randomizer, Flash Parts Mapper, Car PCK Mesh Injector, Mesh ID Sync, Car PCK Cleaner, Vehicle DAT Builder and Compact ISO |
| **Anchors** | Anchor positions with a 3D preview, multi-select, mirroring and wheel/exhaust sync |
| **Meshes** | Piece IDs, shader IDs, re-embedding loose `mesh.pck` files and OBJ export |
| **Performance** | Vehicle physics and performance values across all three PCKs at once |
| **Textures** | Finds, previews and replaces PS2 textures in a PCK |
| **Audio** | Engine audio curves and values, with an audible preview from the game's sound banks |
| **ISO Install** | Installs the finished cars straight into the game's ISO |

## Credits

Built on the community's investigation of the game's files: Bruno (@offlbruno) and ZNX (@znxee)
for the research and base code behind the PCK format; @ZNXee171 and @mc3rxx (Performance Editor);
EdnessP (`dave.py`); RibeiroG (MC3 ISO Direct Explorer). Special thanks to Almightypear, Rato.jpg and
RibeiroG. Toolkit by [@mid_engine](https://youtube.com/@mid_engine). The full list is in
**Help ▸ About**.

## How it edits

**Everything is edited in memory. Nothing is written to disk until you explicitly save.** Opening,
editing, undoing and switching between tabs never touch a file; the only writes in the whole
application happen inside the save action, and every destination is read back and byte-compared
before the document is marked as saved.

## Anchor Editor

- Detects PS2 `0x44` and PSP `0x60` anchor layouts, reading the parent/child/next hierarchy.
- Edits A1 and A2 as little-endian `float32` values, with undo/redo, clipboard actions and
  dedicated `Copy Values` / `Paste Values` controls per anchor.
- Supports horizontal value scrubbing in every coordinate field (`Shift` fine, `Ctrl` fast),
  recorded as one undo step per drag.
- Accepts arithmetic in the coordinate fields — `1.5+0.25`, `10-5`, `2*1.5`, `10/4`, parentheses.
  The field already holds its current value, so appending an operation is the usual gesture.
  Nothing is implicit: a bare `*2` is not a relative operation, it just reverts the field, as does
  anything else that isn't a complete expression.
- Sets every taillight glow anchor at once from the **Global light anchors** panel: type the
  left-hand XYZ on the `tail`, `rev` or `brake` row and press its `Set`. The value goes to every
  taillight variant, with X flipped for the right side and the same value in A1 and A2. Each row is
  applied on its own and is its own undo step.
- Mirroring, pasting and dragging across a multi-selection are each a single undo step.
- Multi-selects anchors (`Ctrl`+click to toggle, `Shift`+click for a range) and moves them together
  in the 3D view via a translation gizmo (`Ctrl+G`).
- Offsets a whole selection by a relative step from the **Offset** panel: enter XYZ, press `Move`,
  and every selected anchor advances from its own current position (A1 and A2 alike). The fields
  keep their values, so clicking again steps by the same amount.
- Mirrors the selected anchors across X in one step (`Ctrl+Shift+M`, the `Mirror` button, or
  `Edit ▸ Mirror anchors on X`), recorded as a single undo step.
- Synchronizes changed anchors, plus validated PS2 wheel and exhaust runtime positions, to the
  other loaded roles when saving.
- Previews the car with Three.js, decoding standalone PS2 `mesh.pck` geometry, and can load
  optional `exhaust.ppf`, `rim.ppf` and `tire.ppf` files as reference placeholders with a
  synchronized 13–30 inch rim-size selector. PPFs are never modified.

## Mesh Editor

- Colors the model by shader ID and identifies the piece, material group and shader behind any
  triangle you click.
- Edits a piece's **ID**, mirrored across the HLOD/MLOD/LLOD tables, every embedded copy and the
  loose `mesh.pck`.
- Edits a piece's **shader IDs** per material group, written to every loaded PCK that embeds the
  piece and to the loose file. Pending values show amber until saved.
- **Re-embeds** a loose `mesh.pck` into the PCKs that bake it in, handling a piece whose mesh
  changed size, and **inserts** pieces that have a table row but no embedded copy yet. Shell-family
  pieces go into every PCK that has a row for them; customization parts go into the garage PCK
  alone. `Sync all` does both in one pass.
- Re-embedding is idempotent: repeating it reuses the block the piece already occupies instead of
  appending a duplicate, and saving reclaims space left by earlier copies.

## Building

Requires Node.js 22.13.0+, pnpm and the Rust toolchain. A build writes the executable and an NSIS
installer:

```text
src-tauri\target\release\MC3 Modding Toolkit.exe
src-tauri\target\release\bundle\nsis\MC3 Modding Toolkit_<version>_x64-setup.exe
```

If `cargo` is not on the inherited PATH, reload it before building:

```powershell
nvm use 22.13.0
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","User") + ";" + [System.Environment]::GetEnvironmentVariable("Path","Machine")
pnpm typecheck
pnpm tauri build
```

`pnpm dev` runs the app in a dev window with hot reload. Close `MC3 Modding Toolkit.exe` first before a release
build — a running instance locks the output file.

There is no browser mode. The `@tauri-apps/*` packages need the real Tauri runtime, and
`getCurrentWindow()` runs during the first render, so serving `dist/` over plain HTTP gets you a
blank page and a console error rather than a working app.

## Distributing it

The app draws its interface with WebView2 — the whole interface, the 3D viewer and every file
engine run inside it, with Rust doing little more than opening the window. Windows 11 and current
Windows 10 ship WebView2, so `pnpm tauri build` produces a 10 MB exe that runs anywhere on its own.
That is the build to hand out.

Some installs have no WebView2 — Server, LTSC, N editions, debloated images with Edge stripped —
and there a bare exe fails with "Could not find the WebView2 Runtime" before drawing anything. For
those, `pnpm package:portable` builds a second kind that carries its own engine, merging
`src-tauri/tauri.portable.conf.json` over the normal config to set `webviewInstallMode` to
`fixedRuntime`. Nothing about the day-to-day build changes, and there is no flag to remember: the
overlay applies only inside that one script.

The two are not interchangeable. A `fixedRuntime` build **does not** fall back to an installed
WebView2 — with no reachable `wv2` folder beside it, the window opens empty and no renderer starts.
So the portable exe must always travel with its folder, and the ordinary exe must never be shipped
to someone without WebView2.

The runtime folder is **not in the repository** — it is 800 MB. Download the x64 fixed-version
from the [WebView2 download page](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)
(Fixed Version, x64) and expand the `.cab` into `src-tauri/wv2/`, so that
`src-tauri/wv2/msedgewebview2.exe` exists:

```powershell
expand.exe Microsoft.WebView2.FixedVersionRuntime.<version>.x64.cab -F:* src-tauri\_cab
Move-Item src-tauri\_cab\Microsoft.WebView2.FixedVersionRuntime.<version>.x64 src-tauri\wv2
```

Then build the package to send:

```powershell
pnpm package:portable
```

It writes `dist-portable/` — a folder of about 810 MB and a zip of about 360 MB. The recipient
extracts it and runs the exe; nothing is installed and no internet is needed. Before compressing,
the script launches the staged copy and checks that a titled window appears and that the renderer
processes come from the bundled `wv2` — this build is never exercised while developing, so without
that check the first person to find it broken would be whoever downloaded it.

Two things this trades away. Windows no longer updates the browser engine for these builds, so a
security update means downloading a newer runtime and rebuilding. And the runtime is deeply nested,
which matters because Windows caps a path at 260 characters: the package spends 110 of them, so it
can be extracted into a folder path of up to 150. Deeper than that and the loader cannot reach the
runtime — the window opens empty. That is why the folder inside the zip is `MC3ModTool` and the
runtime folder is `wv2`, rather than the app's full name and the runtime's own 56-character one.
Those names buy 48 characters of headroom and cost nothing; the app itself keeps its real name.

## Binary safety

The parser validates the anchor pointer route, entry count, file bounds, names and hierarchy links
before enabling editing. Wheel and exhaust runtime synchronization is enabled only when those
tables pass their own structural checks.

Relocating a mesh piece walks the piece's exact internal pointer graph rather than scanning for
pointer-shaped values, because vertex data can contain values indistinguishable from a valid
address. Pieces that fail any bounds or pointer check are rejected before they can reach a car PCK.
Blocks the game shipped embedded are never overwritten or moved.

## License

[MIT](LICENSE).
