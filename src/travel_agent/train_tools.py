from __future__ import annotations

import json
import queue
import shutil
import subprocess
import threading
import time

from langchain_core.tools import tool


# ---------------------------------------------------------------------------
# Node.js / npx availability check
# ---------------------------------------------------------------------------

def _check_node_available() -> bool:
    return shutil.which("npx") is not None


# ---------------------------------------------------------------------------
# Minimal MCP JSON-RPC stdio client
# ---------------------------------------------------------------------------

class _McpClient:
    """Communicate with 12306-mcp via MCP JSON-RPC over stdin/stdout."""

    def __init__(self, timeout: float = 60.0):
        self._started_at = time.monotonic()
        npx_path = shutil.which("npx")
        if npx_path is None:
            raise RuntimeError("未找到 npx，请安装 Node.js 后重试。")
        self._process = subprocess.Popen(
            [npx_path, "-y", "12306-mcp"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            encoding="utf-8",
            errors="replace",
        )

        self._id = 0
        self._lock = threading.Lock()
        self._stdout_queue: queue.Queue[str | None] = queue.Queue()

        # Drain stderr in a background thread so the subprocess never blocks on
        # a full pipe buffer.
        self._stderr_lines: list[str] = []
        self._stdout_thread = threading.Thread(target=self._drain_stdout, daemon=True)
        self._stderr_thread = threading.Thread(target=self._drain_stderr, daemon=True)
        self._stdout_thread.start()
        self._stderr_thread.start()

        try:
            self._initialize(timeout=timeout)
        except Exception:
            self.close()
            raise

    # -- stderr drain --------------------------------------------------------

    def _drain_stderr(self) -> None:
        try:
            for line in self._process.stderr:
                self._stderr_lines.append(line)
        except Exception:
            pass

    def _drain_stdout(self) -> None:
        try:
            for line in self._process.stdout:
                self._stdout_queue.put(line)
        except Exception:
            pass
        finally:
            self._stdout_queue.put(None)

    def _stderr_tail(self, n: int = 4) -> str:
        return "".join(self._stderr_lines[-n:]).strip()

    # -- JSON-RPC helpers ----------------------------------------------------

    def _next_id(self) -> int:
        self._id += 1
        return self._id

    def _send_request(self, method: str, params: dict | None = None, timeout: float = 60.0) -> dict:
        with self._lock:
            deadline = time.monotonic() + timeout
            req_id = self._next_id()
            request = {
                "jsonrpc": "2.0",
                "id": req_id,
                "method": method,
                "params": params or {},
            }
            line = json.dumps(request, ensure_ascii=False) + "\n"
            try:
                self._process.stdin.write(line)
                self._process.stdin.flush()
            except (BrokenPipeError, OSError) as exc:
                tail = self._stderr_tail()
                raise RuntimeError(f"12306-MCP 子进程已退出。stderr 尾部: {tail}") from exc

            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    tail = self._stderr_tail()
                    raise TimeoutError(f"12306-MCP 请求超时。method={method} stderr 尾部: {tail}")
                try:
                    response_line = self._stdout_queue.get(timeout=remaining)
                except queue.Empty as exc:
                    tail = self._stderr_tail()
                    raise TimeoutError(f"12306-MCP 请求超时。method={method} stderr 尾部: {tail}") from exc
                if response_line is None:
                    tail = self._stderr_tail()
                    raise RuntimeError(f"12306-MCP stdout 意外关闭。stderr 尾部: {tail}")
                try:
                    response = json.loads(response_line)
                except json.JSONDecodeError:
                    continue
                if response.get("id") == req_id:
                    return response
                # Skip notifications (no id) and responses for other ids

    # -- MCP handshake -------------------------------------------------------

    def _initialize(self, timeout: float = 60.0) -> None:
        init_result = self._send_request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "travel-agent", "version": "1.0.0"},
            },
            timeout=timeout,
        )

        if "error" in init_result:
            raise RuntimeError(f"12306-MCP 初始化失败: {init_result['error']}")

        # Send initialized notification (no response expected)
        with self._lock:
            notification = {"jsonrpc": "2.0", "method": "notifications/initialized"}
            self._process.stdin.write(json.dumps(notification, ensure_ascii=False) + "\n")
            self._process.stdin.flush()

    # -- Public API ----------------------------------------------------------

    def call_tool(self, name: str, arguments: dict) -> str:
        result = self._send_request("tools/call", {"name": name, "arguments": arguments}, timeout=90.0)
        if "error" in result:
            return f"工具调用异常：{result['error'].get('message', result['error'])}"
        content = result.get("result", {}).get("content", [])
        if content and isinstance(content, list):
            return content[0].get("text", str(content))
        return str(content)

    def close(self) -> None:
        try:
            self._process.stdin.close()
            self._process.stdout.close()
            self._process.stderr.close()
        except Exception:
            pass
        try:
            self._process.terminate()
            self._process.wait(timeout=5)
        except Exception:
            try:
                self._process.kill()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Lazy global singleton
# ---------------------------------------------------------------------------

_mcp_client: _McpClient | None = None
_mcp_checked: bool = False  # separate from None → we tried and it failed


