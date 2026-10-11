---
title: "Adventures in Fleet Security: Root Runs First"
date: 2026-10-10
draft: false
reading_time: "7 min"
---

AI-found CVEs are the trend right now, and some of them are genuinely impressive. But a CVE is one slice of securing a company. Most of the real exposure isn't a novel memory bug, it's boring: a script in the wrong order, a path nobody owns, a privilege drop one line too late. When an org's maturity isn't high yet, attackers reach for the boring stuff first, because it's easier and it's already there. So that's where I look first too.

Every org running a fleet of Macs has a layer of background machinery nobody looks at: agents, daemons, and scheduled scripts that keep laptops patched and compliant. It's some of the most privileged code in the building and some of the least reviewed. That gap is where the interesting bugs live.

Here's one. A root-privileged maintenance routine ran a Homebrew command on a schedule. Before it dropped to the logged-in user, it executed `git` from `/opt/homebrew`, a directory that user owns. Any local, unprivileged user who could write into their own Homebrew prefix got root code execution. No race, no memory corruption, no clever trick. Just an ordering bug in a shell script, the kind that survives for years because it never looks like a vulnerability.

---

## A Note on Scope

This is not a bug in Homebrew, in any MDM, or in any EDR product. IRU/Kandji, like Jamf or Mosyle, lets you push arbitrary scripts that run as root on enrolled devices. That's the point of the thing, not a flaw.

The bug is in the custom script that gets pushed. In one case it was a maintenance script deployed to the fleet through the MDM, nothing IRU/Kandji or Homebrew did wrong. These scripts are worth writing up precisely because they arrive through configuration, not code review: nobody opens a PR, nobody runs a linter. They get pasted into a web console, scoped to a Blueprint, and from then on they run as root on every machine, with kernel-level privilege and a fraction of the scrutiny.

So this is a pattern, with Homebrew and `git` as the concrete example. If you run root-level maintenance on macOS through any mechanism, it's yours to worry about too.

---

## Background: The Privilege-Drop Assumption

Plenty of macOS tooling ships a root component (a system extension, a privileged helper, a LaunchDaemon) that does more than its headline job. A common one: push package and security updates on a schedule. That's real security work, which is why it runs as root.

Homebrew, though, flatly refuses to run as root:

```
Error: Running Homebrew as root is extremely dangerous and no longer supported.
As Homebrew does not drop privileges on installation you would be giving all
build scripts full access to your system.
```

That's the front door. A plain `sudo brew update` errors out with exactly that message. But a root-scheduled maintenance job still needs to run `brew`, so the tooling runs it from a root context and lets Homebrew re-exec the real work as the console user. Reasonable. The catch is that `brew` does some of its own startup work before that drop, and that startup runs as root. (Dropping first, with `sudo -u "$CONSOLE_USER"` before `brew` ever starts, would have been safe. That's the fix, and we'll get there.)

---

## The Vulnerable Pattern

```
launchd (root)
  └─ root script:  brew update                                  <- still root
       └─ brew preflight:  git -C /opt/homebrew describe ...     <- runs HERE, still root
            └─ /opt/homebrew/bin/git  ->  Cellar/git  (user-writable)
       └─ brew re-execs the real work as the console user        <- the intended boundary, too late
```

The script calls `brew` and lets Homebrew re-run the real work as the logged-in user. The catch is what Homebrew does first. Every `brew` invocation starts by checking its own install state, with a few preflight git commands against the Homebrew repo:

```bash
git -C /opt/homebrew describe --tags --dirty
git -C /opt/homebrew rev-parse HEAD
git config --file=/opt/homebrew/.git/config --get homebrew.devcmdrun
```

These run before the drop, as root. And `git` here isn't `/usr/bin/git`. Where Homebrew installed its own `git`, `/opt/homebrew/bin/git` is a shim that execs the Cellar copy:

```
/opt/homebrew/bin/git  ->  #!/bin/sh ... exec /opt/homebrew/Cellar/git/<version>/bin/git "$@"
```

