#!/usr/bin/env python3
"""Export ABI arrays using the pinned Foundry profile; --check detects stale exports."""
import argparse
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--check", action="store_true")
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
for contract in ("SNIP", "AntiSniperDecayHook"):
    result = subprocess.run(
        ["forge", "inspect", f"src/{contract}.sol:{contract}", "abi", "--json"],
        cwd=root, check=True, text=True, capture_output=True,
    )
    abi = json.loads(result.stdout)
    target = root / "docs" / "abi" / f"{contract}.json"
    if args.check:
        if json.loads(target.read_text()) != abi:
            raise SystemExit(f"Stale ABI: {target}")
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(abi, indent=2) + "\n")
    print(f"{'Verified' if args.check else 'Exported'} {target.relative_to(root)}")
