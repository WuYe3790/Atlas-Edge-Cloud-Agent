from __future__ import annotations

import argparse
import sys

from travel_agent.agent import run_agent, run_offline_demo
from travel_agent.config import load_llm_config


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="LangChain 旅游出行规划智能体")
    parser.add_argument(
        "-q",
        "--query",
        help="行程需求，例如：我明天从郑州去杭州，玩3天，2个人，酒店300，餐饮120，门票300。",
    )
    parser.add_argument(
        "--offline-demo",
        action="store_true",
        help="不调用 LLM，仅验证工具和本地流程。",
    )
    parser.add_argument(
        "--thinking",
        action="store_true",
        help="启用深度思考模式，使用 LLM_THINKING_MODEL 并要求智能体先充分分析再回答。",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    user_input = args.query or input("请输入你的行程需求：\n").strip()

    if not user_input:
        print("错误：行程需求不能为空。")
        sys.exit(1)

    print("=" * 70)
    print("LangChain 旅游出行规划智能体")
    print("=" * 70)
    print(f"用户需求：{user_input}")

    try:
        if args.offline_demo:
            final_answer = run_offline_demo(user_input)
        else:
            config = load_llm_config()
            final_answer = run_agent(user_input, config, thinking_mode=args.thinking)
    except Exception as exc:
        print(f"\n运行失败：{exc}")
        print("提示：如果还没有 API Key，可先运行 python run.py --offline-demo 验证工具流程。")
        sys.exit(1)

    print("\n" + "=" * 70)
    print("智能体最终输出")
    print("=" * 70)
    print(final_answer)