The shim and the `Cellar/git` it execs are both user-owned, by design: Homebrew refuses to do its real work as root precisely so its prefix can be user-writable. Under the normal model that's fine. Here it's root-owned-executes-user-owned, one step before the drop.

So the script author doesn't even write a vulnerable line. They call `brew update` as root, assume Homebrew drops on its own, and Homebrew's preflight walks root straight into the user-writable `Cellar/git` first. The real work runs as the user; the preflight that ran before it already executed a user-owned binary as root.

No race, either. In this case the call fired roughly once a day, so an attacker gets one attempt per cycle, can plant the payload hours ahead, and walk away. They just need their own `git` sitting where the daemon will look.

### Why only some machines

Homebrew prefers its own `git` when the formula is installed: with `/opt/homebrew/opt/git` present, the preflight resolves to the user-writable `Cellar/git`. Without it, it falls back to the root-owned `/usr/bin/git`, and there's no bug. So exposure hinges on one invisible precondition: did the user run `brew install git`? On a dev machine, usually yes. It also means the bug comes and goes on the same host as the formula is installed or removed, with nothing in the script changing. Easy to miss in an audit that samples a few machines.

---

## How We Found It

Endpoint telemetry. The fleet's EDR ships process-exec events to our SIEM, and `git` executions grouped by effective uid turned up something that shouldn't exist: `git` running as `uid 0`, where no human runs `git` as root.

A normal `git` is `uid=501`, parented to a shell or IDE. A `uid=0` `git` parented to a scheduled maintenance process is not. Pivoting on uid, parent, and an executable path under `/opt/homebrew` turned one oddity into a population: a scheduled root job on many hosts, running `git` from a user-writable prefix daily.

I'm not reproducing the actual script here, for obvious reasons. The specifics that would identify the environment stay out. The shape is the point: a root-scheduled `brew` run, Homebrew's preflight firing `git` as root, and that `git` in a prefix the user owns.

---

## How You'd Abuse It

Nothing here needs privilege to set up, which is the whole problem. If you're the logged-in user, you already own `/opt/homebrew`, so you already own the `git` the root job will run:

1. Confirm `/opt/homebrew/bin/git` resolves into the user-writable `Cellar`, not `/usr/bin/git`.
2. Shadow that `git` with something you control. You own the path, so no `sudo`, no entitlement.
3. Wait. The next scheduled pass runs it as root.

To prove the primitive without breaking anything, I used an observe-only canary: a shim that logs the caller, then execs the real binary, so the job behaves normally.

```bash
#!/bin/bash
# /opt/homebrew/bin/git  (a shim at a path the logged-in user owns)
echo "$(date -u +%FT%TZ)  uid=$(id -u)  euid=$(id -un)  parent=$(ps -o comm= -p "$PPID")" \
    >> "$HOME/canary.log"
exec /opt/homebrew/Cellar/git/*/bin/git "$@"
```

After the next pass:

```
2026-10-05T09:14:02Z  uid=0  euid=root  parent=<scheduled maintenance>
```

`uid=0`, from a directory the user fully controls, parented to the root job rather than any shell the user started. The shim only logs, but it runs with root's privileges, and so does anything you put in its place. The rest is an exercise. If root will run a file you own, you've already won.

---

## Impact

Any unprivileged user who can write the Homebrew prefix gets root, triggered by nothing but the next scheduled pass. Why it's worse than a textbook LPE:

| Property | Typical LPE | This |
|---|---|---|
| Timing | Narrow TOCTOU race | Fixed schedule, unlimited attempts |
| Setup | Often needs a crafted trigger | Drop a file you own, then wait |
| Footprint | Memory corruption, crashes, ASan-visible | A plain exec that looks like maintenance |
| Permission model | Exploits a misconfiguration | Exploits the intended, documented config |

