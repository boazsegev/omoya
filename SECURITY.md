# Security notes

## Filesystem boundary

File tools use the Agent folder as working directory. Reads may target either that folder's tree or Env.cwd's project tree, even if the two are disjoint; writes and edits target only the Agent folder. Absolute syntax alone is not an escape. Tools own their argument guards and localize their own successful path labels relative to the working folder. Agent does not reinterpret arbitrary strings or rewrite tool-owned call history, including refused arguments. This is not blanket sanitization of code, file contents, shell output, or session metadata.

The shared write/edit content trip-wire remains intentionally weak and permission-overridable: it flags recognized references to existing outside paths and absolute references to existing project files/folders. Missing references remain allowed; shebangs, device exceptions, and relative `import.meta.url` references retain their exceptions. Text is checked, never silently rewritten. The scanner is not a code parser or filesystem enforcement layer. Content/command trip-wires permit conventional temporary roots and their children (the system temporary directories, their macOS private aliases, and the runtime temporary directory), standard development devices, and process file descriptors. These exceptions do not exempt existing absolute project references or change destination guards or the OS sandbox; temporary locations are real directories, not guaranteed data sinks.

`read` rejects symbolic links in requested paths and never follows discovered links (skipped and reported). Every auxiliary `.gitignore`/`.ignore` read uses the same component inspection and no-follow regular-file open; explicit file queries do not load ignore rules. Special files are refused/skipped. Opened files are checked against inspected inode/device identity. These checks, including `O_NOFOLLOW` on the final component where available, prevent ordinary link traversal but do not eliminate ancestor replacement races; hostile concurrent-tree confinement requires descriptor-relative operations or kernel read confinement.

Read queries have finite scan, file, entry, per-file, time, and output budgets. Shared read-engine filesystem errors expose relative paths only; native messages, causes, and absolute stack locations are not forwarded to read callers. Matching executes in a query-owned terminable worker rather than blocking the harness event loop. Ignore filtering is opt-in and never relaxes filesystem guards. `read` with `target` calls the shared engine, rejects incomplete output, applies text content policy, stages a private sibling file, and atomically replaces the guarded destination (the same saver as `write`). Safe mode refuses `target`, and target calls schedule as mutating barriers. Atomic replacement is not a transaction over a concurrently changing source tree; permissions, timestamps, and filesystem race confinement are not copy guarantees.

`bash` is intentionally available because it is required for practical agent work. It refuses `cd` and `ln`; `ls` is allowed so listings can stream into other commands (the scanner permits visible paths in the Agent and project trees). The Agent runs bash under the OS write sandbox rooted at the Agent folder: project-sibling reads are allowed but writes outside the Agent folder are denied, including writes reached through a link. This is **not** a read sandbox. A shell command can dynamically construct a path or follow a symbolic link that already exists inside the working tree and may read its target if the host OS permits it. The command/path scanner is only an early refusal layer, not a complete shell parser.

Do not run the agent in a working tree containing untrusted symlinks, and do not treat `bash` as suitable for handling secrets outside that tree. A future safe shell would require kernel-enforced read confinement or descriptor-relative/no-follow filesystem primitives; neither is supplied by the current macOS seatbelt/Linux bubblewrap write-sandbox configuration.

## Skill resources

`skill-resource` reads only skill-relative regular files in registered skill directories, rejects observed symlinks and traversal, and bounds byte reads to 16 MiB. It exposes logical identifiers rather than installation paths. Optional `target` writes exact bytes to a new project-confined file with exclusive creation; it never executes code. Safe mode refuses saving, and exports serialize with mutating tools. Exported UTF-8 content passes the same weak content guard.

As with ordinary file tools, ancestor inspection is not protection against concurrent directory replacement. Registered skill roots and the project must not be writable by untrusted principals. Skill instructions are trusted guidance, not a grant of tool permissions.

## Tool configuration trust

Tool code loads from installed/package and user-settings roots, plus trusted `tools.folders` arrays. Every project-scanned settings/auth file removes `tools.folders`; only `tools.timeout`, `tools.timeoutLimit`, and `tools.concurrency` survive. Non-object project `tools` values cannot replace the trusted object. Settings merging rejects prototype-control keys so inherited values cannot bypass folder sanitization. Constructor settings are trusted host configuration.

## Jobs filesystem boundary

Jobs checks that its layout directories are real directories and rejects observed
symlinks, but these are observation-time checks, not protection against concurrent
replacement. The project tree must not be writable by untrusted principals.
Concurrent replacement, disable/restore, scans, task edits, and archive writes are
outside Jobs' guarantees: folder-only Jobs intentionally has no lock or ownership
protocol. Disable can strand a prepared attempt; restore followed by a scan
reconciles it without replaying accepted work.

## Web server

`om --serve` has no authentication: reaching the port means owning the agent. It binds to loopback by default, so only local processes and user accounts can reach it; `--host 0.0.0.0` is meant for trusted networks only. Project management (add, pin, group, remove) additionally requires a loopback peer using a loopback host name. A page in the user's own browser can reach the loopback port through DNS rebinding (its name re-pointed at 127.0.0.1), so the peer address alone proves nothing. The server therefore answers only requests addressed to this machine's names on its port — loopback names, the bound host, the OS hostname and its `.local` form, and current interface addresses — and WebSocket and upload requests must also carry the matching same-host Origin. Requests through a reverse proxy or another DNS name are refused unless that name is the bound host.
