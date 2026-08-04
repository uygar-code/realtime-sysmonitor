"""System metric collection built on top of psutil.

The collector is deliberately stateful. Disk and network counters exposed by the
operating system are cumulative totals since boot, so a *rate* (MB/s, KB/s) can
only be derived by diffing two consecutive readings against the elapsed wall
time between them. The same applies to per-process CPU usage, which psutil
reports relative to the previous call on the same process object.
"""

from __future__ import annotations

import platform
import socket
import time
from typing import Any, Callable, Iterable, TypeVar

import psutil

KB = 1024
MB = 1024**2
GB = 1024**3

# The kernel's idle task accounts for *unused* CPU, so it would otherwise sit at
# the top of a "busiest processes" list and mean the opposite of what it looks
# like. Task Manager and top hide it for the same reason.
IDLE_PROCESS_NAMES = {"system idle process", "swapper", "idle"}

T = TypeVar("T")


def _safe(fn: Callable[[], T], default: T | None = None) -> T | None:
    """Run a psutil call, swallowing platform specific failures.

    psutil raises on hardware/permission edge cases that differ per OS (empty
    CD-ROM drives, containers without /proc access, missing sensors...). For a
    dashboard, a missing value is better than a crashed sampler.
    """
    try:
        return fn()
    except Exception:
        return default


def _round(value: float | None, digits: int = 1) -> float | None:
    return None if value is None else round(value, digits)


def system_info() -> dict[str, Any]:
    """Static machine facts.

    Served once over HTTP instead of being streamed every tick, since none of it
    changes while the process is running.
    """
    freq = _safe(psutil.cpu_freq)
    vmem = psutil.virtual_memory()
    boot_time = psutil.boot_time()

    return {
        "hostname": _safe(socket.gethostname, "unknown"),
        "platform": f"{platform.system()} {platform.release()}",
        "platform_version": platform.version(),
        "architecture": platform.machine(),
        "python_version": platform.python_version(),
        "cpu_model": platform.processor() or "Unknown CPU",
        "cpu_cores_physical": psutil.cpu_count(logical=False) or 0,
        "cpu_cores_logical": psutil.cpu_count(logical=True) or 0,
        "cpu_freq_max_mhz": _round(getattr(freq, "max", None) or None, 0),
        "memory_total_gb": round(vmem.total / GB, 2),
        "boot_time": boot_time,
        "boot_time_iso": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(boot_time)),
    }


