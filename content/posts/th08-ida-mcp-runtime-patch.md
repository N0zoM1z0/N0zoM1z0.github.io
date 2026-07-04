---
title: "Teaching `th08.exe` a Tiny Spell: IDA Pro MCP, Codex, and a Runtime Life Patch"
date: "2026-07-04"
slug: "th08-ida-mcp-runtime-patch"
categories:
  - Reverse Engineering
  - Tooling
tags:
  - reverse-engineering
  - ida-pro
  - mcp
  - touhou
---

# Teaching `th08.exe` a Tiny Spell: IDA Pro MCP, Codex, and a Runtime Life Patch

*Imperishable Night, but the boundary between miss and Game Over has been politely postponed.*

Sometimes the hardest part of a Touhou run is not the bullet pattern. Sometimes it is getting far enough into the game to understand what the later patterns are even asking of you.

This writeup documents a small reverse-engineering trip through *Touhou 8: Imperishable Night* (`th08.exe`). The goal was deliberately modest: keep the normal death and respawn flow intact, but stop the game from decrementing Player lives after a miss. No collision bypass, no permanent invulnerability, no skipping the drama. Just enough mercy to finish a full route and study the flow.

The final solution was not a static patched EXE. That turned out to be the wrong spell. The working solution is a small runtime patcher, closer in spirit to tools like `thprac`.

## Artifacts

Companion gist:

```text
https://gist.github.com/N0zoM1z0/3913ba7da8eb00cb6d27b49883f4bbad
```

IDA decompiler checkpoint:

![IDA decompiler checkpoint](/assets/img/posts/th08-ida-mcp-runtime-patch/ida-decompiler-checkpoint.png)

Full launcher flow and in-game no-life-decrement demo:

![Runtime patch demo](/assets/img/posts/th08-ida-mcp-runtime-patch/runtime-patch-demo.webp)

Scripts:

