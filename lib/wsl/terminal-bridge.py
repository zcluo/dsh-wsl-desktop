#!/usr/bin/env python3
"""PTY bridge for the WSL execution world.

`wsl.exe` hands out three pipes, never a terminal, so a real PTY has to be
allocated on the Linux side and bridged. This script allocates one with the
`pty` module, runs the requested program on the slave, and pumps bytes between
the master and the host's pipes:

    stdin  <- host keystrokes, forwarded to the PTY
    stdout -> PTY output, forwarded to the host
    stderr <- one JSON control reply per line, prefixed for the host to demux

Control arrives through a FIFO whose path is the first argument, written by a
second `wsl.exe` process the host keeps open. Only stdlib is used, so nothing
has to be installed inside the distribution.

Usage:
    python3 bridge.py <fifo> <cols> <rows> <argv...>

Exits with the child's own exit status (128 + signal when it was killed).
"""

import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

REPLY_PREFIX = b"#dsh-pty "

SIGNALS = {
    "SIGINT": signal.SIGINT,
    "SIGTERM": signal.SIGTERM,
    "SIGKILL": signal.SIGKILL,
    "SIGHUP": signal.SIGHUP,
    "SIGTSTP": signal.SIGTSTP,
}

GRACE_SECONDS = 3.0


def reply(payload):
    """Write one control reply line for the host to demux off stderr."""
    try:
        os.write(2, REPLY_PREFIX + json.dumps(payload).encode("utf-8") + b"\n")
    except OSError:
        # The host is gone; nothing left to report to.
        pass


def exit_code_of(status):
    """Map a waitpid status onto the shell convention the host reports."""
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return 0


