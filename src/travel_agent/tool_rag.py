from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import faiss
import numpy as np
from langchain_core.tools import tool

from travel_agent.tool_formatters import _log_tool_end, _log_tool_start


PROJECT_ROOT = Path(__file__).resolve().parents[2]
KNOWLEDGE_ROOT = PROJECT_ROOT / "knowledge"
SUPPORTED_EXTENSIONS = {".md", ".txt"}
MAX_CHUNK_CHARS = 1100
CHUNK_OVERLAP = 120
EMBED_DIM = 512


@dataclass(frozen=True)
class KnowledgeChunk:
    source: str
    title: str
    text: str


@dataclass
class FaissKnowledgeIndex:
    signature: tuple[tuple[str, int, int], ...]
    chunks: list[KnowledgeChunk]
    index: Any


_INDEX_CACHE: FaissKnowledgeIndex | None = None


def _tokenize(text: str) -> list[str]:
    text = (text or "").lower()
    tokens = re.findall(r"[a-z0-9]+", text)
    chinese_runs = re.findall(r"[\u4e00-\u9fff]+", text)
    for run in chinese_runs:
        if len(run) == 1:
            tokens.append(run)
            continue
        tokens.extend(run[index : index + 2] for index in range(len(run) - 1))
        if len(run) >= 3:
            tokens.extend(run[index : index + 3] for index in range(len(run) - 2))
    return [token for token in tokens if token.strip()]


def _hash_token(token: str) -> tuple[int, float]:
    digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
    raw = int.from_bytes(digest, "little", signed=False)
    index = raw % EMBED_DIM
    sign = 1.0 if (raw >> 63) == 0 else -1.0
    return index, sign


def _embed_text(text: str) -> np.ndarray:
    vector = np.zeros(EMBED_DIM, dtype=np.float32)
    for token in _tokenize(text):
        index, sign = _hash_token(token)
        vector[index] += sign
    norm = np.linalg.norm(vector)
    if norm > 0:
        vector /= norm
    return vector


def _relative_source(path: Path) -> str:
    try:
        return path.relative_to(PROJECT_ROOT).as_posix()
    except ValueError:
        return path.as_posix()


def _split_long_text(text: str) -> list[str]:
    if len(text) <= MAX_CHUNK_CHARS:
        return [text]
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(len(text), start + MAX_CHUNK_CHARS)
        chunks.append(text[start:end].strip())
        if end >= len(text):
            break
        start = max(0, end - CHUNK_OVERLAP)
    return [chunk for chunk in chunks if chunk]


def _load_markdown_chunks(path: Path) -> list[KnowledgeChunk]:
    raw = path.read_text(encoding="utf-8", errors="ignore")
    source = _relative_source(path)
    chunks: list[KnowledgeChunk] = []
    current_title = path.stem
    buffer: list[str] = []

    def flush() -> None:
        nonlocal buffer
        text = "\n".join(line for line in buffer).strip()
        if text:
            for part in _split_long_text(text):
                chunks.append(KnowledgeChunk(source=source, title=current_title, text=part))
        buffer = []

    for line in raw.splitlines():
        heading = re.match(r"^(#{1,4})\s+(.+?)\s*$", line)
        if heading:
            flush()
            current_title = heading.group(2).strip()
            buffer.append(line.strip())
        else:
            buffer.append(line.rstrip())
    flush()
    return chunks


def _knowledge_files() -> list[Path]:
    if not KNOWLEDGE_ROOT.exists():
        return []
    return [
        path
        for path in sorted(KNOWLEDGE_ROOT.rglob("*"))
        if path.is_file() and path.suffix.lower() in SUPPORTED_EXTENSIONS
    ]


def _knowledge_signature(files: list[Path]) -> tuple[tuple[str, int, int], ...]:
    signature: list[tuple[str, int, int]] = []
    for path in files:
        stat = path.stat()
        signature.append((_relative_source(path), int(stat.st_mtime), int(stat.st_size)))
    return tuple(signature)