- [`th08_attach_no_life_decrement.py`](https://gist.githubusercontent.com/N0zoM1z0/3913ba7da8eb00cb6d27b49883f4bbad/raw/f4f49a5fd33d05a2b9e49110a388a69412cbd07e/th08_attach_no_life_decrement.py)
- [`run_th08_no_life_decrement_attach.bat`](https://gist.githubusercontent.com/N0zoM1z0/3913ba7da8eb00cb6d27b49883f4bbad/raw/585427b49a1280df86377a9c39baced8fac601c4/run_th08_no_life_decrement_attach.bat)

The initial mood was less "I am about to cheat" and more:

> `thprac` with 8 lives is still not enough. At this point, Reisen is not running practice mode. She is load-testing the player.

So the rule for this patch was set early: do not delete the game. Do not turn collision off. Do not make a fake god mode. The goal was a sightseeing and study build, not a victory screenshot generator.

The patch priority list was:

1. Best: lock lives, or more precisely, stop decrementing Player lives.
2. Acceptable later: lock Bombs, because dying with bombs in stock is the classic pain.
3. Riskier: patch the Game Over branch.
4. Worst first move: skip collision or force permanent invulnerability.

That became the guiding principle for the whole trip:

> Keep death real. Keep respawn real. Keep the clear-bullets, dropped Power, failed spellcard, and "yes, you got hit" flow intact.
>
> Just stop the Player counter from ending the field trip.

## 1. Setting Up IDA Pro MCP from WSL

The setup environment was slightly unusual:

- IDA Pro 9.3 was installed on Windows:

```text
<IDA_INSTALL>
```

- Codex was running inside WSL.
- Windows drives were accessible from WSL through the mounted Windows drive path.

The MCP package was installed into IDA's bundled Python:

```bash
'<IDA_INSTALL_WSL>/python311/python.exe' -m pip install --upgrade ida-pro-mcp
```

The IDA plugin was placed into the Windows user plugin directory:

```text
%APPDATA%\Hex-Rays\IDA Pro\plugins\mcp-plugin.py
```

One important trap appeared immediately: IDA was still using an older embedded Python binding, so the MCP plugin failed with:

```text
Python 3.11 or higher is required for the MCP plugin
```

The fix was to switch IDA's Python binding with `idapyswitch.exe`:

```bash
'<IDA_INSTALL_WSL>/idapyswitch.exe' \
  --force-path '<IDA_INSTALL>\python311\python3.dll'
```

After restarting IDA, `Edit -> Plugins -> MCP` appeared, and `Ctrl+Alt+M` started the local IDA RPC server.

On the Codex side, the MCP server was added to `~/.codex/config.toml`:

```toml
[mcp_servers.ida-pro-mcp]
command = "<IDA_INSTALL_WSL>/python311/python.exe"
args = [
    '<IDA_INSTALL>\python311\Lib\site-packages\ida_pro_mcp\server.py',
]
startup_timeout_ms = 1800000
```

The mixed path style matters. The command is launched from WSL, so the WSL-mounted Python path works. But the argument is consumed by Windows Python, so the script path should stay Windows-style.

After restarting Codex, the MCP tool connected cleanly:

```text
Successfully connected to IDA Pro (open file: th08.exe)
```

At that moment the operation officially changed from "Reisen is educating the player" to:

> Reisen: "I will distort your visual perception."
>
> Me: "Then I will distort your control flow."
>
> Gensokyo: "How many lives do you have left?"
>
> IDA: "We are redefining that question."
>
> Break the boundary. Start.

## 2. Finding the Death Flow

The first strong clue came from a string:

```text
0x4B6F1C  "player DEAD"
```

Its only reference led to:

```text
0x44AB40  player_dead_handler
```

This function clearly starts the player death flow. It logs `"player DEAD"`, triggers effects, and transitions toward respawn or miss handling. But the actual life decrement was not directly there.

This was a very strong anchor, but not yet the final answer. A string like `"player DEAD"` can be a log marker, not the arithmetic itself. The useful workflow was:

```text
player DEAD -> xref -> death handler -> callees/callers -> resource getters/setters
```

Or, in less professional terms:

> The screen is still drawing danmaku.
>
> IDA is already following xrefs.

The next step was to distinguish Player lives from Bomb count. A debug/status rendering function gave us the key:

```text
0x43826B  draw_player_status_debug_panel
```

This function draws strings such as:

```text
Player =%8d0
Bomb   =%7d0
```

From there:

```text
0x42F2B0  get_player_lives
0x4398CE  get_player_bombs
```

The fields are stored as floats internally:

```asm
get_player_lives:
    fld dword ptr [state_inner + 0x74]
    call __ftol2

get_player_bombs:
    fld dword ptr [state_inner + 0x80]
    call __ftol2
```

The life mutator was:

```text
0x43C641  add_player_lives
```

Its core behavior:

```asm
fild [arg_0]
fadd dword ptr [state_inner + 0x74]
fstp dword ptr [state_inner + 0x74]
```

So the spell was now visible: find who calls `add_player_lives(-1)`.

This was the point where the patch became much cleaner than "make the player immortal." We were not trying to silence the death system. We were looking for the exact arithmetic at the boundary between miss handling and Game Over pressure.

## 3. The Minimal Static Patch

The actual decrement appeared in:

```text
0x44CBF0  player_respawn_or_miss_handler
```

Relevant code:

```asm
0x44D0E7  call get_player_lives
0x44D0EC  test eax, eax
0x44D0EE  jg loc_44D0F9
0x44D0F0  mov byte_164D0BB, 1
0x44D0F7  jmp loc_44D147

0x44D0F9  push -1
0x44D0FB  mov ecx, offset dword_160F508
0x44D100  call add_player_lives
```

This is exactly the desired patch site. The smallest possible change is one byte:

```text
VA:          0x44D0F9
RVA:         0x0004D0F9
file offset: 0x0004CEF9
old bytes:   6A FF
new bytes:   6A 00
```

In assembly:

```asm
; before
push -1

; after
push 0
```

This keeps the death, visual effects, respawn, cleanup, and state transitions intact. It only changes the amount passed to `add_player_lives`.

In chat form, the whole discovery compresses beautifully:

> Reisen: distort visual perception.
>
> Me: locate the respawn flow.
>
> TH08: `Player += -1`.
>
> Codex + IDA: no, you do not.

This is not "nuke Gensokyo" invulnerability. It is very specifically:

```text
Spell Card:  Boundary of Life Decrement
Patch Sign:  6A FF -> 6A 00
```

Or, if Kaguya gets a vote:

> Kaguya: "The eternal night shall not end."
>
> Me: "Agreed. Neither shall Player."

Very elegant. Very tiny. Very wrong as a disk patch.

## 4. Why the Static Patch Was Not the Final Answer

A patched copy was created:

```text
th08_patched_no_life_decrement.exe
```

It did not launch.

Then a clean byte-for-byte copy was tested:

```text
th08_clean.exe
```

It also did not launch.

That was the first hint that `th08.exe` cared about more than code bytes. It likely expected to be named `th08.exe`, and it had score/config/checksum behavior tied to startup.

The original filename was restored and patched directly. That also failed.

At this point, the static patch was abandoned. The game was making it clear: do not carve the spell into the scroll. Cast it at runtime.

This was a good reminder that a correct byte patch can still be the wrong product. The instruction was right. The delivery mechanism was wrong.

Also, the "keep three copies" advice was correct in spirit:

```text
clean original
working copy
patched experiment
patch notes
```

Because otherwise you end up reverse-engineering your own reverse engineering:

> "What did I patch yesterday?"
>
> Famous last words, usually followed by opening the hex editor again.

## 5. The Actual Crash Was `score.dat`

During debugging, the clean original `th08.exe` itself started crashing before writing a fresh log. Windows reported:

```text
Exception:      0xC0000005
Fault offset:   0x000A5CFF
VA:             0x4A5CFF
Function:       _strncmp
```

The callers led back into score file parsing:

```text
0x45A5E0  load_score_dat_and_check_exe_sum
```

The binary contains the warning:

```text
warning : score.dat exesumcheck error
```

The old `score.dat` was moved aside:

```text
score.dat.disabled-by-codex
```

After that, clean `th08.exe` launched again and generated a fresh working `score.dat`.

The crash was not caused by the life patch. It was stale or incompatible score data colliding with startup validation. Gensokyo had a second gatekeeper.

This detour was very Touhou: before reaching the boss, the save file itself became a midboss.

## 6. Runtime Patch: The Working Solution

The final approach leaves the executable untouched:

```text
th08.exe remains clean
```

On disk, the patch bytes are still original:

```text
6A FF
```

The launcher starts the clean game, waits briefly, attaches to the running process, and modifies only process memory:

```text
0x0044D0FA: FF -> 00
```

That changes the immediate byte of:

```asm
0x44D0F9  push -1
```

into:

```asm
0x44D0F9  push 0
```

The working launcher is:

```text
<GAME_DIR>\run_th08_no_life_decrement_attach.bat
```

It runs:

```text
<WORKDIR>/codex_ida/th08_attach_no_life_decrement.py
```

The expected runtime log:

```text
attach patcher started
found th08.exe pid=...
read 0x0044D0FA = ff
patched memory: 0x0044D0FA: FF -> 00
```

That was the final successful spell.

The actual success moment was the good kind of ridiculous:

```text
read 0x0044D0FA = ff
patched memory: 0x0044D0FA: FF -> 00
```

That log line is the entire spellcard captured in two lines. The game still gets to say "you died"; the patch only answers "but the counter does not move."

> Reisen makes you doubt your eyes.
>
> The patch makes `th08.exe` doubt its arithmetic.
>
> `Player += -1`?
>
> No.
>
> `Player += 0`.

## 7. Final Files Kept

The working files:

```text
run_th08_no_life_decrement_attach.bat
th08.exe                         clean original executable
score.dat                        regenerated working score file
```

The script and notes:

```text
<WORKDIR>/codex_ida/th08_attach_no_life_decrement.py
<WORKDIR>/codex_ida/th08_life_patch_notes.md
```

Backups:

```text
backup/codex_patch_no_life_decrement/th08_original_330fbdbf58a710829d65277b4f312cfbb38d5448b3df523e79350b879213d924.exe
backup/codex_runtime_debug/score.dat.20260704-115625.bak
backup/codex_runtime_debug/score.dat.disabled-by-codex.original-bad
```

## 8. What This Patch Does and Does Not Do

It does:

- keep the normal miss/death flow
- keep respawn behavior
- keep bullet cleanup and state transitions
- prevent Player lives from decrementing
- avoid modifying `th08.exe` on disk

It does not:

- disable collision
- make the player permanently invulnerable
- skip death processing
- patch score data
- bypass the whole game loop

This is why the patch feels stable. The game still knows you got hit. It just stops taking one Player from the counter.

In Touhou terms: the spellcard still lands, the screen still blooms, the run still has consequences. The only thing removed is the hard stop that prevents a full sightseeing route through Imperishable Night.

So this is not a serious-score build. It is an observation deck.

Use it to see the full route, learn what the later stages are asking, and then go back to clean `th08.exe` or `thprac` when it is time to practice properly. One side is "I want to understand Imperishable Night." The other is "I want to earn the run."

## 9. Takeaways

The main reverse-engineering lesson was not the one-byte patch. It was the path to trusting it.

Static patching found the right instruction:

```asm
push -1
call add_player_lives
```

But runtime patching was the better delivery mechanism because the game has startup assumptions around executable identity, score data, and checksum-related parsing.

IDA Pro MCP made the workflow much tighter:

- search strings
- follow xrefs
- inspect functions
- rename symbols
- annotate patch points
- verify bytes
- iterate without losing context

Codex acted less like an oracle and more like a tireless reversing assistant: follow the xref, check the getter, prove the field, test the patch, then back out when the static route starts summoning startup ghosts.

Final verdict:

```text
Static patch:   correct byte, wrong delivery.
Runtime patch:  correct byte, correct timing.
```

What can I say?

```text
IDA out.
```

The moon is still full. The Player counter simply stopped being quite so judgmental.

Sightseeing Mode: Imperishable Night, start.