That last row is the one that sticks. The user-writable prefix isn't a misconfiguration you can tell people to fix, it's documented, load-bearing Homebrew behavior. No `chmod` fixes it without breaking `brew`. The fault is in what touches that prefix while still root, which a file-permission audit never sees.

It generalizes past Homebrew. Any root flow that resolves a binary, config, plugin, or library from a user-controlled location before dropping has the same shape:

- `$PATH` with a user-writable directory ahead of the system paths.
- `$PYTHONPATH` / `$NODE_PATH` / `$RUBYLIB` honored as root.
- A plugin or hook directory under the user's home.
- `source`-ing a user-owned rc file as root.

---

## Detection

One question: does any root process run a binary from a user-writable path before it drops? Two ways to check.

**Audit the scripts.** Pull every root-level custom script you push to endpoints and read it. Find the drop (`sudo -u`, `launchctl asuser`, `su`, `setuid`) and look at what runs before it. Anything that shells out before the drop via `$PATH` instead of an absolute root-owned path is a candidate. An afternoon per script, deterministic. One blind spot: if the script just calls `brew` (or any tool that does its own pre-drop work) and lets it drop internally, the vulnerable call lives inside that tool, not in your script, so reading the script won't show it. That's what the runtime check is for.

**Watch at runtime.** Flag any exec under `/opt/homebrew` (or `/usr/local` on Intel) with `euid 0`:

```bash
sudo eslogger exec 2>/dev/null \
  | jq -r 'select(.event.exec.target.executable.path
                  | test("^/opt/homebrew|^/usr/local/Cellar|^/usr/local/bin"))
           | select(.process.audit_token.euid == 0)
           | "\(.time)  \(.event.exec.target.executable.path)  <- \(.process.executable.path)"'
```

One hit is enough to start pulling. Zero across a few cycles is decent evidence you're clean.

---

## Mitigation

You already know what to do, this isn't rocket science. Drop before anything shells out, not after. Don't resolve binaries through a user-writable `$PATH` as root: give root an absolute path (`/usr/bin/git`), or set `HOMEBREW_GIT=/usr/bin/git` if you can't avoid running `brew` as root. Set `secure_path` in `/etc/sudoers`, which macOS doesn't by default. And treat these scripts like the root code they are: version control, review, a lint pass.

The bug was never a missing drop. It was a drop one line too late, in front of a subprocess nobody thought of as a subprocess.

---

## Conclusion

This is what happens when "run as root, then drop" is a sequence of steps instead of an invariant. Every assumption held: Homebrew's refusal to do its work as root is correct, the user-writable prefix is intentional, the drop worked. The bug lived in the gap between "the real work runs as the user" and "nothing I control runs as root," and that gap was one preflight `git` wide.

No memory corruption, no crash, no weird syscall. Just a root process running a command that was always allowed to run, from a directory that was always user-writable, one step before a drop that was always going to happen. It looked exactly like maintenance, because it was.

If anything on your fleet runs root-level dev-tool upkeep on macOS, go read the script. Find the drop, look at what runs before it, check whether any of it comes from a path a user can write. Costs an afternoon.

---

## References

1. Homebrew maintainers, *"Homebrew Documentation: Installation"* (on why Homebrew refuses to run as root and expects a user-owned prefix). [Link](https://docs.brew.sh/Installation)
2. MITRE, *CWE-426: Untrusted Search Path*. [Link](https://cwe.mitre.org/data/definitions/426.html)
3. MITRE, *CWE-427: Uncontrolled Search Path Element*. [Link](https://cwe.mitre.org/data/definitions/427.html)
4. MITRE, *CWE-271: Privilege Dropping / Lowering Errors*. [Link](https://cwe.mitre.org/data/definitions/271.html)
5. Apple, *"eslogger"* and the Endpoint Security framework, `man eslogger`. [Link](https://developer.apple.com/documentation/endpointsecurity)
6. Apple, *"Creating launch daemons and agents"*, `man launchd.plist`. [Link](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
