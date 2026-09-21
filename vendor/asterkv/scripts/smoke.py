#!/usr/bin/env python3
"""Exercise built CLI against three processes, including leader SIGKILL and retry."""
import json
import pathlib
import socket
import subprocess
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="asterkv-smoke-") as directory:
    base = pathlib.Path(directory)
    addresses, reservations = {}, []
    for i in range(1, 4):
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        reservations.append(sock)
        addresses[f"node{i}"] = f"127.0.0.1:{sock.getsockname()[1]}"
    processes, logs = {}, []
    endpoints = ",".join(f"{k}={v}" for k, v in addresses.items())

    def start(node):
        stream = open(base / f"{node}.log", "a")
        logs.append(stream)
        peers = ",".join(f"{k}={v}" for k, v in addresses.items() if k != node)
        processes[node] = subprocess.Popen([
            str(ROOT / "bin/asterkv-node"), f"--id={node}",
            f"--addr={addresses[node]}", f"--peers={peers}",
            f"--data={base / node}", "--snapshot-threshold=3",
        ], stdout=stream, stderr=stream)

    def command(*args):
        result = subprocess.run([
            str(ROOT / "bin/asterkv-client"), f"--endpoints={endpoints}",
            "--timeout=10s", *args,
        ], capture_output=True, text=True, timeout=12, check=True)
        return json.loads(result.stdout)

    try:
        for sock in reservations:
            sock.close()
        for node in addresses:
            start(node)
        assert command("put", "x", "5")["success"]
        assert command("get", "x")["value"] == "5"
        args = ("--client-id=smoke", "--request-id=91", "cas", "x", "5", "6")
        first = command(*args)
        assert first["success"]
        leaders = []
        for node in addresses:
            for line in (base / f"{node}.log").read_text().splitlines():
                event = json.loads(line)
                if event.get("msg") == "leader elected":
                    leaders.append((event["term"], node))
        assert leaders, "no leader event recorded"
        leader = max(leaders)[1]
        at = time.monotonic()
        processes[leader].kill()
        processes[leader].wait(timeout=3)
        assert command(*args) == first, "CAS retry changed its original result"
        recovery = time.monotonic() - at
        assert command("get", "x")["value"] == "6"
        start(leader)
        assert command("delete", "x")["success"]
        assert not command("get", "x").get("found", False)
        print(json.dumps({"result": "PASS", "nodes": 3,
                          "killed_leader": leader,
                          "cas_retry_after_sigkill": "original success preserved",
                          "recovery_seconds": recovery,
                          "checks": ["put", "get", "cas", "dedup", "SIGKILL",
                                     "restart", "delete"]}))
    finally:
        for process in processes.values():
            if process.poll() is None:
                process.terminate()
        for process in processes.values():
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        for stream in logs:
            stream.close()
