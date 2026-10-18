"""E6 learners: tabular Q-learning (and Monte Carlo control) over core.features, and a
contextual bandit that picks a concession schedule once per session.

Reward (R1): profit in $k on a closed deal, 0 otherwise. Each move the policy engine rejects
(only possible by trying to accept a below-floor offer; offers are clamped at the floor) costs
the session's full possible profit (list total - cost total of the bundle), so any session with
a rejected move scores at or below walking away. That follows the E8 literature review: rewards
that score rule-breaking no worse than a walk-away teach sellers to close at any price.

Credit assignment (R11): the reward only arrives at the end. Q-learning bootstraps from the
next seller decision (gamma = 1, the round is part of the state, so the horizon is finite);
updates are applied backward through each episode so the end reward reaches round 1 in one
pass. MC control uses the full return instead of bootstrapping.
"""

from __future__ import annotations

import json
import random

import numpy as np

from buyers import evaluate, run_episode, summarize
from sell2agent.catalog import cost_total
from core import ACTIONS, ACCEPT, Ctx, features, to_move, valid_actions
from strategies import QPolicy, _Cached, arm_name, arm_specs, make_arm

SHAPE_STYLE = (8, 5, 8, 5, 2, 2)
SHAPE_NOSTYLE = (8, 5, 8, 2, 2)
NA = len(ACTIONS)


class QTable:
    def __init__(self, style: bool = True):
        self.style = style
        shape = SHAPE_STYLE if style else SHAPE_NOSTYLE
        self.Q = np.zeros(shape + (NA,))
        self.N = np.zeros(shape + (NA,), dtype=np.int64)

    def get(self, s):
        return self.Q[s] if self.N[s].sum() > 0 else None

    def to_json(self) -> dict:
        out = {}
        for idx in zip(*np.nonzero(self.N.sum(axis=-1))):
            s = tuple(int(i) for i in idx)
            out[",".join(map(str, s))] = {
                "q": [round(float(x), 4) for x in self.Q[s]],
                "n": [int(x) for x in self.N[s]],
            }
        return {"style": self.style, "actions": ACTIONS, "states": out}


def load_qdict(path) -> dict:
    """Load an exported table as {state tuple: q values} for QPolicy."""
    d = json.load(open(path))
    return {tuple(int(x) for x in k.split(",")): v["q"] for k, v in d["states"].items()}


class QLearner(_Cached):
    """Epsilon-greedy behavior policy that records its trajectory for an end-of-episode update."""

    def __init__(self, table: QTable, eps: float, rng: random.Random):
        super().__init__()
        self.t, self.eps, self.rng = table, eps, rng
        self.traj: list[list] = []  # [state, action, step reward, valid actions]

    def _decide(self, state):
        c = self.ctx(state)
        acts = valid_actions(c, allow_bad_accept=True)
        s = features(c, self.t.style)
        if self.rng.random() < self.eps:
            a = self.rng.choice(acts)
        else:
            q = self.t.Q[s]
            best = max(q[x] for x in acts)
            a = self.rng.choice([x for x in acts if q[x] >= best - 1e-12])
        self.traj.append([s, a, 0.0, acts])
        self._pen = (c.list_s - cost_total(c.product, c.seller_addons)) / 1000.0
        if a == ACCEPT and not c.buyer_valid:
            from sell2agent.agents import StrategyMove

            return StrategyMove("accept", note="accept")
        return to_move(c, a)

    def on_rejected(self):
        self.traj[-1][2] -= self._pen


def update(table: QTable, traj: list, final: float, method: str = "q", alpha_pow: float = 0.6, alpha_min: float = 0.01):
    G = final
    for t in range(len(traj) - 1, -1, -1):
        s, a, r, _ = traj[t]
        if method == "mc":
            G = r + G
            target = G
        elif t == len(traj) - 1:
            target = r + final
        else:
            s2, _, _, acts2 = traj[t + 1]
            q2 = table.Q[s2]
            target = r + max(q2[x] for x in acts2)
        sa = s + (a,)
        table.N[sa] += 1
        alpha = max(alpha_min, 1.0 / table.N[sa] ** alpha_pow)
        table.Q[sa] += alpha * (target - table.Q[sa])


def eps_at(ep: int, total: int, start: float = 1.0, end: float = 0.05, frac: float = 0.6) -> float:
    return max(end, start - (start - end) * ep / (frac * total))


def train_q(train_buyers, val_buyers, *, style=True, method="q", seed=0, eval_every=2500, log=print,
            alpha_pow=0.6, eps_end=0.05):
    rng = random.Random(seed)
    table = QTable(style)
    curve = []
    window = []
    total = len(train_buyers)
    for ep, (p, k) in enumerate(train_buyers, 1):
        learner = QLearner(table, eps_at(ep, total, end=eps_end), rng)
        res = run_episode(p, k, learner, rng)
        update(table, learner.traj, res.profit / 1000.0, method, alpha_pow=alpha_pow)
        window.append(res.profit)
        if ep % eval_every == 0 or ep == total:
            ev = summarize(evaluate(lambda: QPolicy(table, style=style), val_buyers, seed=99), boot=200)
            curve.append({"episode": ep, "eval_pps": ev["profit_per_session"], "eval_conv": ev["conversion"],
                          "train_pps": round(float(np.mean(window)), 1), "eps": round(eps_at(ep, total), 3)})
            window = []
            log(f"  [{method}{'' if style else '-nostyle'} s{seed}] ep {ep}: eval pps {ev['profit_per_session']}, conv {ev['conversion']}")
    return table, curve


