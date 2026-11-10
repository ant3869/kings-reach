"""GET /busy: what the core asks before it stops the War Room. It must be plain HTTP and must never touch a session."""

import asyncio
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "warroom"))

import websockets  # noqa: E402
import server  # noqa: E402


async def http_get(port, path):
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n".encode())
    await writer.drain()
    raw = await reader.read()
    writer.close()
    head, _, body = raw.partition(b"\r\n\r\n")
    return int(head.split()[1]), head.decode().lower(), body.decode()


class ProbeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.saved = (server.busy_tasks, list(server.DETACHED), set(server.SESSIONS))
        self.opened = []

        async def handler(websocket):  # a stand-in for handle_client: counts the sessions a connection would have made
            self.opened.append(websocket)
            await websocket.wait_closed()

        self.server = await websockets.serve(handler, "127.0.0.1", 0, process_request=server.answer_probe)
        self.port = self.server.sockets[0].getsockname()[1]

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()
        server.busy_tasks = self.saved[0]
        server.DETACHED[:] = self.saved[1]

    async def test_busy_reports_the_running_count_and_the_server_version_as_json(self):
        server.busy_tasks = lambda: 3
        status, head, body = await http_get(self.port, "/busy")
        self.assertEqual(status, 200)
        self.assertIn("application/json", head)
        self.assertEqual(json.loads(body), {"busy": 3, "server": server.SERVER_VERSION})

    async def test_it_counts_work_that_kept_running_after_its_tab_left(self):
        class Detached:  # stands in for a session whose page left but whose reply is still going
            tasks = {object(), object()}
            _retire_timer = None

        server.DETACHED[:] = [Detached()]
        _, _, body = await http_get(self.port, "/busy")
        self.assertEqual(json.loads(body)["busy"], 2)

    async def test_asking_never_takes_over_or_creates_a_session(self):
        sentinel = object()
        server.DETACHED[:] = [sentinel]  # a run waiting for its tab to come back
        before = set(server.SESSIONS)
        server.busy_tasks = lambda: 0
        for _ in range(3):
            await http_get(self.port, "/busy")
        self.assertEqual(server.DETACHED, [sentinel], "the waiting run is still waiting for a real tab")
        self.assertEqual(set(server.SESSIONS), before)
        self.assertEqual(self.opened, [], "no websocket handler ran: the probe is not a client")

    async def test_the_real_websocket_still_works_beside_the_probe(self):
        async with websockets.connect(f"ws://127.0.0.1:{self.port}"):
            await asyncio.sleep(0.05)
            self.assertEqual(len(self.opened), 1)

    async def test_other_http_paths_are_not_answered_as_busy(self):
        status, _, body = await http_get(self.port, "/something-else")
        self.assertNotEqual(status, 200)
        self.assertNotIn("busy", body)


if __name__ == "__main__":
    unittest.main()