class MetricsCollector:
    """Samples CPU, memory, disk, network and process metrics.

    Args:
        top_processes: how many processes to include in the "top" table.
        process_every: only rebuild the process table every N samples. Walking
            every process is by far the most expensive part of a sample, and at
            a 1s tick it is not worth doing on every frame.
        partitions_every: how often to re-scan mounted partitions (mounts change
            rarely, e.g. when a USB drive is plugged in).
    """

    def __init__(
        self,
        top_processes: int = 5,
        process_every: int = 2,
        partitions_every: int = 30,
    ) -> None:
        self.top_processes = top_processes
        self.process_every = max(1, process_every)
        self.partitions_every = max(1, partitions_every)

        self._tick = 0
        self._cached_processes: list[dict[str, Any]] = []
        self._cached_partitions: list[dict[str, Any]] = []
        self._logical_cores = psutil.cpu_count(logical=True) or 1

        # Prime the counters. The first psutil.cpu_percent() call always returns
        # 0.0 because it has no previous reading to compare against, so we get
        # that throwaway call out of the way here.
        psutil.cpu_percent(interval=None)
        psutil.cpu_percent(interval=None, percpu=True)
        self._prime_process_cpu()

        self._last_time = time.monotonic()
        self._last_disk = _safe(psutil.disk_io_counters)
        self._last_net = _safe(psutil.net_io_counters)
        self._last_cpu_stats = _safe(psutil.cpu_stats)

    # ------------------------------------------------------------------ public

    def sample(self) -> dict[str, Any]:
        """Take one full snapshot of the machine's current state."""
        self._tick += 1
        now = time.monotonic()
        elapsed = max(now - self._last_time, 1e-6)
        self._last_time = now

        return {
            "type": "metrics",
            "ts": time.time() * 1000,  # epoch ms, ready for JS Date()
            "cpu": self._cpu(elapsed),
            "memory": self._memory(),
            "disk": self._disk(elapsed),
            "network": self._network(elapsed),
            "processes": self._processes(),
            "uptime_seconds": int(time.time() - psutil.boot_time()),
        }

    @staticmethod
    def _prime_process_cpu() -> None:
        """Seed each process' CPU counter.

        Same story as the system-wide counter: the first cpu_percent() call on a
        Process returns 0.0. Without this, the first process table we build
        would show 0% for everything. process_iter caches Process objects
        globally, so this priming carries over to later calls.
        """
        try:
            for _ in psutil.process_iter(["cpu_percent"]):
                pass
        except Exception:
            pass

    def reset_baseline(self) -> None:
        """Re-prime the rate counters.

        Called when sampling resumes after a pause so the first sample does not
        report a spike caused by a long gap between readings.
        """
        self._last_time = time.monotonic()
        self._last_disk = _safe(psutil.disk_io_counters)
        self._last_net = _safe(psutil.net_io_counters)
        self._last_cpu_stats = _safe(psutil.cpu_stats)
        psutil.cpu_percent(interval=None)
        psutil.cpu_percent(interval=None, percpu=True)

    # ----------------------------------------------------------------- private

    def _cpu(self, elapsed: float) -> dict[str, Any]:
        per_core = psutil.cpu_percent(interval=None, percpu=True)
        overall = psutil.cpu_percent(interval=None)
        freq = _safe(psutil.cpu_freq)

        ctx_per_s = None
        stats = _safe(psutil.cpu_stats)
        if stats and self._last_cpu_stats:
            delta = stats.ctx_switches - self._last_cpu_stats.ctx_switches
            ctx_per_s = int(max(delta, 0) / elapsed)
        self._last_cpu_stats = stats

        return {
            "percent": round(overall, 1),
            "per_core": [round(c, 1) for c in per_core],
            "core_count": len(per_core),
            "freq_mhz": _round(getattr(freq, "current", None) or None, 0),
            "ctx_switches_per_s": ctx_per_s,
        }

    def _memory(self) -> dict[str, Any]:
        vmem = psutil.virtual_memory()
        swap = _safe(psutil.swap_memory)

        return {
            "percent": round(vmem.percent, 1),
            "used_gb": round(vmem.used / GB, 2),
            "available_gb": round(vmem.available / GB, 2),
            "total_gb": round(vmem.total / GB, 2),
            "swap_percent": round(swap.percent, 1) if swap else None,
            "swap_used_gb": round(swap.used / GB, 2) if swap else None,
            "swap_total_gb": round(swap.total / GB, 2) if swap else None,
        }

    def _disk(self, elapsed: float) -> dict[str, Any]:
        counters = _safe(psutil.disk_io_counters)
        read_mbs = write_mbs = 0.0
        read_total_gb = write_total_gb = None

        if counters:
            if self._last_disk:
                read_delta = max(counters.read_bytes - self._last_disk.read_bytes, 0)
                write_delta = max(counters.write_bytes - self._last_disk.write_bytes, 0)
                read_mbs = round(read_delta / MB / elapsed, 2)
                write_mbs = round(write_delta / MB / elapsed, 2)
            read_total_gb = round(counters.read_bytes / GB, 2)
            write_total_gb = round(counters.write_bytes / GB, 2)
            self._last_disk = counters

        return {
            "read_mbs": read_mbs,
            "write_mbs": write_mbs,
            "read_total_gb": read_total_gb,
            "write_total_gb": write_total_gb,
            "partitions": self._partitions(),
        }

    def _partitions(self) -> list[dict[str, Any]]:
        if self._cached_partitions and self._tick % self.partitions_every != 1:
            return self._cached_partitions

        partitions: list[dict[str, Any]] = []
        for part in _safe(lambda: psutil.disk_partitions(all=False)) or []:
            # Removable/empty drives (e.g. a CD-ROM bay) raise on disk_usage.
            if "cdrom" in part.opts or part.fstype == "":
                continue
            usage = _safe(lambda p=part.mountpoint: psutil.disk_usage(p))
            if usage is None:
                continue
            partitions.append(
                {
                    "device": part.device,
                    "mountpoint": part.mountpoint,
                    "fstype": part.fstype,
                    "percent": round(usage.percent, 1),
                    "used_gb": round(usage.used / GB, 1),
                    "total_gb": round(usage.total / GB, 1),
                    "free_gb": round(usage.free / GB, 1),
                }
            )

        self._cached_partitions = partitions
        return partitions

    def _network(self, elapsed: float) -> dict[str, Any]:
        counters = _safe(psutil.net_io_counters)
        up_kbs = down_kbs = 0.0
        sent_total_mb = recv_total_mb = None
        packets_sent = packets_recv = None

        if counters:
            if self._last_net:
                sent_delta = max(counters.bytes_sent - self._last_net.bytes_sent, 0)
                recv_delta = max(counters.bytes_recv - self._last_net.bytes_recv, 0)
                up_kbs = round(sent_delta / KB / elapsed, 1)
                down_kbs = round(recv_delta / KB / elapsed, 1)
            sent_total_mb = round(counters.bytes_sent / MB, 1)
            recv_total_mb = round(counters.bytes_recv / MB, 1)
            packets_sent = counters.packets_sent
            packets_recv = counters.packets_recv
            self._last_net = counters

        return {
            "up_kbs": up_kbs,
            "down_kbs": down_kbs,
            "sent_total_mb": sent_total_mb,
            "recv_total_mb": recv_total_mb,
            "packets_sent": packets_sent,
            "packets_recv": packets_recv,
        }

    def _processes(self) -> list[dict[str, Any]]:
        # Reuse the previous table on ticks where we skip the (expensive) walk.
        if self._cached_processes and self._tick % self.process_every != 1:
            return self._cached_processes

        rows: list[dict[str, Any]] = []
        attrs = ("pid", "name", "cpu_percent", "memory_info")

        # process_iter caches Process objects between calls, which is what makes
        # cpu_percent() meaningful here: each value is the usage since the last
        # time we asked this same process.
        procs: Iterable[psutil.Process] = _safe(lambda: list(psutil.process_iter(attrs))) or []
        for proc in procs:
            try:
                info = proc.info
                name = info.get("name") or "?"
                if info["pid"] == 0 or name.lower() in IDLE_PROCESS_NAMES:
                    continue

                raw_cpu = info.get("cpu_percent") or 0.0
                mem_info = info.get("memory_info")
                rows.append(
                    {
                        "pid": info["pid"],
                        "name": name,
                        # psutil reports up to 100% *per core*; normalising by
                        # core count matches what Task Manager shows.
                        "cpu": round(raw_cpu / self._logical_cores, 1),
                        "memory_mb": round(mem_info.rss / MB, 1) if mem_info else 0.0,
                    }
                )
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue

        rows.sort(key=lambda r: (r["cpu"], r["memory_mb"]), reverse=True)
        self._cached_processes = rows[: self.top_processes]
        return self._cached_processes
