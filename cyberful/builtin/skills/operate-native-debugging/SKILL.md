---
name: operate-native-debugging
description: Operate managed GDB sessions, tracing, symbolization, crash triage, and deterministic exploitability evidence for native artifacts.
---

# Operate Native Debugging

Debug only a lab-owned process or an imported local artifact. Never attach to a host process, a shared service, or an unrelated container.

## Prepare the evidence and lab

Record artifact hash, format, architecture, ABI, interpreter, libraries, symbols, hardening, invocation, input, environment, and expected behavior. Use `checksec`, `readelf`, `xxd`, and `objdump`, then `native_lab create`. Run `harness_validate` for shell, JavaScript, native executable, or native source inputs before execution; opaque native ABI structures must compile against real headers and may never be replaced with guessed storage. Snapshot before patching a scratch copy with `patchelf` or changing fixtures.

## Observe the earliest invalid state

Use `native_debug launch` or attach only to a PID returned by `native_lab start_process`. Treat `running`, `stopped`, `exited`, and `closed` as explicit states; use `wait` after asynchronous continue and `status` before dependent commands. `SIGSYS` stops and is not passed by default. Change that behavior only with an explicit `signal_policy` call justified by the discriminator. Set breakpoints at the parser boundary, validation, allocation, copy, free, indirect call, and crash site. Capture registers, stack, memory, backtrace, and decisive token-matched GDB/MI output. Use `native_lab readiness` or `file_rendezvous` instead of timing guesses, and use `strace` and `ltrace` only until the ambiguity is answered.

## Triage reproducibly

Use `crash_triage collect`, `reproduce`, `symbolize`, `classify`, `deduplicate`, and `minimize` in that order when applicable. Reproduce outside a fuzzer with the exact binary and input. Identify the first violated invariant, not only the final signal. Distinguish controlled read/write, disclosure, denial of service, allocator corruption, instruction-pointer influence, and unproven exploitability.

Use `eu_stack`, `llvm_symbolizer`, Valgrind, and sanitizer output as mutually checking evidence. Use `ROPgadget`, `ropper`, and pwntools only after hardening and a concrete primitive justify exploit-development work.

## Close cleanly

Close every debugger idempotently, stop every lab process, export decisive crash evidence, inspect `native_lab diagnostics`, and destroy or restore the lab as required by the phase. Preserve exact commands, hashes, validation evidence, symbols, minimized input, control case, traces, causal frames, signal policy, mitigations, typed limitations, and evidence paths.