class Bridge:
    """One PTY session plus its host-facing pipes."""

    def __init__(self, fifo, cols, rows, argv):
        self.argv = argv
        self.stdin_fd = 0
        self.stdout_fd = 1
        self.master = None
        self.pid = None
        self.shell_pgrp = None
        self.stdin_open = True
        self.control_buffer = b""
        self.revision = 0
        self.last_state = None
        self.control_fd = self._open_control(fifo)
        self._spawn()
        self.resize(cols, rows)

    def _open_control(self, fifo):
        """Create the control FIFO and hold its read end open."""
        try:
            os.unlink(fifo)
        except FileNotFoundError:
            pass
        os.mkfifo(fifo, 0o600)
        return os.open(fifo, os.O_RDONLY | os.O_NONBLOCK)

    def _spawn(self):
        """Fork the program onto a new PTY."""
        self.pid, self.master = pty.fork()
        if self.pid == 0:
            try:
                os.execvp(self.argv[0], self.argv)
            except OSError:
                pass
            os._exit(127)
        self.shell_pgrp = os.getpgid(self.pid)
        reply({"event": "started", "pid": self.pid, "pgrp": self.shell_pgrp})

    def resize(self, cols, rows):
        """Apply a window size to the PTY."""
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", int(rows), int(cols), 0, 0))

    def foreground_pgrp(self):
        """The PTY's current foreground process group."""
        try:
            return os.tcgetpgrp(self.master)
        except OSError:
            return None

    def activity(self):
        """Report busy when the foreground group is not the shell itself."""
        pgrp = self.foreground_pgrp()
        state = "unknown" if pgrp is None else ("idle" if pgrp == self.shell_pgrp else "busy")
        if state != self.last_state:
            self.last_state = state
            self.revision += 1
        return {"state": state, "revision": self.revision}

    def drain(self):
        """Read every immediately available PTY byte, stopping at the EIO that marks a closed slave."""
        while True:
            try:
                ready, _, _ = select.select([self.master], [], [], 0)
            except InterruptedError:
                return
            if not ready:
                return
            try:
                data = os.read(self.master, 65536)
            except OSError as error:
                # EIO is how Linux reports that the slave side is gone.
                if error.errno == errno.EIO:
                    return
                raise
            if not data:
                return
            os.write(self.stdout_fd, data)

    def handle_control(self, line):
        """Run one control request and answer it."""
        try:
            request = json.loads(line.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            reply({"ok": False, "error": "control line is not JSON"})
            return
        op = request.get("op")
        if op == "resize":
            self.resize(request.get("cols", 80), request.get("rows", 24))
            reply({"ok": True})
        elif op == "foreground":
            pgrp = self.foreground_pgrp()
            reply({"ok": True, "pgrp": pgrp, "shellPgrp": self.shell_pgrp})
        elif op == "activity":
            reply({"ok": True, **self.activity()})
        elif op == "signal":
            name = request.get("signal")
            number = SIGNALS.get(name)
            if number is None:
                reply({"ok": False, "error": "unsupported signal %s" % name})
                return
            pgrp = self.foreground_pgrp()
            if pgrp is None:
                reply({"ok": False, "error": "no foreground process group"})
                return
            try:
                os.killpg(pgrp, number)
                reply({"ok": True, "pgrp": pgrp})
            except OSError as error:
                reply({"ok": False, "error": str(error)})
        elif op == "terminate":
            reply({"ok": True, "terminated": self.terminate()})
        else:
            reply({"ok": False, "error": "unknown op"})

    def terminate(self):
        """Signal the whole session and report the group that received it."""
        pgrp = self.foreground_pgrp() or self.shell_pgrp
        for number, wait in ((signal.SIGHUP, 0.2), (signal.SIGTERM, GRACE_SECONDS), (signal.SIGKILL, 0.2)):
            try:
                os.killpg(pgrp, number)
            except OSError:
                break
            deadline = time.monotonic() + wait
            while time.monotonic() < deadline:
                done, _ = os.waitpid(self.pid, os.WNOHANG)
                if done == self.pid:
                    return True
                time.sleep(0.05)
        return False

    def run(self):
        """Pump bytes until the child settles, then exit with its status."""
        status = 0
        while True:
            watched = [self.master, self.control_fd]
            if self.stdin_open:
                watched.append(self.stdin_fd)
            try:
                ready, _, _ = select.select(watched, [], [], 0.2)
            except InterruptedError:
                continue

            if self.master in ready:
                try:
                    data = os.read(self.master, 65536)
                except OSError as error:
                    data = b""
                    if error.errno != errno.EIO:
                        raise
                if data:
                    os.write(self.stdout_fd, data)

            if self.stdin_open and self.stdin_fd in ready:
                try:
                    data = os.read(self.stdin_fd, 65536)
                except OSError:
                    data = b""
                if data:
                    try:
                        os.write(self.master, data)
                    except OSError:
                        # The session ended between the select and the write.
                        pass
                else:
                    # The host closed its side; keep the session but stop polling it.
                    self.stdin_open = False

            if self.control_fd in ready:
                chunk = os.read(self.control_fd, 65536)
                self.control_buffer += chunk
                while b"\n" in self.control_buffer:
                    line, self.control_buffer = self.control_buffer.split(b"\n", 1)
                    if line.strip():
                        self.handle_control(line)

            try:
                done, status = os.waitpid(self.pid, os.WNOHANG)
            except ChildProcessError:
                done, status = self.pid, 0
            if done == self.pid:
                self.drain()
                return exit_code_of(status)


def main():
    if len(sys.argv) < 5:
        sys.stderr.write("usage: bridge.py <fifo> <cols> <rows> <argv...>\n")
        return 2
    fifo = sys.argv[1]
    cols, rows = sys.argv[2], sys.argv[3]
    argv = sys.argv[4:]
    bridge = Bridge(fifo, cols, rows, argv)
    try:
        code = bridge.run()
    finally:
        try:
            os.unlink(fifo)
        except OSError:
            pass
    return code


if __name__ == "__main__":
    sys.exit(main())