def _load_knowledge_chunks(files: list[Path]) -> list[KnowledgeChunk]:
    chunks: list[KnowledgeChunk] = []
    for path in files:
        chunks.extend(_load_markdown_chunks(path))
    return chunks


def _build_faiss_index(chunks: list[KnowledgeChunk]) -> Any:
    index = faiss.IndexFlatIP(EMBED_DIM)
    if not chunks:
        return index
    vectors = np.vstack(
        [_embed_text(f"{chunk.title}\n{chunk.source}\n{chunk.text}") for chunk in chunks]
    ).astype("float32")
    index.add(vectors)
    return index


def _get_index() -> FaissKnowledgeIndex:
    global _INDEX_CACHE
    files = _knowledge_files()
    signature = _knowledge_signature(files)
    if _INDEX_CACHE and _INDEX_CACHE.signature == signature:
        return _INDEX_CACHE
    chunks = _load_knowledge_chunks(files)
    _INDEX_CACHE = FaissKnowledgeIndex(
        signature=signature,
        chunks=chunks,
        index=_build_faiss_index(chunks),
    )
    return _INDEX_CACHE


def _compact_snippet(text: str, max_chars: int = 420) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    if len(text) <= max_chars:
        return text
    return text[:max_chars].rstrip() + "..."


@tool
def search_local_knowledge(query: str, top_k: int = 5) -> str:
    """检索项目本地 FAISS 知识库，适合查询课程实验、Agent 架构、LangChain、RAG/Memory/Skill 和城市攻略经验。"""
    start = _log_tool_start("search_local_knowledge", query=query, top_k=top_k)

    knowledge_index = _get_index()
    if not knowledge_index.chunks:
        result = "数据源：本地知识库 RAG\n检索方式：FAISS\n本地 knowledge/ 目录暂无可检索文档。"
        _log_tool_end("search_local_knowledge", start, result)
        return result

    try:
        limit = max(1, min(int(top_k or 5), 8))
    except (TypeError, ValueError):
        limit = 5

    query_vector = _embed_text(query).reshape(1, -1).astype("float32")
    if np.linalg.norm(query_vector) == 0:
        result = (
            "数据源：本地知识库 RAG\n"
            "检索方式：FAISS\n"
            f"查询：{query}\n"
            "查询词过短或缺少有效关键词，未能生成检索向量。"
        )
        _log_tool_end("search_local_knowledge", start, result)
        return result

    search_k = min(max(limit * 3, limit), len(knowledge_index.chunks))
    scores, indices = knowledge_index.index.search(query_vector, search_k)
    hits: list[tuple[float, KnowledgeChunk]] = []
    seen: set[tuple[str, str]] = set()
    for score, raw_index in zip(scores[0].tolist(), indices[0].tolist()):
        if raw_index < 0 or score <= 0:
            continue
        chunk = knowledge_index.chunks[raw_index]
        key = (chunk.source, chunk.title)
        if key in seen:
            continue
        seen.add(key)
        hits.append((float(score), chunk))
        if len(hits) >= limit:
            break

    if not hits:
        result = (
            "数据源：本地知识库 RAG\n"
            "检索方式：FAISS\n"
            f"查询：{query}\n"
            "未检索到足够相关的本地知识。可继续调用实时工具或请用户补充更明确关键词。"
        )
        _log_tool_end("search_local_knowledge", start, result)
        return result

    lines = [
        "数据源：本地知识库 RAG",
        "检索方式：FAISS 向量检索（本地哈希嵌入）",
        f"查询：{query}",
        f"命中片段：{len(hits)}/{len(knowledge_index.chunks)}",
    ]
    for index, (score, chunk) in enumerate(hits, start=1):
        lines.append(
            f"{index}. {chunk.title}｜来源 {chunk.source}｜相似度 {score:.3f}\n"
            f"摘要：{_compact_snippet(chunk.text)}"
        )

    result = "\n".join(lines)
    _log_tool_end("search_local_knowledge", start, result)
    return result
