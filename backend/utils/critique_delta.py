"""Round-over-round critique delta — Jaccard distance over claim sets."""
from __future__ import annotations

import re
from typing import Iterable


_WORD_RE = re.compile(r"[a-z0-9]+")


def _tokens(s: str) -> set[str]:
    return set(_WORD_RE.findall(s.lower()))


def _claim_signature(claim: str) -> frozenset[str]:
    toks = _tokens(claim)
    return frozenset(t for t in toks if len(t) > 3)


def _claim_sets(claims: Iterable[str]) -> set[frozenset[str]]:
    return {_claim_signature(c) for c in claims if c}


def _jaccard(a: set[frozenset[str]], b: set[frozenset[str]]) -> float:
    if not a and not b:
        return 0.0
    # Match claim-signatures by sufficient overlap rather than exact equality.
    matches = 0
    unmatched_b = list(b)
    for x in a:
        best = 0.0
        best_idx = -1
        for i, y in enumerate(unmatched_b):
            inter = len(x & y)
            union = len(x | y) or 1
            sim = inter / union
            if sim > best:
                best, best_idx = sim, i
        if best >= 0.4 and best_idx >= 0:
            matches += 1
            unmatched_b.pop(best_idx)
    total = max(len(a), len(b))
    if total == 0:
        return 0.0
    return 1.0 - (matches / total)


def compute_critique_delta(
    prev_claims: list[str],
    curr_claims: list[str],
) -> float:
    """Return a value in [0, 1]: 0 = identical claim sets, 1 = completely disjoint."""
    return _jaccard(_claim_sets(prev_claims), _claim_sets(curr_claims))