def _get_mcp_client() -> _McpClient | None:
    global _mcp_client, _mcp_checked

    if _mcp_client is not None and _mcp_client._process.poll() is not None:
        _mcp_client = None
        _mcp_checked = False

    if _mcp_checked:
        return _mcp_client

    _mcp_checked = True
    if not _check_node_available():
        print("12306-MCP: npx 不可用，火车票工具已禁用。")
        return None

    try:
        _mcp_client = _McpClient()
        print("12306-MCP: 已连接，火车票工具可用。")
    except Exception as exc:
        print(f"12306-MCP 启动失败: {exc}")
        _mcp_client = None
    return _mcp_client


# ---------------------------------------------------------------------------
# LangChain tools
# ---------------------------------------------------------------------------

@tool
def search_train_tickets(
    date: str,
    from_city: str,
    to_city: str,
    train_filter_flags: str = "",
    limit: int = 0,
) -> str:
    """查询12306火车余票信息，用于跨城市铁路出行规划。

    当用户询问两地之间的火车/高铁/动车票时，应优先调用此工具获取真实余票数据。

    Args:
        date: 出发日期，格式为 yyyy-MM-dd。可使用 Python datetime 计算。
        from_city: 出发城市名称或车站名称，例如"杭州"、"郑州"、"北京南"，支持中文。
        to_city: 到达城市名称或车站名称，例如"杭州"、"郑州"、"上海虹桥"，支持中文。
        train_filter_flags: 车次类型筛选标志，可多选，留空表示不筛选。
            可选标志: [G(高铁/城际), D(动车), Z(直达特快), T(特快),
            K(快速), O(其他), F(复兴号), S(智能动车组)]。
            例如用户说"高铁"则应传"G"，说"高铁或动车"则应传"GD"。
        limit: 返回结果数量上限，0 表示不限制。
    """
    client = _get_mcp_client()
    if client is None:
        return (
            "12306火车票查询暂不可用：系统未检测到 Node.js 运行环境，"
            "或 12306-mcp 启动失败。请确认已安装 Node.js。\n"
            "作为替代，建议根据通用经验给出高铁/动车/普速列车参考建议。"
        )

    try:
        result = client.call_tool(
            "get-tickets",
            {
                "date": date,
                "fromStation": from_city,
                "toStation": to_city,
                "trainFilterFlags": train_filter_flags,
                "limitedNum": max(0, int(limit)),
                "format": "text",
            },
        )
        return f"数据源：12306\n{result}"
    except Exception as exc:
        return f"12306查询异常：{exc}"


@tool
def get_train_route(train_code: str, date: str) -> str:
    """查询特定列车车次的详细经停站、到站/出发时间和停留时间。

    当用户询问某趟列车的具体停靠站或时刻时调用。

    Args:
        train_code: 车次代码，例如"G1033"、"D3101"、"Z283"。
        date: 列车出发日期，格式为 yyyy-MM-dd。
    """
    client = _get_mcp_client()
    if client is None:
        return "12306列车查询暂不可用：系统未检测到 Node.js 运行环境，或 12306-mcp 启动失败。"

    try:
        result = client.call_tool(
            "get-train-route-stations",
            {"trainCode": train_code, "departDate": date, "format": "text"},
        )
        return f"数据源：12306\n{result}"
    except Exception as exc:
        return f"12306查询异常：{exc}"


@tool
def search_interline_train_tickets(
    date: str,
    from_city: str,
    to_city: str,
    middle_city: str = "",
    train_filter_flags: str = "",
    limit: int = 10,
) -> str:
    """查询12306中转余票信息，用于两地没有合适直达车次、需要比较换乘方案时调用。

    Args:
        date: 出发日期，格式为 yyyy-MM-dd。
        from_city: 出发城市名或车站名，例如 "宁波"、"宁波站"。
        to_city: 到达城市名或车站名，例如 "张家界"、"张家界西"。
        middle_city: 可选中转城市或车站名，例如 "杭州东"；留空表示由 12306 推荐。
        train_filter_flags: 车次类型筛选标志，例如 "G" 高铁、"D" 动车、"GD" 高铁或动车。
        limit: 返回中转方案数量，建议 3-10。
    """
    client = _get_mcp_client()
    if client is None:
        return "12306中转查询暂不可用：系统未检测到 Node.js 运行环境，或 12306-mcp 启动失败。"

    try:
        result = client.call_tool(
            "get-interline-tickets",
            {
                "date": date,
                "fromStation": from_city,
                "toStation": to_city,
                "middleStation": middle_city,
                "showWZ": False,
                "trainFilterFlags": train_filter_flags,
                "limitedNum": max(1, min(int(limit), 10)),
                "format": "text",
            },
        )
        return f"数据源：12306中转查询\n{result}"
    except Exception as exc:
        return f"12306中转查询异常：{exc}"


# ---------------------------------------------------------------------------
# Public helpers for agent.py
# ---------------------------------------------------------------------------

def get_train_tools() -> list:
    """Return 12306-related LangChain tools if available, otherwise empty list."""
    if not _check_node_available():
        return []
    return [search_train_tickets, search_interline_train_tickets, get_train_route]


def is_train_tools_available() -> bool:
    """Return whether the optional 12306 tool runtime is likely available."""
    return _check_node_available()


TRAIN_TOOLS: list = []  # populated lazily by get_train_tools()
