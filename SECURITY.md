# Security notes

## Filesystem boundary

`read` rejects symbolic links in the requested path and in folder listings/searches. Its `lstat` checks prevent ordinary link traversal but cannot eliminate all filesystem race conditions without descriptor-relative `O_NOFOLLOW` operations.

`bash` is intentionally available because it is required for practical agent work. It refuses `cd`, `ln`, and `ls`; folder inspection and listing belong in the `read` tool. The Agent runs bash under the OS write sandbox: writes outside the working folder are denied, including writes reached through a link. This is **not** a read sandbox. A shell command can dynamically construct a path or follow a symbolic link that already exists inside the working tree and may read its target if the host OS permits it. The command/path scanner is only an early refusal layer, not a complete shell parser.

Do not run the agent in a working tree containing untrusted symlinks, and do not treat `bash` as suitable for handling secrets outside that tree. A future safe shell would require kernel-enforced read confinement or descriptor-relative/no-follow filesystem primitives; neither is supplied by the current macOS seatbelt/Linux bubblewrap write-sandbox configuration.

## Jobs filesystem boundary

Jobs checks that its layout directories are real directories and rejects observed
symlinks, but these are observation-time checks, not protection against concurrent
replacement. The project tree must not be writable by untrusted principals.
Concurrent replacement, disable/restore, scans, task edits, and archive writes are
outside Jobs' guarantees: folder-only Jobs intentionally has no lock or ownership
protocol. Disable can strand a prepared attempt; restore followed by a scan
reconciles it without replaying accepted work.
