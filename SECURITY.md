# Security notes

## Filesystem boundary

`read` rejects symbolic links in requested paths and never follows discovered links (skipped and reported). Every auxiliary `.gitignore`/`.ignore` read uses the same component inspection and no-follow regular-file open; explicit file queries do not load ignore rules. Special files are refused/skipped. Opened files are checked against inspected inode/device identity. These checks, including `O_NOFOLLOW` on the final component where available, prevent ordinary link traversal but do not eliminate ancestor replacement races; hostile concurrent-tree confinement requires descriptor-relative operations or kernel read confinement.

Read queries have finite scan, file, entry, per-file, time, and output budgets. Shared read-engine filesystem errors expose relative paths only; native messages, causes, and absolute stack locations are not forwarded to read or write.source callers. Matching executes in a query-owned terminable worker rather than blocking the harness event loop. Ignore filtering is opt-in and never relaxes filesystem guards. `write.source` calls the shared engine, rejects incomplete output, applies text content policy, stages a private sibling file, and atomically replaces the guarded destination. It is not safe/read-only. Atomic replacement is not a transaction over a concurrently changing source tree; permissions, timestamps, and filesystem race confinement are not copy guarantees.

`bash` is intentionally available because it is required for practical agent work. It refuses `cd` and `ln`; `ls` is allowed so listings can stream into other commands (the path scanner still keeps visible arguments inside the working folder). The Agent runs bash under the OS write sandbox: writes outside the working folder are denied, including writes reached through a link. This is **not** a read sandbox. A shell command can dynamically construct a path or follow a symbolic link that already exists inside the working tree and may read its target if the host OS permits it. The command/path scanner is only an early refusal layer, not a complete shell parser.

Do not run the agent in a working tree containing untrusted symlinks, and do not treat `bash` as suitable for handling secrets outside that tree. A future safe shell would require kernel-enforced read confinement or descriptor-relative/no-follow filesystem primitives; neither is supplied by the current macOS seatbelt/Linux bubblewrap write-sandbox configuration.

## Skill resources

`skill-resource` reads only skill-relative regular files in registered skill directories, rejects observed symlinks and traversal, and bounds byte reads to 16 MiB. It exposes logical identifiers rather than installation paths. Optional `target` writes exact bytes to a new project-confined file with exclusive creation; it never executes code. Safe mode refuses saving, and exports serialize with mutating tools. Exported UTF-8 content passes the existing outside-path content guard.

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
