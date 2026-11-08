"""Cancelling or timing out a bridge call must kill the whole process tree, not just the bridge (Windows only).

On Windows Process.kill() ends one process. The agent (claude CLI and its tools) runs UNDER the bridge, so without
kill_tree a cancelled council left the agent working with nobody listening.
"""

import asyncio
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "warroom"))

import agent_bridge  # noqa: E402

MARK = "ping -n 97 127.0.0.1"  # an unmistakable command line to look for


async def _marked_pings():
    """Number of running PING.EXE processes whose command line carries MARK."""
    ps = await asyncio.create_subprocess_exec(
        "powershell", "-NoProfile", "-Command",
        "(Get-CimInstance Win32_Process -Filter \"Name='PING.EXE'\" | Where-Object { $_.CommandLine -match '-n 97 ' } | Measure-Object).Count",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, creationflags=agent_bridge.NO_WINDOW)
    out, _ = await ps.communicate()
    return int(out.decode().strip() or 0)


@unittest.skipUnless(os.name == "nt", "process trees behave differently off Windows")
class KillTreeTests(unittest.IsolatedAsyncioTestCase):
    async def test_kills_the_grandchild_that_proc_kill_would_orphan(self):
        # cmd.exe (the "bridge") -> ping.exe (the "agent"): the same shape as node -> claude CLI.
        proc = await asyncio.create_subprocess_exec(
            "cmd.exe", "/c", MARK + " >NUL", creationflags=agent_bridge.NO_WINDOW)
        try:
            for _ in range(40):  # wait for the grandchild to exist
                if await _marked_pings():
                    break
                await asyncio.sleep(0.25)
            self.assertEqual(await _marked_pings(), 1, "the grandchild should be running before the kill")
            await agent_bridge.kill_tree(proc)
            await asyncio.wait_for(proc.wait(), 10)
            for _ in range(20):
                if not await _marked_pings():
                    break
                await asyncio.sleep(0.25)
            self.assertEqual(await _marked_pings(), 0, "kill_tree must take the grandchild down too")
        finally:
            if proc.returncode is None:
                proc.kill()

    async def test_already_finished_process_is_left_alone(self):
        proc = await asyncio.create_subprocess_exec("cmd.exe", "/c", "exit 0", creationflags=agent_bridge.NO_WINDOW)
        await proc.wait()
        await agent_bridge.kill_tree(proc)  # must not raise


if __name__ == "__main__":
    unittest.main()