# ---------------------------------------------------------------- contextual bandit

OPEN_EDGES = (-1.5, -1.0, -0.5)


def bandit_context(c: Ctx) -> tuple:
    """What the seller knows when it picks a schedule: the product and how low the buyer opened."""
    if not c.buyer_u:
        o = 0
    else:
        o = 1 + sum(c.buyer_u[0] >= e for e in OPEN_EDGES)
    return (c.product, o)


class Bandit:
    def __init__(self, contextual: bool = True):
        self.contextual = contextual
        self.specs = arm_specs()
        self.n: dict[tuple, np.ndarray] = {}
        self.mean: dict[tuple, np.ndarray] = {}

    def key(self, c: Ctx) -> tuple:
        return bandit_context(c) if self.contextual else ()

    def choose(self, key, eps: float, rng: random.Random) -> int:
        if key not in self.n:
            self.n[key] = np.zeros(len(self.specs))
            self.mean[key] = np.zeros(len(self.specs))
        if rng.random() < eps or self.n[key].sum() == 0:
            return rng.randrange(len(self.specs))
        m = np.where(self.n[key] > 0, self.mean[key], -np.inf)
        return int(np.argmax(m))

    def greedy(self, key) -> int:
        if key not in self.n or self.n[key].sum() == 0:
            key = ()  # unseen context: fall back to the pooled best arm
            if key not in self.n:
                return 0
        m = np.where(self.n[key] > 0, self.mean[key], -np.inf)
        return int(np.argmax(m))

    def update(self, key, arm: int, reward: float):
        self.n[key][arm] += 1
        self.mean[key][arm] += (reward - self.mean[key][arm]) / self.n[key][arm]
        if self.contextual:  # keep a pooled estimate for unseen contexts
            pk = ()
            if pk not in self.n:
                self.n[pk] = np.zeros(len(self.specs))
                self.mean[pk] = np.zeros(len(self.specs))
            self.n[pk][arm] += 1
            self.mean[pk][arm] += (reward - self.mean[pk][arm]) / self.n[pk][arm]

    def to_json(self) -> dict:
        out = {}
        for key in self.n:
            name = "|".join(map(str, key)) or "pooled"
            best = self.greedy(key)
            out[name] = {"best_arm": arm_name(self.specs[best]), "best_mean_profit": round(float(self.mean[key][best]) * 1000, 1),
                         "pulls": int(self.n[key].sum())}
        return {"contextual": self.contextual, "arms": [arm_name(s) for s in self.specs], "contexts": out}


class BanditPolicy(_Cached):
    """Picks an arm at the seller's first turn, then plays that schedule for the session."""

    def __init__(self, bandit: Bandit, eps: float = 0.0, rng: random.Random | None = None, greedy: bool = True):
        super().__init__()
        self.b, self.eps, self.rng, self.greedy_mode = bandit, eps, rng or random.Random(0), greedy
        self.arm = None
        self.key = None
        self.arm_idx = None

    @property
    def name(self):
        return "bandit" + ("_ctx" if self.b.contextual else "")

    def _decide(self, state):
        if self.arm is None:
            c = self.ctx(state)
            self.key = self.b.key(c)
            self.arm_idx = self.b.greedy(self.key) if self.greedy_mode else self.b.choose(self.key, self.eps, self.rng)
            self.arm = make_arm(self.b.specs[self.arm_idx])
            self.arm._base = self._base
        return self.arm.decide(state)


def train_bandit(train_buyers, val_buyers, *, contextual=True, seed=0, eval_every=2500, log=print):
    rng = random.Random(seed)
    b = Bandit(contextual)
    curve, window = [], []
    total = len(train_buyers)
    for ep, (p, k) in enumerate(train_buyers, 1):
        pol = BanditPolicy(b, eps=eps_at(ep, total), rng=rng, greedy=False)
        res = run_episode(p, k, pol, rng)
        if pol.arm_idx is not None:
            b.update(pol.key, pol.arm_idx, res.profit / 1000.0)
        window.append(res.profit)
        if ep % eval_every == 0 or ep == total:
            ev = summarize(evaluate(lambda: BanditPolicy(b), val_buyers, seed=99), boot=200)
            curve.append({"episode": ep, "eval_pps": ev["profit_per_session"], "eval_conv": ev["conversion"],
                          "train_pps": round(float(np.mean(window)), 1), "eps": round(eps_at(ep, total), 3)})
            window = []
            log(f"  [bandit{'-ctx' if contextual else ''} s{seed}] ep {ep}: eval pps {ev['profit_per_session']}, conv {ev['conversion']}")
    return b, curve
